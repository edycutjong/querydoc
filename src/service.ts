import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmClientFromEnv } from "./adapters/llm.js";
import { LlmGateway } from "./adapters/nim.js";
import { loadConfig, ROOT, type VerifierConfig } from "./config.js";
import { DuckDbEngine } from "./engine/duckdb.js";
import type { QueryEngine } from "./engine/types.js";
import { ZetarisEngine, zetarisConfigFromEnv } from "./engine/zetaris.js";
import { Playbook } from "./memory/playbook.js";
import { runCase } from "./orchestrator.js";
import { caseMarkdown } from "./report/markdown.js";
import type { Case, Decision } from "./types.js";

// The HTTP-independent core of the API (server.ts only routes). One /run at a time: timing is the judged evidence, so two cases
// never share the CPU. Every outcome is a structured JSON value; a request never throws past this layer.

export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SQL_CHARS = 20_000;

export interface Reply {
  status: number;
  json: unknown;
}

export class ApiError extends Error {
  constructor(readonly http: number, readonly type: string, message: string, readonly recoverable = true) {
    super(message);
  }
}

const fail = (e: ApiError): Reply => ({ status: e.http, json: { status: "error", error: { type: e.type, message: e.message, recoverable: e.recoverable } } });

export interface ServiceOptions {
  root?: string; // repository root (data/, fixtures/, recorded/ live under it)
  env?: NodeJS.ProcessEnv;
  cacheWrite?: boolean; // record.ts turns the llm-cache write on for the canonical pass only
  llm?: LlmGateway; // tests inject a gateway
  engineFactory?: (mode: "duckdb" | "zetaris") => Promise<QueryEngine>;
  clock?: () => Date;
}

interface RunRequest {
  run_id?: unknown;
  input?: { sql?: unknown; candidate_sql?: unknown; source?: unknown; schema?: unknown };
  options?: { sample_mode?: unknown; max_attempts?: unknown; playbook?: unknown };
  // flat form (CLI files, input_examples/live): {sql, candidate_sql, source}
  sql?: unknown;
  candidate_sql?: unknown;
  source?: unknown;
}

export class QueryDocService {
  readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly engines = new Map<string, Promise<QueryEngine>>();
  private queue: Promise<unknown> = Promise.resolve();
  private inflight = 0; // POST /run requests queued or running
  private readonly llm: LlmGateway;

  constructor(private readonly o: ServiceOptions = {}) {
    this.root = o.root ?? ROOT;
    this.env = o.env ?? process.env;
    this.llm = o.llm ?? new LlmGateway({ client: llmClientFromEnv(this.env), ...(o.cacheWrite ? { cacheWrite: true } : {}), cacheDir: join(this.root, "llm-cache") });
  }

  private p = (...parts: string[]) => join(this.root, ...parts);

  // --- mode -----------------------------------------------------------------------------------------------------------------
  // The per-request flag wins over credentials; SAMPLE_MODE=true forces the sample engine; no usable Zetaris settings falls back to
  // the sample engine with a labelled banner. Empty values and the .env.example placeholders count as absent (env loader skips them).
  resolveMode(sampleOpt: unknown): { engine: "duckdb" | "zetaris"; banner?: string } {
    const creds = zetarisConfigFromEnv(this.env);
    const envSample = String(this.env.SAMPLE_MODE ?? "").toLowerCase() === "true";
    if (sampleOpt === true || envSample) return { engine: "duckdb" };
    if (!creds) return { engine: "duckdb", banner: "falling back to SAMPLE_MODE: no usable Zetaris settings (ZETARIS_JDBC_*) in the environment" };
    return { engine: "zetaris" };
  }

  private engine(mode: "duckdb" | "zetaris"): Promise<QueryEngine> {
    let e = this.engines.get(mode);
    if (!e) {
      e = this.o.engineFactory
        ? this.o.engineFactory(mode)
        : mode === "duckdb"
          ? DuckDbEngine.open({ dataDir: this.p("data", "sample") })
          : Promise.resolve(new ZetarisEngine(zetarisConfigFromEnv(this.env)!));
      this.engines.set(mode, e);
      e.catch(() => this.engines.delete(mode));
    }
    return e;
  }

  async close(): Promise<void> {
    for (const e of this.engines.values()) await e.then((engine) => engine.close()).catch(() => undefined); // an engine that never opened has nothing to close
    this.engines.clear();
  }

  // --- POST /run ------------------------------------------------------------------------------------------------------------
  run(body: unknown): Promise<Reply> {
    this.inflight++;
    const job = this.queue.then(() => this.runNow(body)).finally(() => this.inflight--);
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async runNow(raw: unknown): Promise<Reply> {
    const t0 = performance.now();
    try {
      const b = (raw && typeof raw === "object" ? raw : null) as RunRequest | null;
      if (!b) throw new ApiError(400, "InvalidInput", "request body must be a JSON object");
      const inp = b.input ?? { sql: b.sql, candidate_sql: b.candidate_sql, source: b.source };
      const opt = b.options ?? {};
      const sql = typeof inp.sql === "string" ? inp.sql.trim() : "";
      if (!sql) throw new ApiError(400, "InvalidInput", "input.sql is required (one SELECT statement)");
      if (sql.length > MAX_SQL_CHARS) throw new ApiError(400, "InvalidInput", `input.sql is longer than ${MAX_SQL_CHARS} characters`);
      let candidate: string | undefined;
      if (inp.candidate_sql !== undefined && inp.candidate_sql !== null && inp.candidate_sql !== "") {
        if (typeof inp.candidate_sql !== "string" || inp.candidate_sql.length > MAX_SQL_CHARS) throw new ApiError(400, "InvalidInput", "input.candidate_sql must be a string of at most 20000 characters");
        candidate = inp.candidate_sql.trim();
      }
      const source = inp.source === "slow_queries" ? "slow_queries" : "paste";
      let maxAttempts: number | undefined;
      if (opt.max_attempts !== undefined) {
        const n = Number(opt.max_attempts);
        if (!Number.isInteger(n) || n < 1 || n > 3) throw new ApiError(400, "InvalidOption", "options.max_attempts must be an integer from 1 to 3");
        maxAttempts = n;
      }
      if (b.run_id !== undefined && (typeof b.run_id !== "string" || !RUN_ID_RE.test(b.run_id))) throw new ApiError(400, "InvalidInput", "run_id must match [A-Za-z0-9_-]{1,64}");
      const pbOpt = opt.playbook === undefined ? undefined : String(opt.playbook);
      if (pbOpt !== undefined && !(pbOpt === "empty" || pbOpt === "seed" || /^run:[A-Za-z0-9_-]{1,64}$/.test(pbOpt))) throw new ApiError(400, "InvalidOption", 'options.playbook must be "empty", "seed" or "run:<run_id>"');

      const mode = this.resolveMode(opt.sample_mode);
      const requested = typeof b.run_id === "string" ? b.run_id : `run-${(this.o.clock?.() ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
      let runId = requested;
      if (existsSync(this.p("data", "runs", runId))) runId = `${requested.slice(0, 55)}-${randomBytes(3).toString("hex")}`; // a repeated id never appends to another run's trace
      else if (typeof b.run_id !== "string") runId = `${requested}-${randomBytes(2).toString("hex")}`;

      const engine = await this.engine(mode.engine);
      const cfg: VerifierConfig = loadConfig(this.p("querydoc.config.json"), mode.engine);
      const runDir = this.p("data", "runs", runId);
      if (mode.engine === "zetaris" && pbOpt?.startsWith("run:")) throw new ApiError(400, "InvalidOption", 'options.playbook "run:<id>" is a sample-mode option (live runs share one persistent playbook)');
      const playbook = this.openPlaybook(mode.engine, runDir, pbOpt ?? "seed"); // validates the source first: a refused request leaves no run directory
      mkdirSync(runDir, { recursive: true });
      const ran = await runCase({ sql, ...(candidate ? { candidate_sql: candidate } : {}), source }, {
        engine, cfg, llm: this.llm, attemptCap: 3, logDir: runDir, playbook,
      }, { runId, ...(maxAttempts ? { maxAttempts } : {}) });
      const c = ran.case;
      c.playbook_state = mode.engine === "zetaris" ? "persistent" : pbOpt ?? "seed"; // live always opens the one shared store (data/hmem)
      writeFileSync(join(runDir, "case.json"), JSON.stringify(c, null, 2) + "\n");
      const dossier = caseMarkdown(c);
      writeFileSync(join(runDir, "dossier.md"), dossier);

      const partial = !candidate && c.verdict === "NO_SAFE_REWRITE" && c.no_rewrite_reason === "llm_unavailable";
      const status = c.verdict === "ERROR" ? "error" : partial ? "partial" : "ok";
      const agents = [...new Set(ran.trace.events.map((e) => e.agent_name))].map((name) => ({ name, events: ran.trace.events.filter((e) => e.agent_name === name).length }));
      return {
        status: 200,
        json: {
          status, run_id: runId, ...(runId !== requested && typeof b.run_id === "string" ? { requested_run_id: requested } : {}),
          engine: c.engine, llm: c.llm, ...(mode.banner ? { banner: mode.banner } : {}),
          verdict: c.verdict, ...(c.no_rewrite_reason ? { no_rewrite_reason: c.no_rewrite_reason, llm_unavailable: c.no_rewrite_reason === "llm_unavailable" } : {}),
          ...(partial ? { error: { type: "SampleModeNoLLM", message: "needs a live model through Meterless Nightshift (METERLESS_RUNTIME_TOKEN) for rewrites, or pass candidate_sql" } } : {}),
          ...(status === "error" ? { error: { type: "UpstreamError", message: c.detail ?? "engine error" } } : {}),
          output: { dossier, case: c }, agents, trace_id: runId, log_file: join("data", "runs", runId, `trace-${runId}.jsonl`),
          execution_time_seconds: Math.round(((performance.now() - t0) / 1000) * 10) / 10,
        },
      };
    } catch (e) {
      if (e instanceof ApiError) return fail(e);
      return { status: 500, json: { status: "error", error: { type: "InternalError", message: (e as Error).message.slice(0, 300), recoverable: false } } };
    }
  }

  // Sample mode: a fresh store per request, fixed clock. Live: the one persistent store (data/hmem).
  private openPlaybook(mode: "duckdb" | "zetaris", runDir: string, option: string): Playbook {
    if (mode === "zetaris") return Playbook.open({ dir: this.p("data", "hmem") });
    const dir = join(runDir, "hmem");
    if (option === "empty") return Playbook.open({ dir, fixedClock: true });
    if (option === "seed") {
      const seed = this.p("fixtures", "hmem-seed", "sample");
      if (!existsSync(join(seed, "state.json"))) throw new ApiError(500, "SeedMissing", "fixtures/hmem-seed/sample is missing: the committed playbook seed is part of the build (npm run record writes it)", false);
      return Playbook.open({ dir, seedDir: seed, fixedClock: true });
    }
    const src = this.p("data", "runs", option.slice(4), "hmem");
    if (!existsSync(join(src, "state.json"))) throw new ApiError(400, "InvalidOption", `playbook "${option}": no such earlier run (unknown or purged), nothing was run`);
    return Playbook.open({ dir, seedDir: src, fixedClock: true }); // copied through a temp dir and a rename
  }

  // --- GET /runs/:id --------------------------------------------------------------------------------------------------------
  getRun(id: string): Reply {
    if (!RUN_ID_RE.test(id)) return fail(new ApiError(400, "InvalidInput", "bad run id"));
    const f = this.p("data", "runs", id, "case.json");
    if (!existsSync(f)) return fail(new ApiError(404, "NotFound", `no run ${id}`));
    const md = this.p("data", "runs", id, "dossier.md");
    return { status: 200, json: { status: "ok", run_id: id, case: JSON.parse(readFileSync(f, "utf8")) as Case, ...(existsSync(md) ? { dossier: readFileSync(md, "utf8") } : {}) } };
  }

  // --- GET /runs/:id/trace --------------------------------------------------------------------------------------------------
  // The live trace of a run, readable while the run is still going (the Report UI polls it); `done` flips when case.json lands.
  runTrace(id: string): Reply {
    if (!RUN_ID_RE.test(id)) return fail(new ApiError(400, "InvalidInput", "bad run id"));
    const dir = this.p("data", "runs", id);
    const f = join(dir, `trace-${id}.jsonl`);
    const events = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
    return { status: 200, json: { status: "ok", run_id: id, done: existsSync(join(dir, "case.json")), events } };
  }

  // --- POST /runs/:id/decision ----------------------------------------------------------------------------------------------
  // Queued with the runs: H-MEM rewrites its whole state.json from memory on every write, so a decision written while a live run
  // holds the same store open would be overwritten by that run's next write (and both would draw ids from the same counter).
  decide(id: string, body: unknown): Promise<Reply> {
    const job = this.queue.then(() => this.decideNow(id, body));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private decideNow(id: string, body: unknown): Reply {
    if (!RUN_ID_RE.test(id)) return fail(new ApiError(400, "InvalidInput", "bad run id"));
    const f = this.p("data", "runs", id, "case.json");
    if (!existsSync(f)) return fail(new ApiError(404, "NotFound", `no run ${id}`));
    const b = (body && typeof body === "object" ? body : {}) as { decision?: unknown; actor?: unknown; note?: unknown };
    if (b.decision !== "approve" && b.decision !== "reject") return fail(new ApiError(400, "InvalidInput", 'decision must be "approve" or "reject"'));
    const actor = typeof b.actor === "string" && /^[\w .@-]{1,60}$/.test(b.actor) ? b.actor : "";
    if (!actor) return fail(new ApiError(400, "InvalidInput", "actor is required (1-60 characters: letters, digits, space . _ @ -)"));
    const note = typeof b.note === "string" ? b.note.slice(0, 300) : undefined;
    const c = JSON.parse(readFileSync(f, "utf8")) as Case;
    const acc = c.attempts.find((a) => a.verdict === "ACCEPT");
    if (c.verdict !== "ACCEPTED" || !acc) return fail(new ApiError(409, "NotDecidable", `run ${id} has no accepted rewrite to decide on (verdict ${c.verdict})`));
    if (c.decision) return fail(new ApiError(409, "AlreadyDecided", `run ${id} was already ${c.decision.decision}d by ${c.decision.actor}`));
    const pb = c.engine === "duckdb" ? Playbook.open({ dir: this.p("data", "runs", id, "hmem"), fixedClock: true }) : Playbook.open({ dir: this.p("data", "hmem") });
    const m = pb.recordDecision(b.decision, actor, acc, { pattern: c.diagnosis?.pattern_label ?? "other", schema: c.schema_fqn ?? "default", origSql: c.sql, origFp: c.precheck?.fingerprint ?? "" }, note);
    const decision: Decision = { decision: b.decision, actor, at: (this.o.clock?.() ?? new Date()).toISOString(), memory_id: m.id, ledger_entries: pb.hmem.ledger.history(m.id).length };
    c.decision = decision;
    writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
    if (b.decision === "approve") {
      mkdirSync(this.p("data", "patches"), { recursive: true });
      writeFileSync(this.p("data", "patches", `${id}.sql`), `-- Query Doctor patch for run ${id}, approved by ${actor}\n-- verified by execution on ${c.engine}: same rows, ${acc.timing_ms?.median_speedup}× median\n${acc.sql.trim()};\n`);
      writeFileSync(this.p("data", "patches", `${id}.md`), `### Query Doctor — suggested rewrite (approved by ${actor})\n\n${caseMarkdown(c)}`);
    }
    const patch = b.decision === "approve" ? { sql: readFileSync(this.p("data", "patches", `${id}.sql`), "utf8"), markdown: readFileSync(this.p("data", "patches", `${id}.md`), "utf8") } : undefined;
    return { status: 200, json: { status: "ok", memory_id: m.id, ledger_entries: decision.ledger_entries, decision, ...(patch ? { patch } : {}) } };
  }

  // --- GET /slow-queries ----------------------------------------------------------------------------------------------------
  slowQueries(mode: "sample" | "live"): Reply {
    const dir = this.p("evals", "queries", mode === "sample" ? "sample" : "zetaris");
    const items = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.includes(".rewrite") && !f.includes("-rewrite")).sort().map((f) => ({
          id: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim(),
        }))
      : [];
    return { status: 200, json: { status: "ok", source: mode === "sample" ? "sample query pack (committed, labelled)" : "live query pack — the local platform exposes no slow-query history", items } };
  }

  // --- GET /playbook --------------------------------------------------------------------------------------------------------
  playbook(runId: string | null, schema: string | null): Reply {
    let dir: string;
    if (runId) {
      if (!RUN_ID_RE.test(runId)) return fail(new ApiError(400, "InvalidInput", "bad run id"));
      dir = this.p("data", "runs", runId, "hmem");
      if (!existsSync(join(dir, "state.json"))) return { status: 200, json: { status: "ok", scope: `run ${runId}`, entries: [] } };
    } else {
      dir = this.p("data", "hmem");
      if (!existsSync(join(dir, "state.json"))) {
        dir = this.p("fixtures", "hmem-seed", "sample");
        if (!existsSync(join(dir, "state.json"))) return { status: 200, json: { status: "ok", scope: "empty", entries: [] } };
      }
    }
    const entries = Playbook.open({ dir }).ledgerView().filter((e) => !schema || e.tags.includes(`schema:${schema}`)); // read only: ledgerView() writes nothing
    return { status: 200, json: { status: "ok", scope: runId ? `run ${runId}` : "store", entries } };
  }

  // --- GET /traces/recorded -------------------------------------------------------------------------------------------------
  recorded(name: string | null): Reply {
    const base = this.p("recorded", "live");
    if (!existsSync(base)) return { status: 200, json: { status: "ok", label: "recorded live run", runs: [] } };
    if (name) {
      if (!/^[a-z0-9-]{1,40}$/.test(name) || !existsSync(join(base, name))) return fail(new ApiError(404, "NotFound", `no recorded run ${name}`));
      const dossier = existsSync(join(base, name, "dossier.md")) ? readFileSync(join(base, name, "dossier.md"), "utf8") : "";
      const trace = existsSync(join(base, name, "trace.jsonl")) ? readFileSync(join(base, name, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const caseFile = join(base, name, "case.json");
      return { status: 200, json: { status: "ok", label: `recorded live run · ${name}`, name, dossier, trace, ...(existsSync(caseFile) ? { case: JSON.parse(readFileSync(caseFile, "utf8")) } : {}) } };
    }
    const runs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    return { status: 200, json: { status: "ok", label: "recorded live run", runs } };
  }

  // The measured SELECT 1 baseline and noise floor the Report shows in its table caption (querydoc.config.json, with its source run).
  private calibration() {
    try {
      const n = (JSON.parse(readFileSync(this.p("querydoc.config.json"), "utf8")) as { noise?: { select1MedianMs?: number; select1SpreadMs?: number; noiseFloorMs?: number } }).noise ?? {};
      return { select1_median_ms: n.select1MedianMs ?? null, select1_spread_ms: n.select1SpreadMs ?? null, zetaris_noise_floor_ms: n.noiseFloorMs ?? null };
    } catch {
      return null;
    }
  }

  // --- GET /health ----------------------------------------------------------------------------------------------------------
  async health(): Promise<Reply> {
    const mode = this.resolveMode(undefined);
    let engine: { name: string; ok: boolean; busy?: true; error?: string };
    // While a case runs, the engine is not probed: a live probe would queue behind the case's statements on the one sidecar
    // (minutes), and the UI renders nothing until /health answers.
    if (this.inflight > 0) engine = { name: mode.engine, ok: true, busy: true };
    else {
      try {
        const h = await (await this.engine(mode.engine)).health();
        engine = { name: mode.engine, ok: h.ok, ...(h.error ? { error: h.error } : {}) };
      } catch (e) {
        engine = { name: mode.engine, ok: false, error: (e as Error).message.slice(0, 200) };
      }
    }
    return { status: 200, json: { status: engine.ok ? "ok" : "degraded", engine, ...(mode.banner ? { banner: mode.banner } : {}), llm: { provider: this.llm.provider ?? "none", configured: this.llm.live }, llm_cache: existsSync(this.p("llm-cache")), calibration: this.calibration(), playbook_seed: existsSync(this.p("fixtures", "hmem-seed", "sample", "state.json")) } };
  }
}

