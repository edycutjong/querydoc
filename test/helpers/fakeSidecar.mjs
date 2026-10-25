// A stand-in for QuerySidecar.java speaking the same line protocol (id \t op \t maxRows \t drain \t timeoutSec \t base64 sql).
// It writes one non-protocol line first (as a JVM banner would), never answers a statement containing "hang", and answers
// everything else with one row: [1]. With --never-ready it never announces itself (a JVM stuck at startup).
import { createInterface } from "node:readline";

process.stdout.write("Picked up a non-JSON banner line\n");
if (!process.argv.includes("--never-ready")) process.stdout.write('{"ready":true}\n');
createInterface({ input: process.stdin }).on("line", (line) => {
  const [id, , , , , b64] = line.split("\t");
  const sql = Buffer.from(b64 ?? "", "base64").toString("utf8");
  if (sql.includes("hang")) return;
  if (sql.startsWith("EXPLAIN")) return void process.stdout.write(JSON.stringify({ id, ok: true, columns: [{ name: "plan", type: "string", jdbcType: 12 }], rows: [[sql]], rowCount: 1, rowCountExact: true, truncated: false, elapsedMs: 1 }) + "\n"); // echoes the statement
  process.stdout.write(JSON.stringify({ id, ok: true, columns: [{ name: "x", type: "int", jdbcType: 4 }], rows: [[1]], rowCount: 1, rowCountExact: true, truncated: false, elapsedMs: 1 }) + "\n");
});
