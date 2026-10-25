# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r3` · engine duckdb · llm nim · 2026-10-25T11:19:34.349Z

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
- Diagnoser's reading (model text, unverified): The query executes two full sequential scans of the trips table (for trip_distance > 30 and fare_amount > 100) and then performs a hash-based duplicate elimination (HASH_GROUP_BY) to implement UNION DISTINCT. The majority of execution time is likely spent in the HASH_GROUP_BY deduplicating the combined ~200k rows and in the two scans reading the table twice.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 1) The UNION node can be eliminated by rewriting the query as a single scan with a combined predicate (trip_distance > 30 OR fare_amount > 100), reducing the number of sequential scans from two to one.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION DISTINCT with a single scan using OR predicate to avoid duplicate scans and hash-based deduplication.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION DISTINCT with a single scan using OR predicate plus explicit DISTINCT to preserve exact deduplication semantics while avoiding duplicate scans and separate hash aggregation.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.85×, saving -0.5 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.85×, saving -0.5 ms, 0/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced UNION DISTINCT (two scans + hash dedupe) with a single scan using OR predicate plus explicit DISTINCT to preserve exact deduplication semantics.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.85×, saving -0.6 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.85×, saving -0.6 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
