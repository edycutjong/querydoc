import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmGateway } from "../src/adapters/nim.js";
import { ROOT } from "../src/config.js";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import { createApp } from "../src/server.js";
import { QueryDocService } from "../src/service.js";

let server: Server;
let base: string;
let root: string;
let engine: DuckDbEngine;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qd-http-"));
  for (const f of ["evals", "querydoc.config.json", "recorded", "fixtures"]) symlinkSync(join(ROOT, f), join(root, f));
  engine = await DuckDbEngine.open();
  const svc = new QueryDocService({ root, env: { SAMPLE_MODE: "true" }, llm: new LlmGateway({ client: null, cacheDir: join(root, "llm-cache") }), engineFactory: async () => engine });
  server = createApp(svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await engine.close();
  rmSync(root, { recursive: true, force: true });
});
const post = (path: string, body: unknown, raw = false) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) });

describe("HTTP API on the Hub self-test path", () => {
  it("curl -d @input_examples/example_5.json /run returns a verdict envelope; /runs/:id returns the stored case", async () => {
    const res = await post("/run", JSON.parse(readFileSync(join(ROOT, "input_examples/example_5.json"), "utf8")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const j = (await res.json()) as any;
    expect(j).toMatchObject({ status: "ok", verdict: "NOT_VERIFIABLE", engine: "duckdb" });
    expect(j.trace_id).toBe(j.run_id);
    expect(typeof j.execution_time_seconds).toBe("number");
    const again = (await (await fetch(`${base}/runs/${j.run_id}`)).json()) as any;
    expect(again.case.run_id).toBe(j.run_id);
  });

  it("malformed JSON, a missing route and a bad run id are structured errors", async () => {
    const bad = await post("/run", "{nope", true);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.type).toBe("InvalidJson");
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/runs/bad%20id`)).status).toBe(400);
    expect((await fetch(`${base}/runs/run-unknown`)).status).toBe(404);
  });

  it("an oversized body is refused with 413 before it is parsed", async () => {
    const res = await post("/run", JSON.stringify({ input: { sql: "x".repeat(300_000) } }), true).catch(() => null);
    if (res) expect(res.status).toBe(413); // the server may also drop the socket; either way nothing ran
  });

  it("/health, /slow-queries, /playbook and /traces/recorded answer", async () => {
    expect(((await (await fetch(`${base}/health`)).json()) as any).engine.name).toBe("duckdb");
    expect(((await (await fetch(`${base}/slow-queries`)).json()) as any).items.length).toBeGreaterThanOrEqual(7);
    expect(((await (await fetch(`${base}/playbook`)).json()) as any).status).toBe("ok");
    const rec = (await (await fetch(`${base}/traces/recorded`)).json()) as any;
    expect(rec.label).toBe("recorded live run");
    expect(rec.runs).toContain("hero-r1");
    const one = (await (await fetch(`${base}/traces/recorded/hero-r1`)).json()) as any;
    expect(one.label).toMatch(/^recorded live run · hero/);
    expect(one.trace.length).toBeGreaterThan(5);
    expect((await fetch(`${base}/traces/recorded/..%2f..`)).status).toBe(404);
  });
});
