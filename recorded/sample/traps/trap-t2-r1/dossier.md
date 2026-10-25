# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r1` · engine duckdb · llm nim · 2026-10-25T11:18:01.855Z

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
- Diagnoser's reading (model text, unverified): The query scans the same large table twice (full sequential scans) and then performs a hash-based deduplication (HASH_GROUP_BY) on the combined rows, causing high I/O and CPU for hash table building.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 2) The UNION node (and its parent HASH_GROUP_BY) forces a full deduplication of the two inputs; if the two filter predicates overlap significantly, the hash group by processes many duplicate rows, increasing memory and CPU usage.
- **h3** [untested] (model claim, unverified, plan node 3) The first sequential scan (trip_distance > 30) reads the entire trips table; an index on trip_distance could turn this into an index scan if selectivity is high.
- **h4** [untested] (model claim, unverified, plan node 4) The second sequential scan (fare_amount > 100) also reads the entire trips table; an index on fare_amount could avoid a second full scan, or a single scan with a combined predicate could reduce I/O.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION (which requires two full scans and a hash deduplication) with a single scan using OR predicate and one DISTINCT operation.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 1.03×, saving 0.1 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.03×, saving 0.1 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Eliminated overlap between the two branches by excluding rows matching the first predicate from the second, removing the need for hash-based deduplication.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 AND fare_amount <= 100 UNION ALL SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["132","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["132","1","1"]`

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced two sequential scans with a single scan using OR predicate and one DISTINCT operation to eliminate duplicate rows from overlapping predicates.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.9×, saving -0.3 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.9×, saving -0.3 ms, 0/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT ROW_DIFF, #3 REJECT NOT_FASTER
