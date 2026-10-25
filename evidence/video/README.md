# Evidence — the live runs filmed for the demo video

Three live runs of query pack `01-hero` were made from the web UI on 2026-10-25 (UTC) while filming the demo video (P28):
Intake → "let the agents find one" → `01-hero` → Examine. All ran on the local Zetaris platform over JDBC (TPCDS_DB, Parquet)
with `nvidia/nemotron-3-ultra-550b-a55b` through direct NVIDIA NIM (`LLM_PROVIDER=nim`, the declared fallback — no Meterless
Nightshift runtime was running on this laptop). All three were ACCEPTED on the first attempt with the same row fingerprint
`87cd00c56c06b340`:

| Run | Started (UTC) | Verdict | Median of 3 alternating pairs | Faster pairs | Median saving | Decision |
|---|---|---|---:|---:|---:|---|
| `ui-20261025182354-dfzd` | 18:23:54 | ACCEPTED | 2.13× | 3/3 | 13.9 s | none (the screen capture of this take failed) |
| `ui-20261025182908-scdm` | 18:29:08 | ACCEPTED | 2.11× | 3/3 | 17.6 s | approved in the UI (H-MEM mem-23) |
| `ui-20261025184326-k9dc` | 18:43:26 | ACCEPTED | 2.32× | 3/3 | 21.5 s | approved in the UI (H-MEM mem-24) — **the take the video shows** |

The video uses the third take because its capture follows the agent trace as it fills (the earlier take left the trace
panel unscrolled); the video says it is take 3 of 3 and shows all three ratios. Files are copied unedited from the
server's local state (`data/runs/<run>/`, `data/patches/<run>.*`, both gitignored): `case.json`, `dossier.md`,
`trace.jsonl` (what the UI's agent-trace rail shows), and for approved runs `patch.sql` + `review-comment.md`. These are
single runs, not a benchmark — the benchmark is in `DEMO.md` (2.11×, 10 pairs).
