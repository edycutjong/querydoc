# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r3` · engine duckdb · llm nim · 2026-10-25T11:26:33.851Z

## Original
```sql
SELECT z.LocationID, z.Zone
FROM ops.zones z
WHERE z.LocationID NOT IN (SELECT t.RatecodeID FROM lake.trips t WHERE t.PULocationID = z.LocationID)
ORDER BY z.LocationID
```

Pre-check: deterministic true, 43 row(s), fingerprint `95c658947951847a` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `not_in_nullable` (deterministic detector)
- Diagnoser's reading (model text, unverified): The correlated NOT IN subquery is executed as a left anti-join (node 5) that drives a large hash join (node 7) scanning the entire trips table (495k rows) with a CAST on the join column, causing high CPU and memory usage.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 8) The COLUMN_DATA_SCAN shows an estimated cardinality of 0, indicating the optimizer misestimates the subquery result due to NOT IN nullable semantics; this misestimation can lead to a suboptimal join order and hash table size.
- **h3** [untested] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN (anti-join) processes a large right-side input (estimated 312k rows) because the correlation is not fully pushed down; rewriting to NOT EXISTS or a LEFT JOIN ... WHERE IS NULL could allow earlier filtering and reduce the hash build size.
- **h4** [untested] (model claim, unverified, plan node 7) The join condition CAST(PULocationID AS BIGINT) = LocationID in the inner hash join (node 7) may prevent predicate pushdown and statistics usage; aligning data types or adding a cast index could improve join performance.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrote NOT IN correlated subquery as NOT EXISTS with an additional equality predicate, converting null-aware anti-join into a standard anti-join that avoids full table scans and casting.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrite NOT IN as NOT EXISTS with IS NOT NULL guard on RatecodeID to preserve null-aware semantics while avoiding null-aware anti-join overhead.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Split the NOT IN into a NOT EXISTS for the join and a NOT IN with IS NOT NULL guard to preserve null-aware semantics while allowing optimization
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) AND z.LocationID NOT IN (SELECT t.RatecodeID FROM lake.trips t WHERE t.RatecodeID IS NOT NULL AND t.PULocationID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
