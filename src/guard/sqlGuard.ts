import pkg from "node-sql-parser";
import { maskSql, trimStatement } from "../sql/text.js";

const { Parser } = pkg;
const parser = new Parser();

// The read-only gate on every statement the agents send to an engine. The execution path can itself run DDL (the platform runs
// ACTIVATE through the same SQL entry point), so this guard — not a tool allowlist — is what keeps a rewrite read-only.
// Zetaris side: a literal-aware keyword scan (decisive) plus node-sql-parser in the Day-1 dialect (`hive`, querydoc.config.json).
// A single statement the parser cannot read but the scan passes is a WARN, not a refusal; more than one statement, a DDL/DML
// keyword outside literals, a direct file read (`parquet.\`s3a://…\``) or a JVM call (`reflect`, `java_method`) is REFUSED.

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
const FILE_READ_RE = /\b(parquet|csv|json|orc|text|avro|binaryfile|delta|jdbc|hive)\s*\.\s*`/i;
const JVM_CALL_RE = /\b(reflect|java_method|try_reflect)\s*\(/i;

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
  if (FILE_READ_RE.test(masked)) return { ok: false, reason: "direct file/source read", warnings };
  if (JVM_CALL_RE.test(masked)) return { ok: false, reason: "JVM reflection call", warnings };

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
