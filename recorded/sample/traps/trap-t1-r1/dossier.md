# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r1` · engine duckdb · llm nim · 2026-10-25T11:10:09.374Z

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
- Diagnoser's reading (model text, unverified): The query scans the full trips table (495k rows) to apply the payment_type=2 filter, then hash-joins the resulting ~99k rows to the 265-row zones table, and finally hash-groups those 99k rows into 265 groups.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [falsified] (model claim, unverified, plan node 8) The sequential scan on trips reads all 495,833 rows because the columnar zone maps cannot prune row groups for payment_type=2 (only 5 distinct values, low selectivity); sorting or partitioning the data by payment_type would allow skipping irrelevant row groups.
- **h3** [untested] (model claim, unverified, plan node 7) The join condition uses CAST(PULocationID AS BIGINT) = LocationID, which adds per-row CPU overhead and may prevent the optimizer from using a more efficient join strategy; aligning the data types of PULocationID and LocationID would eliminate the cast.
- **h4** [unproven] (model claim, unverified, plan node 4) The hash group by processes 99,167 joined rows to produce only 265 groups; pre-aggregating trips by PULocationID (and payment_type=2) before the left join would reduce the probe side to at most 243 distinct locations, cutting join and aggregation work dramatically.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated the filtered trips by PULocationID before joining to zones, reducing the join input from ~99k rows to at most 243 groups and eliminating the post-join hash aggregation.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(agg.cnt, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT PULocationID, COUNT(*) AS cnt
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY PULocationID
) agg ON agg.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.47×, saving 2.2 ms, 3/3 pairs faster — missed: floor
timing: median 2.47×, saving 2.2 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Moved payment_type filter into conditional aggregation inside the join to enable potential zone-map pruning on LocationID instead of full table scan with payment_type filter.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(SUM(CASE WHEN t.payment_type = 2 THEN 1 ELSE 0 END), 0) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 0.41×, saving -6 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.41×, saving -6 ms, 0/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h4 · Rewriter's note (model text): Pre-aggregate trips filtered by payment_type=2 per PULocationID before the left join to reduce join and aggregation workload.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.64×, saving 2.3 ms, 3/3 pairs faster — missed: floor
timing: median 2.64×, saving 2.3 ms, 3/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
