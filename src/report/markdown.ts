import type { Case } from "../types.js";
import { firstDiffWhere } from "../verify/diff.js";

// Plain-markdown dossier for one case. Every verdict and every number in the Attempts and Verdict sections is copied from a
// Verifier field on the case. Text a model wrote (the Diagnoser's reading and hypotheses, the Rewriter's change note) is printed too
// but is labelled as unverified model text. (The Report UI in P24 renders the same case JSON.)

const sql = (s: string) => "```sql\n" + s.trim() + "\n```";

export function caseMarkdown(c: Case): string {
  const out: string[] = [`# Query Doctor — ${c.verdict}`, ""];
  out.push(`run \`${c.run_id}\` · engine ${c.engine} · llm ${c.llm} · ${c.started_at}`, "");
  out.push("## Original", sql(c.sql), "");
  if (c.precheck) out.push(`Pre-check: deterministic ${c.precheck.deterministic}, ${c.precheck.rows} row(s), fingerprint \`${c.precheck.fingerprint.slice(0, 16)}\` (${c.precheck.fingerprint_kind}).`, "");
  if (c.engine === "duckdb") out.push("> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.", "");
  if (c.diagnosis) {
    const llmText = c.diagnosis.narrative !== "omitted";
    out.push("## Diagnosis", `- pattern: \`${c.diagnosis.pattern_label}\` (deterministic detector)`, `- ${llmText ? "Diagnoser's reading (model text, unverified): " : ""}${c.diagnosis.bottleneck}`);
    out.push(`- narrative: ${c.diagnosis.narrative}`);
    for (const h of c.diagnosis.hypotheses) out.push(`- **${h.id}** [${h.status}] (${h.source === "llm" ? "model claim, unverified" : "detector"}, plan node ${h.plan_node_id}) ${h.claim}${h.evidence ? ` — ${h.evidence}` : ""}`);
    out.push("");
  }
  if (c.attempts.length) out.push("## Attempts");
  for (const a of c.attempts) {
    out.push(`### Attempt ${a.n} — ${a.verdict}${a.reason ? ` (${a.reason}${a.not_faster_detail ? "/" + a.not_faster_detail : ""})` : ""}`);
    out.push(`origin ${a.origin}${a.hypothesis_id ? ` · hypothesis ${a.hypothesis_id}` : ""} · ${a.origin === "rewriter" ? "Rewriter's note (model text): " : ""}${a.change_summary}`, sql(a.sql));
    if (a.origin === "candidate_sql") {
      // Two plain fact lines for a human-supplied rewrite: "not safe" is reserved for rows that differ.
      const rowsLine = a.reason === "ROW_DIFF" ? `differ${a.first_diff ? ` (first differing row ${JSON.stringify(a.first_diff.row)}, ${firstDiffWhere(a.first_diff)})` : ""}` : a.reason === "GUARD" || a.reason === "ERROR" ? "not compared (the candidate did not run)" : "identical";
      const speedLine = a.verdict === "ACCEPT" ? `faster (median ${a.timing_ms?.median_speedup}×, saving ${a.timing_ms?.median_saving_ms} ms)`
        : a.reason === "NOT_FASTER" ? `not faster (gate missed: ${a.timing_ms?.gates_missed.join(", ") ?? "see timing"})`
        : "not measured — refused before timing";
      out.push(`**Rows:** ${rowsLine}`, `**Speed:** ${speedLine}`);
      if (a.reused_from) out.push(`**Memory:** this refusal was reused from the playbook ledger (${a.reused_from}); the candidate was not executed.`);
    }
    out.push(`rows ${a.rows.orig} vs ${a.rows.rewrite}${a.detail ? ` · ${a.detail}` : ""}`);
    if (a.first_diff) out.push(`first difference (${firstDiffWhere(a.first_diff)}): \`${JSON.stringify(a.first_diff.row)}\``);
    if (a.timing_ms) out.push(`timing: median ${a.timing_ms.median_speedup}×, saving ${a.timing_ms.median_saving_ms} ms, ${a.timing_ms.faster_pairs}/${a.timing_ms.orig.length} pairs faster (noise floor ${a.timing_ms.noise_floor_ms} ms)`);
    out.push("");
  }
  if (c.playbook_hits.length) out.push(`Playbook entries used: ${c.playbook_hits.map((h) => `\`${h}\``).join(", ")}`, "");
  out.push(`## Verdict: ${c.verdict}${c.no_rewrite_reason ? ` — ${c.no_rewrite_reason}` : ""}`);
  if (c.detail) out.push(`(${c.attempts.length ? "attempt summary / upstream message" : "upstream message"}) ${c.detail}`);
  return out.join("\n") + "\n";
}
