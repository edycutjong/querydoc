# recorded/live — recorded live runs on the Zetaris platform

Real runs of `npm run record -- --live` (`scripts/record.ts`) against the local Zetaris platform (TPCDS_DB, Parquet, JDBC sidecar) with Nemotron 3
Ultra on the NVIDIA endpoint, recorded 2026-10-25. They use the final P23 code: reason-routed retry with `Diagnoser.revise`, the
H-MEM playbook (live mode: one persistent store, so later runs can see entries earlier runs wrote), and the Verifier's paired timing.
Each folder holds `case.json`, the markdown `dossier.md`, and the Hub-schema JSONL `trace.jsonl`. Nothing here is edited by hand; the
files are re-created by the command above. A route reads: attempt verdicts in order (`NOT_FASTER/no_gain` = rows identical, no time saved).

| Run | Verdict | Route |
|---|---|---|
| `correlated-avg-r1` | ACCEPTED | NOT_FASTER/no_gain → ACCEPT — 1.44× median, saving 3.9 s, 3/3 pairs faster, same 1 row(s) |
| `hero-trap-r1` | NO_SAFE_REWRITE/attempts_exhausted | ROW_DIFF → ROW_DIFF → ROW_DIFF |
| `hero-r1` | ACCEPTED | ACCEPT — 2.1× median, saving 16.9 s, 3/3 pairs faster, same 1 row(s) |
| `hero-r2` | ACCEPTED | ACCEPT — 2.15× median, saving 19.4 s, 3/3 pairs faster, same 1 row(s) |
| `no-gain-r1` | NO_SAFE_REWRITE/attempts_exhausted | NOT_FASTER/no_gain → ERROR → NOT_FASTER/no_gain |
| `no-gain-r2` | NO_SAFE_REWRITE/attempts_exhausted | NOT_FASTER/no_gain → NOT_FASTER/no_gain → ROW_DIFF |
| `trap-t1-r1` | NO_SAFE_REWRITE/attempts_exhausted | ROW_DIFF → NOT_FASTER/under_gate → ROW_DIFF |
| `trap-t1-r2` | NO_SAFE_REWRITE/attempts_exhausted | NOT_FASTER/no_gain → ROW_DIFF → NOT_FASTER/under_gate |

What these runs are: evidence that the live path works end to end on the instance and that the Verifier refuses rewrites that change rows
(`hero-trap`, the T1 runs). What they are not: a benchmark. Two runs per query (one for the others) is a small-n observation, and the model
samples at temperature 1.0, so a fresh recording will route differently. Speedups are wall-clock medians of alternating pairs measured on one
laptop over local JDBC; they say nothing about a hosted Zetaris deployment.
