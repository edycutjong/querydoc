// CLI: npx tsx run.ts <input.json> [--sample] [--max-attempts N] [--out <dir>]
// input.json = a POST /run body ({input:{sql, candidate_sql?, source?}, options?}) or the flat {sql, candidate_sql?, source?}. Without
// --sample the engine follows the same rules as the server: input.options.sample_mode, SAMPLE_MODE, else Zetaris when ZETARIS_* settings
// exist (~/.config/querydoc/zetaris.env), else the DuckDB sample engine. Prints the markdown dossier; writes the case, dossier and the
// Hub-schema JSONL trace into --out. Credentials are read from ~/.config/querydoc/*.env, never from the tree.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadQuerydocEnv } from "./src/env.js";
import { QueryDocService } from "./src/service.js";

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const file = args.find((a, i) => !a.startsWith("--") && !["--max-attempts", "--out"].includes(args[i - 1] ?? ""));
if (!file) {
  console.error("usage: npx tsx run.ts <input.json> [--sample] [--max-attempts N] [--out <dir>]");
  process.exit(2);
}
loadQuerydocEnv();
const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
body.options = { ...(body.options ?? {}), ...(args.includes("--sample") ? { sample_mode: true } : {}), ...(val("--max-attempts") ? { max_attempts: Number(val("--max-attempts")) } : {}) };
const svc = new QueryDocService();
try {
  const r = (await svc.run(body)) as { status: number; json: any };
  if (r.status !== 200) {
    console.error(JSON.stringify(r.json, null, 2));
    process.exit(1);
  }
  const outDir = val("--out");
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "case.json"), JSON.stringify(r.json.output.case, null, 2) + "\n");
    writeFileSync(join(outDir, "dossier.md"), r.json.output.dossier);
    copyFileSync(join("data", "runs", r.json.run_id, `trace-${r.json.run_id}.jsonl`), join(outDir, "trace.jsonl"));
  }
  if (r.json.banner) console.log(`> ${r.json.banner}\n`);
  console.log(r.json.output.dossier);
  if (r.json.error) console.log(`status ${r.json.status}: ${r.json.error.type} — ${r.json.error.message}`);
  console.log(`trace: ${r.json.log_file}`);
} finally {
  await svc.close();
}
