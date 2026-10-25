import { appendFileSync } from "node:fs";

// One JSON object per line (Hub Technical Execution Guide §8; architecture §Trace schema).

export type AgentName = "Diagnoser" | "Rewriter" | "Verifier" | "Orchestrator" | "Human";

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  agent_name: AgentName;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent: AgentName | null;
  sponsor_call?: {
    service: "zetaris" | "duckdb" | "nightshift" | "nim" | "llm-cache" | "hmem" | "markovian";
    name: string;
    latency_ms: number;
    // live model calls only: which model handled the request (the response's `model`), beside the route we asked for
    provider?: "nightshift" | "nim";
    requested_model?: string;
    handled_model?: string | null;
    recorded_model?: string; // llm-cache hits: the model the replayed response came from when it was recorded
  };
  retry_count: number;
  status: string;
}

export class Trace {
  readonly events: TraceEvent[] = [];
  constructor(
    readonly runId: string,
    private readonly file?: string,
  ) {}

  emit(e: Omit<TraceEvent, "timestamp" | "run_id">): TraceEvent {
    const ev: TraceEvent = { timestamp: new Date().toISOString(), run_id: this.runId, ...e };
    this.events.push(ev);
    if (this.file) appendFileSync(this.file, JSON.stringify(ev) + "\n");
    return ev;
  }
}
