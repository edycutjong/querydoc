import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmGateway, NimClient } from "../src/adapters/nim.js";
import type { VerifierConfig } from "../src/config.js";
import { runCase } from "../src/orchestrator.js";
import { CARRYOVER_TOKENS } from "../src/reasoning/chain.js";
import { caseMarkdown } from "../src/report/markdown.js";
import { StubEngine, type StubQuery } from "./helpers/stubEngine.js";

const cfg: VerifierConfig = {
  speedupMin: 1.2, noGainSpeedup: 1.05, noiseFloorMs: 50, minPairs: 3, maxPairs: 5, rowCap: 100, floatSigDigits: 9, timingCapMinMs: 150_000, dialect: "hive",
};
const N = [{ name: "n", type: "bigint" }];
const ORIG = "SELECT COUNT(1) AS n FROM f LEFT JOIN d ON f.k = d.k";
const WRONG = "SELECT COUNT(1) AS n FROM f WHERE f.k IS NOT NULL";
const RIGHT = "SELECT COUNT(1) AS n FROM f";
const SLOW = "SELECT COUNT(1) AS n FROM f WHERE 1 = 1";
const queries: Record<string, StubQuery> = {
  [ORIG]: { columns: N, rows: [[10]], wallMs: 1000 },
  [WRONG]: { columns: N, rows: [[9]], wallMs: 300 },
  [RIGHT]: { columns: N, rows: [[10]], wallMs: 400 },
  [SLOW]: { columns: N, rows: [[10]], wallMs: 990 },
  "SELECT COUNT(*) AS n, COUNT(k) AS nn, COUNT(DISTINCT k) AS d FROM d": { columns: [{ name: "n", type: "bigint" }, { name: "nn", type: "bigint" }, { name: "d", type: "bigint" }], rows: [[5, 5, 5]], wallMs: 3 },
};

// A scripted "model": the n-th Rewriter call returns the n-th SQL; Diagnoser returns two hypotheses, one citing a node that does not exist.
function fakeLlm(rewrites: string[]) {
  const prompts: { task: string; user: string }[] = [];
  let r = 0;
  const fetchFn = (async (_u: unknown, init: RequestInit) => {
    const msgs = JSON.parse(init.body as string).messages as { content: string }[];
    const user = msgs[1]!.content;
    const isRewrite = msgs[0]!.content.startsWith("You rewrite");
    prompts.push({ task: isRewrite ? "rewrite" : "diagnose", user });
    const content = isRewrite
      ? JSON.stringify({ hypothesis_id: /TARGET HYPOTHESIS (h\d+)/.exec(user)![1], sql: rewrites[Math.min(r++, rewrites.length - 1)], change_summary: "drop the unused join", risk_notes: "" })
      : JSON.stringify({ bottleneck: "The LEFT JOIN to d is never read.", hypotheses: [{ plan_node_id: "99", claim: "hallucinated node citation that must be dropped" }] });
    return new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: "…" }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  return { prompts, llm: new LlmGateway({ client: new NimClient("k", { fetchFn }), cacheDir: mkdtempSync(join(tmpdir(), "qd-")) }) };
}
const deps = (llm: LlmGateway) => ({ engine: new StubEngine(queries), cfg, llm, attemptCap: 3, logDir: mkdtempSync(join(tmpdir(), "qd-log-")) });

describe("runCase — Diagnoser → Rewriter → Verifier end to end (stub engine, scripted model)", () => {
  it("retries after a ROW_DIFF with the rejection in the carryover and ends ACCEPTED", async () => {
    const { llm, prompts } = fakeLlm([WRONG, RIGHT]);
    const { case: c, trace, chain } = await runCase({ sql: ORIG }, deps(llm), { runId: "t1" });
    expect(c.verdict).toBe("ACCEPTED");
    expect(c.attempts.map((a) => [a.n, a.verdict, a.reason ?? null])).toEqual([[1, "REJECT", "ROW_DIFF"], [2, "ACCEPT", null]]);
    expect(c.attempts[1]).toMatchObject({ origin: "rewriter", hypothesis_id: "h1" });
    expect(c.diagnosis?.pattern_label).toBe("unused_outer_join");
    expect(c.diagnosis?.narrative).toBe("llm");
    expect(c.diagnosis?.raw_refs).toEqual(["dropped hypothesis citing unknown plan node 99"]);
    expect(c.diagnosis?.hypotheses.map((h) => [h.id, h.status])).toEqual([["h1", "confirmed"]]);

    // the second Rewriter prompt carries the first rejection through the Markovian carryover
    const rw = prompts.filter((p) => p.task === "rewrite");
    expect(rw[0]!.user).toContain("This is the first attempt.");
    expect(rw[1]!.user).toContain("CARRYOVER STATE FROM EARLIER ATTEMPTS");
    expect(rw[1]!.user).toMatch(/attempt 1 on h1 rejected ROW_DIFF/);
    expect(rw[1]!.user).toContain("first differing row");
    expect(rw[1]!.user).toContain("MEASURED KEY FACTS:\nd.k: 5 rows, 5 non-NULL, 5 distinct → UNIQUE");
    expect(chain?.chunks).toBe(2);
    expect(chain?.carryovers.every((b) => b.length / 4 <= CARRYOVER_TOKENS)).toBe(true);

    // Hub gate: >= 2 named agents doing distinct things + >= 1 critique/retry event
    const byAgent = new Set(trace.events.map((e) => e.agent_name));
    expect([...byAgent].sort()).toEqual(["Diagnoser", "Orchestrator", "Rewriter", "Verifier"]);
    expect(trace.events.some((e) => e.agent_name === "Rewriter" && e.action === "retry" && e.retry_count === 1)).toBe(true);
    const crit = trace.events.filter((e) => e.action === "critique");
    expect(crit.some((e) => e.status !== "approved" && e.target_agent === "Rewriter")).toBe(true);
    expect(trace.events.every((e) => e.run_id === "t1" && !!e.timestamp)).toBe(true);
    expect(caseMarkdown(c)).toContain("Attempt 1 — REJECT (ROW_DIFF)");
  });

  it("ends NO_SAFE_REWRITE (attempts_exhausted) when every attempt is refused by the Verifier, and stops at the cap", async () => {
    const { llm } = fakeLlm([WRONG]);
    const { case: c, trace } = await runCase({ sql: ORIG }, deps(llm), { runId: "t2" });
    expect(c.verdict).toBe("NO_SAFE_REWRITE");
    expect(c.no_rewrite_reason).toBe("attempts_exhausted");
    expect(c.attempts.map((a) => a.verdict)).toEqual(["REJECT", "REJECT", "REJECT"]);
    expect(trace.events.filter((e) => e.agent_name === "Verifier" && e.action === "critique" && e.target_agent === "Orchestrator").length).toBeGreaterThan(0);
  });

  it("moves on to the next hypothesis after NOT_FASTER (falsified) and never repeats the same SQL role", async () => {
    const { llm } = fakeLlm([SLOW, RIGHT]);
    const { case: c } = await runCase({ sql: ORIG }, deps(llm), { runId: "t3" });
    expect(c.attempts.map((a) => [a.verdict, a.reason ?? null, a.not_faster_detail ?? null])).toEqual([["REJECT", "NOT_FASTER", "no_gain"], ["ACCEPT", null, null]]);
    expect(c.diagnosis?.hypotheses[0]).toMatchObject({ id: "h1", status: "confirmed" });
  });

  it("verifies a supplied candidate_sql without calling the Rewriter", async () => {
    const { llm, prompts } = fakeLlm([WRONG]);
    const { case: c } = await runCase({ sql: ORIG, candidate_sql: RIGHT }, deps(llm), { runId: "t4" });
    expect(c.verdict).toBe("ACCEPTED");
    expect(c.attempts[0]).toMatchObject({ origin: "candidate_sql", hypothesis_id: null });
    expect(prompts.filter((p) => p.task === "rewrite")).toHaveLength(0);
  });

  it("keyless with no cache: the detector still diagnoses, the Rewriter is unavailable → NO_SAFE_REWRITE llm_unavailable", async () => {
    const llm = new LlmGateway({ client: null, cacheDir: mkdtempSync(join(tmpdir(), "qd-")) });
    const { case: c, trace } = await runCase({ sql: ORIG }, deps(llm), { runId: "t5" });
    expect(c.verdict).toBe("NO_SAFE_REWRITE");
    expect(c.no_rewrite_reason).toBe("llm_unavailable");
    expect(c.diagnosis).toMatchObject({ pattern_label: "unused_outer_join", narrative: "omitted" });
    expect(c.attempts).toEqual([]);
    expect(trace.events.find((e) => e.agent_name === "Rewriter")?.status).toBe("skipped");
  });

  it("REFUSES a write statement before anything runs and ERRORs on an unknown query", async () => {
    const { llm } = fakeLlm([RIGHT]);
    const d = deps(llm);
    const refused = await runCase({ sql: "DROP TABLE f" }, d, { runId: "t6" });
    expect(refused.case.verdict).toBe("REFUSED");
    expect(d.engine.calls).toEqual([]);
    const err = await runCase({ sql: "SELECT 1 FROM nowhere" }, d, { runId: "t7" });
    expect(err.case.verdict).toBe("ERROR");
    expect(err.case.attempts).toEqual([]);
  });
});
