# Query Doctor — NO_SAFE_REWRITE

run `trap-t3-r5` · engine duckdb · llm nim · 2026-10-25T12:40:51.343Z

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
- Diagnoser's reading (model text, unverified): The LEFT_DELIM_JOIN (node 5) implements a left anti join for the NOT IN predicate, which must handle potential NULLs in the subquery's RatecodeID column; this forces a costly hash join build (312k rows from trips) and probe with extra null‑checking overhead for each of the 265 zone rows.
- narrative: llm
- **h1** [unproven] (detector, plan node 5) NOT IN over a subquery forces a null-aware anti join, which is expensive. (matched: not in (select t.ratecodeid from lake.trips t where t.pulocationid = z.locationid) order b)
- **h2** [unproven] (model claim, unverified, plan node 5) The LEFT_DELIM_JOIN is the primary cost center because it materializes the correlated subquery result via a large hash join (312k rows) and then performs a null‑aware anti join; rewriting the NOT IN as a NOT EXISTS or a LEFT JOIN ... WHERE IS NULL would eliminate the null‑handling logic and allow a more efficient semi/anti join implementation.
- **h3** [untested] (model claim, unverified, plan node 8) The COLUMN_DATA_SCAN shows an estimated cardinality of 0, indicating a severe statistics misestimation on the subquery's RatecodeID column; this likely causes the optimizer to choose a suboptimal join order or hash table size. Gathering statistics on lake.trips.RatecodeID (and possibly PULocationID) would improve cardinality estimates and may lead to a better plan.
- **h4** [untested] (model claim, unverified, plan node 6) Although the SEQ_SCAN on zones is small (265 rows), it drives the left anti join; if the join is rewritten to a more efficient anti join (e.g., using a hash semi join), this scan could be combined with a probe-side build, reducing overall work. However, this node is less likely to be the main bottleneck compared to the hash join build.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Rewrote NOT IN subquery to NOT EXISTS with correlated equality predicate to eliminate null-aware anti join overhead and enable more efficient join execution
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Added IS NOT NULL filter on RatecodeID in subquery to enable standard anti-join while preserving NOT IN null semantics.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE z.LocationID NOT IN (SELECT t.RatecodeID FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID IS NOT NULL) ORDER BY z.LocationID
```
rows 43 vs 264 · rows differ (43 vs 264 rows); first differing row ["5","Arden Heights"] returned by the original, missing from the candidate
first difference (orig only): `["5","Arden Heights"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Rewrote NOT IN subquery to NOT EXISTS with explicit equality correlation to avoid null-aware anti-join semantics while preserving original logic.
```sql
SELECT z.LocationID, z.Zone FROM ops.zones z WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID) ORDER BY z.LocationID
```
rows 43 vs 264 · refusal reused from ledger mem-1 — same original-result fingerprint; the candidate was not executed (not_in_nullable: rewrite changed the rows (ROW_DIFF). Rewrote NOT IN subquery to NOT EXISTS with correlated equality predicate to eliminate null-aware anti join overhead and enable more efficient join)
first difference (orig only): `["5","Arden Heights"]`

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
