// `tsc --noEmit` over our code with one exception: diagnostics INSIDE vendor/ are ignored. vendor/meterless is the upstream
// reference source, vendored unmodified (vendor/meterless/NOTICE); it does not compile under our noUncheckedIndexedAccess.
// Anything outside vendor/ still fails the check.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8" });
const out = (r.stdout ?? "") + (r.stderr ?? "");
const ours = out.split("\n").filter((l) => /^\S.*\(\d+,\d+\): error TS/.test(l) && !l.startsWith("vendor/"));
const vendor = out.split("\n").filter((l) => l.startsWith("vendor/") && /error TS/.test(l)).length;
for (const l of ours) console.error(l);
console.log(`typecheck: ${ours.length} error(s) in our code; ${vendor} ignored in vendor/ (upstream, unmodified)`);
process.exit(ours.length ? 1 : 0);
