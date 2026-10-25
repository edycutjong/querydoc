import { describe, expect, it } from "vitest";
import type { Column } from "../src/engine/types.js";
import { canonCell, canonRows, isVacuous, roundSig, sameSchema, typeClass } from "../src/verify/canonical.js";
import { diffRows, rowsFingerprint } from "../src/verify/diff.js";
import { orderSpec } from "../src/verify/order.js";

const cols: Column[] = [
  { name: "k", type: "bigint" },
  { name: "v", type: "string" },
];
const canon = (rows: (string | number | null)[][], c: Column[] = cols) => canonRows(rows, c, 9);
const multiset = orderSpec("SELECT k, v FROM t", ["k", "v"]);

describe("canonical cells", () => {
  it("normalises by type class", () => {
    expect(typeClass("decimal(17,2)")).toBe("decimal");
    expect(typeClass("INT")).toBe("int");
    expect(canonCell("1.50", "decimal", 9)).toBe("1.5");
    expect(canonCell("-0.00", "decimal", 9)).toBe("0");
    expect(canonCell("9007199254740993", "int", 9)).toBe("9007199254740993");
    expect(canonCell(true, "bool", 9)).toBe("true");
    expect(canonCell(null, "string", 9)).toBeNull();
  });

  it("rounds floats to N significant digits, so a re-ordered sum's last bits do not count", () => {
    expect(roundSig(0.1 + 0.2, 9)).toBe(roundSig(0.3, 9));
    expect(roundSig(-0, 9)).toBe("0");
    expect(roundSig(1234567.891, 9)).not.toBe(roundSig(1234567.9, 9));
  });

  it("detects vacuous results", () => {
    expect(isVacuous([])).toBe(true);
    expect(isVacuous([[null, null]])).toBe(true);
    expect(isVacuous([[null, 1]])).toBe(false);
  });

  it("compares result schemas by name and type class", () => {
    expect(sameSchema(cols, [{ name: "k", type: "int" }, { name: "v", type: "varchar(10)" }]).equal).toBe(true);
    expect(sameSchema(cols, [{ name: "key", type: "bigint" }, { name: "v", type: "string" }]).detail).toMatch(/named/);
    expect(sameSchema(cols, [{ name: "k", type: "double" }, { name: "v", type: "string" }]).detail).toMatch(/type int vs float/);
    expect(sameSchema(cols, [cols[0]!]).equal).toBe(false);
  });
});

describe("row diff and fingerprint — multiset", () => {
  const a = canon([[1, "a"], [2, null], [2, null], [3, "c"]]);
  it("a row-permuted multiset keeps its fingerprint", () => {
    const b = canon([[3, "c"], [2, null], [1, "a"], [2, null]]);
    expect(rowsFingerprint(b, multiset)).toBe(rowsFingerprint(a, multiset));
    expect(diffRows(a, b, multiset).equal).toBe(true);
  });
  it("duplicates count: a missing duplicate is a difference", () => {
    const b = canon([[1, "a"], [2, null], [3, "c"]]);
    expect(rowsFingerprint(b, multiset)).not.toBe(rowsFingerprint(a, multiset));
    expect(diffRows(a, b, multiset)).toEqual({ equal: false, firstDiff: { side: "orig", row: ["2", null] } });
  });
  it("NULL is not the string 'null' and not an empty string", () => {
    expect(diffRows(canon([[2, null]]), canon([[2, "null"]]), multiset).equal).toBe(false);
    expect(diffRows(canon([[2, null]]), canon([[2, ""]]), multiset).equal).toBe(false);
  });
  it("re-paired rows differ (what a wrong join key produces)", () => {
    const d = diffRows(canon([[1, "a"], [2, "b"]]), canon([[1, "b"], [2, "a"]]), multiset);
    expect(d).toEqual({ equal: false, firstDiff: { side: "rewrite", row: ["1", "b"] } });
  });
  it("floats within the tolerance are equal; outside it they are not", () => {
    const fc: Column[] = [{ name: "s", type: "double" }];
    expect(diffRows(canon([[0.1 + 0.2]], fc), canon([[0.3]], fc), multiset).equal).toBe(true);
    expect(diffRows(canon([[0.3]], fc), canon([[0.3000001]], fc), multiset).equal).toBe(false);
  });
});

describe("row diff and fingerprint — ordered", () => {
  const sql = "SELECT k, v FROM t ORDER BY k DESC";
  const spec = orderSpec(sql, ["k", "v"]);
  it("maps ORDER BY keys to output columns", () => {
    expect(spec).toEqual({ kind: "ordered", keyIdx: [0], limit: null });
    expect(orderSpec("SELECT a AS x, b FROM t ORDER BY 2, x LIMIT 5", ["x", "b"])).toEqual({ kind: "ordered", keyIdx: [1, 0], limit: 5 });
    expect(orderSpec("SELECT a FROM t UNION ALL SELECT a FROM u ORDER BY a", ["a"]).kind).toBe("ordered");
  });
  it("a permutation inside a tie keeps the fingerprint", () => {
    const a = canon([[3, "x"], [2, "a"], [2, "b"], [1, "z"]]);
    const b = canon([[3, "x"], [2, "b"], [2, "a"], [1, "z"]]);
    expect(rowsFingerprint(b, spec)).toBe(rowsFingerprint(a, spec));
    expect(diffRows(a, b, spec).equal).toBe(true);
  });
  it("a changed key order (DESC → ASC) changes the fingerprint", () => {
    const desc = canon([[3, "x"], [2, "a"], [1, "z"]]);
    const asc = canon([[1, "z"], [2, "a"], [3, "x"]]);
    expect(rowsFingerprint(asc, spec)).not.toBe(rowsFingerprint(desc, spec));
    expect(diffRows(desc, asc, spec).equal).toBe(false);
  });
  it("the first difference names a row that really is on one side only, or says only the order differs", () => {
    const orig = canon([[3, "x"], [2, "a"], [1, "z"]]);
    // same rows, other order: no row is missing from either side
    expect(diffRows(orig, canon([[1, "z"], [2, "a"], [3, "x"]]), spec).firstDiff).toEqual({ side: "orig", row: orig[0], order: true });
    // [2,"a"] → [2,"b"]: position 1 differs, and [2,"a"] really is missing from the rewrite (not [3,"x"], which both have)
    const changed = diffRows(orig, canon([[3, "x"], [2, "b"], [1, "z"]]), spec).firstDiff!;
    expect(changed.order).toBeUndefined();
    expect(changed.row).toEqual(canon([[2, "b"]])[0]);
    expect(changed.side).toBe("rewrite");
    // an extra row at the top shifts every position; the named row is the extra one
    const extra = diffRows(orig, canon([[4, "n"], [3, "x"], [2, "a"], [1, "z"]]), spec).firstDiff!;
    expect(extra).toEqual({ side: "rewrite", row: canon([[4, "n"]])[0] });
  });
  it("a non-selected or expression key falls back to raw order, which still sees a changed order", () => {
    const raw = orderSpec("SELECT v FROM t ORDER BY created_at DESC", ["v"]);
    expect(raw.kind).toBe("raw");
    expect(orderSpec("SELECT k FROM t ORDER BY k + 1", ["k"]).kind).toBe("raw");
    const c1: Column[] = [{ name: "v", type: "string" }];
    const desc = canon([["c"], ["b"], ["a"]], c1);
    const asc = canon([["a"], ["b"], ["c"]], c1);
    expect(rowsFingerprint(asc, raw)).not.toBe(rowsFingerprint(desc, raw));
    expect(diffRows(desc, asc, raw).equal).toBe(false);
  });
  it("an unparseable ORDER BY is raw (fail-safe), an unparseable query without one is a multiset", () => {
    expect(orderSpec("SELECT k FROM t ORDER BY k QUALIFY ???", ["k"]).kind).toBe("raw");
    expect(orderSpec("SELECT k FROM t QUALIFY ???", ["k"]).kind).toBe("multiset");
  });
});
