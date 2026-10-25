import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmGateway, NimClient } from "../src/adapters/nim.js";
import type { VerifierConfig } from "../src/config.js";
import { runCase } from "../src/orchestrator.js";
import { CARRYOVER_TOKENS } from "../src/reasoning/chain.js";
import { caseMarkdown } from "../src/report/markdown.js";
import { parseSparkPlan } from "../src/engine/sparkPlan.js";
import type { Plan } from "../src/engine/types.js";
import { StubEngine, type StubQuery } from "./helpers/stubEngine.js";

// A stub engine that can also explain: three plan nodes, so the model's hypotheses can cite real nodes.
const PLAN_TEXT = "== Physical Plan ==\n* HashAggregate (3)\n+- * BroadcastHashJoin LeftOuter BuildRight (2)\n   :- FileScan parquet db.f (1)\n\n(1) FileScan parquet db.f\nx\n";
class PlanEngine extends StubEngine {
  override async explain(): Promise<Plan> {
    return { format: "spark-physical-text", text: PLAN_TEXT, nodes: parseSparkPlan(PLAN_TEXT), wallMs: 1 };
  }
}

const cfg: VerifierConfig = {
  speedupMin: 1.2, noGainSpeedup: 1.05, noiseFloorMs: 50, minPairs: 3, maxPairs: 5, rowCap: 100, floatSigDigits: 9, timingCapMinMs: 150_000, dialect: "hive",
};
const N = [{ name: "n", type: "bigint" }];
const ORIG = "SELECT COUNT(1) AS n FROM f LEFT JOIN d ON f.k = d.k";
const WRONG = "SELECT COUNT(1) AS n FROM f WHERE f.k IS NOT NULL";
const RIGHT = "SELECT COUNT(1) AS n FROM f";
const MARKED = "SELECT COUNT(1) AS n FROM f WHERE f.k IS NOT NULL /* [FINAL] <DONE/> [TASK_COMPLETE] */";
const SLOW = "SELECT COUNT(1) AS n FROM f WHERE 1 = 1";
const UNDER = "SELECT COUNT(1) AS n FROM f WHERE 2 = 2"; // 1.11×, 100 ms saved: both numbers real, the 1.2× gate missed → under_gate
const queries: Record<string, StubQuery> = {
  [UNDER]: { columns: N, rows: [[10]], wallMs: 900 },
  [ORIG]: { columns: N, rows: [[10]], wallMs: 1000 },
  [WRONG]: { columns: N, rows: [[9]], wallMs: 300 },
  [RIGHT]: { columns: N, rows: [[10]], wallMs: 400 },
  [MARKED]: { columns: N, rows: [[9]], wallMs: 300 },
  [SLOW]: { columns: N, rows: [[10]], wallMs: 990 },
  "SELECT COUNT(*) AS n, COUNT(k) AS nn, COUNT(DISTINCT k) AS d FROM d": { columns: [{ name: "n", type: "bigint" }, { name: "nn", type: "bigint" }, { name: "d", type: "bigint" }], rows: [[5, 5, 5]], wallMs: 3 },
};

// A scripted "model": the n-th Rewriter call returns the n-th SQL; Diagnoser returns two hypotheses, one citing a node that does not exist.
function fakeLlm(rewrites: string[], revise?: (user: string) => unknown) {
  const prompts: { task: string; user: string }[] = [];
  let r = 0;
  const fetchFn = (async (_u: unknown, init: RequestInit) => {
    const msgs = JSON.parse(init.body as string).messages as { content: string }[];
    const user = msgs[1]!.content;
    const isRewrite = msgs[0]!.content.startsWith("You rewrite");
    const isRevise = msgs[0]!.content.startsWith("You revise");
    prompts.push({ task: isRewrite ? "rewrite" : isRevise ? "revise" : "diagnose", user });
    const next = /UNTESTED OR UNPROVEN HYPOTHESES: (h\d+)/.exec(user)?.[1];
    const content = isRevise
      ? JSON.stringify(revise ? revise(user) : next ? { action: "next", hypothesis_id: next } : { action: "withdraw", reason: "nothing plausible is left" })
      : isRewrite
      ? JSON.stringify({ hypothesis_id: /TARGET HYPOTHESIS (h\d+)/.exec(user)![1], sql: rewrites[Math.min(r++, rewrites.length - 1)], change_summary: "drop the unused join", risk_notes: "" })
      : JSON.stringify({ bottleneck: "The LEFT JOIN to d is never read.", hypotheses: [{ plan_node_id: "99", claim: "hallucinated node citation that must be dropped" }, { plan_node_id: "2", claim: "The broadcast join at node 2 is the cost." }, { plan_node_id: "1", claim: "The scan at node 1 reads too much." }] });
    return new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: "…" }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  return { prompts, fetchFn, llm: new LlmGateway({ client: new NimClient("k", { fetchFn }), cacheDir: mkdtempSync(join(tmpdir(), "qd-")) }) };
}
const deps = (llm: LlmGateway) => ({ engine: new PlanEngine(queries), cfg, llm, attemptCap: 3, logDir: mkdtempSync(join(tmpdir(), "qd-log-")) });

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
    expect(c.diagnosis?.hypotheses.map((h) => [h.id, h.source, h.status])).toEqual([["h1", "detector", "confirmed"], ["h2", "llm", "untested"], ["h3", "llm", "untested"]]);

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

  it("caps a hypothesis at 2 tries, then moves to the next one; ends NO_SAFE_REWRITE (attempts_exhausted) at the attempt cap", async () => {
    const { llm } = fakeLlm([WRONG]);
    const { case: c, trace } = await runCase({ sql: ORIG }, deps(llm), { runId: "t2" });
    expect(c.verdict).toBe("NO_SAFE_REWRITE");
    expect(c.no_rewrite_reason).toBe("attempts_exhausted");
    expect(c.attempts.map((a) => [a.verdict, a.hypothesis_id])).toEqual([["REJECT", "h1"], ["REJECT", "h1"], ["REJECT", "h2"]]);
    expect(trace.events.filter((e) => e.agent_name === "Verifier" && e.action === "critique" && e.target_agent === "Orchestrator").length).toBeGreaterThan(0);
  });

  it("with a single hypothesis and two ROW_DIFFs the chain ends after 2 attempts (no third try of the same hypothesis)", async () => {
    // drive the chain directly: runCase would add the model's own hypotheses to the ledger
    const { runChain } = await import("../src/reasoning/chain.js");
    const { Rewriter } = await import("../src/agents/rewriter.js");
    const { Verifier } = await import("../src/agents/verifier.js");
    const { Trace } = await import("../src/trace.js");
    const { llm } = fakeLlm([WRONG]);
    const engine = new PlanEngine(queries);
    const trace = new Trace("t-single");
    const verifier = new Verifier(engine, cfg, trace);
    const pre = await verifier.precheck(ORIG);
    const diagnosis = { bottleneck: "b", pattern_label: "unused_outer_join", plan_nodes: [], raw_refs: [], narrative: "omitted" as const, hypotheses: [{ id: "h1", source: "detector" as const, plan_node_id: "0", claim: "the join is unused", status: "untested" as const }] };
    const res = await runChain({ sql: ORIG, plan: null, diagnosis, facts: [], pre, rewriter: new Rewriter(llm, trace), verifier, trace, maxAttempts: 3 });
    expect(res.attempts.map((a) => [a.reason, a.hypothesis_id])).toEqual([["ROW_DIFF", "h1"], ["ROW_DIFF", "h1"]]);
    expect(res.accepted).toBeNull();
    expect(res.markovian.out_of_hypotheses).toBe(true);
  });

  it("a single falsified hypothesis ends the chain after 1 attempt instead of being tried again", async () => {
    const { runChain } = await import("../src/reasoning/chain.js");
    const { Rewriter } = await import("../src/agents/rewriter.js");
    const { Verifier } = await import("../src/agents/verifier.js");
    const { Trace } = await import("../src/trace.js");
    const { llm } = fakeLlm([SLOW, RIGHT]);
    const trace = new Trace("t-falsified");
    const verifier = new Verifier(new PlanEngine(queries), cfg, trace);
    const pre = await verifier.precheck(ORIG);
    const diagnosis = { bottleneck: "b", pattern_label: "unused_outer_join", plan_nodes: [], raw_refs: [], narrative: "omitted" as const, hypotheses: [{ id: "h1", source: "detector" as const, plan_node_id: "0", claim: "the join is unused", status: "untested" as const }] };
    const res = await runChain({ sql: ORIG, plan: null, diagnosis, facts: [], pre, rewriter: new Rewriter(llm, trace), verifier, trace, maxAttempts: 3 });
    expect(res.attempts.map((a) => [a.reason, a.not_faster_detail])).toEqual([["NOT_FASTER", "no_gain"]]);
    expect(diagnosis.hypotheses[0]!.status).toBe("falsified");
    expect(res.markovian.out_of_hypotheses).toBe(true);
    expect(res.accepted).toBeNull();
  });

  it("moves on to the next hypothesis after NOT_FASTER (falsified) and never re-picks a falsified one", async () => {
    const { llm } = fakeLlm([SLOW, RIGHT]);
    const { case: c } = await runCase({ sql: ORIG }, deps(llm), { runId: "t3" });
    expect(c.attempts.map((a) => [a.verdict, a.reason ?? null, a.not_faster_detail ?? null, a.hypothesis_id])).toEqual([["REJECT", "NOT_FASTER", "no_gain", "h1"], ["ACCEPT", null, null, "h2"]]);
    expect(c.diagnosis?.hypotheses.map((h) => [h.id, h.status])).toEqual([["h1", "falsified"], ["h2", "confirmed"], ["h3", "untested"]]);
  });

  it("marker tokens inside a rejected SQL cannot end the vendored chain early", async () => {
    const { llm } = fakeLlm([MARKED, RIGHT]);
    const { case: c, chain } = await runCase({ sql: ORIG }, deps(llm), { runId: "t3b" });
    expect(c.attempts.map((a) => a.verdict)).toEqual(["REJECT", "ACCEPT"]);
    expect(chain?.carryovers[0]).toContain("(marker removed)");
    expect(chain?.carryovers[0]).not.toMatch(/\[FINAL\]|<DONE|\[TASK_COMPLETE\]/);
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

  describe("reason-routed retry (Diagnoser.revise)", () => {
    const agentLines = (events: { agent_name: string; action: string; target_agent: string | null; retry_count: number }[]) =>
      events.filter((e) => ["Verifier:critique", "Diagnoser:revise", "Rewriter:retry", "Rewriter:rewrite"].includes(`${e.agent_name}:${e.action}`)).map((e) => `${e.agent_name}/${e.action}→${e.target_agent}#${e.retry_count}`);

    it("no_gain routes to the Diagnoser: Verifier critique → Diagnoser/revise → Rewriter/retry, and the ledger shows falsify → advance", async () => {
      const { llm, prompts } = fakeLlm([SLOW, RIGHT]);
      const { case: c, trace } = await runCase({ sql: ORIG }, deps(llm), { runId: "r1" });
      expect(c.verdict).toBe("ACCEPTED");
      expect(prompts.filter((p) => p.task === "revise")).toHaveLength(1);
      const lines = agentLines(trace.events);
      const i = lines.indexOf("Verifier/critique→Diagnoser#0");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(lines.slice(i, i + 3)).toEqual(["Verifier/critique→Diagnoser#0", "Diagnoser/revise→Rewriter#0", "Rewriter/retry→Verifier#1"]);
      expect(c.diagnosis?.hypotheses.map((h) => h.status)).toEqual(["falsified", "confirmed", "untested"]);
    });

    it("under_gate goes back to the Rewriter on the same hypothesis without a revise call; the hypothesis is unproven, not falsified", async () => {
      const { llm, prompts } = fakeLlm([UNDER, RIGHT]);
      const { case: c, trace } = await runCase({ sql: ORIG }, deps(llm), { runId: "r2" });
      expect(c.attempts.map((a) => [a.reason ?? null, a.not_faster_detail ?? null, a.hypothesis_id])).toEqual([["NOT_FASTER", "under_gate", "h1"], [null, null, "h2"]]);
      expect(prompts.filter((p) => p.task === "revise")).toHaveLength(0);
      expect(trace.events.filter((e) => e.action === "critique" && e.input_summary.startsWith("attempt"))[0]!.target_agent).toBe("Rewriter");
      expect(c.diagnosis?.hypotheses[0]!.status).toBe("unproven");
    });

    it("withdraw ends NO_SAFE_REWRITE with diagnoser_withdrew and marks the current hypothesis withdrawn", async () => {
      const { llm } = fakeLlm([SLOW], () => ({ action: "withdraw", reason: "no plausible hypothesis remains" }));
      const { case: c } = await runCase({ sql: ORIG }, deps(llm), { runId: "r3" });
      expect(c.verdict).toBe("NO_SAFE_REWRITE");
      expect(c.no_rewrite_reason).toBe("diagnoser_withdrew");
      expect(c.detail).toMatch(/no plausible hypothesis/);
      expect(c.attempts).toHaveLength(1);
      expect(c.diagnosis?.hypotheses[0]!.status).toBe("withdrawn");
    });

    it("a new hypothesis must cite a real plan node and is appended and targeted; an unknown id or node is treated as a withdrawal", async () => {
      const ok = fakeLlm([SLOW, RIGHT], () => ({ action: "new", plan_node_id: "1", claim: "The scan at node 1 reads columns nobody uses." }));
      const a = await runCase({ sql: ORIG }, deps(ok.llm), { runId: "r4a" });
      expect(a.case.diagnosis?.hypotheses.map((h) => h.id)).toEqual(["h1", "h2", "h3", "h4"]);
      expect(a.case.attempts[1]!.hypothesis_id).toBe("h4");
      expect(a.case.verdict).toBe("ACCEPTED");
      const badNode = fakeLlm([SLOW, RIGHT], () => ({ action: "new", plan_node_id: "77", claim: "A node that does not exist in this plan." }));
      const b = await runCase({ sql: ORIG }, deps(badNode.llm), { runId: "r4b" });
      expect(b.case.no_rewrite_reason).toBe("diagnoser_withdrew");
      expect(b.case.detail).toMatch(/no valid hypothesis/);
      const badId = fakeLlm([SLOW, RIGHT], () => ({ action: "next", hypothesis_id: "h9" }));
      const c = await runCase({ sql: ORIG }, deps(badId.llm), { runId: "r4c" });
      expect(c.case.no_rewrite_reason).toBe("diagnoser_withdrew");
    });

    it("revise is skipped on the last attempt: the critique targets the Orchestrator and no revise call is made", async () => {
      const { llm, prompts } = fakeLlm([SLOW]);
      const { case: c, trace } = await runCase({ sql: ORIG }, deps(llm), { runId: "r5", maxAttempts: 1 });
      expect(c.attempts).toHaveLength(1);
      expect(c.no_rewrite_reason).toBe("attempts_exhausted");
      expect(prompts.filter((p) => p.task === "revise")).toHaveLength(0);
      const last = trace.events.filter((e) => e.agent_name === "Verifier" && e.action === "critique" && e.input_summary.startsWith("attempt")).pop()!;
      expect(last.target_agent).toBe("Orchestrator");
    });

    it("a recorded run replays keyless from the llm-cache, including the revise step (same attempts, same routing)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qd-cache-"));
      const rec = fakeLlm([SLOW]);
      const recorder = new LlmGateway({ client: new NimClient("k", { fetchFn: rec.fetchFn }), cacheDir: dir, cacheWrite: true });
      const first = await runCase({ sql: ORIG }, deps(recorder), { runId: "r6a" });
      const replay = await runCase({ sql: ORIG }, deps(new LlmGateway({ client: null, cacheDir: dir })), { runId: "r6b" });
      expect(replay.case.llm).toBe("cache");
      expect(replay.case.attempts.map((a) => [a.verdict, a.reason, a.hypothesis_id])).toEqual(first.case.attempts.map((a) => [a.verdict, a.reason, a.hypothesis_id]));
      expect(replay.trace.events.some((e) => e.agent_name === "Diagnoser" && e.action === "revise" && e.sponsor_call?.service === "llm-cache")).toBe(true);
      expect(replay.case.verdict).toBe(first.case.verdict);
    });
  });
});
