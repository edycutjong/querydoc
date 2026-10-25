# Query Doctor — NO_SAFE_REWRITE

run `canon-example_1` · engine duckdb · llm nim · 2026-10-25T11:05:07.254Z

## Original
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips
FROM ops.zones z
LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2
GROUP BY z.LocationID, z.Borough, z.Zone
ORDER BY z.LocationID
```

Pre-check: deterministic true, 265 row(s), fingerprint `43cbbebc33d85c2b` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `outer_join_predicate` (deterministic detector)
- Diagnoser's reading (model text, unverified): The hash join (node 8) forces a CAST(PULocationID AS BIGINT) on the probe side for ~99K filtered trips rows, preventing predicate pushdown and adding per-row conversion cost; the join then feeds 99K rows into a hash aggregation that only produces 265 groups.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [falsified] (model claim, unverified, plan node 8) The CAST in the join condition (CAST(PULocationID AS BIGINT) = LocationID) disables join-key partition pruning and forces a type conversion on every probe row; removing the cast or aligning column types would allow a faster hash join.
- **h3** [untested] (model claim, unverified, plan node 8) The hash join builds on the larger filtered trips input (~99K rows) instead of the tiny zones table (265 rows); forcing a build on zones (e.g., via join order hint or rewriting as aggregated subquery) would shrink the hash table and reduce probe cost.
- **h4** [unproven] (model claim, unverified, plan node 10) The HASH_GROUP_BY processes 99K rows to produce only 265 groups; pre-aggregating trips by PULocationID + payment_type before the join would reduce the join input cardinality by ~400x and eliminate the post-join aggregation.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate filtered trips by PULocationID to reduce join input from ~99K rows to at most 243 groups, eliminating per-row cast overhead in the hash join.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.5×, saving 2.1 ms, 3/3 pairs faster — missed: floor
timing: median 2.5×, saving 2.1 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Changed implicit CAST to explicit ::BIGINT cast on the trips side so the hash join can avoid per-row conversion overhead while preserving semantics.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID::BIGINT = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.12×, saving 0.4 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.12×, saving 0.4 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h4 · Rewriter's note (model text): Pre-aggregate filtered trips by PULocationID before joining to zones, removing the post-join aggregation and reducing join input from ~99K rows to ~243 rows.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT PULocationID::BIGINT AS PULocationID, COUNT(*) AS cnt
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY PULocationID
) t ON t.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.5×, saving 2.4 ms, 3/3 pairs faster — missed: floor
timing: median 2.5×, saving 2.4 ms, 3/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
