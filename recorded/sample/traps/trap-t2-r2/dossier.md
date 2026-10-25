# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r2` · engine duckdb · llm nim · 2026-10-25T12:25:14.587Z

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
- Diagnoser's reading (model text, unverified): The query performs two full sequential scans of the same 'trips' table (reading all columns to evaluate filters, though only three are projected) and then hash-deduplicates the combined ~198k rows via HASH_GROUP_BY.
- narrative: llm
- **h1** [unproven] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [unproven] (model claim, unverified, plan node 2) HASH_GROUP_BY deduplicates on all three columns; if the two result sets have little overlap, replacing UNION with UNION ALL (and accepting duplicates) would eliminate the hash aggregation entirely.
- **h3** [untested] (model claim, unverified, plan node 1) Each SEQ_SCAN reads full rows despite projecting only three columns; a covering index on (trip_distance, fare_amount) INCLUDE (PULocationID, payment_type, passenger_count) could enable index-only scans for both predicates.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace UNION (which requires a duplicate-eliminating hash aggregate over two full scans) with a single scan using a combined OR filter, eliminating the second scan and the dedup step.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace UNION with UNION ALL and add anti-filter to second scan to avoid duplicates, keeping two scans but removing hash aggregate deduplication.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 UNION ALL SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100 AND trip_distance <= 30
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["132","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["132","1","1"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced UNION with UNION ALL and added an anti-filter (trip_distance <= 30) to the second scan so rows satisfying both predicates are emitted only once, removing the HASH_GROUP_BY deduplication step while preserving the original distinct row set.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 UNION ALL SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100 AND trip_distance <= 30
```
rows 277 vs 1437 · refusal reused from ledger mem-2 — same original-result fingerprint; the candidate was not executed (union_dedupe: rewrite changed the rows (ROW_DIFF). Replace UNION with UNION ALL and add anti-filter to second scan to avoid duplicates, keeping two scans but removing hash aggregate deduplication. Row)
first difference (rewrite only): `["132","1","1"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
