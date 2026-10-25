import { createHash } from "node:crypto";
import type { Cell, Column } from "../engine/types.js";

// Canonical form of a result set, so two engines' (or two runs') rows compare by value, not by how the driver printed them.
// Each cell becomes a string (or null) by its column's type class: integers through BigInt, DECIMALs with trailing zeros dropped,
// floats rounded to N significant digits (relative tolerance — pre-aggregation and pushdown rewrites re-order sums, which moves
// the last bits; rounding at a boundary can only cause a false refusal, never a false accept). Exact DECIMAL aggregates never take
// the float path.

export type TypeClass = "int" | "float" | "decimal" | "string" | "bool" | "date" | "timestamp" | "binary" | "other";
export type CanonCell = string | null;
export type CanonRow = CanonCell[];

export function typeClass(engineType: string): TypeClass {
  const t = engineType.trim().toLowerCase();
  if (/^(tinyint|smallint|int|integer|bigint|long|short|byte|hugeint|ubigint|uinteger|usmallint|utinyint)$/.test(t)) return "int";
  if (/^(float|double|real|float4|float8|double precision)$/.test(t)) return "float";
  if (/^(decimal|numeric)(\s*\(.*\))?$/.test(t)) return "decimal";
  if (/^(string|varchar|char|text)(\s*\(.*\))?$/.test(t)) return "string";
  if (/^bool(ean)?$/.test(t)) return "bool";
  if (t === "date") return "date";
  if (t.startsWith("timestamp")) return "timestamp";
  if (/^(binary|blob|bytea|varbinary)$/.test(t)) return "binary";
  return "other";
}

// The result-schema check compares names exactly (a renamed column breaks a dashboard even when every value matches) and types by
// class (int vs bigint, or decimal(17,2) vs decimal(18,2), hold the same values).
export function canonicalColumns(cols: Column[]): { name: string; type: TypeClass }[] {
  return cols.map((c) => ({ name: c.name, type: typeClass(c.type) }));
}

export function sameSchema(a: Column[], b: Column[]): { equal: boolean; detail?: string } {
  if (a.length !== b.length) return { equal: false, detail: `column count ${a.length} vs ${b.length}` };
  const ca = canonicalColumns(a);
  const cb = canonicalColumns(b);
  for (let i = 0; i < ca.length; i++) {
    const x = ca[i]!;
    const y = cb[i]!;
    if (x.name !== y.name) return { equal: false, detail: `column ${i + 1} named ${JSON.stringify(x.name)} vs ${JSON.stringify(y.name)}` };
    if (x.type !== y.type) return { equal: false, detail: `column ${JSON.stringify(x.name)} type ${x.type} vs ${y.type}` };
  }
  return { equal: true };
}

export function roundSig(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0"; // also folds -0
  return String(Number(x.toPrecision(digits)));
}

function canonDecimal(s: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) return s.trim();
  const int = (m[2] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const body = frac ? `${int}.${frac}` : int;
  return body === "0" ? "0" : `${m[1] === "-" ? "-" : ""}${body}`;
}

export function canonCell(v: Cell, cls: TypeClass, floatSigDigits: number): CanonCell {
  if (v === null || v === undefined) return null;
  switch (cls) {
    case "int":
      try {
        return BigInt(typeof v === "number" ? Math.trunc(v) : String(v).trim()).toString();
      } catch {
        return String(v);
      }
    case "float": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isNaN(n) && String(v) !== "NaN" ? String(v) : roundSig(n, floatSigDigits);
    }
    case "decimal":
      return canonDecimal(String(v));
    case "bool":
      return String(v === true || String(v).toLowerCase() === "true");
    default:
      return String(v);
  }
}

export function canonRows(rows: Cell[][], cols: Column[], floatSigDigits: number): CanonRow[] {
  const classes = cols.map((c) => typeClass(c.type));
  return rows.map((r) => r.map((v, i) => canonCell(v, classes[i] ?? "other", floatSigDigits)));
}

// Total order over canonical rows: NULLs first, then by the canonical string. Any fixed total order works — both sides are
// sorted the same way — so no numeric comparison is needed.
export function compareCanonRows(a: CanonRow, b: CanonRow): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const rowKey = (r: CanonRow): string => JSON.stringify(r);

export function sha256Rows(rows: CanonRow[]): string {
  const h = createHash("sha256");
  for (const r of rows) h.update(rowKey(r) + "\n");
  return h.digest("hex");
}

export function sha256Text(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export const isVacuous = (rows: Cell[][]): boolean => rows.length === 0 || rows.every((r) => r.every((v) => v === null));
