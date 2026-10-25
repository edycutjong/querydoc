// Day-1 spike against the live Zetaris platform (local, over JDBC). Every engine / NIM call is logged to
// evidence/spike/<run>/calls.jsonl; the measured values it derives are merged into querydoc.config.json with the run id and the
// call ids they came from, so each number traces to a logged call.
//
//   npm run spike                 # every section
//   npm run spike -- noise hero   # chosen sections: health tables explain rowcap hash types noise hero dialect xsource nim
//   npm run spike -- --no-config  # log the calls but leave querydoc.config.json alone (re-run checks)

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sqlParser from "node-sql-parser";
import { loadQuerydocEnv } from "../src/env.js";
import { EngineError, type RunOptions, type RunResult } from "../src/engine/types.js";
import { ZetarisEngine, zetarisConfigFromEnv } from "../src/engine/zetaris.js";
import { engineFingerprintSql } from "../src/verify/fingerprint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["health", "tables", "explain", "rowcap", "hash", "types", "noise", "hero", "dialect", "xsource", "nim"] as const;
type Section = (typeof ALL)[number];

const NIM_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NIM_BASE = "https://integrate.api.nvidia.com/v1";

const stripComments = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
const readSql = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));

const HERO = readSql("evals/queries/zetaris/01-hero.sql");
const TRAP = readSql("evals/queries/zetaris/01-hero-trap-dupkey.sql");
// Hand-written join elimination: the probe that a faster rewrite is plausible. The agents produce their own in the pipeline.
const ELIMINATE_JOIN = (sql: string) => sql.replace(/\s*LEFT JOIN TPCDS_DB\.promotion p ON [^\n]+/, "");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const runDir = join(ROOT, "evidence/spike", runId);
mkdirSync(runDir, { recursive: true });
const callsFile = join(runDir, "calls.jsonl");
let callSeq = 0;

function log(entry: Record<string, unknown>): number {
  const call = ++callSeq;
  appendFileSync(callsFile, JSON.stringify({ call, at: new Date().toISOString(), ...entry }) + "\n");
  return call;
}

loadQuerydocEnv();
const cfg = zetarisConfigFromEnv();
if (!cfg) {
  console.error("Zetaris JDBC settings missing (ZETARIS_JDBC_URL / _JAR / _USER / _PASSWORD) — see .env.example");
  process.exit(2);
}
const engine = new ZetarisEngine(cfg);

async function q(label: string, sql: string, opts: RunOptions = {}): Promise<{ call: number; r?: RunResult; err?: EngineError }> {
  try {
    const r = await engine.run(sql, opts);
    const call = log({
      kind: "run", label, sql, ok: true, wallMs: r.wallMs, sidecarMs: r.sidecarMs, rowCount: r.rowCount,
      rowCountExact: r.rowCountExact, truncated: r.truncated, columns: r.columns, rowsHead: r.rows.slice(0, 50),
    });
    console.log(`  [${call}] ${label}: ${r.rowCount} rows, ${r.wallMs} ms`);
    return { call, r };
  } catch (e) {
    const err = e instanceof EngineError ? e : new EngineError(String(e));
    const call = log({ kind: "run", label, sql, ok: false, wallMs: err.wallMs, error: err.message.slice(0, 2000), sqlState: err.sqlState });
    console.log(`  [${call}] ${label}: ERROR ${err.message.slice(0, 160)}`);
    return { call, err };
  }
}

type Results = Record<string, unknown>;
const results: Results = { run: runId };

const sections: Record<Section, () => Promise<void>> = {
  async health() {
    const h = await engine.health();
    const call = log({ kind: "health", ...h });
    results.health = { ...h, call };
  },

  async tables() {
    const out: Record<string, unknown>[] = [];
    for (const schema of ["TPCDS_DB", "NY_TAXI"]) {
      const tables = await engine.listTables(schema);
      const callList = log({ kind: "listTables", schema, tables });
      for (const t of tables) {
        let columns: unknown = null;
        let describeCall: number;
        try {
          columns = await engine.tableInfo(t);
          describeCall = log({ kind: "tableInfo", table: t, columns });
        } catch (e) {
          describeCall = log({ kind: "tableInfo", table: t, ok: false, error: (e as Error).message.slice(0, 500) });
        }
        // Row counts only on the Parquet TPCDS tables: NY_TAXI is CSV read in place from S3 (COUNT on trips took 200 s).
        let rows: number | null = null;
        let countCall: number | null = null;
        if (schema === "TPCDS_DB") {
          const c = await q(`count ${t.table}`, `SELECT COUNT(*) FROM ${t.schema}.${t.table}`, { rowCap: 1 });
          rows = c.r ? Number(c.r.rows[0]?.[0]) : null;
          countCall = c.call;
        }
        out.push({ ...t, format: schema === "TPCDS_DB" ? "parquet" : "csv", rows, columns, calls: { list: callList, describe: describeCall, count: countCall } });
      }
    }
    const doc = {
      note: "Tables on the local Zetaris platform (2.4.3 hackathon bundle), both sample sources from s3a://zetaris-public-dataset. Generated by scripts/spike_zetaris.ts; NY_TAXI row counts are not taken (CSV read in place).",
      run: runId,
      tables: out,
    };
    mkdirSync(join(ROOT, "docs"), { recursive: true });
    writeFileSync(join(ROOT, "docs/zetaris-tables.json"), JSON.stringify(doc, null, 2) + "\n");
    results.tables = { count: out.length, file: "docs/zetaris-tables.json" };
  },

  async explain() {
    const plain = await q("EXPLAIN hero", `EXPLAIN ${HERO}`, { rowCap: 1 });
    const t0 = performance.now();
    const plan = await engine.explain(HERO);
    const formattedCall = log({ kind: "explain", label: "EXPLAIN FORMATTED hero", sql: HERO, wallMs: plan.wallMs, nodes: plan.nodes, text: plan.text });
    // Does EXPLAIN run the query? Explain a query whose execution takes minutes (COUNT over the CSV trips table).
    const slow = await q("EXPLAIN FORMATTED count NY_TAXI.trips", "EXPLAIN FORMATTED SELECT COUNT(*) FROM NY_TAXI.trips", { rowCap: 1, timeoutSec: 180 });
    results.explain = {
      plainCall: plain.call,
      formattedCall,
      formattedWallMs: r1(performance.now() - t0),
      nodeCount: plan.nodes.length,
      nodes: plan.nodes.map((n) => `(${n.id}) ${"  ".repeat(n.depth)}${n.operator}`),
      joinKept: plan.nodes.some((n) => n.operator === "BroadcastHashJoin" || n.operator === "SortMergeJoin"),
      explainSlowQuery: { call: slow.call, wallMs: slow.r?.wallMs ?? null, ok: !!slow.r },
    };
  },

  async rowcap() {
    // Does the driver or platform cap / truncate rows? Drain 200,000 rows while keeping only 10.
    const n = 200_000;
    const d = await q(`drain ${n} rows`, `SELECT ss_item_sk FROM TPCDS_DB.store_sales LIMIT ${n}`, { rowCap: 10, drain: true, timeoutSec: 180 });
    results.rowcap = { requested: n, received: d.r?.rowCount ?? null, call: d.call, engineCapObserved: d.r ? d.r.rowCount < n : null };
  },

  async hash() {
    const fns: Record<string, string> = {
      xxhash64: "SELECT xxhash64(1, 'a')",
      hash: "SELECT hash(1, 'a')",
      md5: "SELECT md5('a')",
      sha2: "SELECT sha2('a', 256)",
      crc32: "SELECT crc32('a')",
    };
    const fnResults: Record<string, unknown> = {};
    for (const [name, sql] of Object.entries(fns)) {
      const r = await q(`hash fn ${name}`, sql, { rowCap: 1 });
      fnResults[name] = { ok: !!r.r, value: r.r?.rows[0]?.[0] ?? null, type: r.r?.columns[0]?.type ?? null, call: r.call };
    }
    // Fingerprint determinism + discrimination on a real table (300 rows, includes NULLs in string columns).
    const inner = "SELECT p_promo_sk, p_item_sk, p_cost, p_channel_details FROM TPCDS_DB.promotion";
    const fpSql = engineFingerprintSql(inner, ["p_promo_sk", "p_item_sk", "p_cost", "p_channel_details"]);
    const a = await q("fingerprint promotion #1", fpSql, { rowCap: 1 });
    const b = await q("fingerprint promotion #2", fpSql, { rowCap: 1 });
    const dropOne = engineFingerprintSql(`${inner} WHERE p_promo_sk <> 1`, ["p_promo_sk", "p_item_sk", "p_cost", "p_channel_details"]);
    const c = await q("fingerprint promotion minus one row", dropOne, { rowCap: 1 });
    results.hash = {
      functions: fnResults,
      fingerprint: {
        sql: fpSql,
        run1: a.r?.rows[0] ?? null,
        run2: b.r?.rows[0] ?? null,
        deterministic: !!a.r && JSON.stringify(a.r.rows) === JSON.stringify(b.r?.rows),
        minusOneRow: c.r?.rows[0] ?? null,
        discriminates: !!c.r && JSON.stringify(c.r.rows) !== JSON.stringify(a.r?.rows),
        calls: [a.call, b.call, c.call],
      },
    };
  },

  async types() {
    const ss = await q("DESCRIBE store_sales", "DESCRIBE TPCDS_DB.store_sales", { rowCap: 100 });
    const numeric = (ss.r?.rows ?? []).filter((r) => /double|decimal|float/i.test(String(r[1]))).map((r) => `${r[0]}:${r[1]}`);
    const agg = await q("aggregate types", "SELECT COUNT(1) AS n, SUM(ss_net_paid) AS s, AVG(ss_quantity) AS a FROM TPCDS_DB.store_sales WHERE ss_customer_sk IS NULL", { rowCap: 1 });
    results.types = {
      storeSalesMoneyColumns: numeric,
      aggregateColumns: agg.r?.columns ?? null,
      aggregateRow: agg.r?.rows[0] ?? null,
      calls: [ss.call, agg.call],
    };
  },

  async noise() {
    const s1: { ms: number; call: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await q(`SELECT 1 #${i + 1}`, "SELECT 1", { rowCap: 1 });
      s1.push({ ms: r.r?.wallMs ?? NaN, call: r.call });
    }
    const kept = s1.slice(1).map((x) => x.ms);
    const spread = Math.max(...kept) - Math.min(...kept);
    results.noise = {
      select1Ms: s1.map((x) => x.ms),
      discardedFirstMs: s1[0]!.ms,
      select1MedianMs: r1(median(kept)),
      select1SpreadMs: r1(spread),
      noiseFloorMs: r1(Math.max(50, 3 * spread)),
      calls: s1.map((x) => x.call),
    };
  },

  async hero() {
    const plan = await engine.explain(HERO);
    const planCall = log({ kind: "explain", label: "EXPLAIN FORMATTED hero", sql: HERO, wallMs: plan.wallMs, nodes: plan.nodes });
    const rewrite = ELIMINATE_JOIN(HERO);
    const trapRewrite = ELIMINATE_JOIN(TRAP);
    // Hero ×5 back to back (run 1 shows the cold/warm gap), then 3 alternating original/rewrite pairs, then the trap pair.
    const runs: { ms: number; call: number; n: unknown }[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await q(`hero #${i + 1}`, HERO, { rowCap: 10, timeoutSec: 300 });
      runs.push({ ms: r.r?.wallMs ?? NaN, call: r.call, n: r.r?.rows[0]?.[0] ?? null });
    }
    const pairs: { orig: number; rewrite: number; origN: unknown; rewriteN: unknown; calls: number[] }[] = [];
    for (let i = 0; i < 3; i++) {
      const first = i % 2 === 0 ? "rewrite" : "orig"; // alternate which side runs first
      const a = await q(`pair ${i + 1} ${first}`, first === "orig" ? HERO : rewrite, { rowCap: 10, timeoutSec: 300 });
      const b = await q(`pair ${i + 1} ${first === "orig" ? "rewrite" : "orig"}`, first === "orig" ? rewrite : HERO, { rowCap: 10, timeoutSec: 300 });
      const [o, w] = first === "orig" ? [a, b] : [b, a];
      pairs.push({ orig: o.r?.wallMs ?? NaN, rewrite: w.r?.wallMs ?? NaN, origN: o.r?.rows[0]?.[0] ?? null, rewriteN: w.r?.rows[0]?.[0] ?? null, calls: [a.call, b.call] });
    }
    const trapO = await q("trap original", TRAP, { rowCap: 10, timeoutSec: 300 });
    const trapW = await q("trap rewrite (join dropped)", trapRewrite, { rowCap: 10, timeoutSec: 300 });
    const dup = await q("promotion key uniqueness", "SELECT COUNT(*) AS n, COUNT(DISTINCT p_promo_sk) AS promo_sk, COUNT(DISTINCT p_item_sk) AS item_sk FROM TPCDS_DB.promotion", { rowCap: 1 });

    const heroMs = runs.map((r) => r.ms);
    const warm = heroMs.slice(1);
    const s1Median = (results.noise as { select1MedianMs?: number } | undefined)?.select1MedianMs;
    results.hero = {
      sql: HERO,
      rewrite,
      planCall,
      planNodes: plan.nodes.map((n) => `(${n.id}) ${"  ".repeat(n.depth)}${n.operator} ${n.detail.slice(0, 120)}`),
      joinKeptByEngine: plan.nodes.some((n) => n.operator === "BroadcastHashJoin" || n.operator === "SortMergeJoin"),
      runsMs: heroMs,
      runCalls: runs.map((r) => r.call),
      count: runs[0]?.n ?? null,
      medianMs: r1(median(heroMs)),
      warmMedianMs: r1(median(warm)),
      coldWarmGap: heroMs[0]! > 1.5 * median(warm),
      ...(s1Median !== undefined ? { medianMinusSelect1Ms: r1(median(heroMs) - s1Median) } : {}),
      pairs,
      pairsOrigMedianMs: r1(median(pairs.map((p) => p.orig))),
      pairsRewriteMedianMs: r1(median(pairs.map((p) => p.rewrite))),
      pairsSpeedup: r1((median(pairs.map((p) => p.orig)) / median(pairs.map((p) => p.rewrite))) * 100) / 100,
      rowsEqualInPairs: pairs.every((p) => p.origN === p.rewriteN),
      trap: {
        sql: TRAP,
        original: trapO.r?.rows[0]?.[0] ?? null,
        rewrite: trapW.r?.rows[0]?.[0] ?? null,
        rowsDiffer: trapO.r?.rows[0]?.[0] !== trapW.r?.rows[0]?.[0],
        calls: [trapO.call, trapW.call],
      },
      promotionKeys: { row: dup.r?.rows[0] ?? null, call: dup.call },
    };
  },

  async dialect() {
    const parser = new sqlParser.Parser();
    const samples: Record<string, string> = {
      hero: HERO,
      rewrite: ELIMINATE_JOIN(HERO),
      trap: TRAP,
      fingerprint: engineFingerprintSql(HERO, ["n"]),
      q17: "SELECT SUM(l.l_extendedprice) / 7.0 AS avg_yearly FROM lineitem l JOIN part p ON p.p_partkey = l.l_partkey WHERE l.l_quantity < (SELECT 0.2 * AVG(l2.l_quantity) FROM lineitem l2 WHERE l2.l_partkey = p.p_partkey)",
    };
    const out: Record<string, Record<string, string>> = {};
    for (const db of ["hive", "trino", "postgresql", "mysql", "bigquery"]) {
      out[db] = {};
      for (const [name, sql] of Object.entries(samples)) {
        try {
          parser.astify(sql, { database: db });
          out[db][name] = "ok";
        } catch (e) {
          out[db][name] = `fail: ${(e as Error).message.slice(0, 120)}`;
        }
      }
    }
    const allOk = Object.entries(out).filter(([, r]) => Object.values(r).every((v) => v === "ok")).map(([db]) => db);
    const call = log({ kind: "dialect", results: out });
    results.dialect = { results: out, parsesAll: allOk, call };
  },

  async xsource() {
    const tables = existsSync(join(ROOT, "docs/zetaris-tables.json"))
      ? (JSON.parse(readFileSync(join(ROOT, "docs/zetaris-tables.json"), "utf8")).tables as { schema: string; table: string }[])
      : [];
    const taxi = tables.find((t) => t.schema === "NY_TAXI")?.table;
    if (!taxi) {
      results.xsource = { skipped: "no NY_TAXI table listed — run the tables section first" };
      return;
    }
    const sql = `SELECT COUNT(*) AS n FROM TPCDS_DB.warehouse w CROSS JOIN (SELECT * FROM NY_TAXI.${taxi} LIMIT 5) t`;
    const plan = await q("EXPLAIN cross-source join", `EXPLAIN FORMATTED ${sql}`, { rowCap: 1, timeoutSec: 180 });
    const r = await q("cross-source join", sql, { rowCap: 1, timeoutSec: 180 });
    results.xsource = { sql, ok: !!r.r, n: r.r?.rows[0]?.[0] ?? null, wallMs: r.r?.wallMs ?? null, calls: [plan.call, r.call] };
  },

  async nim() {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) {
      results.nim = { skipped: "NVIDIA_API_KEY not set" };
      return;
    }
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    let t0 = performance.now();
    const models = await fetch(`${NIM_BASE}/models`, { headers });
    const list = models.ok ? ((await models.json()) as { data: { id: string }[] }).data.map((m) => m.id) : [];
    const listCall = log({ kind: "nim", label: "GET /v1/models", status: models.status, wallMs: r1(performance.now() - t0), listed: list.includes(NIM_MODEL), modelCount: list.length, nemotron: list.filter((m) => m.includes("nemotron-3")) });
    t0 = performance.now();
    const chat = await fetch(`${NIM_BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: NIM_MODEL, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 256, temperature: 0 }),
    });
    const body = (await chat.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; model?: string };
    const chatCall = log({ kind: "nim", label: "POST /v1/chat/completions", model: NIM_MODEL, status: chat.status, wallMs: r1(performance.now() - t0), servedModel: body.model ?? null, content: body.choices?.[0]?.message?.content?.slice(0, 80) ?? null });
    results.nim = { model: NIM_MODEL, listed: list.includes(NIM_MODEL), listStatus: models.status, chatStatus: chat.status, calls: [listCall, chatCall] };
  },
};

function mergeConfig() {
  const path = join(ROOT, "querydoc.config.json");
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const src = (calls: unknown) => ({ run: runId, calls });
  const n = results.noise as { select1MedianMs: number; select1SpreadMs: number; noiseFloorMs: number; calls: number[] } | undefined;
  if (n) config.noise = { select1MedianMs: n.select1MedianMs, select1SpreadMs: n.select1SpreadMs, noiseFloorMs: n.noiseFloorMs, rule: "max(50 ms, 3 × spread of SELECT 1 runs 2–10)", source: src(n.calls) };
  const rc = results.rowcap as { received: number; call: number; engineCapObserved: boolean } | undefined;
  if (rc) config.rowCap = { ...(config.rowCap ?? {}), engineCapObserved: rc.engineCapObserved, largestDrainedRows: rc.received, engineTruncationFlag: false, source: src([rc.call]) };
  const h = results.hash as { functions: Record<string, { ok: boolean; call: number }>; fingerprint: { deterministic: boolean; discriminates: boolean; calls: number[] } } | undefined;
  if (h) {
    const ok = Object.entries(h.functions).filter(([, v]) => v.ok).map(([k]) => k);
    config.fingerprint = { hashFn: ok.includes("xxhash64") ? "xxhash64" : ok[0] ?? null, available: ok, sumAs: "DECIMAL(38,0)", deterministic: h.fingerprint.deterministic, discriminates: h.fingerprint.discriminates, source: src([...Object.values(h.functions).map((v) => v.call), ...h.fingerprint.calls]) };
  }
  const t = results.types as { storeSalesMoneyColumns: string[]; aggregateColumns: { name: string; type: string }[] | null; calls: number[] } | undefined;
  if (t) config.numeric = { tpcdsMoneyType: t.storeSalesMoneyColumns.some((c) => /decimal/i.test(c)) ? "decimal" : "double", aggregateTypes: Object.fromEntries((t.aggregateColumns ?? []).map((c) => [c.name, c.type])), source: src(t.calls) };
  const hero = results.hero as Record<string, unknown> | undefined;
  if (hero) config.hero = { query: "evals/queries/zetaris/01-hero.sql", medianMs: hero.medianMs, warmMedianMs: hero.warmMedianMs, coldWarmGap: hero.coldWarmGap, warmupPair: hero.coldWarmGap, ...(hero.medianMinusSelect1Ms !== undefined ? { medianMinusSelect1Ms: hero.medianMinusSelect1Ms } : {}), source: src(hero.runCalls) };
  const d = results.dialect as { parsesAll: string[]; call: number } | undefined;
  if (d) config.sqlParserDialect = { value: d.parsesAll.includes("hive") ? "hive" : d.parsesAll[0] ?? null, parsesAll: d.parsesAll, source: src([d.call]) };
  const nim = results.nim as { model: string; listed: boolean; chatStatus: number; calls: number[] } | undefined;
  if (nim && nim.calls) config.llm = { model: nim.model, listed: nim.listed, chatStatus: nim.chatStatus, source: src(nim.calls) };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

const wanted = (process.argv.slice(2).filter((a) => (ALL as readonly string[]).includes(a)) as Section[]);
const order = wanted.length ? ALL.filter((s) => wanted.includes(s)) : [...ALL];
console.log(`spike run ${runId}: ${order.join(", ")}`);
try {
  for (const s of order) {
    console.log(`== ${s}`);
    await sections[s]();
    writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
  }
  if (!process.argv.includes("--no-config")) mergeConfig();
} finally {
  await engine.close();
}
console.log(`results → evidence/spike/${runId}/results.json`);
