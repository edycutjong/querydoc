import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = ["QD_COV_A", "QD_COV_B", "QD_COV_C", "QD_COV_D", "QD_COV_E", "QD_COV_F", "QD_COV_G"];
let tmp: string;
let saved: NodeJS.ProcessEnv;

async function load() {
  vi.resetModules();
  return (await import("../src/env.js")).loadQuerydocEnv;
}

beforeEach(() => {
  saved = { ...process.env };
  tmp = mkdtempSync(join(tmpdir(), "qd-env-"));
  process.env.QUERYDOC_ENV_DIR = tmp;
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadQuerydocEnv", () => {
  it("returns an empty list when none of the default files exist", async () => {
    const fn = await load();
    expect(fn()).toEqual([]);
  });

  it("loads variables from existing default files and reports only those files", async () => {
    writeFileSync(join(tmp, "zetaris.env"), "QD_COV_A=alpha\n");
    writeFileSync(join(tmp, "nvidia.env"), "QD_COV_B=beta\n");
    const fn = await load();
    expect(fn()).toEqual(["zetaris.env", "nvidia.env"]);
    expect(process.env.QD_COV_A).toBe("alpha");
    expect(process.env.QD_COV_B).toBe("beta");
  });

  it("does not overwrite a variable already set in the environment", async () => {
    process.env.QD_COV_A = "shell";
    writeFileSync(join(tmp, "x.env"), "QD_COV_A=file\n");
    const fn = await load();
    expect(fn(["x.env"])).toEqual(["x.env"]);
    expect(process.env.QD_COV_A).toBe("shell");
  });

  it("skips blank lines, comments and lines without a key before '='", async () => {
    writeFileSync(join(tmp, "x.env"), "\n# QD_COV_A=no\n   \nnoequals\n=nokey\nQD_COV_B=yes\n");
    const fn = await load();
    fn(["x.env"]);
    expect(process.env.QD_COV_A).toBeUndefined();
    expect(process.env.QD_COV_B).toBe("yes");
  });

  it("strips matching single and double quotes and trims whitespace", async () => {
    writeFileSync(join(tmp, "x.env"), "QD_COV_A = \"dq\" \nQD_COV_B='sq'\nQD_COV_C=\"mixed'\n");
    const fn = await load();
    fn(["x.env"]);
    expect(process.env.QD_COV_A).toBe("dq");
    expect(process.env.QD_COV_B).toBe("sq");
    expect(process.env.QD_COV_C).toBe("\"mixed'");
  });

  it("ignores empty values so they do not set the variable", async () => {
    writeFileSync(join(tmp, "x.env"), "QD_COV_A=\nQD_COV_B=\"\"\n");
    const fn = await load();
    fn(["x.env"]);
    expect(process.env.QD_COV_A).toBeUndefined();
    expect(process.env.QD_COV_B).toBeUndefined();
  });

  it("keeps '=' characters inside values", async () => {
    writeFileSync(join(tmp, "x.env"), "QD_COV_A=a=b=c\n");
    const fn = await load();
    fn(["x.env"]);
    expect(process.env.QD_COV_A).toBe("a=b=c");
  });

  it("skips missing files in a custom list but loads the present ones", async () => {
    writeFileSync(join(tmp, "b.env"), "QD_COV_A=1\n");
    const fn = await load();
    expect(fn(["a.env", "b.env"])).toEqual(["b.env"]);
  });

  it("falls back to ~/.config/querydoc under HOME when QUERYDOC_ENV_DIR is unset", async () => {
    delete process.env.QUERYDOC_ENV_DIR;
    const dir = join(tmp, ".config", "querydoc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "zetaris.env"), "QD_COV_G=home\n");
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    const fn = await load();
    expect(fn(["zetaris.env"])).toEqual(["zetaris.env"]);
    expect(process.env.QD_COV_G).toBe("home");
  });
});
