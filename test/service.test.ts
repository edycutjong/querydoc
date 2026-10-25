import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmGateway } from "../src/adapters/nim.js";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import { ROOT } from "../src/config.js";
import { QueryDocService } from "../src/service.js";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const example = (n: number) => JSON.parse(read(`input_examples/example_${n}.json`));
const strip = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();

let root: string;
let svc: QueryDocService;
let engine: DuckDbEngine;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qd-svc-"));
  symlinkSync(join(ROOT, "evals"), join(root, "evals"));
  symlinkSync(join(ROOT, "fixtures"), join(root, "fixtures"));
  symlinkSync(join(ROOT, "querydoc.config.json"), join(root, "querydoc.config.json"));
  engine = await DuckDbEngine.open();
  // keyless gateway over an empty cache dir; a service never reaches the network in these tests
  svc = new QueryDocService({ root, env: { SAMPLE_MODE: "true" }, llm: new LlmGateway({ client: null, cacheDir: join(root, "llm-cache") }), engineFactory: async () => engine });
});
afterAll(async () => {
  await engine.close();
  rmSync(root, { recursive: true, force: true });
});
const run = async (body: unknown) => (await svc.run(body)) as { status: number; json: any };

describe("POST /run — validation (structured errors, nothing runs)", () => {
  it("rejects a non-object body, a missing/oversized sql, a bad run_id, a bad max_attempts and a bad playbook option", async () => {
    expect((await run(null)).status).toBe(400);
    expect((await run({ input: {} })).json.error.type).toBe("InvalidInput");
    expect((await run({ input: { sql: "x".repeat(20_001) } })).json.error.type).toBe("InvalidInput");
    expect((await run({ run_id: "../etc", input: { sql: "SELECT 1" } })).json.error.type).toBe("InvalidInput");
    expect((await run({ input: { sql: "SELECT 1" }, options: { max_attempts: 9 } })).json.error.type).toBe("InvalidOption");
    expect((await run({ input: { sql: "SELECT 1" }, options: { playbook: "everything" } })).json.error.type).toBe("InvalidOption");
    for (const r of [await run({ input: {} })]) expect(r.json.error.recoverable).toBe(true);
  });

  it("an unknown or purged run:<id> playbook is a recoverable InvalidOption, never a silent fall-back to the seed", async () => {
    const r = await run({ ...example(1), options: { sample_mode: true, playbook: "run:does-not-exist" } });
    expect(r.status).toBe(400);
    expect(r.json.error.type).toBe("InvalidOption");
    expect(r.json.error.message).toMatch(/no such earlier run/);
  });

  it("a write statement is REFUSED with a verdict (not an HTTP error) and zero attempts", async () => {
    const r = await run({ input: { sql: "DROP TABLE lake.trips" }, options: { sample_mode: true, playbook: "empty" } });
    expect(r.status).toBe(200);
    expect(r.json.verdict).toBe("REFUSED");
    expect(r.json.output.case.attempts).toEqual([]);
  });
});

describe("POST /run — keyless sample mode", () => {
  it("example_5 (LIMIT without ORDER BY) is NOT_VERIFIABLE with zero attempts and a Verifier critique line", async () => {
    const r = await run(example(5));
    expect(r.json.status).toBe("ok");
    expect(r.json.verdict).toBe("NOT_VERIFIABLE");
    expect(r.json.output.case.attempts.length).toBe(0);
    const trace = readFileSync(join(root, r.json.log_file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(trace.some((e: any) => e.agent_name === "Verifier" && e.action === "critique")).toBe(true);
  });

  it("plain SQL with no key and no cache is a `partial` 200: deterministic diagnosis + SampleModeNoLLM, with the detector's pattern", async () => {
    const r = await run(example(2));
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("partial");
    expect(r.json.error.type).toBe("SampleModeNoLLM");
    expect(r.json.output.case.diagnosis.pattern_label).toBe("outer_join_predicate");
    expect(r.json.agents.map((a: any) => a.name)).toEqual(expect.arrayContaining(["Orchestrator", "Verifier", "Diagnoser"]));
  });

  it("example_1: the tempting T1 rewrite as candidate_sql gets a real Verifier refusal with the differing row, then ends llm_unavailable", async () => {
    const r = await run(example(1));
    const c = r.json.output.case;
    expect(r.json.status).toBe("ok");
    expect(c.verdict).toBe("NO_SAFE_REWRITE");
    expect(c.no_rewrite_reason).toBe("llm_unavailable");
    expect(r.json.llm_unavailable).toBe(true);
    expect(c.attempts[0].origin).toBe("candidate_sql");
    expect(c.attempts[0].reason).toBe("ROW_DIFF");
    expect(c.attempts[0].first_diff.side).toBe("orig");
    expect(r.json.output.dossier).toContain("**Rows:** differ");
    expect(r.json.output.dossier).toContain("**Speed:** not measured — refused before timing");
  });

  it("an earlier run's refusal is reused from the ledger with options.playbook = run:<id>: same verdict, candidate not executed, no new entry", async () => {
    const first = await run({ ...example(1), run_id: "svc-first" });
    expect(first.json.run_id).toBe("svc-first");
    const second = await run({ ...example(1), run_id: "svc-second", options: { sample_mode: true, playbook: "run:svc-first" } });
    const a = second.json.output.case.attempts[0];
    expect(a.reused_from).toBe("mem-1");
    expect(a.fingerprint.rewrite).toBeNull();
    expect(a.fingerprint_kind).toBeUndefined();
    expect(a.reason).toBe("ROW_DIFF");
    expect(a.first_diff).toEqual(first.json.output.case.attempts[0].first_diff);
    expect(second.json.output.dossier).toContain("reused from the playbook ledger");
    const trace = readFileSync(join(root, second.json.log_file), "utf8");
    expect(trace).not.toContain("candidate (diff run)"); // the candidate was never executed
    expect((svc.playbook("svc-second", null).json as any).entries.length).toBe(1); // a ledger read, not a new write
  });

  it("a repeated run_id gets a server suffix and never appends to the earlier trace", async () => {
    const a = await run({ ...example(5), run_id: "svc-dup" });
    const b = await run({ ...example(5), run_id: "svc-dup" });
    expect(a.json.run_id).toBe("svc-dup");
    expect(b.json.run_id).not.toBe("svc-dup");
    expect(b.json.run_id).toMatch(/^svc-dup-[0-9a-f]{6}$/);
    expect(b.json.requested_run_id).toBe("svc-dup");
    expect(readFileSync(join(root, a.json.log_file), "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l).run_id === "svc-dup")).toBe(true);
  });

  it("the flat body form (CLI files) works and playbook defaults to the seed", async () => {
    const r = await run({ sql: strip(read("evals/queries/sample/07-nondeterministic.sql")), source: "paste", options: { sample_mode: true } });
    expect(r.json.verdict).toBe("NOT_VERIFIABLE");
  });

  it("SAMPLE_MODE unset and no Zetaris settings falls back to the sample engine with a labelled banner", async () => {
    const s = new QueryDocService({ root, env: {}, llm: new LlmGateway({ client: null, cacheDir: join(root, "llm-cache") }), engineFactory: async () => engine });
    expect(s.resolveMode(undefined).banner).toMatch(/falling back to SAMPLE_MODE/);
    const r = (await s.run(example(5))) as { json: any };
    expect(r.json.engine).toBe("duckdb");
    expect(r.json.verdict).toBe("NOT_VERIFIABLE");
  });

  it("the per-request sample_mode flag wins over credentials", () => {
    const s = new QueryDocService({ root, env: { ZETARIS_JDBC_URL: "jdbc:x", ZETARIS_JDBC_JAR: "/x.jar", ZETARIS_USER: "u", ZETARIS_PASSWORD: "p" } });
    expect(s.resolveMode(undefined).engine).toBe("zetaris");
    expect(s.resolveMode(true).engine).toBe("duckdb");
  });
});

describe("decision, playbook, runs, slow queries", () => {
  it("a verified rewrite can be approved once: patch files, a verified playbook entry with a ledger history, and a second decision is refused", async () => {
    const body = example(4);
    body.input.candidate_sql = strip(read("evals/queries/sample/01-hero.rewrite.sql"));
    body.run_id = "svc-hero";
    const r = await run(body);
    expect(r.json.output.case.attempts.every((a: any) => a.reason !== "ROW_DIFF")).toBe(true); // rows identical; the speed gate depends on the machine
    if (r.json.verdict !== "ACCEPTED") return;
    const d = svc.decide("svc-hero", { decision: "approve", actor: "edy" }) as { status: number; json: any };
    expect(d.status).toBe(200);
    expect(d.json.ledger_entries).toBeGreaterThanOrEqual(2); // create + feedback
    expect(existsSync(join(root, "data", "patches", "svc-hero.sql"))).toBe(true);
    expect(readFileSync(join(root, "data", "patches", "svc-hero.md"), "utf8")).toContain("approved by edy");
    const entries = (svc.playbook("svc-hero", null).json as any).entries;
    expect(entries.some((e: any) => e.tags.includes("outcome:verified") && e.source === "human:edy")).toBe(true);
    expect((svc.decide("svc-hero", { decision: "reject", actor: "edy" }) as any).status).toBe(409);
    expect((svc.getRun("svc-hero").json as any).case.decision.decision).toBe("approve");
  });

  it("only an accepted run can be decided on; bad actor/decision and unknown ids are structured errors", async () => {
    expect((svc.decide("svc-first", { decision: "approve", actor: "edy" }) as any).status).toBe(409);
    expect((svc.decide("svc-first", { decision: "maybe", actor: "edy" }) as any).status).toBe(400);
    expect((svc.decide("svc-first", { decision: "approve" }) as any).status).toBe(400);
    expect((svc.decide("nope", { decision: "approve", actor: "edy" }) as any).status).toBe(404);
    expect((svc.getRun("..%2f") as any).status).toBe(400);
  });

  it("GET /slow-queries lists the labelled sample pack without the rewrite files; /playbook scopes to a run", () => {
    const j = svc.slowQueries("sample").json as any;
    expect(j.source).toMatch(/sample query pack/);
    expect(j.items.map((i: any) => i.id)).toContain("03-trap-left-join");
    expect(j.items.some((i: any) => /rewrite/.test(i.id))).toBe(false);
    expect((svc.playbook("svc-never-ran", null).json as any).entries).toEqual([]);
  });

  it("GET /health reports the engine and whether a model key is configured", async () => {
    const h = (await svc.health()).json as any;
    expect(h.status).toBe("ok");
    expect(h.engine.name).toBe("duckdb");
    expect(h.nim.configured).toBe(false);
  });
});

describe("service robustness", () => {
  it("a missing playbook seed is a structured SeedMissing error, never a silent empty store", async () => {
    const bare = mkdtempSync(join(tmpdir(), "qd-bare-"));
    symlinkSync(join(ROOT, "querydoc.config.json"), join(bare, "querydoc.config.json"));
    const s = new QueryDocService({ root: bare, env: { SAMPLE_MODE: "true" }, llm: new LlmGateway({ client: null, cacheDir: join(bare, "llm-cache") }), engineFactory: async () => engine });
    const r = (await s.run({ ...example(3), options: { sample_mode: true, playbook: "seed" } })) as { status: number; json: any };
    expect(r.status).toBe(500);
    expect(r.json.error.type).toBe("SeedMissing");
    expect(((await s.health()).json as any).playbook_seed).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });

  it("a refused run:<id> request leaves no run directory behind, so the id stays free", async () => {
    const r = await run({ ...example(5), run_id: "svc-refused", options: { sample_mode: true, playbook: "run:nothing-here" } });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "data", "runs", "svc-refused"))).toBe(false);
    const ok = await run({ ...example(5), run_id: "svc-refused" });
    expect(ok.json.run_id).toBe("svc-refused");
  });

  it("concurrent requests are served one at a time and each gets its own run", async () => {
    const [a, b, c] = await Promise.all([run({ ...example(5), run_id: "svc-par-1" }), run({ ...example(5), run_id: "svc-par-2" }), run({ ...example(5), run_id: "svc-par-3" })]);
    expect([a.json.run_id, b.json.run_id, c.json.run_id]).toEqual(["svc-par-1", "svc-par-2", "svc-par-3"]);
    expect([a, b, c].every((r) => r.json.verdict === "NOT_VERIFIABLE")).toBe(true);
  });
});
