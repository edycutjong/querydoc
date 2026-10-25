# DX report — building on Zetaris

A dated log of what we hit while building Query Doctor on Zetaris, and what we did about it. All times WIB (UTC+7).
Every number in the 2026-10-25 sections comes from a logged call in `evidence/spike/<run>/calls.jsonl` (run id and call number
given). The 2026-10-20 entry predates this repo; its facts were noted at setup time and are not logged here.

## 2026-10-20 — the MCP endpoint does not exist locally → JDBC

- The hackathon docs describe Zetaris AIDS as one MCP endpoint (`get_slow_queries`, `get_query_stats`, `profile_table`,
  `explain_query`). The Cloud account turned out to be bring-your-own-cloud (the stack bills your AWS), so we run the vendor's
  **"Run locally" bundle** (docker compose, platform 2.4.3 hackathon build). That bundle exposes the **Lightning JDBC driver**,
  a REST API and the UI. It has **no MCP endpoint**.
- What changes: Query Doctor talks to Zetaris over JDBC through a small Java sidecar (`engine/zetaris-jdbc/QuerySidecar.java`).
  Slow-query intake is paste-only (no `get_slow_queries`), table profiles are SQL aggregates (no `profile_table`), plans come
  from `EXPLAIN FORMATTED` (no `explain_query`), and timings are our own wall clock (no `get_query_stats`).
- Bare `SHOW DATABASES` / `SHOW TABLES` are disabled. `SHOW TABLES IN <db>` works and returns `DB.table` names.

## 2026-10-25 — Day-1 spike (`scripts/spike_zetaris.ts`)

Runs: `2026-10-25T07-39-14Z` (health, row cap, hash, types, dialect, NIM), `2026-10-25T07-40-47Z` (explain, noise, hero),
`2026-10-25T07-48-28Z` (tables, cross-source join; see `docs/zetaris-tables.json`), `2026-10-25T07-52-47Z` (types again,
with full `DESCRIBE` rows logged so `querydoc.config.json` can be traced). `npx tsx scripts/check_config_sources.ts` recomputes
every measured value in `querydoc.config.json` from these logs.

**What the instance hosts.** Two sources, both from `s3a://zetaris-public-dataset`: `TPCDS_DB` (24 Parquet tables, from 5
rows in `warehouse` to 11,745,000 in `inventory`; `store_sales` 2,880,404) and `NY_TAXI` (15 CSV tables, read in place, not
counted). A query across the two sources runs: a `CROSS JOIN` of `TPCDS_DB.warehouse` (5 rows) with 5 rows of `NY_TAXI.customers`
counted 25 rows in 17.6 s (run 07-48-28Z, call 67; its plan is call 66).

**Sidecar.** One warm connection, one request per line, JSON back. The driver logs to stdout, so the sidecar moves `System.out`
to stderr and keeps stdout for the protocol. A relative classpath entry for the sidecar's own classes did not resolve
(`ClassNotFoundException: QuerySidecar` when we tried it by hand; not logged), so the adapter passes absolute paths.

**Execution and row cap.** Each request runs on a JDBC statement. JDBC has no truncation flag, and we saw no row cap: 200,000
rows drained in full (run 07-39-14Z, call 2). Query Doctor keeps up to `rowCap` rows (10,000), reads one more row to flag
truncation. Past the cap, the Verifier is designed to compare engine fingerprints (below) instead of rows.

**Plans.** `EXPLAIN FORMATTED <sql>` returns a Spark physical plan as one string row. The tree lists each operator with
Spark's own id, e.g. `+- BroadcastHashJoin LeftOuter BuildRight (7)`, followed by one detail block per id. Query Doctor numbers
plan nodes with those ids (`src/engine/sparkPlan.ts`), so a diagnosis that cites "node (7)" points at the same line a human
reads. Plain `EXPLAIN` (no ids) falls back to line numbering.
- **EXPLAIN plans without running the query.** `EXPLAIN FORMATTED` of the hero takes 7.3–7.4 s (run 07-40-47Z, calls 2 and 14);
  running the hero takes 33.5–41.9 s (calls 15–19). `EXPLAIN FORMATTED SELECT COUNT(*) FROM NY_TAXI.trips` came back in 3.7 s
  (call 3); on 2026-10-20 (pre-repo, not logged) that COUNT ran for about 200 s. Plans are printed with
  `isFinalPlan=false`: adaptive execution may still change them at run time.
- **EXPLAIN is still not free.** 8.5 s for plain `EXPLAIN` of the hero (call 1), 7.3 s for `EXPLAIN FORMATTED` (call 2). We did
  not split planning time from file listing.

**Timing.** The engine does not report its own time over JDBC and has no cache-hit flag, so the Verifier uses wall clock.
- `SELECT 1` ×10 (calls 4–13): first run 168 ms (dropped as connection setup), then a median of **66.2 ms**, a spread of
  **594.3 ms** (one 651 ms outlier on run 2) → **noise floor 1,782.9 ms** = max(50 ms, 3 × spread).
- Queries on the TPCDS Parquet tables take about 10 s even when they touch 300 rows (fingerprint of `promotion`: 9.3–11.0 s,
  calls 8–10, run 07-39-14Z). We have not split that time into planning, S3 file listing and reading; the data is read from
  the public S3 bucket by the local stack.

**Per-row hash for the fingerprint.** `xxhash64`, `hash`, `md5`, `sha2` and `crc32` all exist (calls 3–7). We use
`xxhash64` over the columns cast to string (NULL → sentinel, because `xxhash64` skips NULL arguments), summed as
`DECIMAL(38,0)`: two runs on `promotion` gave the same `(300, -138363129335208073211)`; dropping one row changed it
(calls 8–10).

**Numeric types.** The TPCDS money columns are `double`, not `DECIMAL` (`DESCRIBE TPCDS_DB.store_sales`, run 07-39-14Z call 11; again in run 07-52-47Z call 1). `SUM` and
`AVG` come back as `double`, `COUNT` as `bigint` (run 07-39-14Z call 12). The Verifier's float tolerance therefore applies to TPCDS money
aggregates. The hero is a `COUNT`, so it compares exactly.

**SQL dialect for the guard.** `node-sql-parser` with `database: "hive"` parses the hero, its rewrite, the trap, the
fingerprint SQL and TPC-H Q17. `trino`, `postgresql` and `mysql` fail on the fingerprint SQL — we read the cause as its `CAST(... AS STRING)`;
the log does not name it (run 07-39-14Z, call 13); `trino` also fails on Q17. `hive` and `bigquery` parse all five. We use `hive` because Zetaris runs Spark SQL.

**LLM.** `GET /v1/models` lists `nvidia/nemotron-3-ultra-550b-a55b`, and a chat call to it returned 200 in 0.9 s (calls 14–15).

## 2026-10-25 — the hero on the instance

`evals/queries/zetaris/01-hero.sql`: the query shape from trinodb/trino#2939 (an unused `LEFT JOIN` to a tiny table on its
unique key), re-expressed on `TPCDS_DB.store_sales` × `TPCDS_DB.promotion`. Run 07-40-47Z:

- The engine keeps the join: `BroadcastHashJoin LeftOuter BuildRight (7)` in the plan (call 14).
- Original ×5: 33.5 / 34.2 / 41.9 / 36.8 / 35.7 s, median **35.7 s**, no cold/warm gap (calls 15–19).
- Three alternating pairs, original vs a hand-written join elimination: **33.8 / 17.9, 38.3 / 22.2, 36.0 / 19.0 s**, both
  sides returning **129,752** every time (calls 20–25). That is a ~1.9× gap on the pair medians (36.0 vs 19.0 s). Each pair's gap
  (16.0–17.0 s) is about 9× the 1.78 s noise floor and about 2× the 8.4 s spread of the original's own five runs. This is a
  hand-written probe that a faster rewrite is plausible; producing and verifying the rewrite is the agents' and the Verifier's job.
- The join is only removable because `p_promo_sk` is unique: `promotion` has 300 rows, 300 distinct `p_promo_sk`, **291**
  distinct `p_item_sk` (call 28).
- **Trap sibling** (`01-hero-trap-dupkey.sql`): the same join on `p_item_sk`. Dropping it changes the count, **129,776 →
  129,752** (calls 26–27), so the Verifier must refuse that rewrite.

Friction: the hero runs for about 36 s, longer than we expected. One live verification (pre-check plus three timed pairs) will
therefore take about three to three and a half minutes (the six pair runs alone sum to 167 s). The spike used a 300 s timeout
for the hero, pair and trap executions; the adapter's default is 120 s, so live verification must raise it.

## 2026-10-25 — Day 2: the Verifier on the instance (`scripts/verify_live.ts`, run `2026-10-25T08-13-25Z`)

- **Re-run on the fixed Verifier (run `2026-10-25T08-42-12Z`, the current evidence).** After the first review round (count/hash
  results validated, backtick-quoted file reads refused, top-N rules, kill-rule inputs tightened) the same two cases ran again.
  Hero: pre-check 42.5 s and 34.9 s, same fingerprint; three pairs, original **33.4 / 34.0 / 41.0 s** vs candidate
  **28.5 / 16.0 / 16.6 s** → **ACCEPT**, median speedup **2.12×**, median saving **18.0 s**, 3 of 3 pairs faster, timing cap
  232.2 s. Trap: candidate returned 129,752 where the original returns **129,776** → **REJECT (ROW_DIFF)**, not timed.
  `SELECT 1` median 49.4 ms, spread 8.2 ms over runs 2–10. Kill rule: **YES** (6 comparable queries; engine time
  34,808 ms = hero median 34,857.4 − `SELECT 1` median 49.4, against 6 × the config's noise floor of 1,782.9 ms = 10,697.4 ms;
  that floor is Day 1's, 3 × its 594.3 ms spread, kept because it is the more conservative one). trace.jsonl: 16 Verifier
  events, 4 of them critiques. The two runs differ (1.72× vs 2.12×) and pair 1 here was only 1.17× (33.4 s vs 28.5 s): a ~35 s
  query on this platform moves by several seconds from run to run, which is why ACCEPT needs the median ratio, the saving
  floor and a majority of faster pairs together, never one pair's ratio. Pair exclusion (cache hits) is not wired on this
  path: the JDBC driver reports no cache-hit flag, so no pair is excluded. The bullets below are the first run.

- **First live verdicts.** Hero, pre-check: two runs of the original, 36.7 s and 25.2 s, same fingerprint, 1 row. Candidate
  (the hand-written join elimination, `evals/queries/zetaris/01-hero-rewrite.sql`): same row, then three alternating pairs,
  original **28.8 / 29.3 / 35.3 s** vs candidate **17.5 / 17.1 / 16.0 s** → **ACCEPT**, median speedup **1.72×**, median
  saving **12.2 s**, 3 of 3 pairs faster. Trap: pre-check passed (20.7 s, 25.8 s), candidate returned **129,752** where the
  original returns 129,776 → **REJECT (ROW_DIFF)**, not timed. All in `evidence/verify/2026-10-25T08-13-25Z/` (trace.jsonl:
  16 Verifier events, 4 of them critiques).
- **Timing cap.** The design's 150 s timing cap assumed a 5–12 s hero. At ~30 s per original run, three pairs need ~140–170 s,
  so the cap is now max(150 s, 3 pairs × 2 × the pre-check median of the original), which came to 185.8 s here
  (`querydoc.config.json` policy.timingCapRule). A rewrite as slow as the original still gets its three pairs.
- **Result-schema check** reads the column names and types from the candidate's own diff-run payload (the JDBC metadata),
  so no separate `LIMIT 0` probe is needed. That saves an execution, and on this platform planning alone takes seconds.
- **Float tolerance, measured live.** Per-store `SUM(ss_net_paid)` (DOUBLE) on the hero's rows, computed directly and
  pre-aggregated by (store, day): all 7 stores differ in the raw bits, and the largest relative difference is 4.9e-15. At 9
  significant digits the rows compare equal, and the engine-side fingerprint (`format_string('%.8e')` for float columns)
  matches. Recorded under `floatTolerance` and recomputed by `npm run check:config`. The CI test
  `test/duckdb-sum.test.ts` shows the same effect on DuckDB.
- **Run-to-run spread.** In this run the original took 25.2–36.7 s over 5 runs, and `SELECT 1` had a median of 47.4 ms
  (spread 131.7 ms over runs 2–10). That spread is lower than Day 1's 594.3 ms; the noise floor in the config is still Day 1's
  1,782.9 ms, the more conservative of the two.
