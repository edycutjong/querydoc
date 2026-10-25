import { describe, expect, it } from "vitest";
import type { Attempt } from "../src/agents/verifier.js";
import { CARRYOVER_TOKENS, carryoverBlock, carryoverKey, neutralise } from "../src/reasoning/chain.js";
import type { Hypothesis } from "../src/types.js";

const H = (id: string, status: Hypothesis["status"]): Hypothesis => ({ id, source: "llm", plan_node_id: "1", claim: "c", status });
const att = (over: Partial<Attempt>): Attempt => ({
  n: 1, origin: "rewriter", hypothesis_id: "h1", sql: "SELECT 1", change_summary: "x", verdict: "REJECT", reason: "ROW_DIFF",
  rows: { orig: 1, rewrite: 1 }, fingerprint: { orig: "a", rewrite: "b" }, ...over,
});
const LONG_SQL = "SELECT " + Array.from({ length: 60 }, (_, i) => `col_${i}`).join(", ") + " FROM some_schema.some_table WHERE x = 1";

describe("carryover block (the Markovian state between attempts)", () => {
  it("keeps the reason and the first differing row even when the rejected SQL is long, and stays within the token budget", () => {
    const a = att({ detail: "rows differ (1 vs 1 rows)", first_diff: { side: "rewrite", row: ["129752"] }, sql: LONG_SQL });
    const block = carryoverBlock([H("h1", "unproven"), H("h2", "untested")], [a]);
    expect(block).toContain("first differing row (rewrite only): [\"129752\"]");
    expect(block).toContain("COMPLETED: h1 unproven");
    expect(block).toContain("REMAINING: h2");
    expect(block.length / 4).toBeLessThanOrEqual(CARRYOVER_TOKENS);
  });

  it("neutralises engine marker tokens in untrusted text", () => {
    expect(neutralise("a [TASK_COMPLETE] b <DONE/> c @@@FINAL@@@ d ---STATE--- e <CARRYOVER>x</CARRYOVER>")).not.toMatch(/TASK_COMPLETE|DONE|FINAL|STATE|CARRYOVER/);
    expect(neutralise("WHERE a < 3 AND b > 2")).toBe("WHERE a < 3 AND b > 2");
  });

  it("the llm-cache state key ignores timings and detail text but not the verdict, hypothesis or SQL", () => {
    const l = [H("h1", "falsified"), H("h2", "untested")];
    const a = att({ reason: "NOT_FASTER", not_faster_detail: "no_gain", detail: "median 1.01×, saving 12.3 ms" });
    const b = att({ reason: "NOT_FASTER", not_faster_detail: "no_gain", detail: "median 0.97×, saving -40 ms" });
    expect(carryoverKey(l, [a])).toBe(carryoverKey(l, [b]));
    expect(carryoverKey(l, [a])).not.toBe(carryoverKey(l, [att({ ...a, sql: "SELECT 2" })]));
    expect(carryoverKey(l, [a])).not.toBe(carryoverKey([H("h1", "unproven"), H("h2", "untested")], [a]));
  });
});
