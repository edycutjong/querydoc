# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r3` · engine duckdb · llm nim · 2026-10-25T12:19:56.708Z

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
- Diagnoser's reading (model text, unverified): The query scans the entire trips table (495K rows) to apply the payment_type=2 filter, then hash-joins the resulting ~99K rows with the 265-row zones table, and finally groups 99K rows into 265 groups; the dominant cost is the full table scan and subsequent join on the filtered trips rows.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 9) The sequential scan on trips reads all 495833 rows to find the 99167 with payment_type=2; an index on payment_type or partitioning by payment_type would avoid the full scan.
- **h3** [falsified] (model claim, unverified, plan node 8) The join condition CAST(PULocationID AS BIGINT) = LocationID adds a per-row cast overhead and may prevent join optimizations; ensuring PULocationID and LocationID share the same integer type would eliminate the cast.
- **h4** [untested] (model claim, unverified, plan node 5) The hash group by processes 99167 joined rows to produce only 265 groups; pre-aggregating trips by PULocationID for payment_type=2 before the join could reduce the join input size significantly.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate filtered trips by PULocationID before joining to zones, eliminating the large hash join and group-by on the full filtered trip set.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(cnt.c, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT PULocationID, COUNT(*) AS c
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY PULocationID
) cnt ON cnt.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.53×, saving 2.3 ms, 3/3 pairs faster — missed: floor
timing: median 2.53×, saving 2.3 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Pre-aggregate the filtered trips by PULocationID before joining to zones, reducing the join input from ~99K rows to at most 243 rows.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(cnt.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) cnt ON cnt.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.6×, saving 2.5 ms, 3/3 pairs faster — missed: floor
timing: median 2.6×, saving 2.5 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Eliminated per-row cast by casting LocationID to SMALLINT once to match PULocationID's type in the join condition.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID::SMALLINT AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.07×, saving 0.2 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.07×, saving 0.2 ms, 2/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
