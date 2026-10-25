# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r1` · engine duckdb · llm nim · 2026-10-25T12:24:00.212Z

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
- Diagnoser's reading (model text, unverified): The query scans the large trips table twice (once for each filter) and then feeds all qualifying rows into a hash aggregation to remove duplicates; the double full scan and subsequent hashing of ~200k rows dominate execution time.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 2) Scanning the trips table a second time for fare_amount > 100 repeats I/O and CPU that could be avoided by evaluating both predicates in a single pass.
- **h3** [untested] (model claim, unverified, plan node 3) Scanning the trips table for trip_distance > 30 repeats I/O and CPU that could be avoided by evaluating both predicates in a single pass.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace UNION (which deduplicates) with a single scan using disjunctive predicate to avoid double scan and hash aggregation.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION with a single scan using disjunctive predicate and kept DISTINCT to preserve original deduplication semantics.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.86×, saving -0.4 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.86×, saving -0.4 ms, 1/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Combined both filter conditions into a single table scan using OR predicate and used GROUP BY instead of UNION to eliminate duplicate rows.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100 GROUP BY PULocationID, payment_type, passenger_count
```
rows 277 vs 277 · median 0.96×, saving -0.1 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.96×, saving -0.1 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
