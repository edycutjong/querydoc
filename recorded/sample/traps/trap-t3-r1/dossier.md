# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r1` · engine duckdb · llm nim · 2026-10-25T11:23:00.550Z

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
- Diagnoser's reading (model text, unverified): The NOT IN subquery with a nullable column (RatecodeID) forces a large hash join between the trips table (495k rows) and a delim scan of zones to materialize the subquery result, followed by a left anti-join (LEFT_DELIM_JOIN) that must handle NULL semantics, resulting in high CPU and memory usage.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [untested] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN (node 5) implements the NOT IN anti-join; because RatecodeID is nullable, the engine cannot use a simple hash anti-join and must perform per-row null checks, adding significant overhead.
- **h3** [untested] (model claim, unverified, plan node 8) The COLUMN_DATA_SCAN (node 8) shows an estimated cardinality of 0, indicating a severe statistics misestimate for the correlated parameter that likely leads to a suboptimal join order or join type for the subquery.
- **h4** [untested] (model claim, unverified, plan node 6) The SEQ_SCAN on zones (node 6) is small (265 rows), but if the LEFT_DELIM_JOIN is executed as a correlated nested loop rather than a hash anti-join, it could cause repeated execution of the subquery; however, the plan suggests a hash join is used, so this is less likely.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS and added explicit IS NOT NULL check on RatecodeID to eliminate null-aware anti-join overhead.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT NULL AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS preserving exact NULL semantics without adding extra IS NOT NULL filter
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID)
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["2","Jamaica Bay"] returned by the original, missing from the candidate
first difference (orig only): `["2","Jamaica Bay"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — upstream
(attempt summary / upstream message) NIM timed out after 60000 ms (reasoning off)
