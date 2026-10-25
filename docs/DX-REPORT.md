# DX report — building on Zetaris

A dated log of what we hit while building Query Doctor on Zetaris, and what we did about it. All times WIB (UTC+7).
Every number below comes from a logged call in `evidence/spike/<run>/calls.jsonl` (run id and call number given).

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
counted). A join across the two sources runs: `TPCDS_DB.warehouse` × 5 rows of `NY_TAXI.customers` returned 25 rows in 17.6 s
(run 07-48-28Z, calls 66–67).

**Sidecar.** One warm connection, one request per line, JSON back. The driver logs to stdout, so the sidecar moves `System.out`
to stderr and keeps stdout for the protocol. Relative classpath entries failed with `ClassNotFoundException`, so the adapter
passes absolute paths.

**Execution and row cap.** Each request runs on a JDBC statement. JDBC has no truncation flag, and we saw no row cap: 200,000
rows drained in full (run 07-39-14Z, call 2). Query Doctor keeps up to `rowCap` rows (10,000), reads one more row to flag
truncation, and lets the engine fingerprint decide past the cap.

**Plans.** `EXPLAIN FORMATTED <sql>` returns a Spark physical plan as one string row. The tree lists each operator with
Spark's own id, e.g. `+- BroadcastHashJoin LeftOuter BuildRight (7)`, followed by one detail block per id. Query Doctor numbers
plan nodes with those ids (`src/engine/sparkPlan.ts`), so a diagnosis that cites "node (7)" points at the same line a human
reads. Plain `EXPLAIN` (no ids) falls back to line numbering.
- **EXPLAIN plans without running the query.** `EXPLAIN FORMATTED SELECT COUNT(*) FROM NY_TAXI.trips` came back in 3.7 s
  (run 07-40-47Z, call 3). Running that COUNT took 200 s on 2026-10-20.
- **EXPLAIN is still not free.** Planning lists the S3 files: 8.5 s for plain `EXPLAIN` of the hero (call 1), about 11 s for
  `EXPLAIN FORMATTED` (call 2).

**Timing.** The engine does not report its own time over JDBC and has no cache-hit flag, so the Verifier uses wall clock.
- `SELECT 1` ×10 (calls 4–13): first run 168 ms (dropped as connection setup), then a median of **66.2 ms**, a spread of
  **594.3 ms** (one 651 ms outlier on run 2) → **noise floor 1,782.9 ms** = max(50 ms, 3 × spread).
- Queries on the TPCDS Parquet tables take about 10 s even when they touch 300 rows (fingerprint of `promotion`: 9.3–11.0 s,
  calls 8–10, run 07-39-14Z). Most of that is reading the public S3 dataset from a laptop.

**Per-row hash for the fingerprint.** `xxhash64`, `hash`, `md5`, `sha2` and `crc32` all exist (calls 3–7). We use
`xxhash64` over the columns cast to string (NULL → sentinel, because `xxhash64` skips NULL arguments), summed as
`DECIMAL(38,0)`: two runs on `promotion` gave the same `(300, -138363129335208073211)`; dropping one row changed it
(calls 8–10).

**Numeric types.** The TPCDS money columns are `double`, not `DECIMAL` (`DESCRIBE TPCDS_DB.store_sales`, call 11). `SUM` and
`AVG` come back as `double`, `COUNT` as `bigint` (call 12). The Verifier's float tolerance therefore applies to TPCDS money
aggregates. The hero is a `COUNT`, so it compares exactly.

**SQL dialect for the guard.** `node-sql-parser` with `database: "hive"` parses the hero, its rewrite, the trap, the
fingerprint SQL and TPC-H Q17. `trino`, `postgresql` and `mysql` fail on the fingerprint's `CAST(... AS STRING)` (run 07-39-14Z,
call 13). Zetaris runs Spark SQL, and `hive` is the closest dialect the parser supports.

**LLM.** `GET /v1/models` lists `nvidia/nemotron-3-ultra-550b-a55b`, and a chat call to it returned 200 in 0.9 s (calls 14–15).

## 2026-10-25 — the hero on the instance

`evals/queries/zetaris/01-hero.sql`: the query shape from trinodb/trino#2939 (an unused `LEFT JOIN` to a tiny table on its
unique key), re-expressed on `TPCDS_DB.store_sales` × `TPCDS_DB.promotion`. Run 07-40-47Z:

- The engine keeps the join: `BroadcastHashJoin LeftOuter BuildRight (7)` in the plan (call 14).
- Original ×5: 33.5 / 34.2 / 41.9 / 36.8 / 35.7 s, median **35.7 s**, no cold/warm gap (calls 15–19).
- Three alternating pairs, original vs a hand-written join elimination: **33.8 / 17.9, 38.3 / 22.2, 36.0 / 19.0 s**, both
  sides returning **129,752** every time (calls 20–25). That is a ~1.9× gap on the pair medians, far above the 1.78 s noise
  floor. This is the probe that a faster rewrite is plausible; the agents and the Verifier produce the real one.
- The join is only removable because `p_promo_sk` is unique: `promotion` has 300 rows, 300 distinct `p_promo_sk`, **291**
  distinct `p_item_sk` (call 28).
- **Trap sibling** (`01-hero-trap-dupkey.sql`): the same join on `p_item_sk`. Dropping it changes the count, **129,776 →
  129,752** (calls 26–27), so the Verifier must refuse that rewrite.

Friction: the hero runs for about 36 s, well over the 5–12 s we planned for. One live verification (pre-check plus three timed
pairs) therefore takes about three minutes, and the live timeouts are sized for that.
