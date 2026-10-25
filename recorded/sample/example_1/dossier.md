# Query Doctor — NO_SAFE_REWRITE

run `canon-example_1` · engine duckdb · llm nim · 2026-10-25T12:14:14.804Z

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
- Diagnoser's reading (model text, unverified): The query scans the entire 495K-row trips table to apply the payment_type=2 filter (yielding ~99K rows), then performs a hash join with a CAST on the join key against the tiny 265-row zones table, followed by a hash aggregation of the 99K joined rows.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [falsified] (model claim, unverified, plan node 8) The HASH_JOIN (node 8) incurs CPU overhead from the CAST(PULocationID AS BIGINT) in the join condition; if PULocationID and LocationID shared the same integral type the cast could be eliminated and the join could use a more efficient equality operator.
- **h3** [untested] (model claim, unverified, plan node 8) The left input SEQ_SCAN on trips reads all 495K rows because there is no index or zone-map on payment_type; a partial index on (payment_type, PULocationID) or partitioning by payment_type would allow skipping the 80% of rows that do not match payment_type=2.
- **h4** [untested] (model claim, unverified, plan node 8) The HASH_GROUP_BY following the join processes 99K rows only to reduce to 265 groups; pushing the aggregation into the trips scan (pre-aggregating cash trips per PULocationID) before the join would shrink the build side and avoid hashing 99K rows.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin candidate_sql · candidate supplied with the request
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips
FROM ops.zones z
LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID
WHERE t.payment_type = 2
GROUP BY z.LocationID, z.Borough, z.Zone
ORDER BY z.LocationID
```
**Rows:** differ (first differing row ["2","Queens","Jamaica Bay","0"], orig only)
**Speed:** not measured — refused before timing
rows 265 vs 200 · rows differ (265 vs 200 rows); first differing row ["2","Queens","Jamaica Bay","0"] returned by the original, missing from the candidate
first difference (orig only): `["2","Queens","Jamaica Bay","0"]`

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated trips by PULocationID before joining to reduce join input from 99K rows to at most 243 rows and eliminate the expensive hash aggregation after the join.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips
FROM ops.zones z
LEFT JOIN (
    SELECT PULocationID, COUNT(*) AS cnt
    FROM lake.trips
    WHERE payment_type = 2
    GROUP BY PULocationID
) t ON t.PULocationID = z.LocationID
ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.39×, saving 2.6 ms, 3/3 pairs faster — missed: floor
timing: median 2.39×, saving 2.6 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Eliminated the runtime CAST by casting the zones.LocationID to INTEGER to match trips.PULocationID type, allowing a direct integer equality join.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips
FROM ops.zones z
LEFT JOIN lake.trips t
  ON t.PULocationID = z.LocationID::INTEGER
 AND t.payment_type = 2
GROUP BY z.LocationID, z.Borough, z.Zone
ORDER BY z.LocationID
```
rows 265 vs 265 · median 0.98×, saving -0.1 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.98×, saving -0.1 ms, 1/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
