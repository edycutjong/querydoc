import pkg from "node-sql-parser";
import { maskSql, trimStatement } from "../sql/text.js";

const { Parser } = pkg;
const parser = new Parser();

// The read-only gate on every statement the agents send to an engine. The execution path can itself run DDL (the platform runs
// ACTIVATE through the same SQL entry point), so this guard — not a tool allowlist — is what keeps a rewrite read-only.
// Zetaris side: a literal-aware keyword scan (decisive) plus node-sql-parser in the Day-1 dialect (`hive`, querydoc.config.json).
// A single statement the parser cannot read but the scan passes is a WARN, not a refusal; more than one statement, a DDL/DML
// keyword outside literals, a direct file read (`parquet.\`s3a://…\``), a JVM call (`reflect`, `java_method`) or a script
// transform (`TRANSFORM(…) USING 'cmd'`, also Hive's MAP/REDUCE form) is REFUSED.
// The scan is deliberately blunt: an unquoted column named like a keyword (`comment`, `set`, `lock`) is refused too — a false
// refusal, never a false pass; quote such a name with backticks.

export interface GuardResult {
  ok: boolean;
  reason?: string;
  warnings: string[];
}

const WRITE_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "ACTIVATE",
  "DEACTIVATE", "REFRESH", "CACHE", "UNCACHE", "LOAD", "SET", "RESET", "USE", "CALL", "EXEC", "EXECUTE", "MSCK", "REPAIR",
  "ANALYZE", "VACUUM", "OPTIMIZE", "COPY", "EXPORT", "IMPORT", "INSTALL", "ATTACH", "DETACH", "PRAGMA", "COMMENT", "LOCK",
  "UNLOCK", "KILL", "SHUTDOWN", "ADD", "RENAME", "OVERWRITE", "DIRECTORY", "SHOW", "DESCRIBE", "EXPLAIN",
];
const WRITE_RE = new RegExp(`\\b(${WRITE_KEYWORDS.join("|")})\\b`, "i");
// Both run on a mask that keeps backtick identifiers, so `parquet`.`s3a://…` and `reflect`(…) are seen too.
const FILE_READ_RE = /`?\b(parquet|csv|json|orc|text|avro|binaryfile|delta|jdbc|hive)`?\s*\.\s*`/i;
// Any qualifier (incl. a fully-qualified source like `org.apache.spark.sql.parquet`) applied to a back-quoted path or URI.
const PATH_READ_RE = /`?[\w.]+`?\s*\.\s*`(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;
// In a read-only SELECT, USING may only open a JOIN column list `USING (col)`. Any other USING is refused: it is how a script
// transform names its command (`USING 'cmd'`, raw `USING r'cmd'`), and every other form (CREATE … USING, MERGE … USING) is a write.
const SCRIPT_RE = /\bUSING\b(?!\s*\()/i;
// call_function('reflect', …) names the function in a literal the mask hides, so call_function itself is refused.
// DuckDB table/scalar functions that read files, URLs, the environment or the catalog (sample engine). The engine also runs with
// external access disabled; these are the guard-level refusals (functions and quoted-path scans), and the engine setting is the backstop.
const DUCKDB_IO_RE = /\b(read_[a-z0-9_]+|[a-z_]*_scan|glob|sniff_csv|getenv|current_setting|duckdb_[a-z_]+|pragma_[a-z_]+|query_table|query|load_extension)\s*\(/i;
// DuckDB replacement scans: FROM '/path/file.parquet' / JOIN "https://…" — a quoted string that looks like a path or URL right after
// FROM/JOIN. `EXTRACT(year FROM '2024-01-01'::date)` and `TRIM(BOTH 'x' FROM 'abc')` are not paths and pass.
const QUOTED_SOURCE_RE = /\b(?:from|join)\s*\(?\s*(['"])([^'"]*)\1/gi;
const PATH_LIKE_RE = /[\/\\]|^[a-z][a-z0-9+.-]*:\/\/|\.(?:parquet|csv|tsv|json|ndjson|gz|zst|db|duckdb|xlsx|txt)$/i;
const quotedPathRead = (stmt: string): boolean => [...stmt.matchAll(QUOTED_SOURCE_RE)].some((m) => PATH_LIKE_RE.test(m[2] ?? ""));
const JVM_CALL_RE = /\b(reflect|java_method|try_reflect|call_function)`?\s*\(/i;

export function sqlGuard(sql: string, dialect = "hive"): GuardResult {
  const warnings: string[] = [];
  const stmt = trimStatement(sql);
  if (!stmt) return { ok: false, reason: "empty statement", warnings };
  const masked = maskSql(stmt);
  if (masked.includes(";")) return { ok: false, reason: "more than one statement", warnings };
  const head = masked.trimStart();
  if (!/^(SELECT|WITH|\()/i.test(head)) return { ok: false, reason: `not a SELECT/WITH statement (${head.slice(0, 12)}…)`, warnings };

  const hit = WRITE_RE.exec(masked);
  if (hit) return { ok: false, reason: `keyword ${hit[1]!.toUpperCase()} outside literals`, warnings };
  const withIdents = maskSql(stmt, true);
  if (FILE_READ_RE.test(withIdents) || PATH_READ_RE.test(withIdents)) return { ok: false, reason: "direct file/source read", warnings };
  if (SCRIPT_RE.test(masked)) return { ok: false, reason: "USING outside a JOIN column list (script transform)", warnings };
  if (DUCKDB_IO_RE.test(masked) || quotedPathRead(stmt)) return { ok: false, reason: "file/URL/environment reader function", warnings };
  if (JVM_CALL_RE.test(withIdents)) return { ok: false, reason: "JVM reflection call", warnings };

  try {
    const ast = parser.astify(stmt, { database: dialect });
    const list = Array.isArray(ast) ? ast : [ast];
    if (list.length !== 1) return { ok: false, reason: "more than one statement", warnings };
    const t = (list[0] as { type?: string }).type;
    if (t !== "select") return { ok: false, reason: `statement type ${t}`, warnings };
  } catch (e) {
    warnings.push(`${dialect} parser could not read the statement (${(e as Error).message.split("\n")[0]?.slice(0, 120)}); keyword scan passed`);
  }
  return { ok: true, warnings };
}
