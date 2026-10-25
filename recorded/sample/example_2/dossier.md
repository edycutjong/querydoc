# Query Doctor — NO_SAFE_REWRITE

run `canon-example_2` · engine duckdb · llm nim · 2026-10-25T11:08:51.667Z

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
- Diagnoser's reading (model text, unverified): The query scans ~99k trips rows (filtered by payment_type=2), performs a hash join with a CAST on the join key, then aggregates all 99k rows down to 265 zones. The join probe and subsequent hash group-by on the full trips result dominate runtime.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)

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
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate lake.trips by PULocationID for payment_type=2 to reduce the join probe from 99k rows to distinct locations, then left join the aggregated counts to zones.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON z.LocationID = t.PULocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.29×, saving 2.2 ms, 3/3 pairs faster — missed: floor
timing: median 2.29×, saving 2.2 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Push filter before join and pre-aggregate trips by PULocationID with explicit cast to match join semantics
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT CAST(PULocationID AS BIGINT) AS PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON z.LocationID = t.PULocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.29×, saving 2.8 ms, 3/3 pairs faster — missed: floor
timing: median 2.29×, saving 2.8 ms, 3/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
