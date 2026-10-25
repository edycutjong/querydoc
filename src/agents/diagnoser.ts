import { z } from "zod";
import { LlmGateway, NIM_MODEL, SampleModeNoLLM } from "../adapters/nim.js";
import type { Plan } from "../engine/types.js";
import { schemaFqn } from "../memory/playbook.js";
import { canonicalSql } from "../sql/text.js";
import type { Attempt } from "./verifier.js";
import type { Trace } from "../trace.js";
import type { Diagnosis, Hypothesis } from "../types.js";
import { keyFactLine, type KeyFact } from "./profile.js";
import type { Detection } from "./patterns.js";

// Diagnoser: (1) the deterministic detector result is always present (label + cited plan nodes + one detector hypothesis);
// (2) an LLM narrative {bottleneck, hypotheses[]} when a key or a cache entry exists. Every hypothesis must cite a plan node that
// exists in the cited list — an uncited or invented node drops the hypothesis (logged). It never produces a verdict or a number.

const Reply = z.object({
  bottleneck: z.string().min(10).max(600),
  hypotheses: z.array(z.object({ plan_node_id: z.union([z.string(), z.number()]).transform(String), claim: z.string().min(10).max(500) })).min(1).max(4),
});

export const DIAGNOSER_SYSTEM =
  "You are a SQL performance diagnostician for a Spark-based query engine (Hive dialect). You read a query, its physical plan and " +
  "facts about the join keys, and say where the time goes and why. You never claim a speed-up number and never claim a rewrite is " +
  "correct: a separate verifier executes candidate rewrites on the real data. Reply with ONLY a JSON object.";

export const engineSystem = (system: string, engine: string): string =>
  engine === "duckdb" ? system.replace("a Spark-based query engine (Hive dialect)", "DuckDB (PostgreSQL-like dialect)").replace("a Spark-based engine (Hive dialect)", "DuckDB (PostgreSQL-like dialect)") : system;

// Diagnoser.revise: after a NOT_FASTER(no_gain) verdict (rows identical, no time saved) the ledger is updated by the orchestrator and the
// Diagnoser decides what to try next. Its answer is a pick among the untested hypotheses, one new hypothesis citing a real plan node,
// or a withdrawal. It reads the Verifier's numbers; it never produces one.
export const REVISE_SYSTEM =
  "You revise a SQL performance diagnosis. A rewrite was verified to return the same rows but was not faster, so the hypothesis it " +
  "tested is falsified. Decide what to try next: pick one of the untested hypotheses, propose ONE new falsifiable hypothesis that cites " +
  "a node of the physical plan, or withdraw if nothing plausible is left. You never claim a speed-up number. Reply with ONLY a JSON object.";

export const ReviseReply = z.discriminatedUnion("action", [
  z.object({ action: z.literal("next"), hypothesis_id: z.string().min(2).max(8) }),
  z.object({ action: z.literal("new"), plan_node_id: z.union([z.string(), z.number()]).transform(String), claim: z.string().min(10).max(500) }),
  z.object({ action: z.literal("withdraw"), reason: z.string().min(3).max(300) }),
]);
export type ReviseOutcome =
  | { action: "next"; hypothesis_id: string; source: "nim" | "llm-cache" }
  | { action: "new"; plan_node_id: string; claim: string; source: "nim" | "llm-cache" }
  | { action: "withdraw"; reason: string; source: "nim" | "llm-cache" };

export const planExcerpt = (plan: Plan | null, max = 5000): string => (plan ? plan.text.slice(0, max) : "(no plan available)");

function detectorHypothesis(d: Detection): Hypothesis {
  const n = d.planNodes[0];
  const hit = d.hits[0];
  const claim: Record<string, string> = {
    unused_outer_join: "A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed.",
    outer_join_predicate: "A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost.",
    not_in_nullable: "NOT IN over a subquery forces a null-aware anti join, which is expensive.",
    correlated_subquery: "A correlated subquery is re-evaluated per outer row (or decorrelated into a costly join).",
    or_join_condition: "An OR inside the JOIN condition cannot use a hash join; the engine falls back to a nested-loop style join, which is far more expensive than two equi-joins.",
    union_dedupe: "UNION forces a deduplicating aggregate over both inputs.",
    non_sargable_predicate: "A function on a column in the predicate blocks pushdown and pruning.",
    distinct_over_fanout: "DISTINCT after a fan-out join deduplicates rows the join multiplied.",
    cross_source_join_no_pushdown: "A join across sources cannot push work down to either side.",
    other: "No known pattern matched; the plan's most expensive operator is the candidate.",
  };
  return {
    id: "h1", source: "detector", plan_node_id: n ? String(n.id) : "0",
    claim: `${claim[d.label]}${hit ? ` (matched: ${hit.evidence})` : ""}`, status: "untested",
  };
}

export class Diagnoser {
  constructor(private readonly llm: LlmGateway, private readonly trace: Trace, private readonly reasoning: "on" | "off" = "on", private readonly engine = "") {}

  async diagnose(sql: string, plan: Plan | null, d: Detection, facts: KeyFact[]): Promise<Diagnosis> {
    const diagnosis: Diagnosis = {
      bottleneck: `Detector: ${d.label}${d.hits[0] ? ` — ${d.hits[0].evidence}` : ""}`,
      pattern_label: d.label,
      plan_nodes: d.planNodes.map((n) => ({ id: String(n.id), op: n.op, note: n.note })),
      hypotheses: [detectorHypothesis(d)],
      raw_refs: [],
      narrative: "omitted",
    };
    this.trace.emit({
      agent_name: "Diagnoser", action: "detect_pattern", input_summary: `${sql.replace(/\s+/g, " ").slice(0, 100)}`,
      output_summary: `${d.label}; ${d.hits.length} hit(s); parser ${d.parsed ? "ok" : "fallback"}; cites plan nodes ${diagnosis.plan_nodes.map((n) => n.id).join(", ") || "none"}`,
      target_agent: "Rewriter", retry_count: 0, status: "ok",
    });

    const cited = new Set(diagnosis.plan_nodes.map((n) => n.id));
    // The plan nodes a hypothesis may cite: the detector's, plus any node of the plan (LLM may point at a scan or exchange).
    const allNodes = new Set([...cited, ...(plan?.nodes.map((n) => String(n.id)) ?? [])]);
    const user = [
      "SQL:", sql.trim(), "",
      "Physical plan (node ids in parentheses):", planExcerpt(plan), "",
      `Deterministic detector: pattern ${d.label}; cited plan nodes ${[...cited].join(", ") || "none"}.`,
      facts.length ? `Join-key facts (measured by SQL aggregate):\n${facts.map(keyFactLine).join("\n")}` : "Join-key facts: none (no joins).", "",
      'Reply with JSON: {"bottleneck": "<one or two sentences: where the time goes>", "hypotheses": [{"plan_node_id": "<an id from the plan>", "claim": "<a falsifiable claim about why this node is costly and what could change it>"}]}. 1 to 3 hypotheses, ranked most likely first.',
    ].join("\n");
    const t0 = performance.now();
    try {
      const r = await this.llm.call(
        "diagnose",
        { template: "diagnoser@1", model: NIM_MODEL, engine: this.engine, schema: schemaFqn(d.tables), sql: normaliseSql(sql), pattern: d.label, nodes: [...cited], facts: facts.map(keyFactLine) },
        { system: engineSystem(DIAGNOSER_SYSTEM, this.engine), user, reasoning: this.reasoning, maxTokens: 6000, temperature: 1.0 },
        (raw) => Reply.parse(raw),
      );
      diagnosis.bottleneck = r.out.bottleneck;
      diagnosis.narrative = r.source === "nim" ? "llm" : "llm-cache";
      let n = diagnosis.hypotheses.length;
      for (const h of r.out.hypotheses) {
        if (!allNodes.has(h.plan_node_id)) {
          diagnosis.raw_refs.push(`dropped hypothesis citing unknown plan node ${h.plan_node_id}`);
          continue;
        }
        diagnosis.hypotheses.push({ id: `h${++n}`, source: "llm", plan_node_id: h.plan_node_id, claim: h.claim, status: "untested" });
      }
      this.trace.emit({
        agent_name: "Diagnoser", action: "analyse_plan", input_summary: `plan ${plan?.nodes.length ?? 0} nodes + detector ${d.label}`,
        output_summary: `${r.out.hypotheses.length} LLM hypothesis(es), ${diagnosis.raw_refs.length} dropped; ranked: ${diagnosis.hypotheses.map((h) => h.id).join(" > ")}`,
        target_agent: "Rewriter", sponsor_call: { service: r.source === "nim" ? "nim" : "llm-cache", name: "chat_completions", latency_ms: Math.round(r.latencyMs) },
        retry_count: 0, status: "ok",
      });
    } catch (e) {
      const reason = e instanceof SampleModeNoLLM ? "no key and no cache entry — narrative omitted, detector hypothesis kept" : (e as Error).message.slice(0, 250);
      this.trace.emit({
        agent_name: "Diagnoser", action: "analyse_plan", input_summary: "LLM narrative", output_summary: reason, target_agent: "Rewriter",
        sponsor_call: { service: "nim", name: "chat_completions", latency_ms: Math.round(performance.now() - t0) }, retry_count: 0,
        status: e instanceof SampleModeNoLLM ? "skipped" : "error",
      });
    }
    return diagnosis;
  }

  // Called by the chain after NOT_FASTER(no_gain), with the ledger already updated (current → falsified). Throws SampleModeNoLLM
  // when there is no key and no cache entry; an answer that cites an unknown id or plan node is returned as a withdrawal.
  async revise(a: { schema?: string; sql: string; plan: Plan | null; diagnosis: Diagnosis; attempt: Attempt; carryoverKey: string; attemptNo: number }): Promise<ReviseOutcome> {
    const untested = a.diagnosis.hypotheses.filter((h) => h.status === "untested" || h.status === "unproven");
    const nodes = new Set([...a.diagnosis.plan_nodes.map((n) => n.id), ...(a.plan?.nodes.map((n) => String(n.id)) ?? [])]);
    const t = a.attempt.timing_ms;
    const user = [
      "SQL:", a.sql.trim(), "",
      "Physical plan (node ids in parentheses):", planExcerpt(a.plan), "",
      "HYPOTHESIS LEDGER:", ...a.diagnosis.hypotheses.map((h) => `- ${h.id} [${h.status}] (plan node ${h.plan_node_id}) ${h.claim}`), "",
      `LAST ATTEMPT (${a.attempt.origin}) on ${a.attempt.hypothesis_id ?? "a supplied candidate"}: rows identical, NOT FASTER — ${t ? `median ${t.median_speedup}×, saving ${t.median_saving_ms} ms, ${t.faster_pairs}/${t.orig.length} pairs faster` : "no timing"}.`,
      `UNTESTED OR UNPROVEN HYPOTHESES: ${untested.map((h) => h.id).join(", ") || "none"}.`, "",
      'Reply with ONE of: {"action":"next","hypothesis_id":"<an untested id>"} | {"action":"new","plan_node_id":"<a plan node id>","claim":"<falsifiable claim>"} | {"action":"withdraw","reason":"<why nothing plausible is left>"}.',
    ].join("\n");
    const t0 = performance.now();
    const r = await this.llm.call(
      "diagnose_revise",
      { template: "diagnoser.revise@1", model: NIM_MODEL, engine: this.engine, schema: a.schema ?? "", sql: normaliseSql(a.sql), pattern: a.diagnosis.pattern_label, attempt: a.attemptNo, carryover: a.carryoverKey },
      { system: engineSystem(REVISE_SYSTEM, this.engine), user, reasoning: this.reasoning, maxTokens: 4000, temperature: 1.0 },
      (raw) => ReviseReply.parse(raw),
    );
    let out: ReviseOutcome;
    const o = r.out;
    if (o.action === "next") {
      const id = o.hypothesis_id;
      out = untested.some((h) => h.id === id) ? { action: "next", hypothesis_id: id, source: r.source } : { action: "withdraw", reason: `no valid hypothesis (named ${id})`, source: r.source };
    } else if (o.action === "new") {
      out = nodes.has(o.plan_node_id) ? { action: "new", plan_node_id: o.plan_node_id, claim: o.claim, source: r.source } : { action: "withdraw", reason: `no valid hypothesis (unknown plan node ${o.plan_node_id})`, source: r.source };
    } else out = { action: "withdraw", reason: o.reason, source: r.source };
    this.trace.emit({
      agent_name: "Diagnoser", action: "revise", input_summary: `ledger after ${a.attempt.hypothesis_id ?? "candidate"} falsified; ${untested.length} untested`,
      output_summary: out.action === "next" ? `try ${out.hypothesis_id}` : out.action === "new" ? `new hypothesis on node ${out.plan_node_id}: ${out.claim.slice(0, 100)}` : `withdraw: ${out.reason}`,
      target_agent: out.action === "withdraw" ? "Orchestrator" : "Rewriter",
      sponsor_call: { service: r.source === "nim" ? "nim" : "llm-cache", name: "chat_completions", latency_ms: Math.round(performance.now() - t0) }, retry_count: a.attemptNo - 1, status: "ok",
    });
    return out;
  }
}

export const normaliseSql = canonicalSql;
