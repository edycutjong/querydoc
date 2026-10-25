# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r4` · engine duckdb · llm nim · 2026-10-25T12:38:34.052Z

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
- Diagnoser's reading (model text, unverified): The optimizer chose a costly LEFT_DELIM_JOIN with a HASH_JOIN subtree that scans the 495K-row trips table and builds a hash table on RatecodeID, triggered by the NOT IN subquery with a correlated equality predicate on PULocationID; the DELIM_SCAN (node 8) indicates row-by-row subquery evaluation for each zone row.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN executes the subquery once per zones row (265 times) because the NOT IN with a correlated reference prevents decorrelation, causing repeated scans of trips.
- **h3** [untested] (model claim, unverified, plan node 6) The inner HASH_JOIN builds a hash table on RatecodeID from the full trips scan (495K rows) for each zones row, which is redundant since the join key PULocationID = LocationID could be pushed into a single semi/anti join.
- **h4** [untested] (model claim, unverified, plan node 8) The DELIM_SCAN with Estimated Cardinality 167 reflects the per-iteration overhead of the correlated subquery execution, confirming the row-by-row evaluation pattern.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace NOT IN subquery with NOT EXISTS and an explicit IS NOT DISTINCT FROM predicate to eliminate null-aware anti-join overhead and allow hash anti-join optimization.
```sql
SELECT z.LocationID, z.Zone
FROM ops.zones z
WHERE NOT EXISTS (SELECT 1
                  FROM lake.trips t
                  WHERE t.PULocationID = z.LocationID
                    AND t.RatecodeID IS NOT DISTINCT FROM z.LocationID)
ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN subquery with NOT EXISTS and IS NOT DISTINCT FROM to handle NULLs correctly and enable hash anti-join optimization.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT DISTINCT FROM z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · refusal reused from ledger mem-1 — same original-result fingerprint; the candidate was not executed (not_in_nullable: rewrite changed the rows (ROW_DIFF). Replace NOT IN subquery with NOT EXISTS and an explicit IS NOT DISTINCT FROM predicate to eliminate null-aware anti-join overhead and allow hash a)
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Rewrote NOT IN subquery to NOT EXISTS with IS NOT DISTINCT FROM to handle NULLs correctly and enable hash anti-join optimization
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT DISTINCT FROM z.LocationID)
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["2","Jamaica Bay"] returned by the original, missing from the candidate
first difference (orig only): `["2","Jamaica Bay"]`

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
