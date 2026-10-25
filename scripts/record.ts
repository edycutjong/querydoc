// npm run record -- [--sample] [--live] [--traps N] [--fresh]
// Re-records the evidence in one command (architecture §scripts/record.ts). Needs a live model through Meterless Nightshift (METERLESS_RUNTIME_TOKEN, ~/.config/querydoc/nightshift.env).
//  --sample : the canonical pass over input_examples/example_2,4,6 (plain SQL: the ONLY runs that write llm-cache/), example_1/3 (a supplied
//             candidate) with cache writes off (candidate-origin rule, also enforced inside the gateway), the ledger-reuse seed, N repeats of each trap (03/04/05, cache writes off), then a
//             keyless replay of all six examples written to output_examples/ with the allowed-verdict sets.
//  --live   : the Zetaris pack (input_examples/live/*) N times each into recorded/live/ — only when the platform answers.
// Every run starts from a fresh playbook; nothing here writes a human decision (the builder approves through POST /runs/:id/decision).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmClientFromEnv } from "../src/adapters/llm.js";
import { LlmGateway } from "../src/adapters/nim.js";
import { DIAGNOSER_SYSTEM, REVISE_SYSTEM } from "../src/agents/diagnoser.js";
import { REWRITER_SYSTEM } from "../src/agents/rewriter.js";
import { ROOT } from "../src/config.js";
import { loadQuerydocEnv } from "../src/env.js";
import { Playbook } from "../src/memory/playbook.js";
import { QueryDocService } from "../src/service.js";
import type { Case } from "../src/types.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const doSample = flag("sample") || !flag("live");
const doLive = flag("live");
const N = Number(opt("traps", "5"));
const LIVE_N = Number(opt("live-n", "2"));

loadQuerydocEnv();
const client = llmClientFromEnv();
if (!client) {
  console.error("record: no live model — set METERLESS_RUNTIME_TOKEN (~/.config/querydoc/nightshift.env) and run Meterless Nightshift; the canonical pass goes through it (LLM_PROVIDER=nim is the declared fallback)");
  process.exit(2);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const example = (n: number) => JSON.parse(read(`input_examples/example_${n}.json`));
const save = (dir: string, r: { json: any }, runId: string) => {
  mkdirSync(dir, { recursive: true });
  const c = r.json.output?.case as Case | undefined;
  if (!c) throw new Error(`run ${runId} returned no case: ${JSON.stringify(r.json).slice(0, 300)}`);
  writeFileSync(join(dir, "case.json"), JSON.stringify(c, null, 2) + "\n");
  writeFileSync(join(dir, "dossier.md"), r.json.output.dossier);
  cpSync(join(ROOT, "data", "runs", runId, `trace-${runId}.jsonl`), join(dir, "trace.jsonl"));
};
const summary = (c: Case) => ({
  verdict: c.verdict, no_rewrite_reason: c.no_rewrite_reason ?? null, attempts: c.attempts.length,
  first_attempt: c.attempts[0] ? `${c.attempts[0].verdict}${c.attempts[0].reason ? "/" + c.attempts[0].reason : ""}${c.attempts[0].not_faster_detail ? "/" + c.attempts[0].not_faster_detail : ""}` : "none",
  route: c.attempts.map((a) => `${a.verdict}${a.reason ? "/" + a.reason : ""}${a.not_faster_detail ? "/" + a.not_faster_detail : ""}`).join(" → ") || "none",
  llm: c.llm,
});

const manifest: Record<string, unknown> = {
  recorded_at: new Date().toISOString(), provider: client.provider, requested_model: client.model,
  prompt_hashes: { rewriter: sha(REWRITER_SYSTEM), diagnoser: sha(DIAGNOSER_SYSTEM), revise: sha(REVISE_SYSTEM) },
  sample_data_sha: { trips: sha(readFileSync(join(ROOT, "data/sample/trips.parquet")).toString("base64")), zones: sha(readFileSync(join(ROOT, "data/sample/zones.parquet")).toString("base64")) },
};

async function samplePack() {
  const recDir = join(ROOT, "recorded", "sample");
  rmSync(recDir, { recursive: true, force: true });
  if (flag("fresh") || !existsSync(join(ROOT, "llm-cache"))) rmSync(join(ROOT, "llm-cache"), { recursive: true, force: true });
  const canon = new QueryDocService({ cacheWrite: true, llm: new LlmGateway({ client, cacheWrite: true, cacheDir: join(ROOT, "llm-cache") }), env: { ...process.env, SAMPLE_MODE: "true" } });
  const live = new QueryDocService({ llm: new LlmGateway({ client, cacheDir: join(ROOT, "llm-cache") }), env: { ...process.env, SAMPLE_MODE: "true" } });
  const runs: Record<string, unknown> = {};
  const runOne = async (svc: QueryDocService, body: any, runId: string, dir: string) => {
    for (const d of [join(ROOT, "data", "runs", runId)]) rmSync(d, { recursive: true, force: true });
    const r = (await svc.run({ ...body, run_id: runId })) as { json: any };
    save(dir, r, runId);
    const c = r.json.output.case as Case;
    console.log(`${runId}: ${c.verdict}${c.no_rewrite_reason ? "/" + c.no_rewrite_reason : ""} — ${summary(c).route}`);
    return c;
  };

  // 1. canonical pass: examples 2, 4, 6 (plain SQL) write the cache
  for (const n of [2, 4, 6]) runs[`example_${n}`] = summary(await runOne(canon, example(n), `canon-example_${n}`, join(recDir, `example_${n}`)));
  // 2. example_1 (candidate-origin: cache writes off) → the seed holds that candidate's Verifier refusal
  const c2 = await runOne(live, example(1), "canon-example_1", join(recDir, "example_1"));
  runs.example_1 = summary(c2);
  const refused = c2.attempts.find((a) => a.origin === "candidate_sql" && a.reason === "ROW_DIFF");
  if (!refused) throw new Error("example_1: the candidate was not refused for ROW_DIFF — cannot build the ledger-reuse seed");
  const seedDir = join(ROOT, "fixtures", "hmem-seed", "sample");
  rmSync(seedDir, { recursive: true, force: true });
  const seed = Playbook.open({ dir: seedDir, fixedClock: true });
  seed.recordRejection(refused, { pattern: c2.diagnosis!.pattern_label, schema: c2.schema_fqn!, origSql: c2.sql, origFp: c2.precheck!.fingerprint });
  console.log(`seed: ${seed.size} entry in ${seedDir}`);
  // 3. example_3 reuses it (same candidate, playbook "seed")
  runs.example_3 = summary(await runOne(live, example(3), "canon-example_3", join(recDir, "example_3")));
  // 4. example_5 (deterministic, no model)
  runs.example_5 = summary(await runOne(live, example(5), "canon-example_5", join(recDir, "example_5")));

  // 5. trap repeats, cache writes off, each from an empty store
  const traps: Record<string, string> = { "03-trap-left-join": "T1", "04-trap-union": "T2", "05-trap-not-in": "T3" };
  const trapRuns: Record<string, ReturnType<typeof summary>[]> = {};
  for (const [file, label] of Object.entries(traps)) {
    const sql = read(`evals/queries/sample/${file}.sql`).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    trapRuns[label] = [];
    for (let i = 1; i <= N; i++) {
      const id = `trap-${label.toLowerCase()}-r${i}`;
      const c = await runOne(live, { input: { sql, source: "paste" }, options: { sample_mode: true, playbook: "empty" } }, id, join(recDir, "traps", id));
      trapRuns[label].push(summary(c));
    }
  }
  const lines = ["# Sample-pack trap repeats", "", `Recorded ${manifest.recorded_at} · model ${client!.model} · each run from an empty playbook, cache writes off, ${N} runs per trap.`, "", "| Trap | Runs | First attempt refused for a row difference (k of N) | First attempts |", "|---|---|---|---|"];
  for (const [label, rs] of Object.entries(trapRuns)) lines.push(`| ${label} | ${rs.length} | ${rs.filter((r) => r.first_attempt === "REJECT/ROW_DIFF").length} of ${rs.length} | ${rs.map((r) => r.first_attempt).join("; ")} |`);
  writeFileSync(join(recDir, "TRAPS.md"), lines.join("\n") + "\n");
  manifest.traps = trapRuns;
  manifest.runs = runs;
  manifest.llm_cache_entries = existsSync(join(ROOT, "llm-cache")) ? readdirSync(join(ROOT, "llm-cache")).length : 0;
  writeFileSync(join(recDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

  // 6. keyless replay of the recorded cache → output_examples/ + allowed verdict sets
  const keyless = new QueryDocService({ llm: new LlmGateway({ client: null, cacheDir: join(ROOT, "llm-cache") }), env: { SAMPLE_MODE: "true" } });
  const finalOut = join(ROOT, "output_examples");
  const out = `${finalOut}.tmp`; // written aside and swapped in only after every assertion passes
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const expected: Record<string, { canonical: string; allowed: string[] }> = {};
  const key = (c: { verdict: string; no_rewrite_reason?: string | null }) => `${c.verdict}${c.no_rewrite_reason ? "/" + c.no_rewrite_reason : ""}`;
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const id = `replay-example_${n}`;
    rmSync(join(ROOT, "data", "runs", id), { recursive: true, force: true });
    const r = (await keyless.run({ ...example(n), run_id: id })) as { json: any };
    const c = r.json.output.case as Case;
    writeFileSync(join(out, `example_${n}.dossier.json`), JSON.stringify({ example: `example_${n}`, request: example(n), response: { ...r.json, run_id: undefined, trace_id: undefined, log_file: undefined, execution_time_seconds: undefined, output: { dossier: r.json.output.dossier, case: c } } }, null, 2) + "\n");
    const canonical = runs[`example_${n}`] as ReturnType<typeof summary>;
    // examples 1 and 3 are candidate-origin: with a key the loop continues live, keyless it ends after attempt 1 (llm_unavailable) by construction
    const canonicalKey = [1, 3].includes(n) ? key(c) : key({ verdict: canonical.verdict, no_rewrite_reason: canonical.no_rewrite_reason });
    const timingDerived = [2, 4, 6].includes(n);
    expected[`example_${n}`] = { canonical: canonicalKey, allowed: [...new Set([canonicalKey, ...(timingDerived ? ["ACCEPTED", "NO_SAFE_REWRITE/llm_unavailable"] : [])])] };
    if ([1, 3].includes(n) && canonicalKey !== "NO_SAFE_REWRITE/llm_unavailable") throw new Error(`example_${n}: the keyless replay ended ${canonicalKey}, expected NO_SAFE_REWRITE/llm_unavailable`);
    console.log(`replay example_${n}: ${key(c)} (canonical ${canonicalKey})`);
  }
  writeFileSync(join(out, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  writeFileSync(join(out, "README.md"), "# output_examples\n\nWhat the code produced for each `input_examples/example_N.json` in a **keyless replay of the recorded `llm-cache/`** after the canonical pass (`npm run record`). Nothing in the pipeline or the server ever reads these files; `test/replay-parity.test.ts` re-runs the inputs offline and compares against `expected.json` (the canonical verdict and the explicit set of verdicts a timing-derived replay may end in).\n");
  rmSync(finalOut, { recursive: true, force: true });
  renameSync(out, finalOut);
  await canon.close();
  await live.close();
  await keyless.close();
}

async function livePack() {
  const svc = new QueryDocService({ llm: new LlmGateway({ client, cacheDir: join(ROOT, "llm-cache") }) });
  const h = await svc.health();
  if ((h.json as any).engine?.name !== "zetaris" || !(h.json as any).engine.ok) {
    console.error(`record --live: the Zetaris platform did not answer (${JSON.stringify((h.json as any).engine)}) — skipped`);
    process.exit(3);
  }
  const names = readdirSync(join(ROOT, "input_examples", "live")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  const dest = join(ROOT, "recorded", "live-v2");
  rmSync(dest, { recursive: true, force: true });
  const out: Record<string, unknown[]> = {};
  for (const name of names) {
    out[name] = [];
    for (let i = 1; i <= (["hero", "trap-t1", "no-gain"].includes(name) ? LIVE_N : 1); i++) {
      const body = JSON.parse(read(`input_examples/live/${name}.json`));
      const id = `live-${name}-r${i}`;
      rmSync(join(ROOT, "data", "runs", id), { recursive: true, force: true });
      const r = (await svc.run({ ...body, run_id: id })) as { json: any };
      save(join(dest, `${name}-r${i}`), r, id);
      const c = r.json.output.case as Case;
      out[name]!.push(summary(c));
      console.log(`${id}: ${c.verdict} — ${summary(c).route}`);
    }
  }
  writeFileSync(join(dest, "MANIFEST.json"), JSON.stringify({ recorded_at: new Date().toISOString(), provider: client!.provider, requested_model: client!.model, runs: out }, null, 2) + "\n");
  await svc.close();
}

if (doSample) await samplePack();
if (doLive) await livePack();
