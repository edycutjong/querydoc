# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r2` · engine duckdb · llm nim · 2026-10-25T11:11:41.294Z

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
- Diagnoser's reading (model text, unverified): The query scans the entire trips table (495K rows) to filter payment_type=2, then performs a hash join with a CAST on the join key, and finally aggregates ~99K rows; the sequential scan and the cast in the join condition are the primary cost drivers.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [falsified] (model claim, unverified, plan node 8) The CAST(PULocationID AS BIGINT) in the join condition forces per-row type conversion during hash join probing, increasing CPU; if PULocationID and LocationID share a compatible integer type, removing the cast could eliminate this overhead.
- **h3** [unproven] (model claim, unverified, plan node 8) The RIGHT HASH JOIN builds the hash table on the small zones table (265 rows) but probes with 99K trips rows; the join's output cardinality equals the filtered trips count, indicating no early aggregation—pre-aggregating trips by PULocationID before the join could reduce probe volume.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate cash trips by PULocationID before joining to zones to reduce rows entering the join and remove the CAST in the join condition.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(cnt.cash_trips, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT t.PULocationID, COUNT(*) AS cash_trips
    FROM lake.trips t
    WHERE t.payment_type = 2
    GROUP BY t.PULocationID
) cnt ON cnt.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.88×, saving 1.6 ms, 3/3 pairs faster — missed: floor
timing: median 1.88×, saving 1.6 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Removed the CAST(PULocationID AS BIGINT) in the join condition to eliminate per-row type conversion overhead during hash join probing.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.04×, saving 0.1 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.04×, saving 0.1 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Pre-aggregate trips filtered by payment_type=2 by PULocationID before joining to zones, reducing probe volume and eliminating the CAST in the join condition.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cash_cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cash_cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.67×, saving 2.5 ms, 3/3 pairs faster — missed: floor
timing: median 2.67×, saving 2.5 ms, 3/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-2`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
