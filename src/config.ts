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

export function loadConfig(path = resolve(ROOT, "querydoc.config.json")): VerifierConfig {
  const c = JSON.parse(readFileSync(path, "utf8"));
  const p = c.policy;
  return {
    speedupMin: p.speedupMin,
    noGainSpeedup: p.noGainSpeedup,
    noiseFloorMs: c.noise?.noiseFloorMs ?? p.noiseFloorMinMs,
    minPairs: p.timedPairs,
    maxPairs: p.maxTimedPairs,
    rowCap: p.rowCap,
    floatSigDigits: p.floatSigDigits,
    timingCapMinMs: p.timingCapMinMs,
    dialect: c.sqlParserDialect?.value ?? "hive",
  };
}
