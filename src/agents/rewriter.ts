import { z } from "zod";
import { LlmGateway } from "../adapters/nim.js";
import type { Plan } from "../engine/types.js";
import type { Trace } from "../trace.js";
import type { Diagnosis, Hypothesis } from "../types.js";
import { normaliseSql, planExcerpt } from "./diagnoser.js";
import { keyFactLine, type KeyFact } from "./profile.js";

// Rewriter: one attempt = one LLM call returning {hypothesis_id, sql, change_summary, risk_notes}. hypothesis_id is a one-element
// enum — the orchestrator assigns the hypothesis, the Rewriter targets it and never picks. The prompt carries the Markovian
// carryover (tested hypotheses, rejected attempts and why) and the measured key facts; the product is not prompted worse to make
// a trap more likely. The reply is untrusted text: only the Verifier decides anything about it.

export const REWRITER_SYSTEM =
  "You rewrite SQL for a Spark-based engine (Hive dialect) so it runs faster while returning EXACTLY the same rows. A deterministic " +
  "verifier will execute your rewrite on the real data and reject any difference in rows, NULLs, duplicates or column types, and " +
  "any rewrite that is not measurably faster. Use the key facts: a transformation is only valid if the data satisfies its " +
  "precondition (for example, a join may be removed only if the joined key is unique). Keep the same output column names. " +
  "Return one single SELECT statement. Reply with ONLY a JSON object.";

export interface RewriteContext {
  sql: string;
  plan: Plan | null;
  diagnosis: Diagnosis;
  hypothesis: Hypothesis;
  facts: KeyFact[];
  carryover: string; // Markovian carryover text, "" on the first attempt
  carryoverKey: string; // timing-free description of the same state, for the llm-cache key
  attemptNo: number;
}

export interface Rewrite {
  hypothesis_id: string;
  sql: string;
  change_summary: string;
  risk_notes: string;
}

export class Rewriter {
  constructor(private readonly llm: LlmGateway, private readonly trace: Trace, private readonly reasoning: "on" | "off" = "on") {}

  async rewrite(c: RewriteContext): Promise<Rewrite> {
    const Reply = z.object({
      hypothesis_id: z.literal(c.hypothesis.id),
      sql: z.string().min(10).max(20_000),
      change_summary: z.string().min(5).max(400),
      risk_notes: z.string().max(600).default(""),
    });
    const user = [
      "ORIGINAL SQL:", c.sql.trim(), "",
      "PHYSICAL PLAN (node ids in parentheses):", planExcerpt(c.plan, 4000), "",
      `DIAGNOSIS: ${c.diagnosis.bottleneck}`,
      `TARGET HYPOTHESIS ${c.hypothesis.id} (plan node ${c.hypothesis.plan_node_id}): ${c.hypothesis.claim}`, "",
      c.facts.length ? `MEASURED KEY FACTS:\n${c.facts.map(keyFactLine).join("\n")}` : "MEASURED KEY FACTS: none (no joins).", "",
      c.carryover ? `CARRYOVER STATE FROM EARLIER ATTEMPTS:\n${c.carryover}` : "This is the first attempt.", "",
      `Write rewrite attempt ${c.attemptNo} for hypothesis ${c.hypothesis.id}.`,
      `Reply with JSON: {"hypothesis_id": "${c.hypothesis.id}", "sql": "<the rewritten single SELECT>", "change_summary": "<one sentence: what changed>", "risk_notes": "<what could make it differ on the data, or empty>"}`,
    ].join("\n");
    const t0 = performance.now();
    const r = await this.llm.call(
      "rewrite",
      { sql: normaliseSql(c.sql), hypothesis: c.hypothesis.id, claim: c.hypothesis.claim, attempt: c.attemptNo, carryover: c.carryoverKey },
      { system: REWRITER_SYSTEM, user, reasoning: this.reasoning, maxTokens: 8000, temperature: 1.0 },
      (raw) => Reply.parse(raw),
    );
    this.trace.emit({
      agent_name: "Rewriter", action: c.attemptNo > 1 ? "retry" : "rewrite", input_summary: `hypothesis ${c.hypothesis.id}: ${c.hypothesis.claim.slice(0, 90)}`,
      output_summary: `${r.out.change_summary.slice(0, 140)} | sql ${r.out.sql.replace(/\s+/g, " ").slice(0, 100)}`, target_agent: "Verifier",
      sponsor_call: { service: r.source === "nim" ? "nim" : "llm-cache", name: "chat_completions", latency_ms: Math.round(performance.now() - t0) },
      retry_count: c.attemptNo - 1, status: "ok",
    });
    return r.out;
  }
}
