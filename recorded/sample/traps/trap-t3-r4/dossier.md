# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r4` · engine duckdb · llm nim · 2026-10-25T11:27:26.432Z

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
- Diagnoser's reading (model text, unverified): The query spends most time scanning the trips table (495k rows) and building a hash table for the correlated NOT IN subquery, which is implemented as a left anti join (LEFT_DELIM_JOIN) with a hash join on the trips table.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 6) The LEFT_DELIM_JOIN (left anti join) is costly because it must handle potential NULLs in RatecodeID (NOT IN semantics), forcing a delimiter join that materializes the subquery results and prevents join elimination or predicate pushdown.
- **h3** [untested] (model claim, unverified, plan node 8) The inner HASH_JOIN between trips and DELIM_SCAN processes the full trips table (495k rows) and builds a hash table on PULocationID, which dominates CPU and memory usage; an index on trips.PULocationID could replace this with an index lookup.
- **h4** [untested] (model claim, unverified, plan node 5) The FILTER node after the left anti join evaluates a NULL-aware condition for each row, adding per-row overhead that could be avoided if the subquery were rewritten as a NOT EXISTS with a correlated join.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced NOT IN subquery with correlated NOT EXISTS to eliminate null-aware anti-join overhead and allow early termination on match.
```sql
SELECT z.LocationID, z.Zone
FROM ops.zones z
WHERE NOT EXISTS (
    SELECT 1
    FROM lake.trips t
    WHERE t.PULocationID = z.LocationID
      AND t.RatecodeID = z.LocationID
)
ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Added IS NOT NULL filter to subquery to eliminate null-aware anti-join overhead while preserving NOT IN semantics with NULL handling
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE z.LocationID NOT IN (SELECT t.RatecodeID FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced NOT IN with NOT EXISTS and added explicit IS NOT NULL filter on RatecodeID to preserve null semantics while enabling efficient anti-join execution.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT NULL AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
