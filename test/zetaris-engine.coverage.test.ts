import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ spawnSync: undefined as undefined | ((...a: unknown[]) => unknown), exists: undefined as undefined | (() => boolean), spawnOverride: undefined as undefined | ((...a: unknown[]) => unknown), realSpawn: undefined as undefined | ((...a: unknown[]) => unknown), stat: undefined as undefined | ((p: string) => { mtimeMs: number }) }));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  h.realSpawn = actual.spawn as (...x: unknown[]) => unknown;
  return {
    ...actual,
    spawn: (...a: unknown[]) => (h.spawnOverride ? h.spawnOverride(...a) : (actual.spawn as (...x: unknown[]) => unknown)(...a)),
    spawnSync: (...a: unknown[]) => (h.spawnSync ? h.spawnSync(...a) : (actual.spawnSync as (...x: unknown[]) => unknown)(...a)),
  };
});
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: string) => (h.exists ? h.exists() : actual.existsSync(p)), statSync: (p: string) => (h.stat ? h.stat(p) : actual.statSync(p)) };
});

import { DEFAULT_ROW_CAP, ZetarisEngine, zetarisConfigFromEnv, type ZetarisConfig } from "../src/engine/zetaris.js";
import { EngineError } from "../src/engine/types.js";

// Scriptable stand-in sidecar, driven by the SQL text. Speaks the real line protocol: "id op rowCap drain timeout base64(sql)".
const SCRIPT = `
const rl = require("readline").createInterface({ input: process.stdin });
const mode = process.argv[1] || "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (mode === "exit-early") { process.stderr.write("jvm banner\\n"); setTimeout(() => process.exit(7), 20); }
else if (mode !== "never-ready") send({ ready: true });
rl.on("line", (line) => {
  const [id, op, rowCap, drain, timeout, b64] = line.split("\\t");
  const sql = Buffer.from(b64, "base64").toString("utf8");
  const ok = (extra) => send(Object.assign({ id, ok: true, elapsedMs: 4 }, extra));
  if (sql === "SELECT 1") return ok({ columns: [{ name: "x", type: "INT", jdbcType: 4 }], rows: [[1]], rowCount: 1, rowCountExact: true, truncated: false });
  if (sql === "MINIMAL") return ok({});
  if (sql === "ARGS") return ok({ rows: [[op, rowCap, drain, timeout]] });
  if (sql === "ENV") return ok({ rows: [[process.env.ZETARIS_JDBC_URL, process.env.ZETARIS_USER, process.env.ZETARIS_PASSWORD, process.env.ZETARIS_JDBC_DRIVER_CLASS || null, process.env.SECRET_LEAK || null]] });
  if (sql === "TRUNC") return ok({ columns: [{ name: "n", type: "BIGINT", jdbcType: -5 }], rows: [[1], [2]], rowCount: 2, rowCountExact: false, truncated: true });
  if (sql === "BOOM") return send({ id, ok: false, error: "table not found", sqlState: "42S02", elapsedMs: 1 });
  if (sql === "EXIT") { process.stderr.write("fatal oom\\n"); return process.exit(9); }
  if (sql === "NOISE") {
    for (let i = 0; i < 25; i++) process.stdout.write("junk-" + i + "\\n");
    process.stdout.write("null\\n5\\n");
    send({ id: null, ok: false, error: "ignored", sqlState: null, elapsedMs: 0 });
    send({ id: "999", ok: false, error: "stray", sqlState: null, elapsedMs: 0 });
    return ok({ rows: [["after-noise"]] });
  }
  if (sql === "STDERR") {
    let i = 0;
    const t = setInterval(() => { process.stderr.write("e" + i + "\\n"); if (++i === 25) { clearInterval(t); setTimeout(() => process.exit(2), 30); } }, 2);
    return;
  }
  if (sql.startsWith("SHOW TABLES IN ")) return ok({ rows: [["DB.t1"], ["DB.a.b"], ["bare"], [".lead"]] });
  if (sql.endsWith(".EMPTYT")) return ok({ rows: [] });
  if (sql.endsWith(".NULLNAME")) return ok({ rows: [["id", "int"], [null, null], ["late", "int"]] });
  if (sql.endsWith(".BLANK")) return ok({ rows: [["id", "int"], ["  ", ""], ["late", "int"]] });
  if (sql.startsWith("DESCRIBE ")) return ok({ rows: [["id", "int"], ["name", "string"], ["# Partition Information", ""], ["part", "date"]] });
  if (sql.startsWith("EXPLAIN FORMATTED ")) return ok({ rows: [["== Physical Plan ==\\n* Scan parquet (1)"]] });
  if (sql === "HANG") return;
  ok({ rows: [[sql]] });
});
`;

const cfg = (over: Partial<ZetarisConfig> = {}, mode = ""): ZetarisConfig => ({
  jdbcUrl: "jdbc:fake://host",
  jdbcJar: "/nonexistent.jar",
  user: "alice",
  password: "s3cret",
  sidecarCmd: [process.execPath, "-e", SCRIPT, mode],
  graceSec: 0.3,
  ...over,
});
const engines: ZetarisEngine[] = [];
const open = (over: Partial<ZetarisConfig> = {}, mode = "") => {
  const e = new ZetarisEngine(cfg(over, mode));
  engines.push(e);
  return e;
};
beforeEach(() => {
  h.spawnSync = undefined;
  h.exists = undefined;
  h.spawnOverride = undefined;
  h.stat = undefined;
});
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
});

describe("zetarisConfigFromEnv", () => {
  const base = { ZETARIS_JDBC_URL: "jdbc:z", ZETARIS_JDBC_JAR: "~/lib/z.jar", ZETARIS_USER: "u", ZETARIS_PASSWORD: "p" };
  it.each(["ZETARIS_JDBC_URL", "ZETARIS_JDBC_JAR", "ZETARIS_USER", "ZETARIS_PASSWORD"])("returns null when %s is missing", (k) => {
    expect(zetarisConfigFromEnv({ ...base, [k]: undefined })).toBeNull();
  });
  it("expands a leading ~/ in the jar path and omits driverClass when unset", () => {
    const c = zetarisConfigFromEnv(base)!;
    expect(c.jdbcJar).toBe(`${process.env.HOME}/lib/z.jar`);
    expect(c).not.toHaveProperty("driverClass");
  });
  it("keeps an absolute jar path and carries the driver class override", () => {
    const c = zetarisConfigFromEnv({ ...base, ZETARIS_JDBC_JAR: "/opt/z.jar", ZETARIS_JDBC_DRIVER_CLASS: "com.z.Driver" })!;
    expect(c.jdbcJar).toBe("/opt/z.jar");
    expect(c.driverClass).toBe("com.z.Driver");
  });
  it("reads process.env by default", () => {
    const saved = { ...process.env };
    Object.assign(process.env, base);
    try {
      expect(zetarisConfigFromEnv()?.user).toBe("u");
    } finally {
      for (const k of Object.keys(base)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
});

describe("ZetarisEngine.run", () => {
  it("maps sidecar columns to name/type only and carries rows, counts and sidecarMs", async () => {
    const r = await open().run("SELECT 1");
    expect(r.columns).toEqual([{ name: "x", type: "INT" }]);
    expect(r.rows).toEqual([[1]]);
    expect(r.rowCount).toBe(1);
    expect(r.rowCountExact).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.sidecarMs).toBe(4);
    expect(r.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("defaults missing reply fields: no columns/rows, rowCount 0, exact, not truncated", async () => {
    const r = await open().run("MINIMAL");
    expect(r).toMatchObject({ columns: [], rows: [], rowCount: 0, rowCountExact: true, truncated: false });
  });

  it("returns truncated=true and rowCountExact=false when the sidecar reports more rows than rowCap", async () => {
    const r = await open().run("TRUNC", { rowCap: 2 });
    expect(r.truncated).toBe(true);
    expect(r.rowCountExact).toBe(false);
  });

  it("sends the default row cap, no drain and the default 120 s timeout", async () => {
    const r = await open().run("ARGS");
    expect(r.rows).toEqual([["run", String(DEFAULT_ROW_CAP), "0", "120"]]);
  });

  it("forwards explicit rowCap, drain and timeoutSec to the sidecar", async () => {
    const r = await open().run("ARGS", { rowCap: 5, drain: true, timeoutSec: 7 });
    expect(r.rows).toEqual([["run", "5", "1", "7"]]);
  });

  it("round-trips non-ASCII SQL through base64", async () => {
    const r = await open().run("SELECT 'héllo ✓'");
    expect(r.rows).toEqual([["SELECT 'héllo ✓'"]]);
  });

  it("throws an EngineError carrying the sidecar's message and sqlState", async () => {
    const err = await open().run("BOOM").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).message).toBe("table not found");
    expect((err as EngineError).sqlState).toBe("42S02");
  });

  it("serialises concurrent statements with increasing ids and keeps working after a failed one", async () => {
    const e = open();
    const [a, b, c] = await Promise.allSettled([e.run("SELECT 1"), e.run("BOOM"), e.run("MINIMAL")]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(c.status).toBe("fulfilled");
  });

  it("passes only the whitelisted environment (credentials, URL, driver class) to the sidecar", async () => {
    process.env.SECRET_LEAK = "leaky";
    try {
      const r = await open({ driverClass: "com.z.Driver" }).run("ENV");
      expect(r.rows).toEqual([["jdbc:fake://host", "alice", "s3cret", "com.z.Driver", null]]);
    } finally {
      delete process.env.SECRET_LEAK;
    }
  });

  it("omits the driver class variable when none is configured", async () => {
    const r = await open().run("ENV");
    expect(r.rows[0]![3]).toBeNull();
  });

  it("ignores junk, non-object and unknown-id lines and still delivers the real reply", async () => {
    const r = await open().run("NOISE");
    expect(r.rows).toEqual([["after-noise"]]);
  });

  it("keeps only a bounded tail of stdout junk for the error message when the sidecar later dies", async () => {
    const e = open();
    await e.run("NOISE");
    await expect(e.run("EXIT")).rejects.toThrow(/sidecar exited \(9\).*fatal oom/s);
  });

  it("bounds the stderr tail to the last 20 chunks", async () => {
    const err = (await open().run("STDERR").catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/sidecar exited \(2\)/);
    expect(err.message).toContain("e24");
    expect(err.message).not.toContain("e0\n");
  });

  it("fails the in-flight statement when the sidecar exits mid-request, then restarts on the next one", async () => {
    const e = open();
    await expect(e.run("EXIT")).rejects.toThrow(/sidecar exited \(9\): .*fatal oom/s);
    const r = await e.run("SELECT 1");
    expect(r.rows).toEqual([[1]]);
  });

  it("fails with the exit code and stderr when the sidecar dies before it is ready", async () => {
    await expect(open({}, "exit-early").run("SELECT 1")).rejects.toThrow(/sidecar exited \(7\).*jvm banner/s);
  });

  it("fails with 'could not run' when the sidecar command cannot be spawned", async () => {
    const e = open({ sidecarCmd: ["/nonexistent/definitely-not-a-binary"] });
    await expect(e.run("SELECT 1")).rejects.toThrow(/sidecar could not run \(.*ENOENT/);
  });

  it("kills a never-ready sidecar at the startup bound", async () => {
    await expect(open({ startupSec: 0.2 }, "never-ready").run("SELECT 1")).rejects.toThrow(/no ready line within 0.2 s/);
  });

  it("a hung statement is killed at timeoutSec + grace with the deadline in the message", async () => {
    const e = open({ graceSec: 0.2 });
    await expect(e.run("HANG", { timeoutSec: 0 })).rejects.toThrow(/no reply from the sidecar 0.2 s after sending a statement with a 0 s timeout/);
    expect((await e.run("SELECT 1")).rows).toEqual([[1]]);
  });
});

describe("ZetarisEngine.health", () => {
  it("reports ok with wall time when SELECT 1 succeeds", async () => {
    const r = await open().health();
    expect(r.ok).toBe(true);
    expect(r.wallMs).toBeGreaterThanOrEqual(0);
  });
  it("reports the sidecar's error when the statement fails", async () => {
    const e = open({ sidecarCmd: [process.execPath, "-e", `const rl=require("readline").createInterface({input:process.stdin});process.stdout.write('{"ready":true}\\n');rl.on("line",l=>{const id=l.split("\\t")[0];process.stdout.write(JSON.stringify({id,ok:false,error:"no auth",sqlState:"28000",elapsedMs:1})+"\\n")})`] });
    expect(await e.health()).toMatchObject({ ok: false, error: "no auth" });
  });
  it("reports ok=false with wallMs 0 when the sidecar cannot start", async () => {
    expect(await open({}, "exit-early").health()).toMatchObject({ ok: false, wallMs: 0, error: expect.stringContaining("exited (7)") });
  });
});

describe("ZetarisEngine metadata helpers", () => {
  it("listTables splits DB.table names and falls back to the given schema for bare names", async () => {
    const t = await open().listTables("DB");
    expect(t).toEqual([
      { schema: "DB", table: "t1" },
      { schema: "DB", table: "a.b" },
      { schema: "DB", table: "bare" },
      { schema: "DB", table: ".lead" },
    ]);
  });
  it("listTables refuses an injectable schema name before touching the sidecar", async () => {
    await expect(open().listTables("x; DROP TABLE y")).rejects.toThrow(/refusing identifier/);
  });
  it("tableInfo stops at the partition section comment row", async () => {
    expect(await open().tableInfo({ schema: "DB", table: "t1" })).toEqual([
      { name: "id", type: "int" },
      { name: "name", type: "string" },
    ]);
  });
  it("tableInfo returns [] for an empty DESCRIBE result", async () => {
    expect(await open().tableInfo({ schema: "DB", table: "EMPTYT" })).toEqual([]);
  });
  it("tableInfo stops at a null or blank column name row", async () => {
    expect(await open().tableInfo({ schema: "DB", table: "NULLNAME" })).toEqual([{ name: "id", type: "int" }]);
    expect(await open().tableInfo({ schema: "DB", table: "BLANK" })).toEqual([{ name: "id", type: "int" }]);
  });
  it("tableInfo refuses a bad table identifier", async () => {
    await expect(open().tableInfo({ schema: "DB", table: "t-1" })).rejects.toThrow(/refusing identifier "t-1"/);
  });
  it("explain refuses a statement the SQL guard rejects", async () => {
    await expect(open().explain("DROP TABLE t")).rejects.toThrow(/guard refused the statement to explain/);
  });
  it("explain returns the plan text, parsed nodes and wall time", async () => {
    const p = await open().explain("SELECT 1;");
    expect(p.format).toBe("spark-physical-text");
    expect(p.text).toContain("Physical Plan");
    expect(Array.isArray(p.nodes)).toBe(true);
    expect(p.wallMs).toBeGreaterThanOrEqual(0);
  });
  it("rowHashSql builds an xxhash64 fingerprint over the inner query", () => {
    const sql = open().rowHashSql("SELECT a FROM t", [{ name: "a", type: "int" }], 6);
    expect(sql).toMatch(/xxhash64/i);
    expect(sql).toContain("SELECT a FROM t");
  });
  it("close() on an engine that never started is a no-op", async () => {
    await expect(open().close()).resolves.toBeUndefined();
  });
});

describe("ZetarisEngine default sidecar launch (javac / java mocked)", () => {
  const fakeSpawn = () => {
    const calls: unknown[][] = [];
    h.spawnOverride = (...a: unknown[]) => {
      calls.push(a);
      return h.realSpawn!(process.execPath, ["-e", SCRIPT, ""], { stdio: ["pipe", "pipe", "pipe"] });
    };
    return calls;
  };
  const noCmd = (over: Partial<ZetarisConfig> = {}): ZetarisEngine => {
    const e = new ZetarisEngine({ jdbcUrl: "jdbc:fake", jdbcJar: "rel/driver.jar", user: "u", password: "p", ...over });
    engines.push(e);
    return e;
  };

  it("skips javac when the compiled class is as new as the source and launches java with an absolute classpath", async () => {
    h.exists = () => true;
    h.stat = () => ({ mtimeMs: 100 });
    const sync = vi.fn();
    h.spawnSync = sync;
    const calls = fakeSpawn();
    await noCmd().run("SELECT 1");
    expect(sync).not.toHaveBeenCalled();
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("java");
    expect(args[0]).toBe("-cp");
    expect(args[1]).toMatch(/^\/.*rel\/driver\.jar:.*zetaris-jdbc\/out$/);
    expect(args[2]).toBe("QuerySidecar");
  });

  it("recompiles when the source is newer than the compiled class", async () => {
    h.exists = () => true;
    let n = 0;
    h.stat = () => ({ mtimeMs: n++ === 0 ? 1 : 2 });
    const sync = vi.fn(() => ({ status: 0 }));
    h.spawnSync = sync;
    fakeSpawn();
    await noCmd().run("SELECT 1");
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("compiles the sidecar with javac derived from a java path, then launches it", async () => {
    h.exists = () => false;
    const sync = vi.fn(() => ({ status: 0 }));
    h.spawnSync = sync;
    const calls = fakeSpawn();
    await noCmd({ java: "/jdk/bin/java" }).run("SELECT 1");
    expect((sync.mock.calls[0] as unknown[])[0]).toBe("/jdk/bin/javac");
    expect((calls[0] as unknown[])[0]).toBe("/jdk/bin/java");
  });

  it("uses plain 'javac' when the java override does not end in 'java'", async () => {
    h.exists = () => false;
    const sync = vi.fn(() => ({ status: 0 }));
    h.spawnSync = sync;
    fakeSpawn();
    await noCmd({ java: "/jdk/bin/jre-wrapper" }).run("SELECT 1");
    expect((sync.mock.calls[0] as unknown[])[0]).toBe("javac");
  });

  it("explains that a JDK is needed when javac is not on PATH", async () => {
    h.exists = () => false;
    h.spawnSync = () => ({ status: null, error: Object.assign(new Error("spawn javac ENOENT"), { code: "ENOENT" }), stderr: "" });
    await expect(noCmd().run("SELECT 1")).rejects.toThrow(/live mode needs a JDK on PATH/);
  });

  it("surfaces javac's stderr when compilation fails", async () => {
    h.exists = () => false;
    h.spawnSync = () => ({ status: 1, stderr: "QuerySidecar.java:3: error" });
    await expect(noCmd().run("SELECT 1")).rejects.toThrow(/javac failed: QuerySidecar.java:3: error/);
  });

  it("falls back to the spawn error message when javac fails with no stderr", async () => {
    h.exists = () => false;
    h.spawnSync = () => ({ status: null, stderr: "", error: Object.assign(new Error("EACCES denied"), { code: "EACCES" }) });
    await expect(noCmd().run("SELECT 1")).rejects.toThrow(/javac failed: EACCES denied/);
  });

  it("health() reports a compile failure instead of throwing", async () => {
    h.exists = () => false;
    h.spawnSync = () => ({ status: 1, stderr: "bad" });
    expect(await noCmd().health()).toMatchObject({ ok: false, error: expect.stringContaining("javac failed") });
  });
});
