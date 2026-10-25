# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r3` · engine duckdb · llm nim · 2026-10-25T11:12:38.912Z

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
- Diagnoser's reading (model text, unverified): The HASH_JOIN (node 8) performs a RIGHT join with filter pushdown on payment_type=2; DuckDB builds the hash table from the filtered trips (est. 99k rows) and probes the 265-row zones table, but the RIGHT join forces retention of all zone rows plus 99k matching trips, causing unnecessary row expansion before GROUP BY. The subsequent HASH_GROUP_BY then re-aggregates those 99k rows down to ~243 distinct PULocationIDs.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 8) Using a RIGHT hash join prevents filter pushdown into the build side and materializes 99k trip rows that immediately collapse to ~243 groups; switching to a LEFT join (zones LEFT JOIN filtered trips) or pre-aggregating trips by PULocationID before joining would eliminate the row expansion.
- **h3** [unproven] (model claim, unverified, plan node 9) The SEQ_SCAN on trips reads all columns needed for the filter but projects only PULocationID; if payment_type is not in the same row group / segment, the scan still decodes full rows. A projection pushdown or columnar skip could reduce I/O.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated the filtered trips table before joining to eliminate the large RIGHT join and reduce row expansion prior to the final GROUP BY.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(agg.cash_trips, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT PULocationID, COUNT(*) AS cash_trips
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY PULocationID
) agg ON agg.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.54×, saving 2.2 ms, 3/3 pairs faster — missed: floor
timing: median 2.54×, saving 2.2 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Pre-aggregate trips with payment_type=2 by PULocationID before left joining to zones, eliminating the 99k-row expansion from the right hash join.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.63×, saving 2.6 ms, 3/3 pairs faster — missed: floor
timing: median 2.63×, saving 2.6 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Pre-aggregate cash trips by PULocationID before joining to zones, reducing rows fed into the join from ~99k to ~243 distinct locations.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(agg.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) agg ON agg.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 3.31×, saving 3.7 ms, 3/3 pairs faster — missed: floor
timing: median 3.31×, saving 3.7 ms, 3/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
