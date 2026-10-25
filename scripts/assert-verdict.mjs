// usage: node scripts/assert-verdict.mjs <response.json> <example_N>
// The CI keyless job and the Hub self-test step: the response of POST /run for a shipped example must be a well-formed envelope whose
// verdict (+ reason) is inside the allowed set recorded in output_examples/expected.json.
import { readFileSync } from "node:fs";
const [file, name] = process.argv.slice(2);
const res = JSON.parse(readFileSync(file, "utf8"));
const expected = JSON.parse(readFileSync(new URL("../output_examples/expected.json", import.meta.url), "utf8"))[name];
if (!expected) throw new Error(`no expectation recorded for ${name}`);
const got = `${res.verdict}${res.no_rewrite_reason ? "/" + res.no_rewrite_reason : ""}`;
const problems = [];
if (!["ok", "partial"].includes(res.status)) problems.push(`status ${res.status}`);
if (!expected.allowed.includes(got)) problems.push(`verdict ${got} not in [${expected.allowed.join(", ")}]`);
if (!res.trace_id || typeof res.execution_time_seconds !== "number" || !Array.isArray(res.agents)) problems.push("envelope fields missing");
if (res.engine !== "duckdb") problems.push(`engine ${res.engine}`);
if (problems.length) {
  console.error(`FAIL ${name}: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`PASS ${name}: ${got} (${res.status}, ${res.engine}, llm ${res.llm}, ${res.agents.map((a) => a.name).join("+")})`);
