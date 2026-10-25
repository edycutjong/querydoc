// Paired alternating timing and the speed gate. The runner times the same kind of statement on both sides, alternating which
// runs first; the decision is a pure function of the pairs so it is table-tested. ACCEPT needs all three gates: median speedup ≥
// speedupMin, median saving ≥ the noise floor, and a majority of pairs won. Otherwise NOT_FASTER, with `no_gain` (median speedup
// below noGainSpeedup, or both the ratio and the floor missed) routed to the Diagnoser, and `under_gate` (some gate missed) to the
// Rewriter. Fewer than 3 valid pairs, or an even count (majority undecided), is never an ACCEPT.

export interface TimingPolicy {
  speedupMin: number; // 1.2
  noGainSpeedup: number; // 1.05
  noiseFloorMs: number;
  minPairs: number; // 3
  maxPairs: number; // 5
}

export interface Pair {
  orig: number | null;
  rewrite: number | null;
  first: "orig" | "rewrite";
  excluded?: string; // e.g. a cache-hit flag; reported, not counted
  error?: string;
}

export type Gate = "ratio" | "floor" | "majority" | "pairs";

export interface TimingDecision {
  verdict: "ACCEPT" | "NOT_FASTER" | "ERROR";
  notFasterDetail?: "no_gain" | "under_gate";
  missed: Gate[];
  note?: string;
  medianSpeedup: number;
  medianSavingMs: number;
  fasterPairs: number;
  validPairs: number;
  excludedPairs: number;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function decideTiming(pairs: Pair[], p: TimingPolicy): TimingDecision {
  const errored = pairs.find((x) => x.error);
  const valid = pairs.filter((x) => !x.error && !x.excluded && x.orig !== null && x.rewrite !== null) as (Pair & { orig: number; rewrite: number })[];
  const excludedPairs = pairs.filter((x) => x.excluded).length;
  const medianSpeedup = median(valid.map((x) => x.orig / x.rewrite));
  const medianSavingMs = median(valid.map((x) => x.orig - x.rewrite));
  const fasterPairs = valid.filter((x) => x.rewrite < x.orig).length;
  const base = { medianSpeedup, medianSavingMs, fasterPairs, validPairs: valid.length, excludedPairs };
  if (errored) return { verdict: "ERROR", missed: [], note: errored.error, ...base };
  if (valid.length < p.minPairs) {
    // The time cap stopped timing early because the candidate is far slower: slower in every pair it ran is no gain (→ Diagnoser),
    // not "timing unreliable" (→ Rewriter on the same hypothesis). Still never an ACCEPT.
    if (valid.length > 0 && fasterPairs === 0 && medianSpeedup < p.noGainSpeedup) {
      const missed: Gate[] = ["pairs", "ratio", ...(medianSavingMs >= p.noiseFloorMs ? [] : (["floor"] as Gate[]))];
      return { verdict: "NOT_FASTER", notFasterDetail: "no_gain", missed, note: `slower in all ${valid.length} pair(s) timed before the cap`, ...base };
    }
    return { verdict: "NOT_FASTER", notFasterDetail: "under_gate", missed: ["pairs"], note: `timing unreliable: ${valid.length} valid pairs < ${p.minPairs}`, ...base };
  }

  const missed: Gate[] = [];
  if (!(medianSpeedup >= p.speedupMin)) missed.push("ratio");
  if (!(medianSavingMs >= p.noiseFloorMs)) missed.push("floor");
  if (valid.length % 2 === 0) missed.push("majority"); // even count: majority undecided
  else if (fasterPairs * 2 <= valid.length) missed.push("majority");

  if (medianSpeedup < p.noGainSpeedup || (missed.includes("ratio") && missed.includes("floor")))
    return { verdict: "NOT_FASTER", notFasterDetail: "no_gain", missed, ...base };
  if (missed.length) {
    const note = valid.length % 2 === 0 ? `majority undecided on an even count (${valid.length} pairs)` : undefined;
    return { verdict: "NOT_FASTER", notFasterDetail: "under_gate", missed, ...(note ? { note } : {}), ...base };
  }
  return { verdict: "ACCEPT", missed, ...base };
}

// Runs up to maxPairs alternating pairs: minPairs first, then one more pair while the valid count is even (so a majority can be
// decided), never past the time cap. A pair whose statement errors stops the timing — the orchestrator's ERROR rules apply.
export async function timePairs(
  runOrig: () => Promise<number>,
  runRewrite: () => Promise<number>,
  p: TimingPolicy,
  capMs: number,
  onPair?: (pair: Pair, i: number) => void,
): Promise<{ pairs: Pair[]; cappedAt?: number }> {
  const pairs: Pair[] = [];
  const t0 = Date.now();
  for (let i = 0; i < p.maxPairs; i++) {
    const valid = pairs.filter((x) => !x.error && !x.excluded).length;
    if (i >= p.minPairs && valid % 2 === 1) break;
    if (Date.now() - t0 >= capMs) return { pairs, cappedAt: Date.now() - t0 };
    const first: Pair["first"] = i % 2 === 0 ? "orig" : "rewrite";
    const pair: Pair = { orig: null, rewrite: null, first };
    try {
      if (first === "orig") {
        pair.orig = await runOrig();
        pair.rewrite = await runRewrite();
      } else {
        pair.rewrite = await runRewrite();
        pair.orig = await runOrig();
      }
    } catch (e) {
      pair.error = (e as Error).message;
    }
    pairs.push(pair);
    onPair?.(pair, i);
    if (pair.error) break;
  }
  return { pairs };
}
