import type { Case } from "../types.js";

// Plain-markdown dossier for one case. Every number printed here is copied from a Verifier field on the case; none is computed
// by a model. (The Report UI in P24 renders the same case JSON.)

const sql = (s: string) => "```sql\n" + s.trim() + "\n```";

export function caseMarkdown(c: Case): string {
  const out: string[] = [`# Query Doctor — ${c.verdict}`, ""];
  out.push(`run \`${c.run_id}\` · engine ${c.engine} · llm ${c.llm} · ${c.started_at}`, "");
  out.push("## Original", sql(c.sql), "");
  if (c.precheck) out.push(`Pre-check: deterministic ${c.precheck.deterministic}, ${c.precheck.rows} row(s), fingerprint \`${c.precheck.fingerprint.slice(0, 16)}\` (${c.precheck.fingerprint_kind}).`, "");
  if (c.diagnosis) {
    out.push("## Diagnosis", `- pattern: \`${c.diagnosis.pattern_label}\` (deterministic detector)`, `- ${c.diagnosis.bottleneck}`);
    out.push(`- narrative: ${c.diagnosis.narrative}`);
    for (const h of c.diagnosis.hypotheses) out.push(`- **${h.id}** [${h.status}] (${h.source}, plan node ${h.plan_node_id}) ${h.claim}${h.evidence ? ` — ${h.evidence}` : ""}`);
    out.push("");
  }
  if (c.attempts.length) out.push("## Attempts");
  for (const a of c.attempts) {
    out.push(`### Attempt ${a.n} — ${a.verdict}${a.reason ? ` (${a.reason}${a.not_faster_detail ? "/" + a.not_faster_detail : ""})` : ""}`);
    out.push(`origin ${a.origin}${a.hypothesis_id ? ` · hypothesis ${a.hypothesis_id}` : ""} · ${a.change_summary}`, sql(a.sql));
    out.push(`rows ${a.rows.orig} vs ${a.rows.rewrite}${a.detail ? ` · ${a.detail}` : ""}`);
    if (a.first_diff) out.push(`first difference (${a.first_diff.side} only): \`${JSON.stringify(a.first_diff.row)}\``);
    if (a.timing_ms) out.push(`timing: median ${a.timing_ms.median_speedup}×, saving ${a.timing_ms.median_saving_ms} ms, ${a.timing_ms.faster_pairs}/${a.timing_ms.orig.length} pairs faster (noise floor ${a.timing_ms.noise_floor_ms} ms)`);
    out.push("");
  }
  out.push(`## Verdict: ${c.verdict}${c.no_rewrite_reason ? ` — ${c.no_rewrite_reason}` : ""}`);
  if (c.detail) out.push(c.detail);
  return out.join("\n") + "\n";
}
