import type { VerifierConfig } from "../config.js";
import { EngineError, type Column, type QueryEngine, type RunResult } from "../engine/types.js";
import { sqlGuard } from "../guard/sqlGuard.js";
import { trimStatement } from "../sql/text.js";
import type { AgentName, Trace } from "../trace.js";
import { canonRows, isVacuous, sameSchema, sha256Text, type CanonRow } from "../verify/canonical.js";
import { lintDeterminism, tieAtCut, tieProbeSql } from "../verify/determinism.js";
import { diffRows, rowsFingerprint } from "../verify/diff.js";
import { countStarSql } from "../verify/fingerprint.js";
import { orderSpec, type OrderSpec } from "../verify/order.js";
import { decideTiming, median, timePairs, type Gate, type TimingPolicy } from "../verify/timing.js";

// The Verifier agent: deterministic code only — the one place an ACCEPT can come from (architecture §Safety invariant 1). LLM
// output is never parsed for a verdict or a number. Order, cheapest gate first: guard → pre-check (lint, double run, vacuity,
// order-above-cap, top-N tie probe) → result-schema check → row diff (rows under the cap, engine row-hash fingerprint at it) →
// paired alternating timing. Every check is a `Verifier / critique` trace line.

export interface Precheck {
  ok: boolean;
  verdict?: "REFUSED" | "NOT_VERIFIABLE";
  reason?: string;
  sql: string;
  deterministic: boolean;
  rows: number;
  fingerprint: string;
  fingerprint_kind: "rows" | "engine";
  vacuous: boolean;
  columns: Column[];
  spec: OrderSpec;
  overCap: boolean;
  transferredRows: number;
  countStar?: number;
  canon: CanonRow[]; // full canonical rows under the cap, the transferred prefix above it
  origRunMs: number[]; // the pre-check's runs of the original: they warm it and size the timing cap
  warnings: string[];
}

export type ReuseLookup = (candidateSql: string) => { id: string; rows: { orig: number; rewrite: number } | null; first_diff: { side: "orig" | "rewrite"; row: unknown[]; order?: true } | null; text: string } | null;

export interface AttemptInput {
  n: number;
  origin: "rewriter" | "candidate_sql";
  hypothesis_id: string | null;
  sql: string;
  change_summary: string;
}

export interface Attempt extends AttemptInput {
  verdict: "ACCEPT" | "REJECT" | "REFUSED";
  reason?: "ROW_DIFF" | "NOT_FASTER" | "GUARD" | "ERROR";
  not_faster_detail?: "no_gain" | "under_gate";
  detail?: string;
  first_diff?: { side: "orig" | "rewrite"; row: unknown[]; order?: true };
  rows: { orig: number; rewrite: number };
  fingerprint: { orig: string; rewrite: string | null };
  fingerprint_kind?: "rows" | "engine";
  reused_from?: string; // H-MEM id when a refusal was reused from the ledger: the candidate was not executed
  timing_ms?: {
    orig: number[];
    rewrite: number[];
    median_speedup: number;
    median_saving_ms: number;
    faster_pairs: number;
    excluded_pairs: number;
    timed_as: "plain" | "fingerprint";
    noise_floor_ms: number;
    gates_missed: Gate[];
    cap_ms: number;
    capped_at_ms?: number;
    note?: string;
  };
}

interface Side {
  res: RunResult;
  canon: CanonRow[];
  overCap: boolean;
  countStar?: number;
}

const TIMEOUT_SEC = 300;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

export class Verifier {
  constructor(
    private readonly engine: QueryEngine,
    private readonly cfg: VerifierConfig,
    private readonly trace: Trace,
  ) {}

  private get policy(): TimingPolicy {
    const c = this.cfg;
    return { speedupMin: c.speedupMin, noGainSpeedup: c.noGainSpeedup, noiseFloorMs: c.noiseFloorMs, minPairs: c.minPairs, maxPairs: c.maxPairs };
  }

  // Every statement sent to the engine passes the guard — the wrappers the Verifier builds included.
  private async exec(label: string, sql: string, rowCap: number): Promise<RunResult> {
    const g = sqlGuard(sql, this.cfg.dialect);
    if (!g.ok) throw new EngineError(`guard refused the Verifier's own ${label} statement: ${g.reason}`);
    try {
      const r = await this.engine.run(sql, { rowCap, timeoutSec: TIMEOUT_SEC });
      this.trace.emit({
        agent_name: "Verifier", action: "execute", input_summary: label,
        output_summary: `${r.rows.length} row(s)${r.truncated ? " (truncated at cap)" : ""} in ${r1(r.wallMs)} ms`,
        target_agent: null, sponsor_call: { service: this.engine.name, name: "run_sql", latency_ms: r1(r.wallMs) }, retry_count: 0, status: "ok",
      });
      return r;
    } catch (e) {
      const ms = e instanceof EngineError ? e.wallMs : 0;
      this.trace.emit({
        agent_name: "Verifier", action: "execute", input_summary: label, output_summary: (e as Error).message.slice(0, 300),
        target_agent: null, sponsor_call: { service: this.engine.name, name: "run_sql", latency_ms: r1(ms) }, retry_count: 0, status: "error",
      });
      throw e;
    }
  }

  private async side(label: string, sql: string, countCheck = true): Promise<Side> {
    const res = await this.exec(label, sql, this.cfg.rowCap);
    let overCap = res.truncated || res.rows.length >= this.cfg.rowCap;
    let countStar: number | undefined;
    if (!this.engine.reportsTruncation && countCheck) {
      // Unknown tool limit: COUNT(*) above the transferred rows is treated exactly like reaching the cap.
      const c = await this.exec(`${label} COUNT(*) check`, countStarSql(sql), 1);
      countStar = Number(c.rows[0]?.[0]);
      if (!Number.isSafeInteger(countStar) || countStar < 0) throw new EngineError(`${label} COUNT(*) check returned ${JSON.stringify(c.rows[0] ?? null)}`);
      if (countStar > res.rows.length) overCap = true;
    }
    return { res, canon: canonRows(res.rows, res.columns, this.cfg.floatSigDigits), overCap, ...(countStar !== undefined ? { countStar } : {}) };
  }

  private async rowHash(label: string, sql: string, columns: Column[]) {
    const r = await this.exec(`${label} row-hash fingerprint`, this.engine.rowHashSql(sql, columns, this.cfg.floatSigDigits), 1);
    const rows = Number(r.rows[0]?.[0]);
    const sum = r.rows[0]?.[1];
    // An empty or NULL wrapper result (e.g. a DECIMAL overflow) must never yield a fingerprint two different queries can share.
    if (!Number.isSafeInteger(rows) || rows < 0 || sum === null || sum === undefined || !/^-?\d+$/.test(String(sum)))
      throw new EngineError(`${label} row-hash fingerprint returned no usable (count, sum): ${JSON.stringify(r.rows[0] ?? null)}`);
    return { rows, fingerprint: sha256Text(`${rows}|${String(sum)}`), wallMs: r.wallMs };
  }

  private critique(target: AgentName, approved: boolean, input: string, output: string, retry = 0) {
    this.trace.emit({
      agent_name: "Verifier", action: "critique", input_summary: input, output_summary: output, target_agent: target,
      retry_count: retry, status: approved ? "approved" : "needs_revision",
    });
  }

  async precheck(rawSql: string): Promise<Precheck> {
    const sql = trimStatement(rawSql);
    const empty: Precheck = {
      ok: false, sql, deterministic: false, rows: 0, fingerprint: "", fingerprint_kind: "rows", vacuous: false, columns: [],
      spec: { kind: "multiset", limit: null }, overCap: false, transferredRows: 0, canon: [], origRunMs: [], warnings: [],
    };
    const stop = (verdict: "REFUSED" | "NOT_VERIFIABLE", reason: string, p: Precheck = empty): Precheck => {
      this.critique("Orchestrator", false, "pre-check of the original", `${verdict}: ${reason}`);
      return { ...p, ok: false, verdict, reason };
    };

    const g = sqlGuard(sql, this.cfg.dialect);
    if (!g.ok) return stop("REFUSED", `read-only guard: ${g.reason}`);
    const lint = lintDeterminism(sql, orderSpec(sql, [], this.cfg.dialect));
    if (lint.length) return stop("NOT_VERIFIABLE", lint.join("; "));

    const a = await this.side("original (pre-check run 1)", sql); // an engine failure here is the case's ERROR, raised to the caller
    const columns = a.res.columns;
    const spec = orderSpec(sql, columns.map((c) => c.name), this.cfg.dialect);
    const base: Precheck = {
      ...empty, columns, spec, overCap: a.overCap, transferredRows: a.res.rows.length, canon: a.canon, warnings: g.warnings,
      ...(a.countStar !== undefined ? { countStar: a.countStar } : {}),
    };
    if (isVacuous(a.res.rows)) return stop("NOT_VERIFIABLE", a.res.rows.length ? "every value is NULL (vacuous result)" : "empty result (vacuous)", { ...base, vacuous: true });
    if (a.overCap && spec.kind !== "multiset") {
      const where = a.countStar !== undefined && !a.res.truncated && a.res.rows.length < this.cfg.rowCap ? "the tool's limit" : "the row cap";
      return stop("NOT_VERIFIABLE", `order not verifiable above ${where}`, base);
    }

    let fpA: string, fpB: string, rows: number, kind: "rows" | "engine";
    const origRunMs: number[] = [];
    if (!a.overCap) {
      const b = await this.side("original (pre-check run 2)", sql, false); // COUNT(*) runs once per pre-check
      fpA = rowsFingerprint(a.canon, spec);
      fpB = rowsFingerprint(b.canon, spec);
      rows = a.res.rows.length;
      kind = "rows";
      origRunMs.push(a.res.wallMs, b.res.wallMs);
    } else {
      const x = await this.rowHash("original (pre-check run 1)", sql, columns);
      const y = await this.rowHash("original (pre-check run 2)", sql, columns);
      fpA = x.fingerprint;
      fpB = y.fingerprint;
      rows = x.rows;
      kind = "engine";
      origRunMs.push(x.wallMs, y.wallMs);
    }
    const done = { ...base, rows, fingerprint: fpA, fingerprint_kind: kind, origRunMs };
    if (fpA !== fpB) return stop("NOT_VERIFIABLE", `non-deterministic: two runs of the original differ (${fpA.slice(0, 8)} vs ${fpB.slice(0, 8)})`, done);

    if (spec.kind === "raw" && spec.limit !== null)
      return stop("NOT_VERIFIABLE", `top-N cut not checkable for ties: ${spec.reason}`, done);
    if (spec.kind === "ordered" && spec.limit !== null) {
      const probe = tieProbeSql(sql, spec.limit);
      if (!probe) return stop("NOT_VERIFIABLE", "top-N tie probe could not be built (LIMIT is not the last clause)", done);
      const t = await this.side(`original top-N tie probe (LIMIT ${spec.limit + 1})`, probe, false);
      if (tieAtCut(t.canon, spec.keyIdx, spec.limit)) return stop("NOT_VERIFIABLE", `ties at the cut (rows ${spec.limit} and ${spec.limit + 1} share the sort keys)`, done);
    }

    const ok: Precheck = { ...done, ok: true, deterministic: true };
    this.critique("Orchestrator", true, "pre-check of the original",
      `deterministic, ${rows} row(s), ${spec.kind} compare, fingerprint ${kind} ${fpA.slice(0, 8)}`);
    return ok;
  }

  async verify(input: AttemptInput, pre: Precheck, opts: { lastAttempt?: boolean; reuse?: ReuseLookup } = {}): Promise<Attempt> {
    if (!pre.ok) throw new Error("verify() needs a passing pre-check");
    const sql = trimStatement(input.sql);
    const att: Attempt = { ...input, sql, verdict: "REJECT", rows: { orig: pre.rows, rewrite: 0 }, fingerprint: { orig: pre.fingerprint, rewrite: null } };
    const label = `attempt ${input.n}`;
    const finish = (a: Attempt): Attempt => {
      const target: AgentName = opts.lastAttempt ? "Orchestrator" : a.not_faster_detail === "no_gain" && a.origin === "rewriter" ? "Diagnoser" : "Rewriter";
      const summary =
        a.verdict === "ACCEPT"
          ? `ACCEPT: same ${a.rows.orig} row(s), ${a.timing_ms!.median_speedup}× median over ${a.timing_ms!.orig.length} pairs`
          : `${a.verdict}${a.reason ? `(${a.reason}${a.not_faster_detail ? `/${a.not_faster_detail}` : ""})` : ""}: ${a.detail ?? ""}`.trim();
      this.critique(target, a.verdict === "ACCEPT", `${label} (${input.origin}) ${input.change_summary}`.slice(0, 300), summary, input.n - 1);
      return a;
    };

    const g = sqlGuard(sql, this.cfg.dialect);
    if (!g.ok) return finish({ ...att, verdict: "REFUSED", reason: "GUARD", detail: `read-only guard: ${g.reason}` });
    // The original passed this lint in the pre-check; a candidate must too. One diff run cannot show a rewrite equal when its own
    // answer can change between runs (rand(), current_date, sampling, an unordered LIMIT): equal today is not equivalent.
    const lint = lintDeterminism(sql, orderSpec(sql, [], this.cfg.dialect));
    if (lint.length) return finish({ ...att, verdict: "REFUSED", reason: "GUARD", detail: `determinism lint: ${lint.join("; ")} — not executed` });

    // Ledger reuse (architecture §Verifier order step 1): a refusal recorded on this original, this candidate and this original-result
    // fingerprint is repeated without executing the candidate. Only refusals are ever reused.
    const hit = opts.reuse?.(sql);
    if (hit) {
      const fd = hit.first_diff ?? undefined;
      return finish({
        ...att, reason: "ROW_DIFF", reused_from: hit.id, rows: hit.rows ?? att.rows, ...(fd ? { first_diff: fd } : {}),
        detail: `refusal reused from ledger ${hit.id} — same original-result fingerprint; the candidate was not executed (${hit.text.slice(0, 200)})`,
      });
    }

    let cand: Side;
    try {
      cand = await this.side(`${label} candidate (diff run)`, sql);
    } catch (e) {
      return finish({ ...att, reason: "ERROR", detail: (e as Error).message.slice(0, 300) });
    }
    att.rows.rewrite = cand.countStar ?? cand.res.rows.length;

    const schema = sameSchema(pre.columns, cand.res.columns);
    if (!schema.equal) {
      return finish({ ...att, reason: "ROW_DIFF", fingerprint_kind: "rows", detail: `result columns differ: ${schema.detail}`,
        fingerprint: { orig: pre.fingerprint, rewrite: cand.overCap ? null : rowsFingerprint(cand.canon, pre.spec) } });
    }

    let timedAs: "plain" | "fingerprint";
    if (!pre.overCap && !cand.overCap) {
      const d = diffRows(pre.canon, cand.canon, pre.spec);
      att.fingerprint.rewrite = rowsFingerprint(cand.canon, pre.spec);
      att.fingerprint_kind = "rows";
      if (!d.equal) {
        const fd = d.firstDiff!;
        if (fd.order) {
          return finish({ ...att, reason: "ROW_DIFF", first_diff: fd,
            detail: `same ${att.rows.orig} rows in a different order (the original's ORDER BY is part of its result); first out-of-place row ${JSON.stringify(fd.row)}` });
        }
        const where = fd.side === "rewrite" ? "returned by the candidate, not by the original" : "returned by the original, missing from the candidate";
        return finish({ ...att, reason: "ROW_DIFF", first_diff: fd,
          detail: `rows differ (${att.rows.orig} vs ${att.rows.rewrite} rows); first differing row ${JSON.stringify(fd.row)} ${where}` });
      }
      timedAs = "plain";
    } else {
      // At the cap the engine-side fingerprint decides for both sides; the transferred prefixes are not compared (a prefix of an
      // unordered result is an arbitrary subset, so a prefix difference proves nothing).
      try {
        const o = pre.fingerprint_kind === "engine" ? { rows: pre.rows, fingerprint: pre.fingerprint } : await this.rowHash("original", pre.sql, pre.columns);
        const c = await this.rowHash(`${label} candidate`, sql, cand.res.columns);
        att.fingerprint = { orig: o.fingerprint, rewrite: c.fingerprint };
        att.rows = { orig: o.rows, rewrite: c.rows };
        att.fingerprint_kind = "engine";
      } catch (e) {
        return finish({ ...att, reason: "ERROR", detail: (e as Error).message.slice(0, 300) });
      }
      if (att.fingerprint.orig !== att.fingerprint.rewrite) {
        return finish({ ...att, reason: "ROW_DIFF", detail: `engine fingerprints differ (${att.rows.orig} vs ${att.rows.rewrite} rows)` });
      }
      timedAs = "fingerprint";
    }

    // Same rows → paired alternating timing of the same kind of statement on both sides. No separate warm-up pair: the diff run
    // warmed the candidate and the pre-check warmed the original.
    const stmt = (s: string, cols: Column[]) => (timedAs === "plain" ? s : this.engine.rowHashSql(s, cols, this.cfg.floatSigDigits));
    const cap = timedAs === "plain" ? this.cfg.rowCap : 1;
    const capMs = Math.max(this.cfg.timingCapMinMs, this.cfg.minPairs * 2 * median(pre.origRunMs));
    const { pairs, cappedAt } = await timePairs(
      async () => (await this.exec(`${label} timing: original`, stmt(pre.sql, pre.columns), cap)).wallMs,
      async () => (await this.exec(`${label} timing: candidate`, stmt(sql, cand.res.columns), cap)).wallMs,
      this.policy,
      capMs,
    );
    // Pair exclusion (a pair dropped as a cache hit) is not wired: the local JDBC path reports no cache-hit flag, so no pair is
    // ever marked excluded and excluded_pairs stays 0. decideTiming handles it (tested in test/timing.test.ts) for engines that do.
    const dec = decideTiming(pairs, this.policy);
    att.timing_ms = {
      orig: pairs.flatMap((p) => (p.orig === null ? [] : [r1(p.orig)])),
      rewrite: pairs.flatMap((p) => (p.rewrite === null ? [] : [r1(p.rewrite)])),
      median_speedup: r2(dec.medianSpeedup),
      median_saving_ms: r1(dec.medianSavingMs),
      faster_pairs: dec.fasterPairs,
      excluded_pairs: dec.excludedPairs,
      timed_as: timedAs,
      noise_floor_ms: this.cfg.noiseFloorMs,
      gates_missed: dec.missed,
      cap_ms: r1(capMs),
      ...(cappedAt !== undefined ? { capped_at_ms: cappedAt } : {}),
      ...(dec.note ? { note: dec.note } : {}),
    };
    if (dec.verdict === "ERROR") return finish({ ...att, reason: "ERROR", detail: `engine error during timing: ${dec.note}` });
    if (dec.verdict === "ACCEPT") return finish({ ...att, verdict: "ACCEPT" });
    const gates = dec.missed.join(", ");
    return finish({ ...att, reason: "NOT_FASTER", not_faster_detail: dec.notFasterDetail!,
      detail: `${dec.note ? dec.note + "; " : ""}median ${r2(dec.medianSpeedup)}×, saving ${r1(dec.medianSavingMs)} ms, ${dec.fasterPairs}/${dec.validPairs} pairs faster — missed: ${gates}` });
  }
}
