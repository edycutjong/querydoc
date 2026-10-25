import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { readBody } from "../src/server.js";

// readBody must settle on every path, including a client that resets the connection mid-body (no "end" event ever arrives).
describe("readBody", () => {
  it("a body aborted mid-upload settles as a 400, it does not leave the handler awaiting for ever", async () => {
    let settled: ((v: unknown) => void) | undefined;
    const result = new Promise((r) => (settled = r));
    const server = createServer(async (req) => settled!(await readBody(req)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/run", headers: { "content-type": "application/json", "content-length": "1000" } });
    req.on("error", () => undefined);
    req.write('{"sql": "SELECT');
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    const r = (await Promise.race([result, new Promise((res) => setTimeout(() => res("pending"), 2_000))])) as { ok: boolean; reply?: { status: number } } | "pending";
    server.close();
    expect(r).not.toBe("pending");
    expect(r !== "pending" && r.ok).toBe(false);
    expect(r !== "pending" && r.reply?.status).toBe(400);
  });
});

describe("POST from another origin", () => {
  it("is refused before the service runs; same-origin and Origin-less POSTs pass", async () => {
    const { createApp } = await import("../src/server.js");
    let runs = 0;
    const svc = { run: async () => (runs++, { status: 200, json: { status: "ok" } }) } as unknown as Parameters<typeof createApp>[0];
    const server = createApp(svc);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (headers: Record<string, string>) => fetch(`${base}/run`, { method: "POST", headers, body: "{}" });
    expect((await post({ "content-type": "text/plain", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect(runs).toBe(0);
    expect((await post({ "content-type": "application/json", origin: base })).status).toBe(200);
    expect((await post({ "content-type": "application/json" })).status).toBe(200);
    expect(runs).toBe(2);
    server.close();
  });
});
