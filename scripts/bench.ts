// Reproducible timing proof: the hero query vs the rewrite the system accepted, N alternating pairs, p50 / p95 per side.
//   npx tsx scripts/bench.ts --engine zetaris --pairs 10     live (needs ZETARIS_JDBC_*; ~10 min on the local platform)
//   npx tsx scripts/bench.ts --engine duckdb  --pairs 20     keyless, committed NYC TLC subset
// Writes evidence/bench/<engine>-<stamp>/results.json and refreshes the generated block of DEMO.md (between the BENCH markers).
// Before timing, both sides run once and their result rows must be identical, otherwise nothing is reported.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.js";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import type { QueryEngine } from "../src/engine/types.js";
import { ZetarisEngine, zetarisConfigFromEnv } from "../src/engine/zetaris.js";
import { loadQuerydocEnv } from "../src/env.js";
import { median } from "../src/verify/timing.js";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const engineName = arg("engine", "zetaris") as "zetaris" | "duckdb";
const pairs = Math.max(3, Number(arg("pairs", engineName === "zetaris" ? "10" : "20")));
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
// Nearest-rank percentile (documented in DEMO.md): with N = 10, p95 is the slowest run.
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)]!;
const readSql = (rel: string) => readFileSync(join(ROOT, rel), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();

async function main() {
  loadQuerydocEnv();
  let engine: QueryEngine;
  let original: string;
  let rewrite: string;
  let rewriteSource: string;
  if (engineName === "zetaris") {
    const z = zetarisConfigFromEnv();
    if (!z) {
      console.error("Zetaris JDBC settings missing (ZETARIS_JDBC_URL / _JAR / _USER / _PASSWORD) — see .env.example");
      process.exit(2);
    }
    engine = new ZetarisEngine(z);
    original = readSql("evals/queries/zetaris/01-hero.sql");
    // The rewrite is what the system itself accepted in the recorded live run, not a hand-written one.
    const rec = JSON.parse(readFileSync(join(ROOT, "recorded/live/hero-r1/case.json"), "utf8")) as { attempts: { verdict: string; sql: string }[] };
    const acc = rec.attempts.find((a) => a.verdict === "ACCEPT");
    if (!acc) throw new Error("recorded/live/hero-r1 has no accepted attempt");
    rewrite = acc.sql;
    rewriteSource = "recorded/live/hero-r1/case.json (the Rewriter's accepted attempt)";
  } else {
    engine = await DuckDbEngine.open({});
    original = readSql("evals/queries/sample/01-hero.sql");
    rewrite = readSql("evals/queries/sample/01-hero.rewrite.sql");
    rewriteSource = "evals/queries/sample/01-hero.rewrite.sql (hand-written, committed)";
  }
  const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  try {
    const h = await engine.health();
    if (!h.ok) throw new Error(`engine unhealthy: ${h.error}`);
    const opts = { rowCap: 10_000, drain: true, timeoutSec: 300 } as const;
    const a = await engine.run(original, opts);
    const b = await engine.run(rewrite, opts);
    const rowsEqual = a.rowCount === b.rowCount && JSON.stringify(a.rows) === JSON.stringify(b.rows);
    say(`identity check: original ${a.rowCount} row(s), rewrite ${b.rowCount} row(s), rows equal: ${rowsEqual}`);
    if (!rowsEqual) throw new Error("original and rewrite return different rows — nothing to benchmark");
    const orig: number[] = [];
    const rew: number[] = [];
    for (let i = 0; i < pairs; i++) {
      const first = i % 2 === 0 ? "orig" : "rewrite";
      const run = async (sql: string) => (await engine.run(sql, opts)).wallMs;
      if (first === "orig") {
        orig.push(await run(original));
        rew.push(await run(rewrite));
      } else {
        rew.push(await run(rewrite));
        orig.push(await run(original));
      }
      say(`pair ${i + 1}/${pairs}: original ${r1(orig.at(-1)!)} ms, rewrite ${r1(rew.at(-1)!)} ms (${first} first)`);
    }
    const ratios = orig.map((o, i) => o / rew[i]!);
    const res = {
      engine: engineName,
      recorded_at: new Date().toISOString(),
      pairs,
      identical_rows: { original_rows: a.rowCount, rewrite_rows: b.rowCount },
      method: "wall clock in the calling process; alternating order (original first on even pairs); nearest-rank percentiles",
      rewrite_source: rewriteSource,
      original_ms: orig.map(r1),
      rewrite_ms: rew.map(r1),
      original: { p50: r1(pct(orig, 50)), p95: r1(pct(orig, 95)), median: r1(median(orig)) },
      rewrite: { p50: r1(pct(rew, 50)), p95: r1(pct(rew, 95)), median: r1(median(rew)) },
      speedup: { median_of_pair_ratios: r2(median(ratios)), p50_over_p50: r2(pct(orig, 50) / pct(rew, 50)), pairs_faster: ratios.filter((x) => x > 1).length },
    };
    const stamp = res.recorded_at.replace(/[:.]/g, "-").slice(0, 19) + "Z";
    const dir = join(ROOT, "evidence", "bench", `${engineName}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify(res, null, 2) + "\n");
    updateDemo(res, `evidence/bench/${engineName}-${stamp}/results.json`);
    say(`wrote ${dir}/results.json — speedup ${res.speedup.median_of_pair_ratios}× (median of pair ratios), ${res.speedup.pairs_faster}/${pairs} pairs faster`);
  } finally {
    await engine.close().catch(() => undefined);
  }
}

// DEMO.md keeps one generated block per engine; each regenerates from its own results.json, so every number in it greps to a run file.
function updateDemo(r: Record<string, any>, file: string) {
  const path = join(ROOT, "DEMO.md");
  const head = "# DEMO — measured proof\n\nEvery number below is copied from the run file named under it (`npm run bench`, `npm run eval`); nothing is typed by hand.\n\n";
  let doc = existsSync(path) ? readFileSync(path, "utf8") : head;
  const tag = `bench-${r.engine}`;
  // Only a rewrite taken from a recorded case is an accepted one; a hand-written comparison rewrite was never a Verifier ACCEPT.
  const rw = /case\.json/.test(String(r.rewrite_source)) ? "accepted rewrite" : "hand-written comparison rewrite (not a Verifier ACCEPT)";
  const block =
    `<!-- BEGIN ${tag} -->\n` +
    `## Benchmark — ${r.engine === "zetaris" ? "hero on the local Zetaris platform (TPCDS_DB, Parquet)" : "hero on the sample engine (DuckDB, committed NYC TLC subset)"}\n\n` +
    `Original vs the ${rw}, ${r.pairs} alternating pairs, wall clock, rows verified identical first ` +
    `(${r.identical_rows.original_rows} row(s) both sides). Rewrite: ${r.rewrite_source}. Percentiles are nearest-rank over ${r.pairs} runs per side.\n\n` +
    `| | p50 ms | p95 ms |\n|---|---:|---:|\n| original | ${r.original.p50} | ${r.original.p95} |\n| ${rw.split(" (")[0]} | ${r.rewrite.p50} | ${r.rewrite.p95} |\n\n` +
    `Speedup: **${r.speedup.median_of_pair_ratios}×** median of per-pair ratios (${r.speedup.pairs_faster}/${r.pairs} pairs faster). ` +
    `Run file: \`${file}\`. Reproduce: \`npx tsx scripts/bench.ts --engine ${r.engine} --pairs ${r.pairs}\`.\n` +
    `<!-- END ${tag} -->\n`;
  const re = new RegExp(`<!-- BEGIN ${tag} -->[\\s\\S]*?<!-- END ${tag} -->\\n?`);
  doc = re.test(doc) ? doc.replace(re, block) : doc.replace(/\n*$/, "\n\n") + block;
  writeFileSync(path, doc);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
