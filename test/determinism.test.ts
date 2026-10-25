import { describe, expect, it } from "vitest";
import { lintDeterminism, tieAtCut, tieProbeSql } from "../src/verify/determinism.js";
import { orderSpec } from "../src/verify/order.js";

const lint = (sql: string) => lintDeterminism(sql, orderSpec(sql, []));

describe("determinism lint", () => {
  it("flags non-deterministic functions and sampling, not literals that mention them", () => {
    expect(lint("SELECT rand() FROM t")[0]).toMatch(/rand/);
    expect(lint("SELECT * FROM t WHERE d < current_date")[0]).toMatch(/current_date/);
    expect(lint("SELECT * FROM t TABLESAMPLE (10 PERCENT)")).toContain("sampling clause");
    expect(lint("SELECT 'rand()' AS s FROM t")).toEqual([]);
  });
  it("flags LIMIT without a top-level ORDER BY, not with one", () => {
    expect(lint("SELECT a FROM t LIMIT 10")).toContain("LIMIT without a top-level ORDER BY");
    expect(lint("SELECT a FROM t ORDER BY a LIMIT 10")).toEqual([]);
    expect(lint("SELECT COUNT(1) AS n FROM t")).toEqual([]);
    expect(lint("SELECT a FROM t QUALIFY ??? LIMIT 10")).toContain("LIMIT without a top-level ORDER BY"); // parser failed
  });
  it("builds the top-N tie probe and detects a tie at the cut", () => {
    expect(tieProbeSql("SELECT a FROM t ORDER BY a LIMIT 10;", 10)).toBe("SELECT a FROM t ORDER BY a LIMIT 11");
    expect(tieProbeSql("SELECT a FROM t ORDER BY a LIMIT 10 OFFSET 5", 10)).toBeNull();
    expect(tieAtCut([["1"], ["2"], ["2"]], [0], 2)).toBe(true);
    expect(tieAtCut([["1"], ["2"], ["3"]], [0], 2)).toBe(false);
    expect(tieAtCut([["1"], ["2"]], [0], 2)).toBe(false);
  });
});

describe("orderSpec when the parser cannot read the statement", () => {
  const sql = "SELECT a FROM t LATERAL VIEW explode(x) e AS y LIMIT 5";
  it("the hive parser really fails on this statement", async () => {
    const { default: pkg } = await import("node-sql-parser");
    expect(() => new pkg.Parser().astify(sql, { database: "hive" })).toThrow();
  });
  it("LIMIT is still read (so the determinism lint sees it) and no ORDER BY means multiset", () => {
    expect(orderSpec(sql, ["a"])).toEqual({ kind: "multiset", limit: 5 });
  });
  it("an ORDER BY it cannot parse is raw, with the LIMIT kept", () => {
    expect(orderSpec("SELECT a FROM t LATERAL VIEW explode(x) e AS y ORDER BY a LIMIT 5", ["a"])).toMatchObject({ kind: "raw", limit: 5 });
  });
});
