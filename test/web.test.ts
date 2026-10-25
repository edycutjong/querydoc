import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
import { staticHandler } from "../src/static.js";
// @ts-expect-error plain browser ES module, no types
import { pretty, sqlDiff, sqlPlain } from "../web/sqldiff.js";

let server: Server;
let base: string;
let root: string;
let engine: DuckDbEngine;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qd-web-"));
  for (const f of ["evals", "querydoc.config.json", "recorded", "fixtures"]) symlinkSync(join(ROOT, f), join(root, f));
  engine = await DuckDbEngine.open();
  const svc = new QueryDocService({ root, env: { SAMPLE_MODE: "true" }, llm: new LlmGateway({ client: null, cacheDir: join(root, "llm-cache") }), engineFactory: async () => engine });
  server = createApp(svc, staticHandler());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Report UI is served and self-contained", () => {
  it("GET / is the UI for a browser and the JSON endpoint list for curl", async () => {
    const html = await fetch(base + "/", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(html.headers.get("content-type")).toMatch(/text\/html/);
    expect(await html.text()).toContain("Query Doctor");
    const json = await fetch(base + "/", { headers: { accept: "*/*" } });
    expect(json.headers.get("content-type")).toMatch(/application\/json/);
    expect(((await json.json()) as any).endpoints).toContain("POST /run");
  });

  it("every asset the page, the stylesheet and the script reference exists in web/, and none is a remote URL", async () => {
    const files = ["index.html", "app.css", "app.js", "sqldiff.js"].map((f) => readFileSync(join(ROOT, "web", f), "utf8"));
    const refs = new Set<string>();
    for (const t of files) for (const m of t.matchAll(/(?:src|href)="(\/web\/[^"]+)"|url\((\/web\/[^)]+)\)|from "(\/web\/[^"]+)"/g)) refs.add((m[1] ?? m[2] ?? m[3])!);
    expect(refs.size).toBeGreaterThanOrEqual(10);
    for (const r of refs) {
      expect(existsSync(join(ROOT, r.slice(1))), r).toBe(true);
      expect((await fetch(base + r)).status, r).toBe(200);
    }
    for (const t of files) expect(t).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no CDN, no remote font
  });

  it("a path that leaves web/ is a 404, and the static handler serves GET only under /web/", async () => {
    expect((await fetch(`${base}/web/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/web/%zz`)).status).toBe(404);
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
  });
});

describe("trace endpoint the UI polls", () => {
  it("returns the run's events and flips done when the case is written; unknown runs are empty, not errors", async () => {
    const ex = JSON.parse(readFileSync(join(ROOT, "input_examples/example_5.json"), "utf8"));
    const j = (await (await fetch(base + "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ex) })).json()) as any;
    const t = (await (await fetch(`${base}/runs/${j.run_id}/trace`)).json()) as any;
    expect(t.done).toBe(true);
    expect(t.events.length).toBeGreaterThan(0);
    expect(t.events[0]).toMatchObject({ run_id: j.run_id, agent_name: expect.any(String) });
    const none = (await (await fetch(`${base}/runs/no-such-run/trace`)).json()) as any;
    expect(none).toMatchObject({ status: "ok", done: false, events: [] });
    expect((await fetch(`${base}/runs/bad%20id/trace`)).status).toBe(400);
    const full = (await (await fetch(`${base}/runs/${j.run_id}`)).json()) as any;
    expect(full.dossier).toContain("# Query Doctor");
  });

  it("/health carries the measured SELECT 1 calibration the table caption quotes", async () => {
    const h = (await (await fetch(base + "/health")).json()) as any;
    expect(h.calibration.select1_median_ms).toBeGreaterThan(0);
  });
});

describe("SqlBlock diff", () => {
  const orig = "SELECT COUNT(1) AS n FROM t ss LEFT JOIN p ON ss.k = p.k WHERE ss.c IS NULL";
  const re = "SELECT COUNT(1) AS n FROM t ss WHERE ss.c IS NULL";
  it("breaks single-line SQL at clauses without splitting LEFT JOIN", () => {
    expect(pretty(orig)).toBe("SELECT COUNT(1) AS n\nFROM t ss\nLEFT JOIN p ON ss.k = p.k\nWHERE ss.c IS NULL");
  });
  it("strikes removed tokens, underlines added ones, and escapes markup", () => {
    const d = sqlDiff(orig, re) as string;
    expect(d).toContain('<span class="del">LEFT</span>');
    expect(d).not.toContain('class="add"');
    const d2 = sqlDiff(re, orig) as string;
    expect(d2).toContain('<span class="add">LEFT</span>');
    expect(sqlPlain("SELECT '<b>x</b>' AS a") as string).not.toContain("<b>");
  });
});
