import { describe, expect, it } from "vitest";
import { Verifier } from "../src/agents/verifier.js";
import type { VerifierConfig } from "../src/config.js";
import type { Cell, Column } from "../src/engine/types.js";
import { Trace } from "../src/trace.js";
import { StubEngine, type StubQuery } from "./helpers/stubEngine.js";

const cfg: VerifierConfig = {
  speedupMin: 1.2, noGainSpeedup: 1.05, noiseFloorMs: 50, minPairs: 3, maxPairs: 5, rowCap: 100, floatSigDigits: 9,
  timingCapMinMs: 150_000, dialect: "hive",
};
const K: Column[] = [{ name: "k", type: "bigint" }];
const range = (n: number, f: (i: number) => Cell[] = (i) => [i]) => Array.from({ length: n }, (_, i) => f(i));

function setup(queries: Record<string, StubQuery>, reportsTruncation = true, silentLimit = Infinity) {
  const engine = new StubEngine(queries, reportsTruncation, silentLimit);
  const trace = new Trace("test");
  return { engine, trace, v: new Verifier(engine, cfg, trace) };
}
const attempt = (sql: string) => ({ n: 1, origin: "candidate_sql" as const, hypothesis_id: null, sql, change_summary: "test" });
const critiques = (t: Trace) => t.events.filter((e) => e.action === "critique");

describe("Verifier — hero and trap shapes", () => {
  it("ACCEPTs a same-rows, faster rewrite and logs an approved critique", async () => {
    const { v, trace } = setup({
      "SELECT COUNT(1) AS n FROM f LEFT JOIN d ON f.k = d.k": { columns: [{ name: "n", type: "bigint" }], rows: [[129752]], wallMs: 1000 },
      "SELECT COUNT(1) AS n FROM f": { columns: [{ name: "n", type: "bigint" }], rows: [[129752]], wallMs: 500 },
    });
    const pre = await v.precheck("SELECT COUNT(1) AS n FROM f LEFT JOIN d ON f.k = d.k");
    expect(pre).toMatchObject({ ok: true, deterministic: true, rows: 1, fingerprint_kind: "rows", vacuous: false });
    const a = await v.verify(attempt("SELECT COUNT(1) AS n FROM f"), pre);
    expect(a.verdict).toBe("ACCEPT");
    expect(a.fingerprint.orig).toBe(a.fingerprint.rewrite);
    expect(a.timing_ms).toMatchObject({ median_speedup: 2, faster_pairs: 3, timed_as: "plain", gates_missed: [] });
    expect(critiques(trace).map((c) => [c.target_agent, c.status])).toEqual([["Orchestrator", "approved"], ["Rewriter", "approved"]]);
  });

  it("REJECTs a row-different rewrite with the first differing row and never times it", async () => {
    const { v, engine } = setup({
      "SELECT n FROM trap": { columns: [{ name: "n", type: "bigint" }], rows: [[129776]] },
      "SELECT n FROM rewrite": { columns: [{ name: "n", type: "bigint" }], rows: [[129752]] },
    });
    const pre = await v.precheck("SELECT n FROM trap");
    const a = await v.verify(attempt("SELECT n FROM rewrite"), pre, { lastAttempt: true });
    expect(a).toMatchObject({ verdict: "REJECT", reason: "ROW_DIFF", first_diff: { side: "rewrite", row: ["129752"] } });
    expect(a.detail).toBe('rows differ (1 vs 1 rows); first differing row ["129752"] returned by the candidate, not by the original');
    expect(a.timing_ms).toBeUndefined();
    expect(engine.calls.filter((s) => s === "SELECT n FROM rewrite")).toHaveLength(1);
  });

  it("routes a no-gain rewrite to the Diagnoser", async () => {
    const { v, trace } = setup({
      "SELECT k FROM a": { columns: K, rows: [[1]], wallMs: 1000 },
      "SELECT k FROM b": { columns: K, rows: [[1]], wallMs: 990 },
    });
    const a = await v.verify(attempt("SELECT k FROM b"), await v.precheck("SELECT k FROM a"));
    expect(a).toMatchObject({ verdict: "REJECT", reason: "NOT_FASTER", not_faster_detail: "no_gain" });
    expect(critiques(trace).at(-1)?.target_agent).toBe("Diagnoser");
  });

  it("refuses a write statement without executing it", async () => {
    const { v, engine } = setup({ "SELECT k FROM a": { columns: K, rows: [[1]] } });
    const pre = await v.precheck("SELECT k FROM a");
    const before = engine.calls.length;
    const a = await v.verify(attempt("DROP TABLE a"), pre);
    expect(a).toMatchObject({ verdict: "REFUSED", reason: "GUARD" });
    expect(engine.calls.length).toBe(before);
  });

  it("rejects renamed result columns even when every value matches", async () => {
    const { v } = setup({
      "SELECT k FROM a": { columns: K, rows: [[1]] },
      "SELECT k AS key FROM a": { columns: [{ name: "key", type: "bigint" }], rows: [[1]] },
    });
    const a = await v.verify(attempt("SELECT k AS key FROM a"), await v.precheck("SELECT k FROM a"));
    expect(a).toMatchObject({ reason: "ROW_DIFF" });
    expect(a.detail).toMatch(/result columns differ/);
  });
});

describe("Verifier — pre-check", () => {
  it("NOT_VERIFIABLE on a lint hit, before any execution", async () => {
    const { v, engine, trace } = setup({});
    const pre = await v.precheck("SELECT k, rand() AS r FROM a");
    expect(pre).toMatchObject({ ok: false, verdict: "NOT_VERIFIABLE" });
    expect(engine.calls).toHaveLength(0);
    expect(critiques(trace)[0]).toMatchObject({ target_agent: "Orchestrator", status: "needs_revision" });
  });
  it("REFUSED when the original fails the guard", async () => {
    const { v } = setup({});
    expect((await v.precheck("SELECT 1; DROP TABLE a")).verdict).toBe("REFUSED");
  });
  it("NOT_VERIFIABLE when two runs of the original differ", async () => {
    const { v } = setup({ "SELECT k FROM a": { columns: K, rows: (n) => [[n]] } });
    const pre = await v.precheck("SELECT k FROM a");
    expect(pre.verdict).toBe("NOT_VERIFIABLE");
    expect(pre.reason).toMatch(/non-deterministic/);
  });
  it("NOT_VERIFIABLE on an empty or all-NULL result", async () => {
    const { v } = setup({ "SELECT k FROM e": { columns: K, rows: [] }, "SELECT k FROM n": { columns: K, rows: [[null]] } });
    expect((await v.precheck("SELECT k FROM e")).vacuous).toBe(true);
    expect((await v.precheck("SELECT k FROM n")).reason).toMatch(/NULL/);
  });
  it("NOT_VERIFIABLE on a tie at the top-N cut", async () => {
    const { v } = setup({
      "SELECT k FROM a ORDER BY k LIMIT 2": { columns: K, rows: [[1], [2]] },
      "SELECT k FROM a ORDER BY k LIMIT 3": { columns: K, rows: [[1], [2], [2]] },
    });
    expect((await v.precheck("SELECT k FROM a ORDER BY k LIMIT 2")).reason).toMatch(/ties at the cut/);
  });
  it("passes a top-N query with no tie at the cut", async () => {
    const { v } = setup({
      "SELECT k FROM a ORDER BY k LIMIT 2": { columns: K, rows: [[1], [2]] },
      "SELECT k FROM a ORDER BY k LIMIT 3": { columns: K, rows: [[1], [2], [3]] },
    });
    expect((await v.precheck("SELECT k FROM a ORDER BY k LIMIT 2")).ok).toBe(true);
  });
  it("an ordered result at the row cap is NOT_VERIFIABLE (the fingerprint is order-independent)", async () => {
    const { v } = setup({ "SELECT k FROM big ORDER BY k": { columns: K, rows: range(150) } });
    expect((await v.precheck("SELECT k FROM big ORDER BY k")).reason).toBe("order not verifiable above the row cap");
  });
  it("an unordered result at the row cap switches to the engine fingerprint", async () => {
    const { v } = setup({ "SELECT k FROM big": { columns: K, rows: range(150) } });
    expect(await v.precheck("SELECT k FROM big")).toMatchObject({ ok: true, fingerprint_kind: "engine", rows: 150, overCap: true });
  });
});

describe("Verifier — a stub engine that silently truncates at L (unknown tool limit)", () => {
  const L = 5;
  const full = range(20);
  it("ordered original → NOT_VERIFIABLE", async () => {
    const { v } = setup({ "SELECT k FROM t ORDER BY k": { columns: K, rows: full } }, false, L);
    const pre = await v.precheck("SELECT k FROM t ORDER BY k");
    expect(pre).toMatchObject({ verdict: "NOT_VERIFIABLE", reason: "order not verifiable above the tool's limit", countStar: 20 });
  });
  it("unordered original → engine fingerprint", async () => {
    const { v } = setup({ "SELECT k FROM t": { columns: K, rows: full } }, false, L);
    expect(await v.precheck("SELECT k FROM t")).toMatchObject({ ok: true, fingerprint_kind: "engine", rows: 20, transferredRows: L });
  });
  it("equal prefix + different tail → ROW_DIFF (two prefixes are never compared)", async () => {
    const tail = [...full.slice(0, 19), [999]];
    const { v } = setup({ "SELECT k FROM t": { columns: K, rows: full }, "SELECT k FROM u": { columns: K, rows: tail } }, false, L);
    const a = await v.verify(attempt("SELECT k FROM u"), await v.precheck("SELECT k FROM t"));
    expect(a).toMatchObject({ verdict: "REJECT", reason: "ROW_DIFF", fingerprint_kind: "engine", rows: { orig: 20, rewrite: 20 } });
    expect(a.timing_ms).toBeUndefined();
  });
  it("equal full results → timed as fingerprint statements", async () => {
    const { v } = setup({ "SELECT k FROM t": { columns: K, rows: full, wallMs: 400 }, "SELECT k FROM u": { columns: K, rows: full, wallMs: 100 } }, false, L);
    const a = await v.verify(attempt("SELECT k FROM u"), await v.precheck("SELECT k FROM t"));
    expect(a).toMatchObject({ verdict: "ACCEPT", fingerprint_kind: "engine" });
    expect(a.timing_ms?.timed_as).toBe("fingerprint");
  });
});
