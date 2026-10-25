// The engine surface the agents and the Verifier see. Two implementations: Zetaris (live, over the JDBC sidecar) and
// DuckDB (sample mode). Timings here are wall clock measured by us; no engine-reported time exists on the local JDBC path.

export type Cell = string | number | boolean | null;

export interface Column {
  name: string;
  type: string; // engine type name as reported, e.g. "bigint", "decimal(17,2)", "double"
}

export interface RunOptions {
  rowCap?: number; // rows kept; one more is read to detect truncation
  drain?: boolean; // keep counting past the cap so rowCount is exact
  timeoutSec?: number;
}

export interface RunResult {
  columns: Column[];
  rows: Cell[][];
  rowCount: number;
  rowCountExact: boolean;
  truncated: boolean;
  wallMs: number; // request sent → last row read, measured in the caller process
  sidecarMs?: number; // the same span measured inside the sidecar (excludes IPC)
}

export interface PlanNode {
  id: number; // pre-order traversal index of the parsed tree, starting at 1
  depth: number;
  operator: string;
  detail: string;
  stage?: number; // whole-stage codegen id, when the engine prints one
}

export interface Plan {
  format: "spark-physical-text" | "duckdb-json";
  text: string;
  nodes: PlanNode[];
  wallMs: number;
}

export interface TableRef {
  schema: string;
  table: string;
}

export interface QueryEngine {
  readonly name: "zetaris" | "duckdb";
  // true when run() sets `truncated` reliably once a result passes rowCap; false means an unknown tool limit, so the Verifier
  // adds a COUNT(*) check (architecture §Verifier order step 2).
  readonly reportsTruncation: boolean;
  // COUNT(*) + summed per-row hash over the canonicalised columns, in this engine's dialect.
  rowHashSql(innerSql: string, columns: Column[], floatSigDigits: number): string;
  health(): Promise<{ ok: boolean; wallMs: number; error?: string }>;
  listTables(schema: string): Promise<TableRef[]>;
  tableInfo(table: TableRef): Promise<Column[]>;
  run(sql: string, opts?: RunOptions): Promise<RunResult>;
  explain(sql: string): Promise<Plan>;
  close(): Promise<void>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly sqlState: string | null = null,
    readonly wallMs = 0,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
