# Query Doctor — NO_SAFE_REWRITE

run `canon-example_3` · engine duckdb · llm nim · 2026-10-25T12:14:50.925Z

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
- Diagnoser's reading (model text, unverified): The query scans the entire trips table (495K rows) to filter payment_type=2, then hash-joins 99K probe rows to 265 zones with a per-row CAST, and finally aggregates; the dominant cost is the full scan and the join's type conversion.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 9) Full sequential scan of 495,833 trips rows to apply payment_type=2 filter; an index, zone map, or partitioning on payment_type could avoid reading non-matching rows.
- **h3** [untested] (model claim, unverified, plan node 8) The join condition CAST(PULocationID AS BIGINT) = LocationID forces a per-row cast on the probe side; aligning PULocationID and LocationID to the same integer type would eliminate this overhead.
- **h4** [untested] (model claim, unverified, plan node 8) The RIGHT OUTER JOIN probes 99,167 trips rows (only 243 distinct PULocationID) against 265 zones; pre-aggregating trips by PULocationID before the join would reduce probe volume and hash work.

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
**Memory:** this refusal was reused from the playbook ledger (mem-1); the candidate was not executed.
rows 265 vs 200 · refusal reused from ledger mem-1 — same original-result fingerprint; the candidate was not executed (outer_join_predicate: rewrite changed the rows (ROW_DIFF). candidate supplied with the request Rows original 265, rewrite 200. First differing row (orig only): ["2","Queens","Jamaica Bay","0"].)
first difference (orig only): `["2","Queens","Jamaica Bay","0"]`

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregate trips by PULocationID after filtering payment_type=2, then left join the small aggregate to zones to avoid full scan and join on raw rows.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.47×, saving 3.6 ms, 3/3 pairs faster — missed: floor
timing: median 2.47×, saving 3.6 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Added explicit cast to BIGINT on PULocationID in the subquery to match zones.LocationID type and eliminate per-row CAST in join; kept LEFT JOIN with subquery aggregation to preserve all zones including zero-count ones.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID::BIGINT AS PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.47×, saving 1.9 ms, 3/3 pairs faster — missed: floor
timing: median 2.47×, saving 1.9 ms, 3/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
