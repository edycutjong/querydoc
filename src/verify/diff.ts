import { compareCanonRows, rowKey, sha256Rows, type CanonRow } from "./canonical.js";
import type { OrderSpec } from "./order.js";

// The canonical row diff of two fully transferred results, and the rows fingerprint (hex SHA-256 of the canonical rows):
// multiset → sorted by a total order over all columns; ordered → in the original's key sequence with rows tied on the keys
// sorted by all columns; raw → as returned.

export function normaliseRows(rows: CanonRow[], spec: OrderSpec): CanonRow[] {
  if (spec.kind === "multiset") return [...rows].sort(compareCanonRows);
  if (spec.kind === "raw") return rows;
  const out: CanonRow[] = [];
  let group: CanonRow[] = [];
  let groupKey: string | null = null;
  for (const r of rows) {
    const k = JSON.stringify(spec.keyIdx.map((i) => r[i] ?? null));
    if (k !== groupKey && group.length) {
      out.push(...group.sort(compareCanonRows));
      group = [];
    }
    groupKey = k;
    group.push(r);
  }
  out.push(...group.sort(compareCanonRows));
  return out;
}

export const rowsFingerprint = (rows: CanonRow[], spec: OrderSpec): string => sha256Rows(normaliseRows(rows, spec));

export interface RowDiff {
  equal: boolean;
  firstDiff?: { side: "orig" | "rewrite"; row: CanonRow };
}

export function diffRows(orig: CanonRow[], rewrite: CanonRow[], spec: OrderSpec): RowDiff {
  if (spec.kind === "multiset") {
    const counts = new Map<string, number>();
    for (const r of orig) counts.set(rowKey(r), (counts.get(rowKey(r)) ?? 0) + 1);
    for (const r of rewrite) {
      const k = rowKey(r);
      const c = counts.get(k) ?? 0;
      if (c === 0) return { equal: false, firstDiff: { side: "rewrite", row: r } };
      counts.set(k, c - 1);
    }
    for (const r of orig) {
      const k = rowKey(r);
      if ((counts.get(k) ?? 0) > 0) return { equal: false, firstDiff: { side: "orig", row: r } };
    }
    return { equal: true };
  }
  const a = normaliseRows(orig, spec);
  const b = normaliseRows(rewrite, spec);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x && y && compareCanonRows(x, y) === 0) continue;
    return x ? { equal: false, firstDiff: { side: "orig", row: x } } : { equal: false, firstDiff: { side: "rewrite", row: y! } };
  }
  return { equal: true };
}
