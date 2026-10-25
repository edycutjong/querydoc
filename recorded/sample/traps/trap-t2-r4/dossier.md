# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r4` · engine duckdb · llm nim · 2026-10-25T12:28:07.421Z

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
- Diagnoser's reading (model text, unverified): The query executes two full sequential scans of the trips table (for trip_distance>30 and fare_amount>100) and then performs a hash-based deduplication (HASH_GROUP_BY) to implement UNION distinct, which is costly due to large intermediate result sets and lack of indexes on the filtered columns.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 1) The UNION node (id 1) can be replaced by a single sequential scan with a combined filter (trip_distance > 30 OR fare_amount > 100), eliminating the need for two full table scans and the subsequent hash group by for deduplication, while returning identical rows.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION of two full scans with a single scan using OR predicate to eliminate duplicate scan and hash deduplication
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Eliminated duplicate scan of rows satisfying both predicates by restricting second scan to fare_amount > 100 AND trip_distance <= 30, avoiding UNION hash deduplication overhead.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 UNION SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100 AND trip_distance <= 30
```
rows 277 vs 277 · median 1.12×, saving 0.3 ms, 3/3 pairs faster — missed: ratio, floor
timing: median 1.12×, saving 0.3 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced two full table scans with UNION and hash deduplication by a single scan with combined OR filter and explicit DISTINCT to preserve UNION semantics.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.82×, saving -0.7 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.82×, saving -0.7 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
