# Query Doctor — NO_SAFE_REWRITE

run `canon-example_3` · engine duckdb · llm nim · 2026-10-25T11:09:21.043Z

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
- Diagnoser's reading (model text, unverified): The query spends most time scanning the full trips table (495k rows) to filter payment_type=2, then hash-joining 99k rows to 265 zones with a CAST on the join key, and finally aggregating. The sequential scan and the CAST in the join condition are the primary cost drivers.
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [falsified] (model claim, unverified, plan node 8) The HASH_JOIN uses CAST(PULocationID AS BIGINT) = LocationID, which adds per-row CPU overhead and may prevent predicate pushdown or partition pruning; aligning the data types (e.g., making PULocationID BIGINT) would eliminate the cast and speed up the join.
- **h3** [untested] (model claim, unverified, plan node 8) The SEQ_SCAN on trips reads all 495k rows to apply payment_type=2; creating an index on payment_type or partitioning by payment_type would allow index scans or partition elimination, reducing I/O and scan time.
- **h4** [untested] (model claim, unverified, plan node 5) The HASH_GROUP_BY aggregates 99k rows after the join; pre-aggregating trips by PULocationID before the join (since the join is a left join from zones) could reduce the probe side cardinality and overall hash table size.

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
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-aggregated filtered trips by PULocationID before joining to zones to eliminate the CAST in the join condition and reduce join input from 99k rows to at most 243 rows, while preserving all zones with zero counts via LEFT JOIN and COALESCE.
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
rows 265 vs 265 · median 2.46×, saving 2.6 ms, 3/3 pairs faster — missed: floor
timing: median 2.46×, saving 2.6 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Removed unnecessary CAST by relying on DuckDB's implicit numeric coercion in the join condition; kept the original join structure to preserve all zones and correct cash_trip counts including zeros.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.13×, saving 0.4 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.13×, saving 0.4 ms, 2/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
