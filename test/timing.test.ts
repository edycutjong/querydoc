import { describe, expect, it } from "vitest";
import { decideTiming, timePairs, type Pair, type TimingPolicy } from "../src/verify/timing.js";

const policy: TimingPolicy = { speedupMin: 1.2, noGainSpeedup: 1.05, noiseFloorMs: 50, minPairs: 3, maxPairs: 5 };
const P = (orig: number, rewrite: number, extra: Partial<Pair> = {}): Pair => ({ orig, rewrite, first: "orig", ...extra });

describe("decideTiming (table)", () => {
  const rows: [string, Pair[], string, string | undefined, string[]][] = [
    ["3 pairs, all gates met", [P(1000, 500), P(1100, 520), P(990, 480)], "ACCEPT", undefined, []],
    ["ratio met, saving under the floor", [P(200, 160), P(210, 170), P(205, 165)], "NOT_FASTER", "under_gate", ["floor"]],
    ["below 1.05x → no_gain", [P(1000, 980), P(1000, 990), P(1000, 970)], "NOT_FASTER", "no_gain", ["ratio", "floor"]],
    ["ratio and floor both missed → no_gain", [P(100, 90), P(100, 92), P(100, 91)], "NOT_FASTER", "no_gain", ["ratio", "floor"]],
    ["1.1x with a large saving → under_gate (ratio)", [P(10000, 9000), P(10000, 9100), P(10000, 9050)], "NOT_FASTER", "under_gate", ["ratio"]],
    ["median fast but majority lost", [P(1000, 400), P(1000, 1100), P(1000, 1050)], "NOT_FASTER", "no_gain", ["ratio", "floor", "majority"]],
    ["even count → majority undecided", [P(1000, 500), P(1000, 500), P(1000, 500), P(1000, 500)], "NOT_FASTER", "under_gate", ["majority"]],
    ["exclusion leaves 2 valid → timing unreliable", [P(1000, 500), P(1000, 500), P(1000, 500, { excluded: "cache hit" })], "NOT_FASTER", "under_gate", ["pairs"]],
    ["cap leaves 2 pairs → timing unreliable", [P(1000, 500), P(1000, 500)], "NOT_FASTER", "under_gate", ["pairs"]],
    ["error pair → ERROR", [P(1000, 500), { orig: 1000, rewrite: null, first: "orig", error: "timeout" }], "ERROR", undefined, []],
  ];
  for (const [name, pairs, verdict, detail, missed] of rows) {
    it(name, () => {
      const d = decideTiming(pairs, policy);
      expect(d.verdict).toBe(verdict);
      expect(d.notFasterDetail).toBe(detail);
      expect(d.missed).toEqual(missed);
    });
  }
  it("never accepts with fewer than 3 valid pairs, whatever the speedup", () => {
    expect(decideTiming([P(10000, 1), P(10000, 1)], policy).verdict).toBe("NOT_FASTER");
  });
});

describe("timePairs", () => {
  it("alternates which side runs first and stops at 3 valid pairs", async () => {
    const order: string[] = [];
    const { pairs } = await timePairs(async () => (order.push("o"), 100), async () => (order.push("r"), 50), policy, 1e9);
    expect(pairs).toHaveLength(3);
    expect(order.join("")).toBe("orroor");
    expect(pairs.map((p) => p.first)).toEqual(["orig", "rewrite", "orig"]);
  });
  it("stops at the first engine error", async () => {
    let n = 0;
    const { pairs } = await timePairs(async () => 100, async () => { if (++n === 2) throw new Error("boom"); return 50; }, policy, 1e9);
    expect(pairs).toHaveLength(2);
    expect(pairs[1]!.error).toBe("boom");
  });
  it("respects the time cap", async () => {
    const { pairs, cappedAt } = await timePairs(async () => { await new Promise((r) => setTimeout(r, 15)); return 100; }, async () => 50, policy, 20);
    expect(pairs.length).toBeLessThan(3);
    expect(cappedAt).toBeGreaterThanOrEqual(20);
  });
});
