import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Attempt } from "../src/agents/verifier.js";
import { Playbook, SAMPLE_CLOCK_MS, canonSql, schemaFqn, sqlSha, type PlaybookCtx } from "../src/memory/playbook.js";

const ORIG = "SELECT z.LocationID FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2";
const CAND = "SELECT z.LocationID FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID WHERE t.payment_type = 2";
const ctx = (over: Partial<PlaybookCtx> = {}): PlaybookCtx => ({ pattern: "outer_join_predicate", schema: "lake+ops", origSql: ORIG, origFp: "abcdef0123456789abcdef", ...over });
const att = (over: Partial<Attempt> = {}): Attempt => ({
  n: 1, origin: "candidate_sql", hypothesis_id: null, sql: CAND, change_summary: "filter moved to WHERE", verdict: "REJECT", reason: "ROW_DIFF",
  rows: { orig: 265, rewrite: 200 }, fingerprint: { orig: "abcdef", rewrite: null }, first_diff: { side: "orig", row: ["2", "Queens", "Jamaica Bay", "0"] }, ...over,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "qd-pb-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => Playbook.open({ fixedClock: true });

describe("playbook writes", () => {
  it("a ROW_DIFF rejection is a verifier-sourced refused entry at confidence 0.9 with the hashes for ledger reuse", () => {
    const pb = fresh();
    const m = pb.recordRejection(att(), ctx())!;
    expect(m.source).toBe("verifier");
    expect(m.confidence).toBe(0.9);
    expect(m.type).toBe("factual");
    expect(m.provenance.origin).toBe("plan_completion");
    expect(m.tags).toEqual(expect.arrayContaining(["schema:lake+ops", "pattern:outer_join_predicate", "outcome:refused", `orig_sha:${sqlSha(ORIG)}`, `cand_sha:${sqlSha(CAND)}`, "orig_fp:abcdef0123456789"]));
    expect(m.content.startsWith("outer_join_predicate")).toBe(true); // content starts with the pattern label verbatim
    expect(m.timestamp).toBe(SAMPLE_CLOCK_MS);
  });

  it("maps outcomes: GUARD → refused, no_gain → no_gain, under_gate → unproven; ERROR and ACCEPT write nothing", () => {
    const pb = fresh();
    expect(pb.recordRejection(att({ verdict: "REFUSED", reason: "GUARD" }), ctx())!.tags).toContain("outcome:refused");
    expect(pb.recordRejection(att({ reason: "NOT_FASTER", not_faster_detail: "no_gain" }), ctx())!.tags).toContain("outcome:no_gain");
    expect(pb.recordRejection(att({ reason: "NOT_FASTER", not_faster_detail: "under_gate" }), ctx())!.tags).toContain("outcome:unproven");
    expect(pb.recordRejection(att({ reason: "ERROR" }), ctx())).toBeNull();
    expect(pb.recordRejection(att({ verdict: "ACCEPT" }), ctx())).toBeNull();
    expect(pb.size).toBe(3);
  });

  it("a refusal reused from the ledger writes no new entry", () => {
    const pb = fresh();
    expect(pb.recordRejection(att({ reused_from: "mem-1" }), ctx())).toBeNull();
    expect(pb.size).toBe(0);
  });

  it("human approve writes a verified entry with a helpful feedback; reject writes human-rejected with a wrong feedback", () => {
    const pb = fresh();
    const accepted = att({ verdict: "ACCEPT", origin: "rewriter", hypothesis_id: "h1", timing_ms: { orig: [80], rewrite: [4], median_speedup: 18.9, median_saving_ms: 75, faster_pairs: 3, excluded_pairs: 0, timed_as: "plain", noise_floor_ms: 50, gates_missed: [], cap_ms: 150000 } });
    delete (accepted as { reason?: string }).reason;
    const a = pb.recordDecision("approve", "edy", accepted, ctx(), "looks right");
    expect(a.source).toBe("human:edy");
    expect(a.tags).toContain("outcome:verified");
    expect(pb.hmem.ledger.history(a.id).map((h) => h.action)).toContain("feedback");
    expect(a.confidence).toBeCloseTo(0.85, 10);
    const r = pb.recordDecision("reject", "edy", accepted, ctx());
    expect(r.tags).toContain("outcome:human-rejected");
    expect(r.confidence).toBeCloseTo(0.6, 10);
  });
});

describe("playbook retrieval (relevance = the closed enum, not the score)", () => {
  it("positive: the refused T1 entry is retrieved for the same pattern and schema, and reinjected without the JSON suffix", () => {
    const pb = fresh();
    const m = pb.recordRejection(att(), ctx())!;
    const hits = pb.retrieve("outer_join_predicate", "lake+ops");
    expect(hits.map((h) => h.id)).toEqual([m.id]);
    expect(hits[0]!.outcome).toBe("refused");
    expect(hits[0]!.text).not.toContain("#json");
    expect(hits[0]!.text).toContain("Jamaica Bay");
  });

  it("negative: an entry for another pattern, or another schema, is not retrieved", () => {
    const pb = fresh();
    pb.recordRejection(att(), ctx({ pattern: "union_dedupe" }));
    pb.recordRejection(att(), ctx({ schema: "tpcds_db" }));
    expect(pb.retrieve("outer_join_predicate", "lake+ops")).toEqual([]);
    expect(pb.retrieve("union_dedupe", "lake+ops").length).toBe(1);
  });

  it("`other` reinjects nothing, even with entries in the store", () => {
    const pb = fresh();
    pb.recordRejection(att(), ctx({ pattern: "other" }));
    expect(pb.retrieve("other", "lake+ops")).toEqual([]);
  });

  it("no_gain is reinjected (as already-tried), unproven is not; a human-approved entry is", () => {
    const pb = fresh();
    pb.recordRejection(att({ reason: "NOT_FASTER", not_faster_detail: "no_gain" }), ctx());
    pb.recordRejection(att({ reason: "NOT_FASTER", not_faster_detail: "under_gate", sql: CAND + " /* 2 */" }), ctx());
    const outcomes = pb.retrieve("outer_join_predicate", "lake+ops").map((h) => h.outcome);
    expect(outcomes).toEqual(["no_gain"]);
  });

  it("many entries of other patterns cannot crowd out the matching one (topN = store size)", () => {
    const pb = fresh();
    for (let i = 0; i < 25; i++) pb.recordRejection(att({ sql: `${CAND} /* ${i} */` }), ctx({ pattern: "not_in_nullable" }));
    const m = pb.recordRejection(att({ sql: CAND + " /* mine */" }), ctx())!;
    expect(pb.retrieve("outer_join_predicate", "lake+ops").map((h) => h.id)).toEqual([m.id]);
  });
});

describe("ledger reuse", () => {
  it("same original + candidate + original-result fingerprint → the refusal is found, with its rows and first differing row", () => {
    const pb = fresh();
    const m = pb.recordRejection(att(), ctx())!;
    const hit = pb.findRefusal(ORIG + ";", CAND.replace(/\s+/g, "  "), ctx().origFp);
    expect(hit?.id).toBe(m.id);
    expect(hit?.rows).toEqual({ orig: 265, rewrite: 200 });
    expect(hit?.first_diff).toEqual({ side: "orig", row: ["2", "Queens", "Jamaica Bay", "0"] });
  });

  it("a different original-result fingerprint → no reuse (re-verify); a different candidate or original → no reuse", () => {
    const pb = fresh();
    pb.recordRejection(att(), ctx());
    expect(pb.findRefusal(ORIG, CAND, "ffffffffffffffffffffff")).toBeNull();
    expect(pb.findRefusal(ORIG, CAND + " AND 1=1", ctx().origFp)).toBeNull();
    expect(pb.findRefusal(ORIG + " AND 1=1", CAND, ctx().origFp)).toBeNull();
  });

  it("only refusals are reused: never a no_gain, an unproven, or an approved ACCEPT", () => {
    const pb = fresh();
    pb.recordRejection(att({ reason: "NOT_FASTER", not_faster_detail: "no_gain" }), ctx());
    const accepted = att({ verdict: "ACCEPT" });
    delete (accepted as { reason?: string }).reason;
    pb.recordDecision("approve", "edy", accepted, ctx());
    expect(pb.findRefusal(ORIG, CAND, ctx().origFp)).toBeNull();
  });

  it("an entry written by a human is never reused as a verifier refusal", () => {
    const pb = fresh();
    const accepted = att({ verdict: "ACCEPT" });
    delete (accepted as { reason?: string }).reason;
    pb.recordDecision("reject", "edy", accepted, ctx());
    expect(pb.findRefusal(ORIG, CAND, ctx().origFp)).toBeNull();
  });
});

describe("determinism and isolation", () => {
  it("same writes from a fixed clock replay the same ids, scores and store hash", () => {
    const run = () => {
      const pb = fresh();
      pb.recordRejection(att(), ctx());
      pb.recordRejection(att({ sql: CAND + " /* 2 */" }), ctx());
      return { hits: pb.retrieve("outer_join_predicate", "lake+ops").map((h) => [h.id, h.score]), hash: pb.storeHash() };
    };
    expect(run()).toEqual(run());
  });

  it("a seed is copied (not shared): writes to the copy leave the seed untouched, and ids continue from the seed's counter", () => {
    const seed = tmp();
    const seeded = Playbook.open({ dir: seed, fixedClock: true });
    seeded.recordRejection(att(), ctx());
    const dir = join(tmp(), "store");
    const copy = Playbook.open({ dir, seedDir: seed, fixedClock: true });
    expect(copy.size).toBe(1);
    const m = copy.recordRejection(att({ sql: CAND + " /* 2 */" }), ctx())!;
    expect(m.id).toBe("mem-2");
    expect(Playbook.open({ dir: seed, fixedClock: true }).size).toBe(1);
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(true);
  });

  it("canonSql ignores comments, case, spacing and a trailing semicolon; schemaFqn sorts schemas", () => {
    expect(canonSql("SELECT  1 -- x\n;")).toBe(canonSql("select 1"));
    expect(schemaFqn(["ops.zones", "lake.trips", "lake.trips"])).toBe("lake+ops");
    expect(schemaFqn(["zones"])).toBe("default");
  });
});
