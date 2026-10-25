import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sqlGuard } from "../guard/sqlGuard.js";
import { engineFingerprintSql } from "../verify/fingerprint.js";
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
// The sidecar asks the driver for a query timeout, but the driver may ignore it (QuerySidecar.java). Past timeoutSec + this grace
// with no reply, the sidecar is killed and the request fails: one stuck statement must not hold the service's queue for ever.
export const SIDECAR_GRACE_SEC = 30;
export const SIDECAR_STARTUP_SEC = 60; // JVM start + driver class load; the JDBC connection itself opens on the first statement

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
  sidecarCmd?: string[]; // test seam: a stand-in sidecar speaking the same line protocol (skips javac)
  graceSec?: number; // default SIDECAR_GRACE_SEC
  startupSec?: number; // default SIDECAR_STARTUP_SEC
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
  if (r.status !== 0) {
    const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    throw new EngineError(missing
      ? `live mode needs a JDK on PATH: the JDBC sidecar is compiled with ${javac} on first use (a JRE alone has no javac; tested with OpenJDK 17.0.14, docs/DX-REPORT.md)`
      : `javac failed: ${r.stderr || r.error?.message}`);
  }
}

export class ZetarisEngine implements QueryEngine {
  readonly name = "zetaris" as const;
  // The sidecar reads one row past rowCap, so `truncated` is a real flag (no engine-side cap seen up to 200k rows on Day 1).
  readonly reportsTruncation = true;
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
    const [cmd, ...args] = this.cfg.sidecarCmd ?? [java, "-cp", `${resolve(this.cfg.jdbcJar)}:${SIDECAR_OUT}`, "QuerySidecar"];
    if (!this.cfg.sidecarCmd) ensureCompiled(java);
    // Absolute classpath entries: the driver resolves relative entries against a different base.
    const proc = spawn(cmd!, args, {
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
      const startup = setTimeout(() => {
        this.stderrTail.push(`[startup] no ready line within ${this.cfg.startupSec ?? SIDECAR_STARTUP_SEC} s; sidecar killed\n`);
        proc.kill("SIGKILL"); // the exit handler below rejects this promise
      }, (this.cfg.startupSec ?? SIDECAR_STARTUP_SEC) * 1000);
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        let msg: SidecarReply | { ready: true };
        try {
          msg = JSON.parse(line) as SidecarReply | { ready: true };
        } catch {
          // stdout is reserved for the protocol, but the JVM itself can still write there (e.g. a fatal-error banner). A line
          // that is not a reply is kept for the error message and ignored; an exit that follows fails the waiting requests.
          this.stderrTail.push(`[stdout] ${line.slice(0, 300)}\n`);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if ("ready" in msg) {
          clearTimeout(startup);
          return resolveReady();
        }
        const done = msg.id !== null ? this.waiting.get(msg.id) : undefined;
        if (done && msg.id !== null) {
          this.waiting.delete(msg.id);
          done(msg);
        }
      });
      const gone = (why: string) => {
        clearTimeout(startup);
        const err: SidecarErr = { id: null, ok: false, error: `sidecar ${why}: ${this.stderrTail.join("").slice(-500)}`, sqlState: null, elapsedMs: 0 };
        if (this.proc === proc) {
          // A sidecar already replaced (killed at a deadline, or closed) must not touch its successor's state.
          for (const done of this.waiting.values()) done(err);
          this.waiting.clear();
          this.ready = undefined;
          this.proc = undefined;
        }
        reject(new EngineError(err.error));
      };
      proc.on("exit", (code) => gone(`exited (${code})`));
      proc.on("error", (e) => gone(`could not run (${e.message})`)); // e.g. spawn ENOENT: without a listener this is an uncaught throw
    });
    proc.stdin.on("error", () => undefined); // EPIPE after the sidecar died: the exit handler above fails the waiting request
    return this.ready;
  }

  private request(op: "run" | "ping", sql: string, rowCap: number, drain: boolean, timeoutSec: number): Promise<{ reply: SidecarReply; wallMs: number }> {
    const next = this.chain.then(async () => {
      await this.start();
      const id = String(++this.seq);
      const line = [id, op, rowCap, drain ? 1 : 0, timeoutSec, Buffer.from(sql, "utf8").toString("base64")].join("\t");
      const proc = this.proc;
      if (!proc) throw new EngineError(`sidecar exited before the statement was sent: ${this.stderrTail.join("").slice(-300)}`);
      const t0 = performance.now();
      const reply = await new Promise<SidecarReply>((done) => {
        const deadlineSec = timeoutSec + (this.cfg.graceSec ?? SIDECAR_GRACE_SEC);
        const timer = setTimeout(() => {
          if (!this.waiting.delete(id)) return;
          if (this.proc === proc) {
            this.proc = undefined; // the next statement starts a fresh sidecar
            this.ready = undefined;
          }
          proc.kill("SIGKILL");
          done({ id, ok: false, error: `no reply from the sidecar ${deadlineSec} s after sending a statement with a ${timeoutSec} s timeout; sidecar killed (restarts on the next statement)`, sqlState: null, elapsedMs: deadlineSec * 1000 });
        }, deadlineSec * 1000);
        this.waiting.set(id, (r) => {
          clearTimeout(timer);
          done(r);
        });
        proc.stdin.write(`${line}\n`);
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
    const g = sqlGuard(sql);
    if (!g.ok) throw new EngineError(`guard refused the statement to explain: ${g.reason}`);
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

  rowHashSql(innerSql: string, columns: Column[], floatSigDigits: number): string {
    return engineFingerprintSql(innerSql, columns, "xxhash64", floatSigDigits);
  }

  async close() {
    const err: SidecarErr = { id: null, ok: false, error: "engine closed", sqlState: null, elapsedMs: 0 };
    for (const done of this.waiting.values()) done(err);
    this.waiting.clear();
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
