# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r2` · engine duckdb · llm nim · 2026-10-25T11:25:39.470Z

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
- Diagnoser's reading (model text, unverified): The NOT IN correlated subquery with nullable columns forces a LEFT_DELIM_JOIN that evaluates the subquery for each of the 265 zones, scanning the 495k-row trips table repeatedly or building a large hash table per iteration due to NULL semantics preventing anti-join transformation.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN (node 5) implements NOT IN with nullable RatecodeID/PULocationID, which disables the anti-join optimization and requires per-zone evaluation of the correlated subquery instead of a single anti-hash join.
- **h3** [untested] (model claim, unverified, plan node 6) The outer HASH_JOIN (node 6) builds a hash table from the trips scan for each zone row, causing 265 separate hash builds over ~495k rows rather than a single shared structure.
- **h4** [untested] (model claim, unverified, plan node 8) The SEQ_SCAN on trips (node 8) reads all 495k rows with no predicate pushdown of the correlated PULocationID = z.LocationID, because the correlation is resolved upstream in the DELIM_JOIN machinery.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN correlated subquery with LEFT JOIN anti-join using explicit NULL-safe equality condition to eliminate null-aware semantics overhead
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z LEFT JOIN (SELECT DISTINCT PULocationID, RatecodeID FROM lake.trips) t ON z.LocationID = t.PULocationID AND z.LocationID = t.RatecodeID WHERE t.PULocationID IS NULL ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS using explicit NULL guard on RatecodeID to preserve original null-aware semantics while enabling efficient anti-join.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS using IS NOT DISTINCT FROM for null-safe equality on RatecodeID to preserve original three-valued logic while enabling anti-join optimization.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT DISTINCT FROM z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
