# Evidence — the live run filmed for the demo video

`ui-20261025182908-scdm/` is the run the demo video shows live (P28, recorded 2026-10-25 18:29 UTC from the web UI: Intake → "let the agents
find one" → query pack `01-hero` → Examine → Approve). It ran on the local Zetaris platform over JDBC (TPCDS_DB, Parquet)
with `nvidia/nemotron-3-ultra-550b-a55b` through direct NVIDIA NIM (`LLM_PROVIDER=nim`, the declared fallback — no
Meterless Nightshift runtime was running on this laptop). Verdict ACCEPTED on the first attempt: median of 3 alternating
pairs 2.11×, 3/3 pairs faster, same row fingerprint `87cd00c56c06b340`; approved in the UI (H-MEM playbook entry mem-23).

Files are copied unedited from the server's local state (`data/runs/ui-20261025182908-scdm/`, `data/patches/ui-20261025182908-scdm.*`, both gitignored):
`case.json`, `dossier.md`, `trace.jsonl` (the agent trace the UI's rail shows), `patch.sql` and `review-comment.md`
(written on approval). The video's on-screen numbers for this run come from `case.json`; it is one run, not a benchmark
(the benchmark is in `DEMO.md`).
