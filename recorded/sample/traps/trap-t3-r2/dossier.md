# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r2` · engine duckdb · llm nim · 2026-10-25T12:34:09.510Z

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
- Diagnoser's reading (model text, unverified): The LEFT_DELIM_JOIN (node 5) probes a 312K-row inner hash join (nodes 7-9) for each of the 265 zones, where the inner side scans the full trips table (495K rows) and builds a hash on the correlated join key.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN implements a correlated NOT IN with a nullable RatecodeID, forcing a per-row probe of the large inner hash join; rewriting to NOT EXISTS with an explicit IS NOT NULL guard or a LEFT JOIN … IS NULL allows a single anti-join instead of repeated probing.
- **h3** [untested] (model claim, unverified, plan node 7) The inner HASH_JOIN (node 7) builds its hash table from a full scan of trips (495K rows) even though the correlated predicate restricts it to the current zone; the planner cannot push the correlation inside, so the hash table is rebuilt or probed for every outer row.
- **h4** [untested] (model claim, unverified, plan node 8) The SEQ_SCAN on trips (node 8) reads all 495K rows and both columns without partition pruning or predicate push-down, so the scan cost dominates the inner join build time for every probe.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrote NOT IN subquery to NOT EXISTS with explicit correlation and equality predicate to enable efficient anti-join and avoid null-aware semantics overhead.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrite NOT IN to NOT EXISTS with explicit IS NOT NULL guard on RatecodeID to match null-aware semantics while enabling efficient anti-join.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Rewrite NOT IN to NOT EXISTS with explicit IS NOT NULL guard on RatecodeID before equality to preserve null-aware semantics while enabling efficient anti-join.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT NULL AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
