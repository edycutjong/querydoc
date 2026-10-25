import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmGateway } from "../src/adapters/nim.js";
import { ROOT } from "../src/config.js";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import type { QueryEngine } from "../src/engine/types.js";
import { QueryDocService } from "../src/service.js";

// GET /health while a case is running answers at once without probing the engine (live: the probe would wait behind the case on
// the one sidecar, and the UI renders nothing until /health answers). close() survives an engine that never opened.
let root: string;
let engine: DuckDbEngine;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qd-health-"));
  for (const f of ["evals", "fixtures", "querydoc.config.json"]) symlinkSync(join(ROOT, f), join(root, f));
  engine = await DuckDbEngine.open();
});
afterAll(async () => {
  await engine.close();
  rmSync(root, { recursive: true, force: true });
});
const llm = () => new LlmGateway({ client: null, cacheDir: join(root, "llm-cache") });

describe("GET /health during a run", () => {
  it("reports busy without an engine probe while a case runs, and probes again after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let probes = 0;
    const gated = new Proxy(engine, {
      get(t, k, r) {
        if (k === "run") return async (...a: Parameters<QueryEngine["run"]>) => { await gate; return t.run(...a); };
        if (k === "health") return async () => { probes++; return t.health(); };
        const v = Reflect.get(t, k, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as unknown as QueryEngine;
    const svc = new QueryDocService({ root, env: { SAMPLE_MODE: "true" }, llm: llm(), engineFactory: async () => gated });
    const running = svc.run({ input: { sql: "SELECT COUNT(*) FROM lake.trips", candidate_sql: "SELECT COUNT(1) FROM lake.trips" } });
    const h = (await svc.health()) as { json: { engine: { busy?: boolean; ok: boolean } } };
    expect(h.json.engine).toMatchObject({ ok: true, busy: true });
    expect(probes).toBe(0);
    release();
    await running;
    const after = (await svc.health()) as { json: { engine: { busy?: boolean; ok: boolean } } };
    expect(after.json.engine.busy).toBeUndefined();
    expect(probes).toBe(1);
  });

  it("a decision waits for a running case (one H-MEM writer at a time)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = new Proxy(engine, {
      get(t, k, r) {
        if (k === "run") return async (...a: Parameters<QueryEngine["run"]>) => { await gate; return t.run(...a); };
        const v = Reflect.get(t, k, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as unknown as QueryEngine;
    const svc = new QueryDocService({ root, env: { SAMPLE_MODE: "true" }, llm: llm(), engineFactory: async () => gated });
    const order: string[] = [];
    const running = svc.run({ input: { sql: "SELECT COUNT(*) FROM lake.trips", candidate_sql: "SELECT COUNT(1) FROM lake.trips" } }).then(() => order.push("run"));
    const deciding = svc.decide("no-such-run", { decision: "approve", actor: "edy" }).then((r) => (order.push("decide"), r));
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    release();
    await Promise.all([running, deciding]);
    expect(order).toEqual(["run", "decide"]);
    expect(((await deciding) as { status: number }).status).toBe(404);
  });

  it("close() does not throw when an engine open is still pending and then fails", async () => {
    const svc = new QueryDocService({ root, env: { SAMPLE_MODE: "true" }, llm: llm(), engineFactory: () => new Promise((_, no) => setTimeout(() => no(new Error("no engine")), 50)) });
    const h = svc.health(); // starts opening the engine
    await expect(svc.close()).resolves.toBeUndefined();
    expect(((await h) as { json: { engine: { ok: boolean } } }).json.engine.ok).toBe(false);
  });
});
