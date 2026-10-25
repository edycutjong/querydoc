// Latency probe (build-plan Day 3): one Diagnoser and one Rewriter call on the hero with reasoning on and off, through the real
// agent classes and prompts. Writes evidence/nim-probe/<run>/results.json (latency, completion tokens, reasoning chars, whether the
// reply validated, and — for the Rewriter — the SQL it proposed; nothing here is executed). The chosen mode goes in docs/DX-REPORT.md.
//
//   npx tsx scripts/nim_probe.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmGateway } from "../src/adapters/nim.js";
import { nimClientFromEnv } from "../src/adapters/nim.js";
import { Diagnoser } from "../src/agents/diagnoser.js";
import { detectPatterns } from "../src/agents/patterns.js";
import { Rewriter } from "../src/agents/rewriter.js";
import { ROOT } from "../src/config.js";
import { parseSparkPlan } from "../src/engine/sparkPlan.js";
import { loadQuerydocEnv } from "../src/env.js";
import { Trace } from "../src/trace.js";

loadQuerydocEnv();
const client = nimClientFromEnv();
if (!client) {
  console.error("NVIDIA_API_KEY missing (~/.config/querydoc/nvidia.env)");
  process.exit(2);
}
const sql = readFileSync(join(ROOT, "input_examples/live/hero.json"), "utf8");
const heroSql = (JSON.parse(sql) as { sql: string }).sql;
const text = readFileSync(join(ROOT, "test/fixtures/hero-explain-formatted.txt"), "utf8");
const plan = { format: "spark-physical-text" as const, text, nodes: parseSparkPlan(text), wallMs: 0 };
const facts = [{ table: "tpcds_db.promotion", column: "p_promo_sk", rows: 300, non_null: 300, distinct: 300, unique: true }];
const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const dir = join(ROOT, "evidence/nim-probe", runId);
mkdirSync(dir, { recursive: true });
const results: unknown[] = [];

for (const mode of ["on", "off"] as const) {
  const trace = new Trace(`probe-${mode}`, join(dir, `trace-${mode}.jsonl`));
  const gw = new LlmGateway({ client });
  const det = detectPatterns(heroSql, plan);
  const t0 = performance.now();
  const dx = await new Diagnoser(gw, trace, mode).diagnose(heroSql, plan, det, facts);
  const dMs = performance.now() - t0;
  const h = dx.hypotheses[0]!;
  const t1 = performance.now();
  let rw: unknown = null;
  let rwOk = true;
  try {
    rw = await new Rewriter(gw, trace, mode).rewrite({ sql: heroSql, plan, diagnosis: dx, hypothesis: h, facts, carryover: "", carryoverKey: "", attemptNo: 1 });
  } catch (e) {
    rwOk = false;
    rw = (e as Error).message;
  }
  const rMs = performance.now() - t1;
  const row = { reasoning: mode, diagnoser_ms: Math.round(dMs), diagnoser_narrative: dx.narrative, diagnoser_hypotheses: dx.hypotheses.length, rewriter_ms: Math.round(rMs), rewriter_valid: rwOk, rewriter_reply: rw };
  results.push(row);
  console.log(JSON.stringify({ ...row, rewriter_reply: undefined }));
}
writeFileSync(join(dir, "results.json"), JSON.stringify({ run: runId, model: client.model, results }, null, 2) + "\n");
console.log("wrote", join(dir, "results.json"));
