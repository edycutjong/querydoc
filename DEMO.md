# DEMO — measured proof

**Provenance:** the accepted Zetaris rewrite and the recorded packs behind these numbers were produced through direct NVIDIA NIM (the declared fallback) before the Meterless Nightshift adapter existed; the three filmed takes below also used direct NIM (no Nightshift runtime was reachable); a Nightshift re-recording is pending. The timings themselves are measured by `scripts/bench.ts` on the engine, independent of which provider wrote the rewrite.

Every number below is copied from the run file named under it (`npm run bench`, `npm run eval`); nothing is typed by hand.


<!-- BEGIN bench-zetaris -->
## Benchmark — hero on the local Zetaris platform (TPCDS_DB, Parquet)

Original vs the accepted rewrite, 10 alternating pairs, wall clock, rows verified identical first (1 row(s) both sides). Rewrite: recorded/live/hero-r1/case.json (the Rewriter's accepted attempt). Percentiles are nearest-rank over 10 runs per side.

| | p50 ms | p95 ms |
|---|---:|---:|
| original | 32442.6 | 46950.8 |
| accepted rewrite | 16428 | 21100.8 |

Speedup: **2.11×** median of per-pair ratios (10/10 pairs faster). Run file: `evidence/bench/zetaris-2026-10-25T14-00-08Z/results.json`. Reproduce: `npx tsx scripts/bench.ts --engine zetaris --pairs 10`.
<!-- END bench-zetaris -->

<!-- BEGIN bench-duckdb -->
## Benchmark — hero on the sample engine (DuckDB, committed NYC TLC subset)

Original vs the hand-written comparison rewrite (not a Verifier ACCEPT), 20 alternating pairs, wall clock, rows verified identical first (8 row(s) both sides). Rewrite: evals/queries/sample/01-hero.rewrite.sql (hand-written, committed). Percentiles are nearest-rank over 20 runs per side.

| | p50 ms | p95 ms |
|---|---:|---:|
| original | 89.7 | 109.9 |
| hand-written comparison rewrite | 5.2 | 6.4 |

Speedup: **16.24×** median of per-pair ratios (20/20 pairs faster). Run file: `evidence/bench/duckdb-2026-10-25T13-50-52Z/results.json`. Reproduce: `npx tsx scripts/bench.ts --engine duckdb --pairs 20`.
<!-- END bench-duckdb -->

Single live runs, not a benchmark: [`recorded/live/`](recorded/live/README.md) (hero-r1 2.1×, hero-r2 2.15×, each the median of 3 alternating pairs) and the three hero takes filmed for the demo video, all ACCEPTED with the same fingerprint ([`evidence/video/README.md`](evidence/video/README.md): 2.13×, 2.11×, 2.32×; the video shows the third).
