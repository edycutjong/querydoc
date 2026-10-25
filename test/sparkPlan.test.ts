import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSparkPlan } from "../src/engine/sparkPlan.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseSparkPlan — EXPLAIN FORMATTED (hero, captured from Zetaris)", () => {
  const nodes = parseSparkPlan(fixture("hero-explain-formatted.txt"));

  it("keeps Spark's own operator ids in tree order", () => {
    expect(nodes.map((n) => n.id)).toEqual([12, 11, 10, 9, 8, 7, 3, 2, 1, 6, 5, 4]);
  });

  it("reads operator names and tree depth", () => {
    const join = nodes.find((n) => n.id === 7)!;
    expect(join.operator).toBe("BroadcastHashJoin");
    expect(join.depth).toBe(5);
    expect(nodes.find((n) => n.id === 1)).toMatchObject({ operator: "Scan", depth: 8 });
    expect(nodes.find((n) => n.id === 4)).toMatchObject({ operator: "Scan", depth: 8 });
  });

  it("attaches each detail block to its node", () => {
    const join = nodes.find((n) => n.id === 7)!;
    expect(join.detail).toContain("LeftOuter");
    expect(join.detail).toContain("Join type: LeftOuter");
    expect(nodes.find((n) => n.id === 1)!.detail).toContain("TPCDS_DB.store_sales");
    expect(nodes.find((n) => n.id === 4)!.detail).toContain("PushedFilters: [IsNotNull(p_promo_sk)]");
  });
});

describe("parseSparkPlan — plain EXPLAIN falls back to line numbering", () => {
  const nodes = parseSparkPlan(fixture("hero-explain-plain.txt"));

  it("numbers operators 1..n in pre-order", () => {
    expect(nodes.map((n) => n.id)).toEqual(nodes.map((_, i) => i + 1));
    expect(nodes[0]!.operator).toBe("AdaptiveSparkPlan");
    expect(nodes.some((n) => n.operator === "BroadcastHashJoin")).toBe(true);
    expect(nodes.filter((n) => n.operator === "FileScan")).toHaveLength(2);
  });

  it("returns nothing for text that is not a plan", () => {
    expect(parseSparkPlan("")).toEqual([]);
  });
});
