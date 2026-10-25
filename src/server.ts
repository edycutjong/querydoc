import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { QueryDocService, type Reply } from "./service.js";

// Routes only; every behaviour is in service.ts. Port 8000. JSON in, JSON out; a body over 256 KB is refused before parsing.

const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<{ ok: true; json: unknown } | { ok: false; reply: Reply }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let dead = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !dead) {
        dead = true;
        resolve({ ok: false, reply: { status: 413, json: { status: "error", error: { type: "PayloadTooLarge", message: "body over 256 KB", recoverable: true } } } });
        req.destroy();
      } else if (!dead) chunks.push(c);
    });
    req.on("end", () => {
      if (dead) return;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ ok: true, json: text.trim() ? JSON.parse(text) : {} });
      } catch {
        resolve({ ok: false, reply: { status: 400, json: { status: "error", error: { type: "InvalidJson", message: "request body is not valid JSON", recoverable: true } } } });
      }
    });
    req.on("error", () => undefined);
  });
}

const send = (res: ServerResponse, r: Reply) => {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(r.json);
  res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
};

export function createApp(svc: QueryDocService, serveStatic?: (url: URL, res: ServerResponse, accept: string) => boolean): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const m = req.method ?? "GET";
      let m2: RegExpMatchArray | null;
      if (m === "POST" && path === "/run") {
        const b = await readBody(req);
        return send(res, b.ok ? await svc.run(b.json) : b.reply);
      }
      if (m === "GET" && (m2 = path.match(/^\/runs\/([^/]+)$/))) return send(res, svc.getRun(m2[1]!));
      if (m === "GET" && (m2 = path.match(/^\/runs\/([^/]+)\/trace$/))) return send(res, svc.runTrace(m2[1]!));
      if (m === "POST" && (m2 = path.match(/^\/runs\/([^/]+)\/decision$/))) {
        const b = await readBody(req);
        return send(res, b.ok ? svc.decide(m2[1]!, b.json) : b.reply);
      }
      if (m === "GET" && path === "/slow-queries") return send(res, svc.slowQueries(svc.resolveMode(undefined).engine === "duckdb" ? "sample" : "live"));
      if (m === "GET" && path === "/playbook") return send(res, svc.playbook(url.searchParams.get("run_id"), url.searchParams.get("schema")));
      if (m === "GET" && path === "/traces/recorded") return send(res, svc.recorded(null));
      if (m === "GET" && (m2 = path.match(/^\/traces\/recorded\/([^/]+)$/))) return send(res, svc.recorded(m2[1]!));
      if (m === "GET" && path === "/health") return send(res, await svc.health());
      if (m === "GET" && serveStatic?.(url, res, req.headers.accept ?? "")) return;
      if (m === "GET" && path === "/") {
        return send(res, { status: 200, json: { name: "querydoc", ui: "open this address in a browser", endpoints: ["POST /run", "GET /runs/:id", "GET /runs/:id/trace", "POST /runs/:id/decision", "GET /slow-queries", "GET /playbook", "GET /traces/recorded", "GET /health"] } });
      }
      send(res, { status: 404, json: { status: "error", error: { type: "NotFound", message: `${m} ${path}`, recoverable: true } } });
    } catch (e) {
      send(res, { status: 500, json: { status: "error", error: { type: "InternalError", message: (e as Error).message.slice(0, 200), recoverable: false } } });
    }
  });
}
