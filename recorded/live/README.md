# recorded/live — the insurance recording (early run · before reason routing)

Real runs of `npx tsx run.ts input_examples/live/<name>.json` against the local Zetaris platform (TPCDS_DB, Parquet) with Nemotron 3
Ultra on the NVIDIA endpoint, on 2026-10-25. Each folder holds the markdown dossier, the Hub-schema JSONL trace, and (for the three runs
made with `--out`) the full `case.json`. Nothing here is edited by hand.

| Folder | Input | Outcome |
|---|---|---|
| `hero/` | unused LEFT JOIN to a unique-key table (trino#2939 shape) | ACCEPTED, 2.1× median, 3/3 pairs, same single row |
| `hero-trap/` | same shape, join key repeats (291 distinct of 300) | NO_SAFE_REWRITE — 3 attempts, all rejected `ROW_DIFF` (129,752 vs the original's 129,776) |
| `trap-t1/` | join filter in the `ON` clause (T1) | NO_SAFE_REWRITE — two no-gain rewrites, then the inner-join rewrite the Verifier rejects with a differing row |
| `correlated-avg/` | correlated `AVG` on `item` | ACCEPTED, 1.69× median, window-function rewrite |
| `no-gain/` | one-column filter on a 300-row table | NO_SAFE_REWRITE — three rewrites inside the noise floor |

`hero/` and `correlated-avg/` come from the first run of the chain, before the audit fixes (hypothesis tries capped, carryover keeps
the differing row); `hero-trap/`, `trap-t1/` and `no-gain/` are from the final P22 code. `scripts/record.ts` re-records the whole set
with reason routing and the playbook.
