# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r4` · engine duckdb · llm nim · 2026-10-25T11:21:27.126Z

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
- Diagnoser's reading (model text, unverified): The query scans the same table twice with sequential scans (nodes 0 and 1), each reading all rows and applying filters afterward, then deduplicates ~198K combined rows via HASH_GROUP_BY (node 2).
- narrative: llm
- **h1** [falsified] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 2) HASH_GROUP_BY performs duplicate elimination for UNION DISTINCT; if the two result sets have high overlap, the hash table build/probe is wasteful and could be avoided with UNION ALL plus a downstream distinct or by rewriting to a single scan.
- **h3** [unproven] (model claim, unverified, plan node 1) No indexes exist on trip_distance or fare_amount; adding a composite or single-column index on the filtered columns could turn the sequential scans into index scans if selectivity is high enough.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace UNION with a single scan and OR predicate, then deduplicate once using DISTINCT.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 1.07×, saving 0.3 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.07×, saving 0.3 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Combined two sequential scans into a single scan with OR predicate and single DISTINCT deduplication
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.92×, saving -0.2 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.92×, saving -0.2 ms, 1/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Replaced UNION with UNION ALL and added a filter to the second scan to exclude rows already captured by the first scan, eliminating the need for deduplication.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 UNION ALL SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100 AND trip_distance <= 30
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["132","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["132","1","1"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT ROW_DIFF
