# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r5` · engine duckdb · llm nim · 2026-10-25T11:16:15.440Z

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
- Diagnoser's reading (model text, unverified): The query spends most time in the HASH_JOIN (node 8) and subsequent HASH_GROUP_BY because the join condition requires a runtime CAST from PULocationID (smallint) to BIGINT to match LocationID, preventing predicate pushdown and forcing a full scan of 99k filtered trips rows through the hash join before aggregation.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 8) The CAST(PULocationID AS BIGINT) = LocationID condition in the HASH_JOIN prevents the payment_type=2 filter from being pushed into the trips scan as an index seek or partition prune, forcing a full sequential scan of the filtered 99k rows.
- **h3** [unproven] (model claim, unverified, plan node 8) Because PULocationID has only 243 distinct values across 495k rows, the hash join builds a large hash table with many collisions on the right (zones) side, and the type coercion adds per-row CPU overhead during probing.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate filtered trips by casted PULocationID before joining to zones to eliminate the expensive hash join on raw rows and avoid per-row CAST in the join condition.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT CAST(PULocationID AS BIGINT) AS loc_id, COUNT(*) AS cnt
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY CAST(PULocationID AS BIGINT)
) t ON t.loc_id = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.5×, saving 2.4 ms, 3/3 pairs faster — missed: floor
timing: median 2.5×, saving 2.4 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Removed CAST on PULocationID in subquery and join condition, allowing direct integer comparison and potential predicate pushdown; moved aggregation before join to reduce rows processed in join.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN ( SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID ) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.21×, saving 2.5 ms, 3/3 pairs faster — missed: floor
timing: median 2.21×, saving 2.5 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Pre-cast PULocationID to BIGINT inside the subquery aggregation to eliminate per-row CAST overhead during the join and enable hash-based join on matching BIGINT types
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT CAST(PULocationID AS BIGINT) AS PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY CAST(PULocationID AS BIGINT)) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 3.06×, saving 3.4 ms, 3/3 pairs faster — missed: floor
timing: median 3.06×, saving 3.4 ms, 3/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
