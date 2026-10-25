# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r4` · engine duckdb · llm nim · 2026-10-25T12:21:14.676Z

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
- Diagnoser's reading (model text, unverified): The query spends most of its time scanning the entire trips table (495,833 rows) to apply the payment_type=2 filter, which reduces the row count to ~99,167 before the join and aggregation.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 8) The sequential scan on trips reads all rows and filters on payment_type=2; because payment_type has only 5 distinct values, a columnar zone map or partitioning on payment_type could avoid scanning irrelevant row groups.
- **h3** [falsified] (model claim, unverified, plan node 7) The hash join condition includes a CAST(PULocationID AS BIGINT) = LocationID, which adds per-row CPU overhead; aligning the data types of the join keys would eliminate the cast.
- **h4** [untested] (model claim, unverified, plan node 4) The hash group by processes 99,167 rows; while this is small, if the hash table exceeds memory and spills to disk, it could become a bottleneck.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated the filtered trips table by PULocationID before the LEFT JOIN, replacing the post-join aggregation with a lookup.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(agg.cnt, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT PULocationID, COUNT(*) AS cnt
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY PULocationID
) agg ON agg.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.6×, saving 2.4 ms, 3/3 pairs faster — missed: floor
timing: median 2.6×, saving 2.4 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Pre-aggregate trips filtered by payment_type=2 before left joining to zones, reducing rows processed in the join and enabling better zone-map pruning on the columnar scan.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(agg.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN ( SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID ) agg ON agg.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.62×, saving 2.1 ms, 3/3 pairs faster — missed: floor
timing: median 2.62×, saving 2.1 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Moved the CAST from the right side (LocationID) to the left side (PULocationID) to align data types before the join, eliminating the per-row cast on the zones table's primary key.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID::BIGINT = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.15×, saving 0.6 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.15×, saving 0.6 ms, 2/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
