# Query Doctor — NO_SAFE_REWRITE

run `canon-example_4` · engine duckdb · llm nim · 2026-10-25T11:06:19.717Z

## Original
```sql
SELECT z.Borough, COUNT(*) AS touches
FROM lake.trips t
JOIN ops.zones z ON z.LocationID = t.PULocationID OR z.LocationID = t.DOLocationID
GROUP BY z.Borough
ORDER BY z.Borough
```

Pre-check: deterministic true, 8 row(s), fingerprint `d4ab3ed2a53751bb` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `or_join_condition` (deterministic detector)
- Diagnoser's reading (model text, unverified): The BLOCKWISE_NL_JOIN (node 8) performs a nested-loop join over 495,833 trips rows and 265 zones rows with an OR join condition (PULocationID OR DOLocationID), preventing hash-join optimization and likely executing ~130M comparisons.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) An OR inside the JOIN condition cannot use a hash join; the engine falls back to a nested-loop style join, which is far more expensive than two equi-joins. (matched: inner join ops.zones z on z.locationid = t.pulocationid or z.locationid = t.dolocationid)
- **h2** [unproven] (model claim, unverified, plan node 8) The OR join condition forces a nested-loop join instead of a hash join; rewriting as a UNION ALL of two separate equi-joins (one on PULocationID, one on DOLocationID) followed by aggregation would enable hash joins and reduce comparisons to ~1M.
- **h3** [untested] (model claim, unverified, plan node 8) Neither trips.PULocationID nor trips.DOLocationID has an index; creating a hash index or sorting trips on both columns would allow a merge join or hash join on each key individually.
- **h4** [untested] (model claim, unverified, plan node 8) The blockwise nested-loop join materializes the full cross-product for the OR condition; pushing a bloom filter or pre-filtering zones into the scan could reduce the inner-loop iterations.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced the OR join with UNION ALL of PULocationID and DOLocationID followed by a single equi-join to zones, enabling hash join optimization.
```sql
SELECT z.Borough, COUNT(*) AS touches FROM (SELECT PULocationID AS LocationID FROM lake.trips UNION ALL SELECT DOLocationID FROM lake.trips) locs JOIN ops.zones z ON z.LocationID = locs.LocationID GROUP BY z.Borough ORDER BY z.Borough
```
rows 8 vs 8 · rows differ (8 vs 8 rows); first differing row ["Bronx","4073"] returned by the original, missing from the candidate
first difference (orig only): `["Bronx","4073"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Split the OR join into two separate equi-joins with UNION ALL to enable hash join optimization, then aggregate by Borough.
```sql
SELECT z.Borough, COUNT(*) AS touches FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.PULocationID GROUP BY z.Borough UNION ALL SELECT z.Borough, COUNT(*) AS touches FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.DOLocationID GROUP BY z.Borough ORDER BY z.Borough
```
rows 8 vs 16 · rows differ (8 vs 16 rows); first differing row ["Bronx","4073"] returned by the original, missing from the candidate
first difference (orig only): `["Bronx","4073"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Rewritten OR join as double equi-join to zones for PULocationID and DOLocationID, then unnest boroughs to preserve per-trip contribution to both boroughs, enabling hash joins.
```sql
SELECT z.Borough, COUNT(*) AS touches FROM lake.trips t JOIN ops.zones z_pu ON z_pu.LocationID = t.PULocationID JOIN ops.zones z_do ON z_do.LocationID = t.DOLocationID CROSS JOIN UNNEST([z_pu.Borough, z_do.Borough]) AS z(Borough) GROUP BY z.Borough ORDER BY z.Borough
```
rows 8 vs 8 · rows differ (8 vs 8 rows); first differing row ["Bronx","4073"] returned by the original, missing from the candidate
first difference (orig only): `["Bronx","4073"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
