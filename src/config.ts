import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// querydoc.config.json: design thresholds (policy) and Day-1 measurements (each with its call-log source).

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface VerifierConfig {
  speedupMin: number;
  noGainSpeedup: number;
  noiseFloorMs: number;
  minPairs: number;
  maxPairs: number;
  rowCap: number;
  floatSigDigits: number;
  timingCapMinMs: number;
  dialect: string;
}

// The sample engine uses the policy floor (50 ms) and the PostgreSQL parser dialect; the Zetaris values were measured on the instance.
export function loadConfig(path = resolve(ROOT, "querydoc.config.json"), engine: "zetaris" | "duckdb" = "zetaris"): VerifierConfig {
  const c = JSON.parse(readFileSync(path, "utf8"));
  const p = c.policy;
  return {
    speedupMin: p.speedupMin,
    noGainSpeedup: p.noGainSpeedup,
    noiseFloorMs: engine === "duckdb" ? p.noiseFloorMinMs : c.noise?.noiseFloorMs ?? p.noiseFloorMinMs,
    minPairs: Math.max(3, p.timedPairs), // never fewer than 3 valid pairs before an ACCEPT (architecture §Verifier order step 4)
    maxPairs: p.maxTimedPairs,
    rowCap: p.rowCap,
    floatSigDigits: p.floatSigDigits,
    timingCapMinMs: p.timingCapMinMs,
    dialect: engine === "duckdb" ? "postgresql" : c.sqlParserDialect?.value ?? "hive",
  };
}
