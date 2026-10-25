import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LlmGateway } from "./adapters/nim.js";
import { Diagnoser } from "./agents/diagnoser.js";
import { detectPatterns } from "./agents/patterns.js";
import { profileJoinKeys } from "./agents/profile.js";
import { Rewriter } from "./agents/rewriter.js";
import { Verifier, type Attempt } from "./agents/verifier.js";
import type { VerifierConfig } from "./config.js";
import { ROOT } from "./config.js";
import type { Plan, QueryEngine } from "./engine/types.js";
import { schemaFqn, type Playbook, type PlaybookCtx } from "./memory/playbook.js";
import { runChain, type ChainResult } from "./reasoning/chain.js";
import { Trace } from "./trace.js";
import type { Case, RunInput, RunOptions } from "./types.js";

// runCase: the whole pipeline for one query — guard → pre-check → plan + detector + key facts → Diagnoser → (candidate_sql | the
// Markovian rewrite chain) → Verifier verdict → Case. The verdict comes from the Verifier's fields only; the Orchestrator maps
// them to a case verdict and never invents a number. Nothing is applied anywhere: an ACCEPTED case is a reviewable candidate.

export interface Deps {
  engine: QueryEngine;
  cfg: VerifierConfig;
  llm: LlmGateway;
  attemptCap: number; // querydoc.config.json policy.attemptCap
  logDir?: string; // JSONL traces go to <logDir>/trace-<run_id>.jsonl
  // Chosen from the Day-3 latency probe (docs/DX-REPORT.md): the Diagnoser reasons once per case; the Rewriter answers directly.
  reasoning?: { diagnoser: "on" | "off"; rewriter: "on" | "off" };
  playbook?: Playbook; // H-MEM playbook for this run; absent = no memory (unit tests)
}

export interface CaseRun {
  case: Case;
  trace: Trace;
  chain?: ChainResult["markovian"];
}

export async function runCase(input: RunInput, deps: Deps, opts: RunOptions = {}): Promise<CaseRun> {
  const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z-${randomBytes(2).toString("hex")}`; // suffix: two runs in one second never share a trace file
  const logDir = deps.logDir ?? join(ROOT, "logs");
  mkdirSync(logDir, { recursive: true });
  const trace = new Trace(runId, join(logDir, `trace-${runId}.jsonl`));
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? deps.attemptCap, 3));
  deps.llm.resetServed();
  const c: Case = {
    run_id: runId, sql: input.sql, source: input.source ?? "paste", engine: deps.engine.name, llm: "none",
    started_at: new Date().toISOString(), attempts: [], verdict: "ERROR", playbook_hits: [],
  };
  const finish = (verdict: Case["verdict"], extra: Partial<Case> = {}, chain?: ChainResult["markovian"]): CaseRun => {
    Object.assign(c, { verdict, finished_at: new Date().toISOString() }, extra);
    trace.emit({
      agent_name: "Orchestrator", action: "case_verdict", input_summary: `${c.attempts.length} attempt(s)`,
      output_summary: `${verdict}${c.no_rewrite_reason ? ` (${c.no_rewrite_reason})` : ""}${c.detail ? ` — ${c.detail.slice(0, 160)}` : ""}`,
      target_agent: "Human", retry_count: Math.max(0, c.attempts.length - 1), status: verdict === "ERROR" ? "error" : "ok",
    });
    return { case: c, trace, ...(chain ? { chain } : {}) };
  };

  const verifier = new Verifier(deps.engine, deps.cfg, trace);
  trace.emit({
    agent_name: "Orchestrator", action: "start_case", input_summary: input.sql.replace(/\s+/g, " ").slice(0, 120),
    output_summary: `engine ${deps.engine.name}; llm ${deps.llm.provider ?? "cache-only"}; attempt cap ${maxAttempts}`, target_agent: "Verifier", retry_count: 0, status: "ok",
  });

  try {
    const pre = await verifier.precheck(input.sql);
    if (!pre.ok) return finish(pre.verdict ?? "ERROR", { detail: pre.reason });
    c.precheck = { deterministic: pre.deterministic, rows: pre.rows, fingerprint: pre.fingerprint, fingerprint_kind: pre.fingerprint_kind, vacuous: pre.vacuous, columns: pre.columns };

    let plan: Plan | null = null;
    try {
      plan = await deps.engine.explain(input.sql);
      trace.emit({
        agent_name: "Orchestrator", action: "explain", input_summary: "original query", output_summary: `${plan.nodes.length} plan node(s)`, target_agent: "Diagnoser",
        sponsor_call: { service: deps.engine.name, name: "explain", latency_ms: Math.round(plan.wallMs * 10) / 10 }, retry_count: 0, status: "ok",
      });
    } catch (e) {
      trace.emit({ agent_name: "Orchestrator", action: "explain", input_summary: "original query", output_summary: (e as Error).message.slice(0, 200), target_agent: "Diagnoser", retry_count: 0, status: "error" });
    }
    const detection = detectPatterns(input.sql, plan);
    const facts = await profileJoinKeys(deps.engine, input.sql, deps.cfg.dialect, trace);
    const diagnoser = new Diagnoser(deps.llm, trace, deps.reasoning?.diagnoser ?? "on", deps.engine.name);
    c.diagnosis = await diagnoser.diagnose(input.sql, plan, detection, facts);
    c.schema_fqn = schemaFqn(detection.tables);

    // Playbook plumbing: retrieval before each Rewriter call, ledger-reuse lookup and the write of every rejection (Verifier outcomes only).
    const pb = deps.playbook;
    const pctx: PlaybookCtx = { pattern: c.diagnosis.pattern_label, schema: c.schema_fqn, origSql: input.sql, origFp: pre.fingerprint };
    const hitSet = new Set<string>();
    if (pb) trace.emit({ agent_name: "Orchestrator", action: "playbook_open", input_summary: `store ${pb.storeHash()}`, output_summary: `${pb.size} entr${pb.size === 1 ? "y" : "ies"}; pattern ${pctx.pattern}; schema ${pctx.schema}`, target_agent: "Rewriter", sponsor_call: { service: "hmem", name: "open", latency_ms: 0 }, retry_count: 0, status: "ok" });
    const retrieve = () => {
      if (!pb) return [];
      const t = performance.now();
      const hits = pb.retrieve(pctx.pattern, pctx.schema);
      for (const h of hits) hitSet.add(h.id);
      trace.emit({
        agent_name: "Orchestrator", action: "playbook_query", input_summary: `${pctx.pattern} ${pctx.schema}`,
        output_summary: hits.length ? hits.map((h) => `${h.id} ${h.outcome} (${h.score})`).join(", ") : "no entries for this pattern and schema", target_agent: "Rewriter",
        sponsor_call: { service: "hmem", name: "query", latency_ms: Math.round((performance.now() - t) * 10) / 10 }, retry_count: 0, status: "ok",
      });
      return hits;
    };
    const reuse = pb ? (cand: string) => pb.findRefusal(input.sql, cand, pre.fingerprint) : undefined;
    const onAttempt = (att: Attempt) => {
      if (!pb) return;
      if (att.reused_from) hitSet.add(att.reused_from);
      const t = performance.now();
      const m = pb.recordRejection(att, pctx);
      if (m) trace.emit({ agent_name: "Orchestrator", action: "playbook_write", input_summary: `attempt ${att.n} ${att.reason}${att.not_faster_detail ? "/" + att.not_faster_detail : ""}`, output_summary: `${m.id} ${m.tags.find((t2) => t2.startsWith("outcome:"))}`, target_agent: null, sponsor_call: { service: "hmem", name: "add", latency_ms: Math.round((performance.now() - t) * 10) / 10 }, retry_count: att.n - 1, status: "ok" });
    };
    const syncHits = () => { c.playbook_hits = [...hitSet]; };

    // Own-candidate path: the human supplied a rewrite as attempt 1 and the Verifier judges it. An accepted candidate ends the case;
    // a rejected one continues into the Rewriter chain when attempts remain (its rejection is in the carryover). With no model
    // available the chain ends at once as NO_SAFE_REWRITE + llm_unavailable, with the candidate's refusal in the dossier.
    const prior: Attempt[] = [];
    if (input.candidate_sql) {
      const att = await verifier.verify({ n: 1, origin: "candidate_sql", hypothesis_id: null, sql: input.candidate_sql, change_summary: "candidate supplied with the request" }, pre, { lastAttempt: maxAttempts <= 1, ...(reuse ? { reuse } : {}) });
      c.attempts.push(att);
      onAttempt(att);
      syncHits();
      if (att.verdict === "ACCEPT" || maxAttempts <= 1) return finalise(att.verdict === "ACCEPT" ? att : null, c.attempts, null, finish);
      prior.push(att);
    }

    const rewriter = new Rewriter(deps.llm, trace, deps.reasoning?.rewriter ?? "off");
    const chain = await runChain({ sql: input.sql, plan, diagnosis: c.diagnosis, facts, pre, rewriter, diagnoser, verifier, trace, maxAttempts, prior, engine: deps.engine.name, schema: c.schema_fqn ?? "", retrieve, ...(reuse ? { reuse } : {}), onAttempt });
    c.attempts.push(...chain.attempts);
    syncHits();
    c.llm = deps.llm.servedLabel(); // what actually served this case's model calls: the live provider, the recorded cache, or both
    if (chain.upstreamError) throw new Error(chain.upstreamError);
    return finalise(chain.accepted, chain.attempts, chain, finish);
  } catch (e) {
    const detail = (e as Error).message.slice(0, 300);
    // after >= 1 attempt an upstream failure is NO_SAFE_REWRITE + "upstream"; before the first it is ERROR (architecture §Schema)
    return c.attempts.length ? finish("NO_SAFE_REWRITE", { no_rewrite_reason: "upstream", detail }) : finish("ERROR", { detail });
  }

  function finalise(accepted: Attempt | null, attempts: Attempt[], chain: ChainResult | null, fin: typeof finish): CaseRun {
    if (accepted) return fin("ACCEPTED", {}, chain?.markovian);
    if (chain?.withdrew) return fin("NO_SAFE_REWRITE", { no_rewrite_reason: "diagnoser_withdrew", detail: chain.withdrew }, chain.markovian);
    if (chain?.llmError) {
      return fin("NO_SAFE_REWRITE", { no_rewrite_reason: chain.llmError.unavailable ? "llm_unavailable" : "upstream", detail: chain.llmError.message }, chain.markovian);
    }
    return fin("NO_SAFE_REWRITE", { no_rewrite_reason: "attempts_exhausted", detail: attempts.map((a) => `#${a.n} ${a.verdict} ${a.reason ?? ""}`).join(", ") }, chain?.markovian);
  }
}
