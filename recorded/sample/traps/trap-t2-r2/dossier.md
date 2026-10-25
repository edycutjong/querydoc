# Query Doctor — NO_SAFE_REWRITE

run `trap-t2-r2` · engine duckdb · llm nim · 2026-10-25T11:19:02.634Z

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
- Diagnoser's reading (model text, unverified): The query scans the same table twice sequentially (99K rows each) and then performs a hash-based deduplication (HASH_GROUP_BY) on the combined ~198K rows, causing high I/O and CPU for duplicate elimination.
- narrative: llm
- **h1** [unproven] (detector, plan node 2) UNION forces a deduplicating aggregate over both inputs. (matched: rips where trip_distance > 30 union select pulocationid, payment_type,)
- **h2** [falsified] (model claim, unverified, plan node 1) The HASH_GROUP_BY (deduplication) processes nearly 200K input rows with high overlap, requiring hash table build/probe and memory; reducing input cardinality or avoiding the second scan would cut its cost.
- **h3** [untested] (model claim, unverified, plan node 2) The first SEQ_SCAN reads the entire trips table to filter trip_distance>30; an index on trip_distance could turn this into an index scan with far fewer rows read.
- **h4** [untested] (model claim, unverified, plan node 3) The second SEQ_SCAN reads the entire trips table again to filter fare_amount>100; an index on fare_amount or a single combined scan (trip_distance>30 OR fare_amount>100) would eliminate the double scan.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION of two scans with a single scan using OR predicate to avoid duplicate scans and deduplication overhead.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · rows differ (277 vs 1437 rows); first differing row ["142","1","1"] returned by the candidate, not by the original
first difference (rewrite only): `["142","1","1"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced UNION of two scans with a single scan using OR predicate to avoid duplicate scans and deduplication overhead.
```sql
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 1437 · refusal reused from ledger mem-1 — same original-result fingerprint; the candidate was not executed (union_dedupe: rewrite changed the rows (ROW_DIFF). Replaced UNION of two scans with a single scan using OR predicate to avoid duplicate scans and deduplication overhead. Rows original 277, rewrite 143)
first difference (rewrite only): `["142","1","1"]`

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced UNION of two sequential scans with a single scan using OR predicate and explicit DISTINCT to preserve UNION's duplicate elimination semantics.
```sql
SELECT DISTINCT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30 OR fare_amount > 100
```
rows 277 vs 277 · median 0.83×, saving -0.6 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.83×, saving -0.6 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT NOT_FASTER
