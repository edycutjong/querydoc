// Eval: Query Doctor vs a plain one-shot model baseline, scored by the same Verifier. Writes evals/results.md (+ raw JSONL).
//   npm run eval                                  regenerate results.md from the recorded runs (no network, no key)
//   npm run eval -- --arm baseline                baseline arm on the sample pack, DuckDB, N = 3 per query (needs Meterless Nightshift: METERLESS_RUNTIME_TOKEN)
//   npm run eval -- --arm baseline --engine zetaris   baseline arm on the live hero + traps (needs ZETARIS_JDBC_* too; slow)
// Baseline = ONE call, prompt below, no diagnosis, no memory, no feedback, one attempt, through the same guard + Verifier. Prompt
// hashes of every arm are written into results.md. The queries are ones WE designed (a non-designed set was cut, see results.md).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmClientFromEnv } from "../src/adapters/llm.js";
import type { LlmClient } from "../src/adapters/nim.js";
import { Verifier } from "../src/agents/verifier.js";
import { ROOT, loadConfig } from "../src/config.js";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import type { QueryEngine } from "../src/engine/types.js";
import { ZetarisEngine, zetarisConfigFromEnv } from "../src/engine/zetaris.js";
import { loadQuerydocEnv } from "../src/env.js";
import { Trace } from "../src/trace.js";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const arm = opt("arm", "pipeline");
const engineName = opt("engine", "duckdb") as "duckdb" | "zetaris";
const N = Number(opt("n", "3"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const stripComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
const RAW = join(ROOT, "evals", "raw");

export const BASELINE_SYSTEM = "You are a SQL performance expert.";
export const BASELINE_USER = (sql: string, dialect: string) => `Rewrite this ${dialect} query to run faster. Return only SQL.\n\n${sql}`;

const SETS: Record<"duckdb" | "zetaris", { id: string; label: string; file: string; trap: string }[]> = {
  duckdb: [
    { id: "hero", label: "hero (unused LEFT JOIN, sample)", file: "evals/queries/sample/01-hero.sql", trap: "-" },
    { id: "T1", label: "trap T1 (LEFT JOIN + filter in ON)", file: "evals/queries/sample/03-trap-left-join.sql", trap: "T1" },
    { id: "T2", label: "trap T2 (UNION dedupe)", file: "evals/queries/sample/04-trap-union.sql", trap: "T2" },
    { id: "T3", label: "trap T3 (NOT IN with NULLs)", file: "evals/queries/sample/05-trap-not-in.sql", trap: "T3" },
    { id: "control", label: "no-gain control", file: "evals/queries/sample/06-no-gain-control.sql", trap: "-" },
  ],
  zetaris: [
    { id: "hero", label: "hero (trino#2939 shape, store_sales × promotion)", file: "evals/queries/zetaris/01-hero.sql", trap: "-" },
    { id: "hero-trap", label: "hero trap (duplicated key)", file: "evals/queries/zetaris/01-hero-trap-dupkey.sql", trap: "dupkey" },
    { id: "T1", label: "trap T1 (outer join + filter)", file: "evals/queries/zetaris/02-t1-outer-join-filter.sql", trap: "T1" },
  ],
};

function extractSql(content: string): string {
  const fenced = content.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? content).trim().replace(/;\s*$/, "");
}

interface BaselineRow {
  engine: string; query: string; run: number; at: string; model: string; provider?: string; outcome: string; reason?: string; sql: string; speedup?: number; first_diff?: unknown;
}

async function baseline() {
  loadQuerydocEnv();
  const client = llmClientFromEnv();
  if (!client) {
    console.error("eval --arm baseline needs a live model: METERLESS_RUNTIME_TOKEN (~/.config/querydoc/nightshift.env) with Meterless Nightshift running");
    process.exit(2);
  }
  let engine: QueryEngine;
  if (engineName === "zetaris") {
    const z = zetarisConfigFromEnv();
    if (!z) {
      console.error("Zetaris JDBC settings missing");
      process.exit(2);
    }
    engine = new ZetarisEngine(z);
  } else engine = await DuckDbEngine.open({});
  const cfg = loadConfig(undefined, engineName);
  const dialect = engineName === "zetaris" ? "Spark SQL" : "DuckDB SQL";
  mkdirSync(RAW, { recursive: true });
  const file = join(RAW, `baseline-${engineName}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z.jsonl`);
  console.log(`baseline arm · ${engineName} · N=${N} · provider ${(client as LlmClient).provider} · route ${(client as LlmClient).model} · prompt ${sha(BASELINE_SYSTEM + BASELINE_USER("<sql>", dialect))} → ${file}`);
  try {
    for (const q of SETS[engineName]) {
      const sql = stripComments(read(q.file));
      for (let i = 1; i <= N; i++) {
        const trace = new Trace(`baseline-${q.id}-${i}`);
        const v = new Verifier(engine, cfg, trace);
        const row: BaselineRow = { engine: engineName, query: q.id, run: i, at: new Date().toISOString(), model: (client as LlmClient).model, outcome: "", sql: "" };
        try {
          // A rate-limited provider answers HTTP 429: wait and ask again, up to 6 tries, before the run counts as an error.
          let r: Awaited<ReturnType<LlmClient["chat"]>> | undefined;
          for (let t = 1; !r; t++) {
            try {
              r = await (client as LlmClient).chat({ system: BASELINE_SYSTEM, user: BASELINE_USER(sql, dialect), reasoning: "off", maxTokens: 4000, temperature: 1.0 });
            } catch (e) {
              if (!/429/.test(String(e)) || t >= 6) throw e;
              await new Promise((res) => setTimeout(res, 20_000 * t));
            }
          }
          row.sql = extractSql(r.content);
          row.provider = r.provider;
          row.model = r.handledModel ?? r.requestedModel; // the model that handled the request, as the response reports it
          const pre = await v.precheck(sql);
          const a = await v.verify({ n: 1, origin: "rewriter", hypothesis_id: null, sql: row.sql, change_summary: "baseline one-shot" }, pre, { lastAttempt: true });
          row.outcome = a.verdict === "ACCEPT" ? "identical_and_faster" : a.reason === "ROW_DIFF" ? "rows_changed" : a.reason === "NOT_FASTER" ? "identical_not_faster" : a.reason === "GUARD" ? "refused_by_guard" : "error";
          if (a.reason) row.reason = a.reason + (a.not_faster_detail ? `/${a.not_faster_detail}` : "");
          if (a.timing_ms) row.speedup = a.timing_ms.median_speedup;
          if (a.first_diff) row.first_diff = a.first_diff;
        } catch (e) {
          row.outcome = "error";
          row.reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        }
        appendFileSync(file, JSON.stringify(row) + "\n");
        console.log(`${q.id} #${i}: ${row.outcome}${row.reason ? ` (${row.reason})` : ""}${row.speedup ? ` ${row.speedup}×` : ""}`);
      }
    }
  } finally {
    await engine.close().catch(() => undefined);
  }
}

// --- results.md ---------------------------------------------------------------------------------------------------------------
const latest = (prefix: string): { file: string; rows: BaselineRow[] } | null => {
  if (!existsSync(RAW)) return null;
  const fs = readdirSync(RAW).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort();
  const f = fs.at(-1);
  return f ? { file: `evals/raw/${f}`, rows: read(`evals/raw/${f}`).split("\n").filter(Boolean).map((l) => JSON.parse(l) as BaselineRow) } : null;
};

// Evidence recorded before the Nightshift adapter existed carries no provider field: it went to direct NVIDIA NIM (the declared fallback).
const providerLabel = (p?: string) => (p === "nightshift" ? "Meterless Nightshift → NVIDIA Nemotron" : p === "nim" || !p ? "direct NVIDIA NIM (declared fallback; recorded before the Nightshift adapter, a Nightshift re-recording is pending)" : p);

const pctOf = (k: number, n: number) => (n ? `${k}/${n} (${Math.round((100 * k) / n)}%)` : "—");
type Run = { verdict: string; no_rewrite_reason?: string | null; attempts: number; first_attempt: string; route: string };

function qdSample() {
  const m = JSON.parse(read("recorded/sample/MANIFEST.json")) as { recorded_at: string; model: string; prompt_hashes?: unknown; traps: Record<string, Run[]>; runs: Record<string, Run> };
  return m;
}

function write() {
  const live = JSON.parse(read("recorded/live/MANIFEST.json")) as { recorded_at: string; model: string; requested_model?: string; provider?: string; runs: Record<string, Run[]> };
  const sample = qdSample();
  const L: string[] = [
    "# Eval results",
    "",
    "Generated by `npm run eval` from the recorded runs (`recorded/`), the baseline raw files (`evals/raw/`) and the bench runs; nothing is typed by hand.",
    "**What this is and is not:** the queries are ones we designed (the hero, its trap siblings, two controls). A set of queries *not* designed by us was cut from",
    "the build (autopilot §Cuts), so these shares say nothing about a general rate on arbitrary workloads. N is small (shown beside every share).",
    "",
    "Definitions. *Changed rows* = the Verifier found a row difference (a wrong result that only execution exposed). *Identical and faster* = the Verifier ACCEPTed",
    "(same rows, ≥ 1.2× median, saving above the noise floor, a majority of pairs won). Both arms are scored by the same Verifier on the same engine.",
    "",
  ];

  // Query Doctor arm (recorded)
  L.push("## Arm A — Query Doctor (full pipeline)", "", `Live pack recorded ${live.recorded_at}, sample pack recorded ${sample.recorded_at}, model ${live.requested_model ?? live.model}, provider ${providerLabel(live.provider)}.`, "");
  L.push("### Live runs on Zetaris (`recorded/live/`)", "", "| Query | Runs | Verdicts | Routing path (attempt verdicts in order) |", "|---|---:|---|---|");
  let liveAcc = 0, liveN = 0, liveWrongShipped = 0;
  for (const [name, rs] of Object.entries(live.runs)) {
    liveN += rs.length;
    liveAcc += rs.filter((r) => r.verdict === "ACCEPTED").length;
    L.push(`| ${name} | ${rs.length} | ${rs.map((r) => r.verdict + (r.no_rewrite_reason ? "/" + r.no_rewrite_reason : "")).join("; ")} | ${rs.map((r) => r.route).join(" ‖ ")} |`);
  }
  L.push("", `Accepted ${pctOf(liveAcc, liveN)}; rewrites shipped with changed rows: ${liveWrongShipped} (an ACCEPT requires an identical row fingerprint, by construction).`, "");
  L.push("### Sample pack on DuckDB (`recorded/sample/`)", "", "| Input | Verdict | Routing path |", "|---|---|---|");
  for (const [name, r] of Object.entries(sample.runs)) L.push(`| ${name} | ${r.verdict}${r.no_rewrite_reason ? "/" + r.no_rewrite_reason : ""} | ${r.route} |`);
  L.push("", "Trap repeats (each run from an empty playbook; first attempt = the model's first rewrite):", "", "| Trap | Runs | First attempt refused for changed rows | Runs ending ACCEPTED |", "|---|---:|---|---:|");
  for (const [t, rs] of Object.entries(sample.traps)) L.push(`| ${t} | ${rs.length} | ${pctOf(rs.filter((r) => r.first_attempt === "REJECT/ROW_DIFF").length, rs.length)} | ${rs.filter((r) => r.verdict === "ACCEPTED").length} |`);

  // Baseline arm
  L.push("", "## Arm B — baseline (one plain model call, no diagnosis, no memory, no feedback, one attempt)", "");
  L.push(`Prompt (system): \`${BASELINE_SYSTEM}\` · user template: \`Rewrite this <dialect> query to run faster. Return only SQL.\` · hash \`${sha(BASELINE_SYSTEM + BASELINE_USER("<sql>", "<dialect>"))}\` (dialect substituted per engine).`, "");
  const combined: Record<string, { b: BaselineRow[] }> = {};
  for (const eng of ["duckdb", "zetaris"] as const) {
    const b = latest(`baseline-${eng}-`);
    if (!b) {
      L.push(`### ${eng === "duckdb" ? "Sample pack (DuckDB)" : "Live (Zetaris)"}`, "", "_Not run yet — `npm run eval -- --arm baseline" + (eng === "zetaris" ? " --engine zetaris" : "") + "`._", "");
      continue;
    }
    combined[eng] = { b: b.rows };
    L.push(`### ${eng === "duckdb" ? "Sample pack (DuckDB)" : "Live (Zetaris)"} — raw: \`${b.file}\` · model ${b.rows[0]?.model} · provider ${providerLabel(b.rows[0]?.provider)}`, "");
    L.push("| Query | Runs | Changed rows | Identical and faster | Identical, not faster | Other (guard/error) |", "|---|---:|---|---|---|---|");
    const byQ = new Map<string, BaselineRow[]>();
    for (const r of b.rows) byQ.set(r.query, [...(byQ.get(r.query) ?? []), r]);
    const cnt = (rs: BaselineRow[], o: string) => rs.filter((r) => r.outcome === o).length;
    for (const [q, rs] of byQ) L.push(`| ${q} | ${rs.length} | ${pctOf(cnt(rs, "rows_changed"), rs.length)} | ${pctOf(cnt(rs, "identical_and_faster"), rs.length)} | ${pctOf(cnt(rs, "identical_not_faster"), rs.length)} | ${rs.length - cnt(rs, "rows_changed") - cnt(rs, "identical_and_faster") - cnt(rs, "identical_not_faster")} |`);
    const all = b.rows;
    L.push(`| **all** | ${all.length} | **${pctOf(cnt(all, "rows_changed"), all.length)}** | **${pctOf(cnt(all, "identical_and_faster"), all.length)}** | ${pctOf(cnt(all, "identical_not_faster"), all.length)} | ${all.length - cnt(all, "rows_changed") - cnt(all, "identical_and_faster") - cnt(all, "identical_not_faster")} |`, "");
  }

  // Head to head on the trap queries
  L.push("## Side by side on the same trap queries (different run counts, not head-to-head)", "");
  const trapRuns = Object.values(sample.traps).flat();
  const trapFirstBad = trapRuns.filter((r) => r.first_attempt === "REJECT/ROW_DIFF").length;
  L.push(`Query Doctor's first rewrite on the sample traps changed rows in ${pctOf(trapFirstBad, trapRuns.length)} of runs — every one of those was refused by the Verifier and none shipped.`);
  const bd = combined.duckdb?.b.filter((r) => ["T1", "T2", "T3"].includes(r.query));
  if (bd?.length) {
    const ch = bd.filter((r) => r.outcome === "rows_changed").length;
    L.push(`The baseline's one rewrite on the same traps changed rows in ${pctOf(ch, bd.length)} of runs; a single call has no execution check of its own, so nothing in that arm would have caught them.`);
  } else L.push("Baseline on the sample traps: not run yet.");
  L.push("");
  writeFileSync(join(ROOT, "evals", "results.md"), L.join("\n"));
  console.log(`wrote evals/results.md (${L.length} lines)`);
}

(async () => {
  if (arm === "baseline") await baseline();
  else if (arm !== "pipeline") throw new Error(`unknown --arm ${arm}`);
  write();
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
