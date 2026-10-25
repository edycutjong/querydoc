import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmGateway } from "../src/adapters/nim.js";
import { ROOT } from "../src/config.js";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import { QueryDocService } from "../src/service.js";

// Keyless replay parity (architecture §SAMPLE_MODE): every shipped example runs on DuckDB with no key, outbound network stubbed to
// throw, from the committed llm-cache and playbook seed. Candidate-origin examples (2, 3) end after attempt 1 with llm_unavailable,
// example_3's attempt 1 reused from the ledger without executing the candidate; the others replay the canonical attempts and end in
// the explicit allowed set recorded in output_examples/expected.json. Every trace has a Verifier critique line.

const EXAMPLES = [1, 2, 3, 4, 5, 6];
const example = (n: number) => JSON.parse(readFileSync(join(ROOT, `input_examples/example_${n}.json`), "utf8"));
const expected = JSON.parse(readFileSync(join(ROOT, "output_examples/expected.json"), "utf8")) as Record<string, { canonical: string; allowed: string[] }>;
const key = (j: { verdict: string; no_rewrite_reason?: string }) => `${j.verdict}${j.no_rewrite_reason ? "/" + j.no_rewrite_reason : ""}`;

let root: string;
let engine: DuckDbEngine;
const make = (env: NodeJS.ProcessEnv, factory?: (m: "duckdb" | "zetaris") => Promise<DuckDbEngine>) =>
  new QueryDocService({ root, env, llm: new LlmGateway({ client: null, cacheDir: join(root, "llm-cache") }), engineFactory: factory ?? (async () => engine) });
const traceOf = (svc: { root: string }, j: any) => readFileSync(join(svc.root, j.log_file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as { agent_name: string; action: string; output_summary: string; input_summary: string }[];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qd-replay-"));
  for (const f of ["evals", "querydoc.config.json", "llm-cache", "fixtures"]) if (existsSync(join(ROOT, f))) symlinkSync(join(ROOT, f), join(root, f));
  engine = await DuckDbEngine.open();
  vi.stubGlobal("fetch", () => {
    throw new Error("outbound network is stubbed in the offline replay");
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("keyless replay parity", () => {
  it("the recorded expectations cover every shipped example", () => {
    expect(Object.keys(expected).sort()).toEqual(EXAMPLES.map((n) => `example_${n}`));
    expect(existsSync(join(ROOT, "llm-cache"))).toBe(true);
    expect(existsSync(join(ROOT, "fixtures/hmem-seed/sample/state.json"))).toBe(true);
  });

  for (const n of EXAMPLES) {
    it(`example_${n} runs keyless, offline, twice, inside its allowed verdict set; its trace carries a Verifier critique and ≥2 named agents when it reaches an attempt`, async () => {
      const svc = make({ SAMPLE_MODE: "true" });
      for (const round of [1, 2]) {
        const r = (await svc.run({ ...example(n), run_id: `rp-${n}-${round}` })) as { status: number; json: any };
        expect(r.status).toBe(200);
        expect(expected[`example_${n}`]!.allowed).toContain(key(r.json));
        expect(r.json.engine).toBe("duckdb");
        const trace = traceOf(svc, r.json);
        expect(trace.some((e) => e.agent_name === "Verifier" && e.action === "critique")).toBe(true);
        const reachedAttempt = r.json.output.case.attempts.length > 0;
        const named = new Set(trace.map((e) => e.agent_name).filter((a) => a !== "Orchestrator"));
        if (reachedAttempt) expect(named.size).toBeGreaterThanOrEqual(2);
        else expect(named.has("Verifier")).toBe(true); // example_5 stops at the pre-check by design
      }
    });
  }

  it("example_2: the supplied rewrite is refused by the Verifier, then NO_SAFE_REWRITE with llm_unavailable and the refusal in the dossier", async () => {
    const r = (await make({ SAMPLE_MODE: "true" }).run(example(2))) as { json: any };
    expect(key(r.json)).toBe("NO_SAFE_REWRITE/llm_unavailable");
    expect(r.json.llm_unavailable).toBe(true);
    expect(r.json.output.case.attempts).toHaveLength(1);
    expect(r.json.output.case.attempts[0]).toMatchObject({ origin: "candidate_sql", verdict: "REJECT", reason: "ROW_DIFF" });
    expect(r.json.output.dossier).toMatch(/\*\*Rows:\*\* differ/);
  });

  it("example_3 reuses the refusal from the ledger without executing the candidate", async () => {
    const svc = make({ SAMPLE_MODE: "true" });
    const r = (await svc.run(example(3))) as { json: any };
    const a = r.json.output.case.attempts[0];
    expect(key(r.json)).toBe("NO_SAFE_REWRITE/llm_unavailable");
    expect(r.json.output.case.attempts).toHaveLength(1);
    expect(a.reused_from).toBeTruthy();
    expect(a.fingerprint.rewrite).toBeNull();
    expect(a.first_diff).toBeTruthy();
    expect(traceOf(svc, r.json).some((e) => /candidate \(diff run\)|candidate COUNT/.test(e.input_summary))).toBe(false);
    expect(r.json.output.case.playbook_hits).toContain(a.reused_from);
  });

  it("example_1 without a key and with the cache is not an error: a verdict envelope (ok or partial), never a 5xx", async () => {
    const r = (await make({ SAMPLE_MODE: "true" }).run(example(1))) as { status: number; json: any };
    expect(r.status).toBe(200);
    expect(["ok", "partial"]).toContain(r.json.status);
  });

  it("examples 1-3 with a fully populated environment still run on DuckDB (options.sample_mode wins over credentials)", async () => {
    const full = { ZETARIS_JDBC_URL: "jdbc:x", ZETARIS_JDBC_JAR: "/x.jar", ZETARIS_USER: "u", ZETARIS_PASSWORD: "p" };
    const svc = make(full, async (m) => {
      if (m !== "duckdb") throw new Error(`the ${m} engine must not be opened for a sample_mode request`);
      return engine;
    });
    for (const n of [1, 2, 3]) {
      const r = (await svc.run(example(n))) as { json: any };
      expect(r.json.engine).toBe("duckdb");
      expect(r.json.banner).toBeUndefined();
    }
  });

  it("no code maps an input to a stored answer: a different query with the same pattern is diagnosed live-in-code, not looked up", async () => {
    const svc = make({ SAMPLE_MODE: "true" });
    const body = { input: { sql: "SELECT z.LocationID, COUNT(t.PULocationID) AS n FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 1 GROUP BY z.LocationID ORDER BY z.LocationID", source: "paste" }, options: { sample_mode: true, playbook: "empty" } };
    const r = (await svc.run(body)) as { json: any };
    expect(r.json.output.case.diagnosis.pattern_label).toBe("outer_join_predicate");
    expect(r.json.output.case.precheck.rows).toBe(265);
    expect(r.json.status).toBe("partial"); // no cache entry for a new query and no key: the deterministic stages ran, the model stages did not
  });
});
