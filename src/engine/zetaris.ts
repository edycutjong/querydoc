import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseSparkPlan } from "./sparkPlan.js";
import { EngineError, type Cell, type Column, type Plan, type QueryEngine, type RunOptions, type RunResult, type TableRef } from "./types.js";

// Zetaris over JDBC. The local Zetaris platform has no MCP endpoint, so this adapter drives the Lightning JDBC driver through a
// small Java sidecar (engine/zetaris-jdbc/QuerySidecar.java): one warm connection, one request per line, JSON back. Requests are
// serialised (one in flight), so a wall-clock timing never overlaps another query.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIDECAR_SRC = resolve(ROOT, "engine/zetaris-jdbc/QuerySidecar.java");
const SIDECAR_OUT = resolve(ROOT, "engine/zetaris-jdbc/out");

export const DEFAULT_ROW_CAP = 10_000;
const DEFAULT_TIMEOUT_SEC = 120;

interface SidecarOk {
  id: string;
  ok: true;
  columns?: { name: string; type: string; jdbcType: number }[];
  rows?: Cell[][];
  rowCount?: number;
  rowCountExact?: boolean;
  truncated?: boolean;
  elapsedMs: number;
}
interface SidecarErr {
  id: string | null;
  ok: false;
  error: string;
  sqlState: string | null;
  elapsedMs: number;
}
type SidecarReply = SidecarOk | SidecarErr;

export interface ZetarisConfig {
  jdbcUrl: string;
  jdbcJar: string;
  user: string;
  password: string;
  driverClass?: string;
  java?: string;
}

export function zetarisConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZetarisConfig | null {
  const { ZETARIS_JDBC_URL, ZETARIS_JDBC_JAR, ZETARIS_USER, ZETARIS_PASSWORD } = env;
  if (!ZETARIS_JDBC_URL || !ZETARIS_JDBC_JAR || !ZETARIS_USER || !ZETARIS_PASSWORD) return null;
  return {
    jdbcUrl: ZETARIS_JDBC_URL,
    jdbcJar: ZETARIS_JDBC_JAR.replace(/^~(?=\/)/, process.env.HOME ?? "~"),
    user: ZETARIS_USER,
    password: ZETARIS_PASSWORD,
    ...(env.ZETARIS_JDBC_DRIVER_CLASS ? { driverClass: env.ZETARIS_JDBC_DRIVER_CLASS } : {}),
  };
}

function ensureCompiled(java: string) {
  const cls = resolve(SIDECAR_OUT, "QuerySidecar.class");
  if (existsSync(cls) && statSync(cls).mtimeMs >= statSync(SIDECAR_SRC).mtimeMs) return;
  const javac = java.endsWith("java") ? `${java}c` : "javac";
  const r = spawnSync(javac, ["-d", SIDECAR_OUT, SIDECAR_SRC], { encoding: "utf8" });
  if (r.status !== 0) throw new EngineError(`javac failed: ${r.stderr || r.error?.message}`);
}

export class ZetarisEngine implements QueryEngine {
  readonly name = "zetaris" as const;
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private waiting = new Map<string, (r: SidecarReply) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private stderrTail: string[] = [];

  constructor(private readonly cfg: ZetarisConfig) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const java = this.cfg.java ?? "java";
    ensureCompiled(java);
    // Absolute classpath entries: the driver resolves relative entries against a different base.
    const proc = spawn(java, ["-cp", `${resolve(this.cfg.jdbcJar)}:${SIDECAR_OUT}`, "QuerySidecar"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ZETARIS_JDBC_URL: this.cfg.jdbcUrl,
        ZETARIS_USER: this.cfg.user,
        ZETARIS_PASSWORD: this.cfg.password,
        ...(this.cfg.driverClass ? { ZETARIS_JDBC_DRIVER_CLASS: this.cfg.driverClass } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stderr.on("data", (b: Buffer) => {
      this.stderrTail.push(b.toString());
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    this.ready = new Promise((resolveReady, reject) => {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        const msg = JSON.parse(line) as SidecarReply | { ready: true };
        if ("ready" in msg) return resolveReady();
        const done = msg.id !== null ? this.waiting.get(msg.id) : undefined;
        if (done && msg.id !== null) {
          this.waiting.delete(msg.id);
          done(msg);
        }
      });
      proc.on("exit", (code) => {
        const err: SidecarErr = { id: null, ok: false, error: `sidecar exited (${code}): ${this.stderrTail.join("").slice(-500)}`, sqlState: null, elapsedMs: 0 };
        for (const done of this.waiting.values()) done(err);
        this.waiting.clear();
        this.ready = undefined;
        this.proc = undefined;
        reject(new EngineError(err.error));
      });
    });
    return this.ready;
  }

  private request(op: "run" | "ping", sql: string, rowCap: number, drain: boolean, timeoutSec: number): Promise<{ reply: SidecarReply; wallMs: number }> {
    const next = this.chain.then(async () => {
      await this.start();
      const id = String(++this.seq);
      const line = [id, op, rowCap, drain ? 1 : 0, timeoutSec, Buffer.from(sql, "utf8").toString("base64")].join("\t");
      const t0 = performance.now();
      const reply = await new Promise<SidecarReply>((done) => {
        this.waiting.set(id, done);
        this.proc!.stdin.write(`${line}\n`);
      });
      return { reply, wallMs: Math.round((performance.now() - t0) * 10) / 10 };
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async health() {
    try {
      const { reply, wallMs } = await this.request("run", "SELECT 1", 1, false, 30);
      return reply.ok ? { ok: true, wallMs } : { ok: false, wallMs, error: reply.error };
    } catch (e) {
      return { ok: false, wallMs: 0, error: (e as Error).message };
    }
  }

  async run(sql: string, opts: RunOptions = {}): Promise<RunResult> {
    const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
    const { reply, wallMs } = await this.request("run", sql, rowCap, opts.drain ?? false, opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
    if (!reply.ok) throw new EngineError(reply.error, reply.sqlState, wallMs);
    return {
      columns: (reply.columns ?? []).map(({ name, type }) => ({ name, type })),
      rows: reply.rows ?? [],
      rowCount: reply.rowCount ?? 0,
      rowCountExact: reply.rowCountExact ?? true,
      truncated: reply.truncated ?? false,
      wallMs,
      sidecarMs: reply.elapsedMs,
    };
  }

  // EXPLAIN FORMATTED: Spark physical plan with Spark's own operator ids. It plans without running the query (probe in
  // docs/DX-REPORT.md), but the planner still lists the S3 files, so it is not free.
  async explain(sql: string): Promise<Plan> {
    const r = await this.run(`EXPLAIN FORMATTED ${sql}`, { rowCap: 1, timeoutSec: 60 });
    const text = String(r.rows[0]?.[0] ?? "");
    return { format: "spark-physical-text", text, nodes: parseSparkPlan(text), wallMs: r.wallMs };
  }

  async listTables(schema: string): Promise<TableRef[]> {
    // Bare SHOW TABLES / SHOW DATABASES are disabled on the platform; SHOW TABLES IN <db> works and returns "DB.table".
    const r = await this.run(`SHOW TABLES IN ${ident(schema)}`, { rowCap: 10_000, timeoutSec: 60 });
    return r.rows.map((row) => {
      const full = String(row[0]);
      const dot = full.indexOf(".");
      return dot > 0 ? { schema: full.slice(0, dot), table: full.slice(dot + 1) } : { schema, table: full };
    });
  }

  async tableInfo(t: TableRef): Promise<Column[]> {
    const r = await this.run(`DESCRIBE ${ident(t.schema)}.${ident(t.table)}`, { rowCap: 10_000, timeoutSec: 60 });
    const cols: Column[] = [];
    for (const [name, type] of r.rows) {
      if (name === null || String(name).startsWith("#") || String(name).trim() === "") break; // partition section follows
      cols.push({ name: String(name), type: String(type) });
    }
    return cols;
  }

  async close() {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = undefined;
    this.ready = undefined;
  }
}

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new EngineError(`refusing identifier ${JSON.stringify(name)}`);
  return name;
}
