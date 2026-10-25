import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { citePlanNodes, detectPatterns } from "../src/agents/patterns.js";
import { parseSparkPlan } from "../src/engine/sparkPlan.js";

const q = (f: string) => readFileSync(new URL(`../evals/queries/zetaris/${f}`, import.meta.url), "utf8");
const labels = (sql: string) => detectPatterns(sql).hits.map((h) => h.label);

describe("pattern detector", () => {
  it("labels the hero and its trap sibling unused_outer_join (the Verifier, not the detector, tells them apart)", () => {
    for (const f of ["01-hero.sql", "01-hero-trap-dupkey.sql"]) {
      const d = detectPatterns(q(f));
      expect(d.label).toBe("unused_outer_join");
      expect(d.parsed).toBe(true);
      expect(d.tables).toEqual(["tpcds_db.store_sales", "tpcds_db.promotion"]);
    }
  });

  it("does not call a LEFT JOIN unused when its alias is read, or the select is *", () => {
    expect(labels("SELECT s.a, p.name FROM t.s s LEFT JOIN t.p p ON s.k = p.k")).toEqual([]);
    expect(labels("SELECT * FROM t.s s LEFT JOIN t.p p ON s.k = p.k")).toEqual([]);
    expect(labels("SELECT s.a FROM t.s s LEFT JOIN t.p p ON s.k = p.k WHERE p.flag = 'x'")).toEqual([]);
  });

  it("handles an unaliased joined table (the table name is the alias)", () => {
    expect(labels("SELECT COUNT(1) FROM f LEFT JOIN d ON f.k = d.k")).toEqual(["unused_outer_join"]);
    expect(labels("SELECT COUNT(1), d.x FROM f LEFT JOIN d ON f.k = d.k")).toEqual([]);
  });

  it("does not claim an unused join when an unqualified column could come from the joined table", () => {
    expect(labels("SELECT c_name FROM t.f f LEFT JOIN t.d d ON f.k = d.k")).toEqual([]);
    expect(labels("SELECT COUNT(1) AS n FROM t.f f LEFT JOIN t.d d ON f.k = d.k WHERE f.x IS NULL")).toEqual(["unused_outer_join"]);
    expect(labels("SELECT COUNT(1) AS n FROM t.f f LEFT JOIN t.d d ON f.k = d.k WHERE x IS NULL")).toEqual([]);
  });

  it("T1: a literal filter on the joined side inside the ON clause", () => {
    expect(labels("SELECT s.a, p.n FROM t.s s LEFT JOIN t.p p ON s.k = p.k AND p.flag = 'X'")).toEqual(["outer_join_predicate"]);
  });

  it("finds NOT IN subqueries, UNION without ALL, correlated subqueries, non-sargable predicates, cross-source joins", () => {
    expect(labels("SELECT a FROM t.x WHERE k NOT IN (SELECT k FROM t.y)")).toContain("not_in_nullable");
    expect(labels("SELECT a FROM t.x UNION SELECT a FROM t.y")).toContain("union_dedupe");
    expect(labels("SELECT a FROM t.x UNION ALL SELECT a FROM t.y")).not.toContain("union_dedupe");
    expect(labels("SELECT i.a FROM t.item i WHERE i.p > (SELECT AVG(j.p) FROM t.item j WHERE j.c = i.c)")).toEqual(["correlated_subquery"]);
    expect(labels("SELECT a FROM t.x WHERE year(d) = 2020")).toEqual(["non_sargable_predicate"]);
    expect(labels("SELECT x.a FROM s1.x x JOIN s2.y y ON x.k = y.k")).toContain("cross_source_join_no_pushdown");
  });

  it("ignores patterns inside string literals and comments", () => {
    expect(labels("SELECT 'a NOT IN (SELECT 1) UNION b' AS s FROM t.x -- union\n")).toEqual([]);
  });

  it("falls back to regex when the parser rejects the statement, and still labels", () => {
    const d = detectPatterns("SELEKT broken ((( FROM t.s s LEFT JOIN t.p p ON s.k = p.k");
    expect(d.parsed).toBe(false);
    expect(d.tables).toContain("t.s");
  });

  it("returns other for an unmatched query and cites only plan nodes that exist", () => {
    const plan = { format: "spark-physical-text" as const, text: "", wallMs: 0, nodes: parseSparkPlan("== Physical Plan ==\n* HashAggregate (3)\n+- * BroadcastHashJoin LeftOuter BuildRight (2)\n   :- FileScan parquet db.t (1)\n\n(1) FileScan parquet db.t\nx\n") };
    const d = detectPatterns("SELECT a FROM t.x", plan);
    expect(d.label).toBe("other");
    const cited = citePlanNodes("unused_outer_join", plan.nodes);
    expect(cited.map((n) => n.id)).toEqual([2]);
    expect(cited.every((n) => plan.nodes.some((p) => p.id === n.id))).toBe(true);
  });
});
