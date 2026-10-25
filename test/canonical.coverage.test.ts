import { describe, expect, it } from "vitest";
import {
  canonCell, canonRows, canonicalColumns, compareCanonRows, isVacuous, roundSig, rowKey,
  sameSchema, sha256Rows, sha256Text, typeClass,
} from "../src/verify/canonical.js";

const col = (name: string, type: string) => ({ name, type }) as never;
const cell = (v: unknown) => v as never;

describe("typeClass", () => {
  it.each([
    ["BIGINT", "int"], [" tinyint ", "int"], ["double precision", "float"], ["REAL", "float"],
    ["decimal(17,2)", "decimal"], ["numeric", "decimal"], ["varchar(20)", "string"], ["text", "string"],
    ["boolean", "bool"], ["bool", "bool"], ["date", "date"], ["timestamp_ntz", "timestamp"],
    ["blob", "binary"], ["bytea", "binary"], ["array<int>", "other"],
  ])("classifies %s as %s", (t, c) => expect(typeClass(t)).toBe(c));
});

describe("schema comparison", () => {
  it("maps columns to name and type class", () => {
    expect(canonicalColumns([col("a", "BIGINT")])).toEqual([{ name: "a", type: "int" }]);
  });
  it("reports differing column counts", () => {
    expect(sameSchema([col("a", "int")], [])).toEqual({ equal: false, detail: "column count 1 vs 0" });
  });
  it("reports a renamed column", () => {
    expect(sameSchema([col("a", "int")], [col("b", "int")])).toEqual({ equal: false, detail: 'column 1 named "a" vs "b"' });
  });
  it("reports a type-class mismatch", () => {
    expect(sameSchema([col("a", "int")], [col("a", "double")])).toEqual({ equal: false, detail: 'column "a" type int vs float' });
  });
  it("treats int vs bigint and decimal precisions as equal", () => {
    expect(sameSchema([col("a", "int"), col("d", "decimal(17,2)")], [col("a", "bigint"), col("d", "decimal(18,2)")])).toEqual({ equal: true });
  });
});

describe("roundSig", () => {
  it("folds -0 to 0", () => expect(roundSig(-0, 6)).toBe("0"));
  it("passes through non-finite values", () => {
    expect(roundSig(NaN, 6)).toBe("NaN");
    expect(roundSig(Infinity, 6)).toBe("Infinity");
    expect(roundSig(-Infinity, 6)).toBe("-Infinity");
  });
  it("rounds to significant digits", () => expect(roundSig(1.23456789, 3)).toBe("1.23"));
});

describe("canonCell", () => {
  it("maps null and undefined to null", () => {
    expect(canonCell(null, "int", 6)).toBeNull();
    expect(canonCell(cell(undefined), "string", 6)).toBeNull();
  });
  it("int: truncates numbers, parses strings and bigint", () => {
    expect(canonCell(3.9, "int", 6)).toBe("3");
    expect(canonCell(-3.9, "int", 6)).toBe("-3");
    expect(canonCell(" 0042 ", "int", 6)).toBe("42");
    expect(canonCell(cell(12345678901234567890n), "int", 6)).toBe("12345678901234567890");
  });
  it("int: falls back to String when not parseable", () => {
    expect(canonCell("abc", "int", 6)).toBe("abc");
    expect(canonCell(NaN, "int", 6)).toBe("NaN");
  });
  it("float: numbers, numeric strings, NaN and unparseable text", () => {
    expect(canonCell(0.1 + 0.2, "float", 6)).toBe("0.3");
    expect(canonCell("1.50", "float", 6)).toBe("1.5");
    expect(canonCell(-0, "float", 6)).toBe("0");
    expect(canonCell(NaN, "float", 6)).toBe("NaN");
    expect(canonCell("NaN", "float", 6)).toBe("NaN");
    expect(canonCell("oops", "float", 6)).toBe("oops");
  });
  it("decimal: strips zeros, signs and leading zeros", () => {
    expect(canonCell("12.500", "decimal", 6)).toBe("12.5");
    expect(canonCell("007.00", "decimal", 6)).toBe("7");
    expect(canonCell("-1.50", "decimal", 6)).toBe("-1.5");
    expect(canonCell("+2.5", "decimal", 6)).toBe("2.5");
    expect(canonCell("-0.00", "decimal", 6)).toBe("0");
    expect(canonCell(".5", "decimal", 6)).toBe("0.5");
    expect(canonCell("", "decimal", 6)).toBe("0");
    expect(canonCell(cell(3), "decimal", 6)).toBe("3");
  });
  it("decimal: returns trimmed text when not numeric", () => {
    expect(canonCell("  1e5 ", "decimal", 6)).toBe("1e5");
  });
  it("bool: true, 'TRUE', false and other values", () => {
    expect(canonCell(true, "bool", 6)).toBe("true");
    expect(canonCell("TRUE", "bool", 6)).toBe("true");
    expect(canonCell(false, "bool", 6)).toBe("false");
    expect(canonCell("no", "bool", 6)).toBe("false");
  });
  it("other classes stringify the value", () => {
    expect(canonCell("x", "string", 6)).toBe("x");
    expect(canonCell(cell(new Date("2024-01-02T03:04:05.000Z")), "timestamp", 6)).toBe(String(new Date("2024-01-02T03:04:05.000Z")));
    expect(canonCell(cell(7), "other", 6)).toBe("7");
  });
});

describe("canonRows", () => {
  it("canonicalises per column class and defaults extra cells to other", () => {
    const rows = [[1.9, "2.50", null, "extra"]] as never;
    expect(canonRows(rows, [col("a", "int"), col("b", "decimal(5,2)"), col("c", "text")], 6)).toEqual([["1", "2.5", null, "extra"]]);
  });
});

describe("compareCanonRows", () => {
  it("returns 0 for equal rows", () => expect(compareCanonRows(["a", null], ["a", null])).toBe(0));
  it("orders null before values", () => {
    expect(compareCanonRows([null], ["a"])).toBe(-1);
    expect(compareCanonRows(["a"], [null])).toBe(1);
  });
  it("orders shorter rows first", () => {
    expect(compareCanonRows(["a"], ["a", "b"])).toBe(-1);
    expect(compareCanonRows(["a", "b"], ["a"])).toBe(1);
  });
  it("orders by canonical string", () => {
    expect(compareCanonRows(["a"], ["b"])).toBe(-1);
    expect(compareCanonRows(["b"], ["a"])).toBe(1);
  });
});

describe("hashing and vacuity", () => {
  it("rowKey is JSON", () => expect(rowKey(["a", null])).toBe('["a",null]'));
  it("sha256Text matches the known digest of 'abc'", () => {
    expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("sha256Rows hashes each row key plus newline", () => {
    expect(sha256Rows([["a"], [null]])).toBe(sha256Text('["a"]\n[null]\n'));
  });
  it("isVacuous: empty, all-null and real data", () => {
    expect(isVacuous([])).toBe(true);
    expect(isVacuous([[null, null]])).toBe(true);
    expect(isVacuous([[null, 0]])).toBe(false);
  });
});
