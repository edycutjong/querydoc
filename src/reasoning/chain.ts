import { Markovian, canonicalBlock } from "../../vendor/meterless/markovian/src/index.ts";
import { SampleModeNoLLM } from "../adapters/nim.js";
import type { Attempt, Precheck, Verifier } from "../agents/verifier.js";
import type { Rewriter } from "../agents/rewriter.js";
import type { KeyFact } from "../agents/profile.js";
import type { Plan } from "../engine/types.js";
import type { Trace } from "../trace.js";
import { sha256Text } from "../verify/canonical.js";
import type { Diagnosis, Hypothesis } from "../types.js";

// One Markovian chunk = one rewrite attempt (Rewriter call + Verifier call). The carryover the next chunk's Rewriter sees is a
// compact fixed-line-format state block built here from the hypothesis ledger and the last rejection — not a model summary — and
// it travels through the vendored engine's marker protocol ([STATE_CHECKPOINT] … / [TASK_COMPLETE]) and its cascade (level 1,
// marker override). Reason routing (Day-3 minimum): ROW_DIFF / GUARD / ERROR retry the same hypothesis (≤2 tries each),
// NOT_FASTER marks it falsified (no_gain) or unproven (under_gate) and moves to the next untested hypothesis.

export const CARRYOVER_TOKENS = 400; // engine budget; the block below stays well under it (asserted in the tests)
export const CHUNK_CONFIG = { chunkSize: 2000, carryoverTokens: CARRYOVER_TOKENS, maxChunks: 3, overlapTokens: 0 } as const;
const MAX_FIELD = 380;

export interface ChainArgs {
  sql: string;
  plan: Plan | null;
  diagnosis: Diagnosis;
  facts: KeyFact[];
  pre: Precheck;
  rewriter: Rewriter;
  verifier: Verifier;
  trace: Trace;
  maxAttempts: number;
}

export interface ChainResult {
  attempts: Attempt[];
  accepted: Attempt | null;
  llmError: { unavailable: boolean; message: string } | null;
  upstreamError: string | null; // the vendored engine swallows a step's exception into run.error; surfaced here, never dropped
  markovian: { chunks: number; carryover_present: boolean[]; status: string; carryovers: string[]; out_of_hypotheses: boolean };
}

const cap = (s: string, n = MAX_FIELD) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// The vendored engine reads marker tokens ([TASK_COMPLETE], [FINAL], <DONE/>, <CARRYOVER>, @@@FINAL@@@, ---STATE---) anywhere in a
// chunk's text. Rejected SQL, engine errors and diff rows are untrusted text that goes into that text, so the tokens are removed.
const MARKERS = /\[(?:TASK_COMPLETE|FINAL|STATE_CHECKPOINT|STATE)\]|@@@\w+@@@|---(?:STATE|FINAL)---|<\/?(?:DONE|CARRYOVER|PROGRESS)\s*\/?>|<NEEDS_[A-Z_]+(?:\s+\w+=(?:"[^"]*"|'[^']*'))*\s*\/?>/gi;
export const neutralise = (s: string): string => s.replace(MARKERS, "(marker removed)");

// Stable, timing-free description of the chain state for the llm-cache key (the carryover text itself may carry timings).
export function carryoverKey(ledger: Hypothesis[], rejected: Attempt[]): string {
  return JSON.stringify({
    ledger: ledger.map((h) => [h.id, h.status]),
    rejected: rejected.map((a) => [a.n, a.hypothesis_id, a.reason ?? a.verdict, a.not_faster_detail ?? null, sha256Text(a.sql.replace(/\s+/g, " ").trim().toLowerCase())]),
  });
}

export function carryoverBlock(ledger: Hypothesis[], rejected: Attempt[]): string {
  const done = ledger.filter((h) => h.status !== "untested").map((h) => `${h.id} ${h.status}${h.evidence ? ` (${h.evidence})` : ""}`);
  const left = ledger.filter((h) => h.status === "untested").map((h) => h.id);
  const last = rejected[rejected.length - 1];
  // The reason and the first differing row come FIRST: they are what the next attempt must learn from; the rejected SQL gets
  // whatever budget is left.
  let context = "no attempt yet";
  if (last) {
    // one line: the engine reads CARRYOVER STATE only up to the first blank line, and a newline could fake a COMPLETED:/REMAINING: field
    const why = neutralise(`${last.detail ?? last.reason}${last.first_diff ? ` — first differing row (${last.first_diff.side} only): ${JSON.stringify(last.first_diff.row)}` : ""}`).replace(/\s+/g, " ");
    const sql = neutralise(last.sql.replace(/\s+/g, " "));
    context = cap(`${cap(why, 220)} — rejected SQL: ${sql}`);
  }
  return canonicalBlock({
    completed: cap(done.join(" · ") || "none"),
    remaining: cap(left.join(" · ") || "none"),
    decisions: cap(rejected.map((a) => `attempt ${a.n} on ${a.hypothesis_id ?? "candidate"} rejected ${a.reason}${a.not_faster_detail ? "/" + a.not_faster_detail : ""}`).join(" · ") || "none"),
    context,
  });
}

export async function runChain(a: ChainArgs): Promise<ChainResult> {
  const ledger = a.diagnosis.hypotheses;
  const attempts: Attempt[] = [];
  const rejected: Attempt[] = [];
  const tries = new Map<string, number>();
  let accepted: Attempt | null = null;
  let llmError: ChainResult["llmError"] = null;
  let current: Hypothesis | undefined;
  let finished = false;
  let outOfHypotheses = false;

  // ROW_DIFF / GUARD / ERROR / REFUSED retry the same hypothesis (<= 2 tries); otherwise the next untested hypothesis, then any
  // unproven one with a try left. A falsified or confirmed hypothesis is never picked again; none eligible → the chain ends.
  const eligible = (h: Hypothesis) => (h.status === "untested" || h.status === "unproven") && (tries.get(h.id) ?? 0) < 2;
  const pick = (): Hypothesis | undefined => {
    const last = attempts[attempts.length - 1];
    const sameKind = last && (last.reason === "ROW_DIFF" || last.reason === "GUARD" || last.reason === "ERROR" || last.verdict === "REFUSED");
    if (current && sameKind && eligible(current)) return current;
    return ledger.find((h) => h.status === "untested") ?? ledger.find(eligible);
  };

  const mk = new Markovian({ chunkConfig: { ...CHUNK_CONFIG, maxChunks: a.maxAttempts } });
  const carryovers: string[] = [];
  const run = await mk.run({
    goal: "Find a faster rewrite that the Verifier proves returns the same rows",
    reflect: false,
    stopWhen: () => finished,
    stepFn: async ({ carryover }) => {
      const n = attempts.length + 1;
      const next = pick();
      if (!next) {
        finished = true;
        outOfHypotheses = true;
        return { content: "No hypothesis left to test.\n[TASK_COMPLETE]" };
      }
      current = next;
      tries.set(current.id, (tries.get(current.id) ?? 0) + 1);
      const t0 = performance.now();
      let rw;
      try {
        rw = await a.rewriter.rewrite({ sql: a.sql, plan: a.plan, diagnosis: a.diagnosis, hypothesis: current, facts: a.facts, carryover, carryoverKey: carryoverKey(ledger, rejected), attemptNo: n });
      } catch (e) {
        llmError = { unavailable: e instanceof SampleModeNoLLM, message: (e as Error).message.slice(0, 300) };
        a.trace.emit({
          agent_name: "Rewriter", action: n > 1 ? "retry" : "rewrite", input_summary: `hypothesis ${current.id}`, output_summary: llmError.message,
          target_agent: "Orchestrator", retry_count: n - 1, status: llmError.unavailable ? "skipped" : "error",
        });
        finished = true;
        return { content: `Rewriter unavailable: ${neutralise(llmError.message)}\n[TASK_COMPLETE]` };
      }
      a.trace.emit({
        agent_name: "Orchestrator", action: "handoff", input_summary: `attempt ${n} SQL from Rewriter`, output_summary: "to Verifier", target_agent: "Verifier",
        sponsor_call: { service: "markovian", name: "chunk", latency_ms: Math.round(performance.now() - t0) }, retry_count: n - 1, status: "ok",
      });
      const att = await a.verifier.verify(
        { n, origin: "rewriter", hypothesis_id: current.id, sql: rw.sql, change_summary: rw.change_summary },
        a.pre,
        { lastAttempt: n >= a.maxAttempts },
      );
      attempts.push(att);
      if (att.verdict === "ACCEPT") {
        current.status = "confirmed";
        current.evidence = att.timing_ms ? `${att.timing_ms.median_speedup}× median, ${att.timing_ms.faster_pairs}/${att.timing_ms.orig.length} pairs faster` : undefined;
        accepted = att;
        finished = true;
        return { content: `Attempt ${n} accepted for ${current.id}.\n[TASK_COMPLETE]` };
      }
      rejected.push(att);
      if (att.reason === "NOT_FASTER") current.status = att.not_faster_detail === "no_gain" ? "falsified" : "unproven";
      else current.status = "unproven";
      const block = carryoverBlock(ledger, rejected);
      carryovers.push(block);
      return { content: `Attempt ${n} rejected for ${current.id}: ${att.reason}.\n[STATE_CHECKPOINT]\n${block}` };
    },
  });
  return {
    attempts, accepted, llmError, upstreamError: run.status === "errored" ? (run.error ?? "chain errored") : null,
    markovian: { chunks: run.chunks.length, carryover_present: run.chunks.map((c) => c.carryover !== ""), status: run.status, carryovers, out_of_hypotheses: outOfHypotheses },
  };
}
