// CLI: npx tsx run.ts <input.json> [--max-attempts N] [--out <dir>]
// input.json = {"sql": "...", "candidate_sql"?: "...", "source"?: "paste"}. Live mode: Zetaris over the JDBC sidecar
// (ZETARIS_* from ~/.config/querydoc/zetaris.env) and NVIDIA_API_KEY from nvidia.env. Writes logs/trace-<run_id>.jsonl and
// prints the markdown dossier. The keyless DuckDB sample path arrives with the sample engine.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmGateway, nimClientFromEnv } from "./src/adapters/nim.js";
import { loadConfig } from "./src/config.js";
import { ZetarisEngine, zetarisConfigFromEnv } from "./src/engine/zetaris.js";
import { loadQuerydocEnv } from "./src/env.js";
import { runCase } from "./src/orchestrator.js";
import { caseMarkdown } from "./src/report/markdown.js";
import type { RunInput } from "./src/types.js";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--max-attempts" && args[i - 1] !== "--out");
if (!file) {
  console.error("usage: npx tsx run.ts <input.json> [--max-attempts N] [--out <dir>]");
  process.exit(2);
}
const maxIdx = args.indexOf("--max-attempts");
const maxAttempts = maxIdx >= 0 ? Number(args[maxIdx + 1]) : undefined;

loadQuerydocEnv();
const zcfg = zetarisConfigFromEnv();
if (!zcfg) {
  console.error("Zetaris JDBC settings missing (ZETARIS_JDBC_URL / _JAR / _USER / _PASSWORD) — see .env.example");
  process.exit(2);
}
const input = JSON.parse(readFileSync(file, "utf8")) as RunInput;
const engine = new ZetarisEngine(zcfg);
try {
  const { case: c } = await runCase(input, { engine, cfg: loadConfig(), llm: new LlmGateway({ client: nimClientFromEnv() }), attemptCap: 3 }, maxAttempts ? { maxAttempts } : {});
  const md = caseMarkdown(c);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "case.json"), JSON.stringify(c, null, 2) + "\n");
    writeFileSync(join(outDir, "dossier.md"), md);
    copyFileSync(join("logs", `trace-${c.run_id}.jsonl`), join(outDir, "trace.jsonl"));
  }
  console.log(md);
  console.log(`trace: logs/trace-${c.run_id}.jsonl`);
} finally {
  await engine.close();
}
