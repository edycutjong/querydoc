# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r5` · engine duckdb · llm nim · 2026-10-25T12:22:36.725Z

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
- Diagnoser's reading (model text, unverified): The query scans the entire trips table (495833 rows) to filter for payment_type=2, then hash-joins the 99k qualifying rows to the 265-row zones table, and finally hash-groups the 99k joined rows down to 265 groups. The dominant cost is the full table scan of trips and the subsequent join/aggregation on the 99k-row intermediate result.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 8) The hash join builds a hash table on the 265-row zones table and probes with 99167 trips rows; the CAST(PULocationID AS BIGINT) in the join condition adds per-row CPU overhead and may prevent vectorized join execution.
- **h3** [unproven] (model claim, unverified, plan node 5) The hash group by processes 99167 rows to produce 265 groups; pre-aggregating trips by PULocationID (with payment_type=2) before the join would reduce the join probe side to at most 243 distinct keys, cutting both join and aggregation work.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated the filtered trips table by PULocationID before joining to zones, reducing the join input from 99k rows to at most 243 distinct locations and eliminating the post-join GROUP BY.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.53×, saving 2.6 ms, 3/3 pairs faster — missed: floor
timing: median 2.53×, saving 2.6 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Moved the CAST to the subquery aggregation so the join uses native BIGINT equality without per-row casting, enabling vectorized join execution.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT CAST(PULocationID AS BIGINT) AS PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY CAST(PULocationID AS BIGINT)) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.58×, saving 1.9 ms, 3/3 pairs faster — missed: floor
timing: median 2.58×, saving 1.9 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Pre-aggregate trips by PULocationID for payment_type=2 before joining to zones, reducing probe side from 99k rows to at most 243 distinct keys.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cash_trips, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT CAST(PULocationID AS BIGINT) AS LocationID, COUNT(*) AS cash_trips FROM lake.trips WHERE payment_type = 2 GROUP BY CAST(PULocationID AS BIGINT)) t ON t.LocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.64×, saving 1.8 ms, 3/3 pairs faster — missed: floor
timing: median 2.64×, saving 1.8 ms, 3/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
