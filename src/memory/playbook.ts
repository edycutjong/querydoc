import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HMEM } from "../../vendor/meterless/hmem/src/index.ts";
import type { MemoryRecord } from "../../vendor/meterless/hmem/src/index.ts";
import type { Attempt } from "../agents/verifier.js";
import { canonicalSql } from "../sql/text.js";
import { sha256Text } from "../verify/canonical.js";

// The playbook: a thin layer over the vendored Meterless H-MEM (store + append-only trust ledger). The Verifier's outcomes are
// written as measured facts; before every Rewriter call the entries for the same pattern and schema are retrieved and put in its
// prompt; a refusal recorded on the same original, candidate and original-result fingerprint is reused without executing the
// candidate. Relevance is the closed enum (exact pattern + schema tags), not the embedding score: T is only a sanity floor.
// Nothing here produces a verdict — only refusals recorded by the Verifier are ever reused as a verdict; a human-approved entry is reinjected
// into the Rewriter prompt as context, never replayed.

export const RETRIEVAL_FLOOR = 0.15;
export const SAMPLE_CLOCK_MS = 1_760_000_000_000; // injected in sample mode so ids, scores and the llm-cache key replay identically
export type Outcome = "refused" | "no_gain" | "unproven" | "verified" | "human-rejected";

export interface PlaybookCtx {
  pattern: string;
  schema: string; // schema fqn, e.g. "lake+ops"
  origSql: string;
  origFp: string; // fingerprint of the original's result (pre-check)
}

export interface PlaybookHit {
  id: string;
  score: number;
  outcome: Outcome;
  text: string; // reinjection text: the content without the JSON suffix
  source: string;
}

export interface LedgerView {
  id: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  history: { action: string; actor: string; timestamp: number }[];
}

const SUFFIX = "\n#json ";
export const canonSql = canonicalSql;
export const sqlSha = (sql: string): string => sha256Text(canonSql(sql)).slice(0, 16);
const tagValue = (m: MemoryRecord, prefix: string): string | undefined => m.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
const stripSuffix = (content: string): string => (content.includes(SUFFIX) ? content.slice(0, content.indexOf(SUFFIX)) : content);

export function schemaFqn(tables: string[]): string {
  const schemas = [...new Set(tables.filter((t) => t.includes(".")).map((t) => t.split(".")[0]!))].sort();
  return schemas.length ? schemas.join("+") : "default";
}

export interface PlaybookOpts {
  dir?: string; // persistence directory (state.json + ledger.jsonl); omitted = in memory only
  seedDir?: string; // copied into `dir` first (through a temp dir and a rename)
  fixedClock?: boolean; // sample mode
}

export class Playbook {
  readonly hmem: HMEM;
  readonly dir: string | undefined;
  private constructor(hmem: HMEM, dir: string | undefined) {
    this.hmem = hmem;
    this.dir = dir;
  }

  static open(o: PlaybookOpts = {}): Playbook {
    if (o.dir && o.seedDir && !existsSync(join(o.dir, "state.json"))) {
      if (!existsSync(o.seedDir)) throw new Error(`playbook seed not found: ${o.seedDir}`);
      const tmp = `${o.dir}.tmp-${process.pid}-${Date.now()}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(join(o.dir, ".."), { recursive: true });
      cpSync(o.seedDir, tmp, { recursive: true });
      renameSync(tmp, o.dir);
    }
    if (o.dir) mkdirSync(o.dir, { recursive: true });
    return new Playbook(new HMEM({ ...(o.fixedClock ? { clock: () => SAMPLE_CLOCK_MS } : {}), ...(o.dir ? { persistDir: o.dir } : {}), actor: "querydoc" }), o.dir);
  }

  get size(): number {
    return this.hmem.store.all().length;
  }

  /** Hash of the store contents (ids, tags, content), written into the trace so a run states which playbook it started from. */
  storeHash(): string {
    return sha256Text(JSON.stringify(this.hmem.store.all().map((m) => [m.id, m.tags, m.content]))).slice(0, 12);
  }

  // The Verifier rejected an attempt. REFUSED(GUARD)/ROW_DIFF → outcome:refused (a trap), NOT_FASTER(no_gain) → outcome:no_gain,
  // under_gate → outcome:unproven. An ERROR is not a finding about the rewrite and is not written. A refusal reused from the ledger
  // writes nothing (a ledger read only).
  recordRejection(att: Attempt, ctx: PlaybookCtx): MemoryRecord | null {
    if (att.verdict === "ACCEPT" || att.reused_from) return null;
    let outcome: Outcome;
    let construct: string;
    if (att.reason === "ROW_DIFF" || att.reason === "GUARD") {
      outcome = "refused";
      construct = att.reason === "GUARD" ? "candidate refused by the read-only guard" : "rewrite changed the rows";
    } else if (att.reason === "NOT_FASTER") {
      outcome = att.not_faster_detail === "no_gain" ? "no_gain" : "unproven";
      construct = outcome === "no_gain" ? "rows identical but no time saved" : "rows identical but below the speed gate";
    } else return null;
    const head = `${ctx.pattern}: ${construct} (${att.reason}${att.not_faster_detail ? `/${att.not_faster_detail}` : ""}). ${att.change_summary}`.slice(0, 400);
    const diff = att.first_diff ? ` First differing row (${att.first_diff.side} only): ${JSON.stringify(att.first_diff.row)}.` : "";
    const counts = ` Rows original ${att.rows.orig}, rewrite ${att.rows.rewrite}.`;
    const suffix = JSON.stringify({ rows: att.rows, first_diff: att.first_diff ?? null, reason: att.reason, detail: att.detail ?? null });
    return this.hmem.add({
      content: `${head}${counts}${diff}${SUFFIX}${suffix}`,
      type: "factual", layer: "working", confidence: 0.9, source: "verifier",
      provenance: { origin: "plan_completion", learnedAt: this.hmem.clock(), label: "verifier" },
      tags: [`schema:${ctx.schema}`, `pattern:${ctx.pattern}`, `outcome:${outcome}`, `orig_sha:${sqlSha(ctx.origSql)}`, `cand_sha:${sqlSha(att.sql)}`, `orig_fp:${ctx.origFp.slice(0, 16)}`],
    });
  }

  // A human approved/rejected an accepted rewrite (POST /runs/:id/decision).
  recordDecision(decision: "approve" | "reject", actor: string, att: Attempt, ctx: PlaybookCtx, note?: string): MemoryRecord {
    const outcome: Outcome = decision === "approve" ? "verified" : "human-rejected";
    const speed = att.timing_ms ? `${att.timing_ms.median_speedup}× median over ${att.timing_ms.orig.length} pairs` : "no timing";
    const m = this.hmem.add({
      content: `${ctx.pattern}: ${decision === "approve" ? "rewrite verified and approved" : "accepted rewrite rejected by a human"}. ${att.change_summary} (${speed}).${note ? ` Note: ${note}` : ""}`,
      type: "factual", layer: "long_term", confidence: 0.8, source: `human:${actor}`,
      provenance: { origin: "manual", learnedAt: this.hmem.clock(), label: `human:${actor}` },
      tags: [`schema:${ctx.schema}`, `pattern:${ctx.pattern}`, `outcome:${outcome}`, `orig_sha:${sqlSha(ctx.origSql)}`, `cand_sha:${sqlSha(att.sql)}`],
    });
    this.hmem.feedback(m.id, decision === "approve" ? "helpful" : "wrong");
    return m;
  }

  // Before every Rewriter call. Label `other` reinjects nothing. topN = store size so another pattern's entries cannot crowd out
  // the matching ones before the exact-tag filter runs.
  retrieve(pattern: string, schema: string): PlaybookHit[] {
    if (pattern === "other" || this.size === 0) return [];
    const r = this.hmem.query(`${pattern} ${schema}`, { topN: this.size, threshold: RETRIEVAL_FLOOR });
    return r.memories
      .filter(({ memory }) => memory.tags.includes(`pattern:${pattern}`) && memory.tags.includes(`schema:${schema}`))
      .filter(({ memory }) => ["refused", "no_gain", "verified"].includes(tagValue(memory, "outcome:") ?? ""))
      .map(({ memory, relevance }) => ({
        id: memory.id, score: Math.round(relevance * 1000) / 1000, outcome: tagValue(memory, "outcome:") as Outcome,
        text: stripSuffix(memory.content), source: memory.source,
      }));
  }

  // Ledger reuse: a recorded refusal for the same canonical original and candidate, on the same original-result fingerprint.
  // Only refusals — never an ACCEPT, never a no_gain.
  findRefusal(origSql: string, candSql: string, origFp: string): { id: string; rows: Attempt["rows"] | null; first_diff: { side: "orig" | "rewrite"; row: unknown[] } | null; reason: string | null; text: string } | null {
    const o = `orig_sha:${sqlSha(origSql)}`;
    const c = `cand_sha:${sqlSha(candSql)}`;
    const fp = `orig_fp:${origFp.slice(0, 16)}`;
    for (const m of this.hmem.store.all()) {
      if (m.source !== "verifier" || !m.tags.includes("outcome:refused") || !m.tags.includes(o) || !m.tags.includes(c) || !m.tags.includes(fp)) continue;
      let extra: { rows?: Attempt["rows"]; first_diff?: { side: "orig" | "rewrite"; row: unknown[] } | null; reason?: string | null } = {};
      const i = m.content.indexOf(SUFFIX);
      if (i >= 0) {
        try {
          extra = JSON.parse(m.content.slice(i + SUFFIX.length));
        } catch {
          /* a hand-edited suffix: reuse the refusal without the rows */
        }
      }
      return { id: m.id, rows: extra.rows ?? null, first_diff: extra.first_diff ?? null, reason: extra.reason ?? null, text: stripSuffix(m.content) };
    }
    return null;
  }

  ledgerView(): LedgerView[] {
    return this.hmem.store.all().map((m) => ({
      id: m.id, content: stripSuffix(m.content), tags: m.tags, source: m.source, confidence: Math.round(m.confidence * 1000) / 1000,
      history: this.hmem.ledger.history(m.id).map((h) => ({ action: h.action, actor: h.actor, timestamp: h.timestamp })),
    }));
  }
}

export const readSeedState = (dir: string): { seq: number; records: number } => {
  const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { seq: number; records: unknown[] };
  return { seq: s.seq, records: s.records.length };
};
