// Literal-aware SQL text helpers. `maskSql` blanks out comments, string literals and quoted identifiers (same length, so offsets
// still line up), leaving only the SQL a keyword scan should see: `SELECT 'DROP TABLE x'` or a `-- DELETE` comment is not DDL.

export function maskSql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && c !== "`") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2; // doubled quote inside the literal
            continue;
          }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, n);
      // keep the quote characters so a masked literal still reads as a token
      out += c + sql.slice(i + 1, stop - 1).replace(/[^\n]/g, " ") + (stop - 1 > i ? sql[stop - 1] : "");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export const trimStatement = (sql: string): string => sql.trim().replace(/;\s*$/, "").trim();
