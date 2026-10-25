import { describe, expect, it } from "vitest";
import { keyFactLine, profileJoinKeys, type KeyFact } from "../src/agents/profile.js";
import type { QueryEngine, RunResult } from "../src/engine/types.js";
import { Trace } from "../src/trace.js";

const res = (rows: (string | number | null)[][]): RunResult =>
  ({ columns: [], rows, rowCount: rows.length, rowCountExact: true, truncated: false, wallMs: 1.26 }) as RunResult;
const engine = (run: (sql: string) => Promise<RunResult>): QueryEngine => ({ name: "duckdb", run }) as unknown as QueryEngine;
const JOIN = "SELECT 1 FROM a.f x LEFT JOIN a.d y ON x.k = y.k";

describe("profileJoinKeys edge branches", () => {
  it("an engine failure is traced as an error and yields no fact", async () => {
    const trace = new Trace("t");
    const facts = await profileJoinKeys(engine(async () => { throw new Error("boom"); }), JOIN, "postgresql", trace);
    expect(facts).toEqual([]);
    const ev = JSON.stringify((trace as any).events ?? []);
    expect(ev).toContain("boom");
  });
  it("an empty result set is treated as unreadable and dropped", async () => {
    const facts = await profileJoinKeys(engine(async () => res([])), JOIN, "postgresql", new Trace("t"));
    expect(facts).toEqual([]);
  });
  it("non-numeric cells are treated as unreadable and dropped", async () => {
    const facts = await profileJoinKeys(engine(async () => res([["x", null, "y"]])), JOIN, "postgresql", new Trace("t"));
    expect(facts).toEqual([]);
  });
  it("string counts are coerced and non-unique keys flagged", async () => {
    const facts = await profileJoinKeys(engine(async () => res([["10", "9", "5"]])), JOIN, "postgresql", new Trace("t"));
    expect(facts).toEqual([{ table: "a.d", column: "k", rows: 10, non_null: 9, distinct: 5, unique: false }]);
  });
  it("a query with no joins profiles nothing", async () => {
    let calls = 0;
    const facts = await profileJoinKeys(engine(async () => { calls++; return res([[1, 1, 1]]); }), "SELECT 1 FROM t", "postgresql", new Trace("t"));
    expect(facts).toEqual([]);
    expect(calls).toBe(0);
  });
  it("at most four keys are profiled", async () => {
    const seen: string[] = [];
    const sql = "SELECT 1 FROM a.f x JOIN a.d y ON x.k1 = y.k1 AND x.k2 = y.k2 AND x.k3 = y.k3 AND x.k4 = y.k4 AND x.k5 = y.k5";
    const facts = await profileJoinKeys(engine(async (q) => { seen.push(q); return res([[1, 1, 1]]); }), sql, "postgresql", new Trace("t"));
    expect(seen).toHaveLength(4);
    expect(facts.map((f) => f.column)).toEqual(["k1", "k2", "k3", "k4"]);
  });
});

describe("keyFactLine", () => {
  const f = (o: Partial<KeyFact>): KeyFact => ({ table: "t", column: "c", rows: 5, non_null: 5, distinct: 5, unique: true, ...o });
  it("unique", () => expect(keyFactLine(f({}))).toBe("t.c: 5 rows, 5 non-NULL, 5 distinct → UNIQUE"));
  it("has NULLs but otherwise unique", () =>
    expect(keyFactLine(f({ non_null: 4, distinct: 4, unique: false }))).toContain("has NULLs, otherwise unique"));
  it("repeated values", () =>
    expect(keyFactLine(f({ distinct: 2, unique: false }))).toContain("NOT unique (repeated values)"));
});
