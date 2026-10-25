# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r5` · engine duckdb · llm nim · 2026-10-25T11:28:24.590Z

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
- Diagnoser's reading (model text, unverified): The NOT IN subquery with a nullable column (RatecodeID) prevents a simple anti-join, causing the optimizer to build a large intermediate hash join (312k rows) from the trips table (495k rows) and zones, which dominates execution time.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 6) The inner HASH_JOIN (estimated 312,468 rows) joins the full trips scan with a delim scan of zones, creating a large hash table that is the primary CPU and memory cost; eliminating the nullable NOT IN could allow a direct anti-join without this intermediate.
- **h3** [untested] (model claim, unverified, plan node 8) The sequential scan of the trips table (495,833 rows) is the main I/O bottleneck; rewriting as NOT EXISTS or a LEFT JOIN ... IS NULL could enable predicate pushdown or index usage if available.
- **h4** [untested] (model claim, unverified, plan node 5) The outer HASH_JOIN with a COLUMN_DATA_SCAN (estimated 0 rows) indicates a failed decorrelation attempt due to the NOT IN nullability; removing the pattern would simplify the plan to a single LEFT_DELIM_JOIN.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN subquery with NOT EXISTS to enable efficient anti-join and avoid null-aware semantics overhead.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 22 · rows differ (43 vs 22 rows); first differing row ["6","Arrochar/Fort Wadsworth"] returned by the original, missing from the candidate
first difference (orig only): `["6","Arrochar/Fort Wadsworth"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrote NOT IN subquery to NOT EXISTS with the same correlation to enable efficient anti-join while preserving three-valued logic semantics.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Rewrote NOT IN to NOT EXISTS with explicit IS NOT NULL guard on the nullable RatecodeID column to preserve three-valued logic semantics while enabling efficient anti-join.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
