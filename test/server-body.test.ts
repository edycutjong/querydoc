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
