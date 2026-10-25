import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZetarisEngine } from "../src/engine/zetaris.js";

// The Node side of the JDBC sidecar protocol, against a stand-in sidecar (test/helpers/fakeSidecar.mjs): no Java, no driver.
const fake = resolve(__dirname, "helpers", "fakeSidecar.mjs");
const engines: ZetarisEngine[] = [];
const open = (graceSec = 0.3) => {
  const e = new ZetarisEngine({ jdbcUrl: "jdbc:fake", jdbcJar: "/nonexistent.jar", user: "u", password: "p", sidecarCmd: [process.execPath, fake], graceSec });
  engines.push(e);
  return e;
};
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
});

describe("ZetarisEngine ↔ sidecar", () => {
  it("a non-JSON line on the sidecar's stdout is ignored, not an uncaught throw", async () => {
    const r = await open().run("SELECT 1", { rowCap: 1, timeoutSec: 5 });
    expect(r.rows).toEqual([[1]]);
  });

  it("a statement the sidecar never answers fails at timeoutSec + grace, and the next statement gets a fresh sidecar", async () => {
    const e = open(0.3);
    const t0 = performance.now();
    await expect(e.run("SELECT 'hang'", { rowCap: 1, timeoutSec: 0 })).rejects.toThrow(/no reply from the sidecar/);
    expect(performance.now() - t0).toBeLessThan(5_000);
    const r = await e.run("SELECT 1", { rowCap: 1, timeoutSec: 5 });
    expect(r.rows).toEqual([[1]]);
  });

  it("a sidecar that never becomes ready is killed at the startup bound and the statement fails", async () => {
    const e = new ZetarisEngine({ jdbcUrl: "jdbc:fake", jdbcJar: "/nonexistent.jar", user: "u", password: "p", sidecarCmd: [process.execPath, fake, "--never-ready"], startupSec: 0.3 });
    engines.push(e);
    await expect(e.run("SELECT 1", { rowCap: 1, timeoutSec: 5 })).rejects.toThrow(/no ready line within 0.3 s/);
  });

  it("EXPLAIN wraps the statement without a pasted trailing semicolon", async () => {
    const plan = await open().explain("SELECT 1 ;  ");
    expect(plan.text).toBe("EXPLAIN FORMATTED SELECT 1");
  });

  it("close() fails a statement still waiting instead of leaving it pending", async () => {
    const e = open(60);
    const pending = e.run("SELECT 'hang'", { rowCap: 1, timeoutSec: 60 });
    await new Promise((r) => setTimeout(r, 300));
    await e.close();
    await expect(pending).rejects.toThrow(/engine closed/);
  });
});
