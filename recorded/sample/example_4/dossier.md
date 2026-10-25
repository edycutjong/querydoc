# Query Doctor — NO_SAFE_REWRITE

run `canon-example_4` · engine duckdb · llm nim · 2026-10-25T12:12:40.861Z

## Original
```sql
SELECT z.Borough, COUNT(*) AS touches
FROM lake.trips t
JOIN ops.zones z ON z.LocationID = t.PULocationID OR z.LocationID = t.DOLocationID
GROUP BY z.Borough
ORDER BY z.Borough
```

Pre-check: deterministic true, 8 row(s), fingerprint `d4ab3ed2a53751bb` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `or_join_condition` (deterministic detector)
- Diagnoser's reading (model text, unverified): The OR join condition (z.LocationID = t.PULocationID OR z.LocationID = t.DOLocationID) forces a blockwise nested loop join between 495K trips rows and 265 zones rows instead of a hash join, causing ~495K * 265 key comparisons with two equality checks per row.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) An OR inside the JOIN condition cannot use a hash join; the engine falls back to a nested-loop style join, which is far more expensive than two equi-joins. (matched: inner join ops.zones z on z.locationid = t.pulocationid or z.locationid = t.dolocationid)
- **h2** [unproven] (model claim, unverified, plan node 8) The BLOCKWISE_NL_JOIN is chosen because the OR predicate prevents hash join optimization; rewriting as a UNION ALL of two separate joins (one on PULocationID, one on DOLocationID) would enable hash joins and avoid the nested loop.
- **h3** [untested] (model claim, unverified, plan node 8) The CAST(PULocationID AS BIGINT) and CAST(DOLocationID AS BIGINT) suggest possible type mismatch; ensuring LocationID, PULocationID, and DOLocationID share the same integer type could eliminate casts and improve predicate evaluation speed.
- **h4** [untested] (model claim, unverified, plan node 5) The HASH_GROUP_BY operates on the join output which may duplicate trips rows matching both PU and DO zones; pre-aggregating trips by location before joining could reduce rows entering the join.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Split the OR join into two separate equi-joins on PULocationID and DOLocationID, aggregated each side, then combined with UNION ALL and a final aggregation to preserve exact counts per borough.
```sql
SELECT z.Borough, SUM(cnt) AS touches FROM (SELECT Borough, COUNT(*) AS cnt FROM ops.zones z JOIN lake.trips t ON z.LocationID = t.PULocationID GROUP BY z.Borough UNION ALL SELECT Borough, COUNT(*) AS cnt FROM ops.zones z JOIN lake.trips t ON z.LocationID = t.DOLocationID GROUP BY z.Borough) z GROUP BY z.Borough ORDER BY z.Borough
```
rows 8 vs 8 · rows differ (8 vs 8 rows); first differing row ["Bronx","4073"] returned by the original, missing from the candidate
first difference (orig only): `["Bronx","4073"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Split the OR join into two separate equi-joins (PU and DO), each aggregated per borough, then combined with UNION ALL and a final SUM aggregation to preserve exact per-borough counts.
```sql
SELECT borough, SUM(touches) AS touches FROM (SELECT z.Borough AS borough, COUNT(*) AS touches FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.PULocationID GROUP BY z.Borough UNION ALL SELECT z.Borough AS borough, COUNT(*) AS touches FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.DOLocationID GROUP BY z.Borough) sub GROUP BY borough ORDER BY borough
```
rows 8 vs 8 · result columns differ: column 1 named "Borough" vs "borough"

### Attempt 3 — REJECT (ERROR)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced the OR join with two separate equi-joins (PU and DO) plus an intersection join, aggregated each, then combined via full outer join using inclusion-exclusion to preserve exact per-borough counts.
```sql
WITH pu AS (SELECT z.Borough, COUNT(*) AS cnt FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.PULocationID GROUP BY z.Borough), do AS (SELECT z.Borough, COUNT(*) AS cnt FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.DOLocationID GROUP BY z.Borough), both AS (SELECT z.Borough, COUNT(*) AS cnt FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.PULocationID AND z.LocationID = t.DOLocationID GROUP BY z.Borough) SELECT coalesce(pu.Borough, do.Borough, both.Borough) AS Borough, (coalesce(pu.cnt, 0) + coalesce(do.cnt, 0) - coalesce(both.cnt, 0)) AS touches FROM pu FULL JOIN do ON pu.Borough = do.Borough FULL JOIN both ON coalesce(pu.Borough, do.Borough) = both.Borough ORDER BY Borough
```
rows 8 vs 0 · Parser Error: syntax error at or near "do"

Playbook entries used: `mem-1`, `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ERROR
