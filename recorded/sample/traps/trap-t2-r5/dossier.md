# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r5` · engine duckdb · llm nim · 2026-10-25T12:29:06.158Z

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
- Diagnoser's reading (model text, unverified): The query performs two full sequential scans of the 'trips' table (one for each UNION branch) followed by a hash-based deduplication to satisfy the UNION semantics, reading the table twice and materializing a large intermediate result.
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [untested] (model claim, unverified, plan node 2) Node 2 (first SEQ_SCAN) reads the entire 'trips' table to evaluate 'trip_distance > 30'; an index or zone map on 'trip_distance' could turn this into an index scan or allow partition/row-group pruning, reducing I/O.
- **h3** [untested] (model claim, unverified, plan node 3) Node 3 (second SEQ_SCAN) reads the entire 'trips' table again to evaluate 'fare_amount > 100'; an index or zone map on 'fare_amount' could similarly avoid a full scan.
- **h4** [untested] (model claim, unverified, plan node 1) Node 1 (UNION) concatenates two ~99k-row streams and the parent HASH_GROUP_BY deduplicates them; if the predicates are mutually exclusive or the overlap is small, rewriting as UNION ALL (if duplicates are acceptable) or pushing a distinct filter earlier could avoid the hash aggregation overhead.
- **h5** [falsified] (model claim, unverified, plan node 2) Creating an index on trip_distance will change node 2 from a sequential scan to an index scan, reducing I/O for the filter trip_distance > 30.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced two sequential scans with UNION deduplication with a single scan using OR predicate to eliminate duplicate table access and hash aggregation.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): No rewrite performed; original query retained as safe fallback after previous OR predicate rewrite failed row-equivalence verification.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 UNION SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100
```
rows 277 vs 277 · median 1.13×, saving 0.5 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.13×, saving 0.5 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h5 · Rewriter's note (model text): No rewrite applied; hypothesis h5 requires a physical index on trip_distance which cannot be created in SQL, so the original query is retained.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 UNION SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100
```
rows 277 vs 277 · median 0.76×, saving -0.7 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.76×, saving -0.7 ms, 0/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
