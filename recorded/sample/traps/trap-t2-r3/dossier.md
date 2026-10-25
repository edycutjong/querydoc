# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r3` · engine duckdb · llm nim · 2026-10-25T12:25:37.797Z

## Original
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30
UNION
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100
```

Pre-check: deterministic true, 277 row(s), fingerprint `009bfc1f642ddfde` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `union_dedupe` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query scans the same large table twice (two full sequential scans) and then performs a hash-based deduplication (HASH_GROUP_BY) on the combined ~200k rows, doubling I/O and CPU for scanning and adding a potentially expensive hash aggregation.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 1) The UNION node concatenates two full table scans on the same table; a single scan with a combined filter (trip_distance > 30 OR fare_amount > 100) followed by a single distinct would read the table once and avoid duplicate work.
- **h3** [falsified] (model claim, unverified, plan node 2) Each SEQ_SCAN reads the entire table and applies a filter that returns ~99k rows; the filters are not selective enough to justify two separate scans, and the projected columns are the same in both scans.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION of two scans with a single scan using OR predicate and explicit DISTINCT to preserve set semantics.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.76×, saving -1.2 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.76×, saving -1.2 ms, 1/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced UNION of two full table scans with a single scan using OR predicate and GROUP BY for deduplication instead of DISTINCT
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100 GROUP BY PULocationID, payment_type, passenger_count
```
rows 277 vs 277 · median 0.92×, saving -0.2 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.92×, saving -0.2 ms, 1/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Single scan with OR filter and DISTINCT deduplication instead of UNION with hash group by.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.91×, saving -0.3 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.91×, saving -0.3 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
