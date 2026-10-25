# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r1` · engine duckdb · llm nim · 2026-10-25T12:32:07.530Z

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
- Diagnoser's reading (model text, unverified): The NOT IN subquery is evaluated as a correlated left-delimited join that forces a full scan of 495,833 trips rows for each of the 265 zones, and the inner hash join builds a large hash table on the correlated RatecodeID values before probing.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN implements NOT IN with correlated subquery semantics, causing repeated execution of the inner pipeline per zones row; rewriting to NOT EXISTS or a LEFT ANTI JOIN would allow a single scan of trips and a single hash build.
- **h3** [untested] (model claim, unverified, plan node 6) The inner HASH_JOIN builds a hash table on the correlated RatecodeID values (estimated 167 distinct) and probes 495,833 trips rows; if RatecodeID has many NULLs the NOT IN semantics force extra null-aware checks that inflate CPU.
- **h4** [untested] (model claim, unverified, plan node 8) The SEQ_SCAN on trips reads all 495,833 rows without predicate pushdown because PULocationID = z.LocationID is a correlation reference; adding an index on trips(PULocationID) or materializing distinct RatecodeID per PULocationID would let the engine avoid the full scan.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace NOT IN with NOT EXISTS to allow null-aware anti-join optimization and avoid per-row hash rebuilds.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrite NOT IN to NOT EXISTS with explicit NULL-aware equality to preserve three-valued logic semantics.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND (t.RatecodeID = z.LocationID OR (t.RatecodeID IS NULL AND z.LocationID IS NULL))) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced correlated NOT IN with NOT EXISTS using null-aware equality (IS NOT DISTINCT FROM) to preserve three-valued logic semantics and enable a single anti-join plan.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT DISTINCT FROM z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
