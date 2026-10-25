import { Markovian, canonicalBlock } from "../../vendor/meterless/markovian/src/index.ts";
import { SampleModeNoLLM } from "../adapters/nim.js";
import type { Attempt, Precheck, Verifier } from "../agents/verifier.js";
import type { Rewriter } from "../agents/rewriter.js";
import type { KeyFact } from "../agents/profile.js";
import type { Plan } from "../engine/types.js";
import type { Trace } from "../trace.js";
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
  markovian: { chunks: number; carryoverLevels: string[]; status: string; carryovers: string[] };
}

const cap = (s: string, n = MAX_FIELD) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function carryoverBlock(ledger: Hypothesis[], rejected: Attempt[]): string {
  const done = ledger.filter((h) => h.status !== "untested").map((h) => `${h.id} ${h.status}${h.evidence ? ` (${h.evidence})` : ""}`);
  const left = ledger.filter((h) => h.status === "untested").map((h) => h.id);
  const last = rejected[rejected.length - 1];
  return canonicalBlock({
    completed: cap(done.join(" · ") || "none"),
    remaining: cap(left.join(" · ") || "none"),
    decisions: cap(rejected.map((a) => `attempt ${a.n} on ${a.hypothesis_id ?? "candidate"} rejected ${a.reason}${a.not_faster_detail ? "/" + a.not_faster_detail : ""}`).join(" · ") || "none"),
    context: cap(last ? `last rejected SQL: ${last.sql.replace(/\s+/g, " ")} — ${last.detail ?? last.reason}${last.first_diff ? ` — first differing row (${last.first_diff.side}): ${JSON.stringify(last.first_diff.row)}` : ""}` : "no attempt yet"),
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

  const pick = (): Hypothesis => {
    const last = attempts[attempts.length - 1];
    const sameKind = last && (last.reason === "ROW_DIFF" || last.reason === "GUARD" || last.reason === "ERROR" || last.verdict === "REFUSED");
    if (current && sameKind && (tries.get(current.id) ?? 0) < 2) return current;
    return ledger.find((h) => h.status === "untested") ?? ledger.find((h) => h.status === "unproven") ?? current ?? ledger[0]!;
  };

  const mk = new Markovian({ chunkConfig: { ...CHUNK_CONFIG, maxChunks: a.maxAttempts } });
  const carryovers: string[] = [];
  const run = await mk.run({
    goal: "Find a faster rewrite that the Verifier proves returns the same rows",
    reflect: false,
    stopWhen: () => finished,
    stepFn: async ({ carryover }) => {
      const n = attempts.length + 1;
      current = pick();
      tries.set(current.id, (tries.get(current.id) ?? 0) + 1);
      const t0 = performance.now();
      let rw;
      try {
        rw = await a.rewriter.rewrite({ sql: a.sql, plan: a.plan, diagnosis: a.diagnosis, hypothesis: current, facts: a.facts, carryover, attemptNo: n });
      } catch (e) {
        llmError = { unavailable: e instanceof SampleModeNoLLM, message: (e as Error).message.slice(0, 300) };
        a.trace.emit({
          agent_name: "Rewriter", action: n > 1 ? "retry" : "rewrite", input_summary: `hypothesis ${current.id}`, output_summary: llmError.message,
          target_agent: "Orchestrator", retry_count: n - 1, status: llmError.unavailable ? "skipped" : "error",
        });
        finished = true;
        return { content: `Rewriter unavailable: ${llmError.message}\n[TASK_COMPLETE]` };
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
    markovian: { chunks: run.chunks.length, carryoverLevels: run.chunks.map((c) => (c.carryover ? "marker" : "none")), status: run.status, carryovers },
  };
}
