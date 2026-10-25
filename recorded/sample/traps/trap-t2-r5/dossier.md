# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r5` · engine duckdb · llm nim · 2026-10-25T11:22:02.296Z

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
- Diagnoser's reading (model text, unverified): The query executes two full table scans of the same table (one for each filter) and then performs a hash-based deduplication (HASH_GROUP_BY) on the combined results, causing redundant I/O and unnecessary aggregation overhead.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 2) The first sequential scan reads the entire table to evaluate trip_distance > 30; a single scan with a combined predicate (trip_distance > 30 OR fare_amount > 100) would eliminate the second full scan.
- **h3** [untested] (model claim, unverified, plan node 3) The second sequential scan reads the entire table again for fare_amount > 100, doubling the I/O cost; this scan is redundant if the two filters are evaluated in one pass.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Combined two scans into one by using a single WHERE clause with OR and retained deduplication via SELECT DISTINCT.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.94×, saving -0.2 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.94×, saving -0.2 ms, 0/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced UNION with a single scan using combined OR predicate and removed explicit deduplication since UNION's distinct behavior is implicitly maintained by the single scan
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Combined both UNION branches into a single table scan with OR predicate and used GROUP BY for deduplication to match UNION's distinct semantics.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE (trip_distance > 30 OR fare_amount > 100) GROUP BY PULocationID, payment_type, passenger_count
```
rows 277 vs 277 · median 0.96×, saving -0.1 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.96×, saving -0.1 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT ROW_DIFF, #3 REJECT NOT_FASTER
