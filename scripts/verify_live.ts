// Day-2 live run: the hero (trinodb/trino#2939 shape) and its trap sibling through the Verifier on the local Zetaris platform,
// the live float-tolerance calibration, and the numeric kill rule (build-plan Day 2). Writes evidence/verify/<run>/:
//   trace.jsonl    one JSON object per Verifier event (execute + critique), Hub trace schema
//   results.json   pre-checks, attempts, SELECT 1 probe, calibration values, kill-rule inputs and outcome
// Then merges `floatTolerance` into querydoc.config.json with its source.
//
//   npx tsx scripts/verify_live.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Verifier, type Attempt, type Precheck } from "../src/agents/verifier.js";
import { loadConfig, ROOT } from "../src/config.js";
import { ZetarisEngine, zetarisConfigFromEnv } from "../src/engine/zetaris.js";
import { loadQuerydocEnv } from "../src/env.js";
import { Trace } from "../src/trace.js";
import { canonRows } from "../src/verify/canonical.js";
import { diffRows } from "../src/verify/diff.js";
import { orderSpec } from "../src/verify/order.js";
import { median } from "../src/verify/timing.js";

const readSql = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
const Q = "evals/queries/zetaris";
const HERO = readSql(`${Q}/01-hero.sql`);
const HERO_REWRITE = readSql(`${Q}/01-hero-rewrite.sql`);
const TRAP = readSql(`${Q}/01-hero-trap-dupkey.sql`);
const TRAP_REWRITE = readSql(`${Q}/01-hero-trap-rewrite.sql`);
// Calibration: the hero's own rows, summed as DOUBLE two ways — direct, and pre-aggregated per store (the re-ordering a
// pre-aggregation rewrite causes). Per-store sums are compared as rows and through the engine fingerprint's float path.
const FILTER = "FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL";
const CAL_DIRECT = `SELECT ss.ss_store_sk AS store, SUM(ss.ss_net_paid) AS s ${FILTER} GROUP BY ss.ss_store_sk`;
const CAL_PREAGG =
  `SELECT store, SUM(s) AS s FROM (SELECT ss.ss_store_sk AS store, ss.ss_sold_date_sk AS d, SUM(ss.ss_net_paid) AS s ${FILTER} ` +
  `GROUP BY ss.ss_store_sk, ss.ss_sold_date_sk) x GROUP BY store`;

const r1 = (x: number) => Math.round(x * 10) / 10;
const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const runDir = join(ROOT, "evidence/verify", runId);
mkdirSync(runDir, { recursive: true });

loadQuerydocEnv();
const zcfg = zetarisConfigFromEnv();
if (!zcfg) {
  console.error("Zetaris JDBC settings missing (ZETARIS_JDBC_URL / _JAR / _USER / _PASSWORD) — see .env.example");
  process.exit(2);
}
const cfg = loadConfig();
const engine = new ZetarisEngine(zcfg);
const trace = new Trace(`verify-${runId}`, join(runDir, "trace.jsonl"));
const verifier = new Verifier(engine, cfg, trace);
const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const results: Record<string, unknown> = { run: runId, engine: "zetaris (local platform, JDBC sidecar)", config: cfg };
try {
  // 1. SELECT 1 round trips — the spread is a kill-rule input; run 1 is connection setup and discarded.
  const s1: number[] = [];
  for (let i = 0; i < 10; i++) s1.push((await engine.run("SELECT 1", { rowCap: 1, timeoutSec: 30 })).wallMs);
  const s1m = s1.slice(1);
  results.select1 = { wallMs: s1.map(r1), medianMs: r1(median(s1m)), spreadMs: r1(Math.max(...s1m) - Math.min(...s1m)), rule: "runs 2–10" };
  say(`SELECT 1 median ${r1(median(s1m))} ms, spread ${r1(Math.max(...s1m) - Math.min(...s1m))} ms`);

  // 2. Hero: pre-check, then the hand-written join elimination as a candidate.
  const cases: { name: string; pre: Precheck; attempt?: Attempt }[] = [];
  for (const [name, orig, rewrite, change] of [
    ["hero", HERO, HERO_REWRITE, "drop the unused LEFT JOIN to promotion (unique key p_promo_sk)"],
    ["trap", TRAP, TRAP_REWRITE, "drop the LEFT JOIN to promotion (key p_item_sk — repeats)"],
  ] as const) {
    say(`${name}: pre-check`);
    const pre = await verifier.precheck(orig);
    say(`${name}: pre-check ${pre.ok ? "passed" : pre.verdict + " — " + pre.reason} (${pre.rows} row(s), runs ${pre.origRunMs.map(r1).join(", ")} ms)`);
    const c: (typeof cases)[number] = { name, pre };
    if (pre.ok) {
      c.attempt = await verifier.verify({ n: 1, origin: "candidate_sql", hypothesis_id: null, sql: rewrite, change_summary: change }, pre, { lastAttempt: true });
      const a = c.attempt;
      say(`${name}: ${a.verdict}${a.reason ? ` (${a.reason}${a.not_faster_detail ? "/" + a.not_faster_detail : ""})` : ""} — rows ${a.rows.orig} vs ${a.rows.rewrite}` +
        (a.timing_ms ? `, median ${a.timing_ms.median_speedup}×, saving ${a.timing_ms.median_saving_ms} ms, ${a.timing_ms.faster_pairs}/${a.timing_ms.orig.length} pairs` : ""));
    }
    cases.push(c);
  }
  // canon rows are internal; keep the dossier small
  results.cases = cases.map(({ name, pre, attempt }) => ({ name, precheck: { ...pre, canon: undefined, spec: pre.spec }, attempt }));

  // 3. Live float-tolerance calibration.
  say("calibration: SUM(double) direct vs pre-aggregated per store");
  const direct = await engine.run(CAL_DIRECT, { rowCap: cfg.rowCap, timeoutSec: 300 });
  const preagg = await engine.run(CAL_PREAGG, { rowCap: cfg.rowCap, timeoutSec: 300 });
  const byStore = (rows: unknown[][]) => new Map(rows.map((r) => [String(r[0]), Number(r[1])]));
  const d = byStore(direct.rows);
  const p = byStore(preagg.rows);
  const pairs = [...d.keys()].map((k) => ({ store: k, direct: d.get(k)!, preagg: p.get(k) ?? null }));
  const rel = pairs.map((x) => (x.preagg === null ? Infinity : x.direct === 0 ? Math.abs(x.preagg) : Math.abs(x.direct - x.preagg) / Math.abs(x.direct)));
  const spec = orderSpec(CAL_DIRECT, direct.columns.map((c) => c.name));
  const rowsEqual = diffRows(canonRows(direct.rows, direct.columns, cfg.floatSigDigits), canonRows(preagg.rows, preagg.columns, cfg.floatSigDigits), spec).equal;
  const fpD = await engine.run(engine.rowHashSql(CAL_DIRECT, direct.columns, cfg.floatSigDigits), { rowCap: 1, timeoutSec: 300 });
  const fpP = await engine.run(engine.rowHashSql(CAL_PREAGG, preagg.columns, cfg.floatSigDigits), { rowCap: 1, timeoutSec: 300 });
  const calibration = {
    directSql: CAL_DIRECT,
    preaggSql: CAL_PREAGG,
    columnTypes: direct.columns.map((c) => c.type),
    pairs,
    rawBitsDiffer: pairs.filter((x) => x.direct !== x.preagg).length,
    maxRelDiff: Math.max(...rel),
    floatSigDigits: cfg.floatSigDigits,
    rowsEqualAtSigDigits: rowsEqual,
    engineFingerprint: { direct: fpD.rows[0], preagg: fpP.rows[0], equal: JSON.stringify(fpD.rows[0]) === JSON.stringify(fpP.rows[0]) },
    wallMs: [direct.wallMs, preagg.wallMs, fpD.wallMs, fpP.wallMs].map(r1),
  };
  results.calibration = calibration;
  say(`calibration: ${pairs.length} stores, ${calibration.rawBitsDiffer} with different raw bits, max rel diff ${calibration.maxRelDiff.toExponential(2)}; rows equal at ${cfg.floatSigDigits} digits: ${rowsEqual}; engine fp equal: ${calibration.engineFingerprint.equal}`);

  // 4. Kill rule (build-plan Day 2, numeric since P5).
  const hero = cases.find((c) => c.name === "hero")!;
  const trap = cases.find((c) => c.name === "trap")!;
  const heroOrigRuns = [...hero.pre.origRunMs, ...(hero.attempt?.timing_ms?.orig ?? [])];
  const heroMedian = median(heroOrigRuns);
  const select1Median = median(s1m);
  const comparable = [
    ["hero original", hero.pre.ok],
    ["hero rewrite", hero.attempt !== undefined && hero.attempt.reason !== "ERROR"],
    ["trap original", trap.pre.ok],
    ["trap rewrite", trap.attempt !== undefined && trap.attempt.reason !== "ERROR"],
    ["calibration direct", direct.rows.length > 0],
    ["calibration pre-aggregated", preagg.rows.length > 0],
  ].filter(([, ok]) => ok).map(([n]) => n);
  const kill = {
    comparableQueries: { value: comparable.length, queries: comparable, need: 3, pass: comparable.length >= 3 },
    engineTime: {
      heroOriginalMedianMs: r1(heroMedian), heroOriginalRunsMs: heroOrigRuns.map(r1), select1MedianMs: r1(select1Median),
      engineMs: r1(heroMedian - select1Median), noiseFloorMs: cfg.noiseFloorMs, need: r1(6 * cfg.noiseFloorMs),
      pass: heroMedian - select1Median >= 6 * cfg.noiseFloorMs,
    },
    select1SpreadRecorded: { spreadMs: r1(Math.max(...s1m) - Math.min(...s1m)), pass: true },
    heroLiveVerdict: { hero: hero.attempt?.verdict ?? hero.pre.verdict ?? null, trap: trap.attempt?.verdict ?? trap.pre.verdict ?? null,
      trapReason: trap.attempt?.reason ?? null, pass: hero.attempt?.verdict !== undefined },
  };
  const yes = kill.comparableQueries.pass && kill.engineTime.pass && kill.select1SpreadRecorded.pass && kill.heroLiveVerdict.pass;
  results.killRule = { ...kill, outcome: yes ? "YES" : "NO" };
  say(`kill rule: ${yes ? "YES" : "NO"} — comparable ${comparable.length}/3, engine ${r1(heroMedian - select1Median)} ms vs ${r1(6 * cfg.noiseFloorMs)} ms, hero ${kill.heroLiveVerdict.hero}, trap ${kill.heroLiveVerdict.trap}`);

  writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2) + "\n");

  // 5. Config: the live calibration, with its source.
  const cpath = join(ROOT, "querydoc.config.json");
  const conf = JSON.parse(readFileSync(cpath, "utf8"));
  conf.floatTolerance = {
    floatSigDigits: cfg.floatSigDigits,
    liveMaxRelDiff: calibration.maxRelDiff,
    liveRawBitsDiffer: calibration.rawBitsDiffer,
    liveRowsEqual: rowsEqual,
    liveEngineFingerprintEqual: calibration.engineFingerprint.equal,
    ciTest: "test/duckdb-sum.test.ts",
    source: { run: runId, file: `evidence/verify/${runId}/results.json`, key: "calibration" },
  };
  writeFileSync(cpath, JSON.stringify(conf, null, 2) + "\n");
  say(`wrote ${runDir}/results.json + trace.jsonl (${trace.events.length} events); querydoc.config.json floatTolerance`);
} catch (e) {
  results.error = (e as Error).message;
  writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.error(e);
  process.exitCode = 1;
} finally {
  await engine.close();
}
