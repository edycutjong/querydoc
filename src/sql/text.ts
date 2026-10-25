// Literal-aware SQL text helpers. `maskSql` blanks out comments, string literals and quoted identifiers (same length, so offsets
// still line up), leaving only the SQL a keyword scan should see: `SELECT 'DROP TABLE x'` or a `-- DELETE` comment is not DDL.

// keepIdents: leave backtick-quoted identifiers intact (only comments and string literals are blanked) — for scans that must see
// a quoted name, e.g. `parquet`.`s3a://…` or `reflect`(…).
export function maskSql(sql: string, keepIdents = false): string {
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
    } else if (keepIdents && c === "`") {
      const end = sql.indexOf("`", i + 1);
      const stop = end === -1 ? n : end + 1;
      out += sql.slice(i, stop);
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

// One statement as pasted: trailing comments after the closing ";" (`…; -- nightly report`, `…; /* end */`) are not a second
// statement — cut at the last character outside a comment (maskSql keeps quote characters, so a closing literal is never cut).
export const trimStatement = (sql: string): string => {
  const s = sql.trim();
  return s.slice(0, maskSql(s).trimEnd().length).replace(/;\s*$/, "").trim();
};

// Canonical text for hashing and cache keys: comments dropped, whitespace collapsed and everything lower-cased OUTSIDE quotes only, so
// 'x--y' and 'Cash' vs 'cash' remain different statements. A trailing semicolon is dropped.
export function canonicalSql(sql: string): string {
  let out = "";
  let space = false;
  let i = 0;
  const n = sql.length;
  const push = (t: string) => {
    if (space && out) out += " ";
    space = false;
    out += t;
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      space = true;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      space = true;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && c !== "`") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, n);
      push(sql.slice(i, stop));
      i = stop;
    } else if (/\s/.test(c)) {
      space = true;
      i++;
    } else {
      push(c.toLowerCase());
      i++;
    }
  }
  return out.replace(/\s*;$/, "").trim();
}
