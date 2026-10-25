# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r2` · engine duckdb · llm nim · 2026-10-25T12:18:00.287Z

## Original
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips
FROM ops.zones z
LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2
GROUP BY z.LocationID, z.Borough, z.Zone
ORDER BY z.LocationID
```

Pre-check: deterministic true, 265 row(s), fingerprint `43cbbebc33d85c2b` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `outer_join_predicate` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query spends most of its time scanning the large trips table to find payment_type=2 rows (≈99k rows), then hash-joining them with the small zones table (265 rows) and finally hash-aggregating the 99k joined rows. The outer join predicate (including a cast) and the lack of pre-aggregation on the trips side cause unnecessary work.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 8) The hash join probes a 265-row zones hash table with 99,167 filtered trips rows. Pre-aggregating trips by PULocationID (where payment_type=2) before the join would reduce the probe side to at most 243 distinct keys, making the join and subsequent group-by much cheaper.
- **h3** [unproven] (model claim, unverified, plan node 8) The join condition uses CAST(PULocationID AS BIGINT) = LocationID, adding a per-row cast overhead and potentially preventing partition-wise join or other join optimizations. Aligning the data types of PULocationID and LocationID would remove the cast.
- **h4** [untested] (model claim, unverified, plan node 5) The sequential scan on trips reads all 495,833 rows to apply the payment_type=2 filter. An index on (payment_type, PULocationID) would allow an index-only scan to fetch only the ~99k relevant rows, reducing I/O.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated cash-payment trips per PULocationID before the LEFT JOIN, eliminating the post-join aggregation and reducing join input from ~99k rows to at most 243 rows.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cash_cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cash_cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.26×, saving 2.4 ms, 3/3 pairs faster — missed: floor
timing: median 2.26×, saving 2.4 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Pre-aggregate cash trips by PULocationID with explicit cast to match zones.LocationID before joining
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cash_cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT CAST(PULocationID AS BIGINT) AS PULocationID, COUNT(*) AS cash_cnt FROM lake.trips WHERE payment_type = 2 GROUP BY CAST(PULocationID AS BIGINT)) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.25×, saving 2 ms, 3/3 pairs faster — missed: floor
timing: median 2.25×, saving 2 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Removed CAST from PULocationID in subquery and join to eliminate per-row type conversion overhead.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cash_cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cash_cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.29×, saving 2.5 ms, 3/3 pairs faster — missed: floor
timing: median 2.29×, saving 2.5 ms, 3/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
