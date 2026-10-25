# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r3` · engine duckdb · llm nim · 2026-10-25T12:36:38.390Z

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
- Diagnoser's reading (model text, unverified): The query executes a correlated NOT IN subquery that forces a full scan of the 495k-row trips table for each of the 265 zones, performing a LEFT_DELIM_JOIN (anti-join) with a hash join build side that is rebuilt repeatedly due to the correlation on PULocationID = LocationID.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN (node 5) implements the NOT IN as a correlated anti-join, causing the inner hash join subtree (nodes 6-8) to be rebuilt or re-probed for every row from zones, resulting in O(zones × trips) work instead of a single hash anti-join.
- **h3** [untested] (model claim, unverified, plan node 7) The inner HASH_JOIN (node 7) builds a hash table on trips filtered by the correlated PULocationID value, but the optimizer fails to hoist the trips scan out of the correlation, so the same large table is scanned repeatedly.
- **h4** [untested] (model claim, unverified, plan node 8) The SEQ_SCAN on trips (node 8) reads all 495k rows with two columns for each zone; converting the NOT IN to a single uncorrelated LEFT ANTI JOIN or NOT EXISTS with a pre-aggregated distinct RatecodeID per PULocationID would allow one scan and one hash build.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS to enable standard anti-join optimization and avoid null-aware semantics overhead.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS using IS NOT DISTINCT FROM to preserve null-aware semantics and avoid correlated subquery overhead.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT DISTINCT FROM z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Added IS NOT NULL filter to RatecodeID in the subquery to make NOT IN semantically equivalent to NOT EXISTS while preserving NULL-aware behavior, enabling the optimizer to use a hash anti-join instead of correlated execution.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE z.LocationID NOT IN (SELECT t.RatecodeID FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
