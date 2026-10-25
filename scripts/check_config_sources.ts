// Checks that every measured value in querydoc.config.json traces to logged calls: each section's source {run, calls} must exist in
// evidence/spike/<run>/calls.jsonl, and the value is recomputed from those calls. Exit 1 on any mismatch.
//
//   npx tsx scripts/check_config_sources.ts

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(ROOT, "querydoc.config.json"), "utf8"));

type Call = Record<string, any> & { call: number };
const cache = new Map<string, Map<number, Call>>();
function calls(run: string): Map<number, Call> {
  if (!cache.has(run)) {
    const path = join(ROOT, "evidence/spike", run, "calls.jsonl");
    const m = new Map<number, Call>();
    if (existsSync(path)) for (const l of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const c = JSON.parse(l) as Call;
      m.set(c.call, c);
    }
    cache.set(run, m);
  }
  return cache.get(run)!;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

const recompute: Record<string, (v: any, cs: Call[]) => [boolean, string]> = {
  noise(v, cs) {
    const ms = cs.map((c) => c.wallMs as number);
    const kept = ms.slice(1);
    const spread = Math.max(...kept) - Math.min(...kept);
    const exp = { select1MedianMs: r1(median(kept)), select1SpreadMs: r1(spread), noiseFloorMs: r1(Math.max(50, 3 * spread)) };
    const ok = cs.length === 10 && cs.every((c) => c.sql === "SELECT 1" && c.ok) &&
      exp.select1MedianMs === v.select1MedianMs && exp.select1SpreadMs === v.select1SpreadMs && exp.noiseFloorMs === v.noiseFloorMs;
    return [ok, `recomputed ${JSON.stringify(exp)}`];
  },
  rowCap(v, cs) {
    const c = cs[0]!;
    return [cs.length === 1 && c.ok && c.rowCount === v.largestDrainedRows && c.rowCountExact === true, `logged rowCount ${c.rowCount}`];
  },
  fingerprint(v, cs) {
    const fns = cs.filter((c) => String(c.label).startsWith("hash fn ")).filter((c) => c.ok).map((c) => String(c.label).slice(8));
    const fp = cs.filter((c) => String(c.label).startsWith("fingerprint "));
    const [a, b, d] = fp.map((c) => JSON.stringify(c.rowsHead));
    const ok = JSON.stringify(fns) === JSON.stringify(v.available) && fns.includes(v.hashFn) &&
      (a === b) === v.deterministic && (a !== d) === v.discriminates && fp.length === 3;
    return [ok, `functions ${fns.join(",")}; fingerprint runs equal=${a === b}, minus-one differs=${a !== d}`];
  },
  numeric(v, cs) {
    const desc = cs.find((c) => String(c.label).startsWith("DESCRIBE"));
    const agg = cs.find((c) => c.label === "aggregate types");
    const money = (desc?.rowsHead ?? []).filter((r: unknown[]) => /double|decimal|float/i.test(String(r[1]))).map((r: unknown[]) => String(r[1]));
    const kind = money.some((t: string) => /decimal/i.test(t)) ? "decimal" : "double";
    const types = Object.fromEntries((agg?.columns ?? []).map((c: any) => [c.name, c.type]));
    const ok = money.length > 0 && kind === v.tpcdsMoneyType && JSON.stringify(types) === JSON.stringify(v.aggregateTypes);
    return [ok, `${money.length} money columns, all ${kind}; aggregate types ${JSON.stringify(types)}`];
  },
  hero(v, cs) {
    const ms = cs.map((c) => c.wallMs as number);
    const ok = cs.length === 5 && cs.every((c) => c.ok && String(c.label).startsWith("hero #")) && r1(median(ms)) === v.medianMs &&
      r1(median(ms.slice(1))) === v.warmMedianMs && (ms[0]! > 1.5 * median(ms.slice(1))) === v.coldWarmGap;
    return [ok, `recomputed median ${r1(median(ms))}, warm ${r1(median(ms.slice(1)))}`];
  },
  sqlParserDialect(v, cs) {
    const res = cs[0]?.results as Record<string, Record<string, string>> | undefined;
    const all = Object.entries(res ?? {}).filter(([, r]) => Object.values(r).every((x) => x === "ok")).map(([d]) => d);
    return [JSON.stringify(all) === JSON.stringify(v.parsesAll) && all.includes(v.value), `parse-all dialects ${all.join(",")}`];
  },
  llm(v, cs) {
    const list = cs.find((c) => c.label === "GET /v1/models");
    const chat = cs.find((c) => String(c.label).startsWith("POST"));
    return [list?.listed === v.listed && chat?.status === v.chatStatus && chat?.model === v.model, `listed=${list?.listed}, chat ${chat?.status}`];
  },
};

for (const [key, value] of Object.entries(config)) {
  if (key === "policy") continue;
  const v = value as { source?: { run: string; calls: number[] } };
  if (!v.source) {
    check(key, false, "no source {run, calls}");
    continue;
  }
  const logged = calls(v.source.run);
  const cs = v.source.calls.map((id) => logged.get(id)).filter((c): c is Call => !!c);
  if (cs.length !== v.source.calls.length) {
    check(key, false, `calls ${v.source.calls.join(",")} not all in evidence/spike/${v.source.run}/calls.jsonl`);
    continue;
  }
  const fn = recompute[key];
  if (!fn) {
    check(key, false, "no recompute rule");
    continue;
  }
  const [ok, detail] = fn(v, cs);
  check(key, ok, `run ${v.source.run} calls ${v.source.calls.join(",")}: ${detail}`);
}
console.log(failures ? `${failures} FAIL` : "ALL PASS");
process.exit(failures ? 1 : 0);
