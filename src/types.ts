import type { Column } from "./engine/types.js";
import type { Attempt } from "./agents/verifier.js";

// Case record shapes (architecture §Schema). Only what the Day-3 end-to-end path produces; playbook fields land with the playbook.

export type HypothesisStatus = "untested" | "unproven" | "falsified" | "confirmed" | "withdrawn";

export interface Hypothesis {
  id: string; // h1..
  source: "llm" | "detector";
  plan_node_id: string;
  claim: string;
  status: HypothesisStatus;
  evidence?: string; // numbers come from Verifier fields only
}

export interface Diagnosis {
  bottleneck: string;
  pattern_label: string;
  plan_nodes: { id: string; op: string; note: string }[];
  hypotheses: Hypothesis[];
  raw_refs: string[];
  narrative: "llm" | "llm-cache" | "omitted"; // omitted = no key and no cache entry; the detector part is still real
}

export type CaseVerdict = "ACCEPTED" | "NO_SAFE_REWRITE" | "NOT_VERIFIABLE" | "REFUSED" | "ERROR";
export type NoRewriteReason = "attempts_exhausted" | "diagnoser_withdrew" | "upstream" | "timeout" | "llm_unavailable";

export interface RunInput {
  sql: string;
  candidate_sql?: string;
  source?: "paste" | "slow_queries";
}

export interface RunOptions {
  runId?: string;
  maxAttempts?: number;
}

export interface Decision {
  decision: "approve" | "reject";
  actor: string;
  at: string;
  memory_id: string;
  ledger_entries: number;
}

export interface Case {
  run_id: string;
  sql: string;
  source: string;
  schema_fqn?: string;
  engine: "zetaris" | "duckdb";
  llm: "nightshift" | "nim" | "cache" | "mixed" | "none"; // the live provider that served this case, or its cache
  started_at: string;
  finished_at?: string;
  precheck?: { deterministic: boolean; rows: number; fingerprint: string; fingerprint_kind: "rows" | "engine"; vacuous: boolean; columns: Column[] };
  diagnosis?: Diagnosis;
  attempts: Attempt[];
  verdict: CaseVerdict;
  no_rewrite_reason?: NoRewriteReason;
  detail?: string;
  playbook_hits: string[];
  decision?: Decision;
  playbook_state?: string; // sample mode: the options.playbook value this run started from
}
