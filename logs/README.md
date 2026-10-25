# logs/

Committed copies of recorded traces (Hub schema, one JSON object per line): two sample-mode runs on DuckDB and one live run on Zetaris.
They name the agents Orchestrator, Diagnoser, Rewriter and Verifier and contain `critique`, `retry` and `revise` events.
The originals are in `recorded/`. A run you start yourself writes `data/runs/<id>/trace-<id>.jsonl` (git-ignored).
