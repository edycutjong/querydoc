# Query Doctor — NO_SAFE_REWRITE

run `canon-example_2` · engine duckdb · llm nim · 2026-10-25T12:11:01.959Z

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
- Diagnoser's reading (model text, unverified): The query spends most of its time scanning the trips table (495k rows) to filter payment_type=2, then hash-joining the 99k matching rows to the tiny zones table (265 rows) and grouping. The sequential scan on trips is the largest data movement.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [falsified] (model claim, unverified, plan node 8) The sequential scan on trips reads all rows to evaluate payment_type=2; creating an index on payment_type (if DuckDB supported secondary indexes) or partitioning the table by payment_type would avoid the full scan.
- **h3** [falsified] (model claim, unverified, plan node 7) The join condition CAST(PULocationID AS BIGINT) = LocationID forces a per-row cast on the 99k probe rows; aligning the data types of PULocationID and LocationID would eliminate this CPU overhead.
- **h4** [untested] (model claim, unverified, plan node 4) The hash group by processes 99k rows with string columns (Borough, Zone) in the grouping key; replacing those with integer surrogates (e.g., zone_id) would reduce hash/comparison cost.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate trips by PULocationID after filtering payment_type=2, then join the tiny aggregated result to zones, avoiding a large hash join and group-by on the full trip set.
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
rows 265 vs 265 · median 2.44×, saving 2.3 ms, 3/3 pairs faster — missed: floor
timing: median 2.44×, saving 2.3 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): No rewrite possible without indexes; query already uses optimal hash join and grouping order for DuckDB columnar engine.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.09×, saving 0.4 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.09×, saving 0.4 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Explicitly cast PULocationID to BIGINT in the join condition to match LocationID's type, eliminating the implicit per-row cast on the probe side.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID::BIGINT = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.16×, saving 0.5 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.16×, saving 0.5 ms, 2/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
