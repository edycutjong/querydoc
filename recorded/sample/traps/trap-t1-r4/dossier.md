# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r4` · engine duckdb · llm nim · 2026-10-25T11:14:24.550Z

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
- Diagnoser's reading (model text, unverified): The HASH_JOIN (node 8) processes 99K filtered trips rows with a CAST(PULocationID AS BIGINT) join condition, and the subsequent HASH_GROUP_BY aggregates these rows by string columns (Borough, Zone), causing high CPU for type conversion and string hashing.
- narrative: llm
- **h1** [falsified] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [unproven] (model claim, unverified, plan node 8) The CAST(PULocationID AS BIGINT) in the join condition forces a per-row type conversion on the 99K trips rows, adding CPU overhead; if PULocationID and LocationID shared the same integer type, the cast could be eliminated and the hash join would be faster.
- **h3** [unproven] (model claim, unverified, plan node 4) The HASH_GROUP_BY (node 4) groups 99K rows by two string columns (Borough, Zone) which are not compressed in the join output, causing expensive string hashing and comparison; pre-aggregating trips by PULocationID before joining would reduce the input to at most 243 rows.
- **h4** [untested] (model claim, unverified, plan node 8) The RIGHT HASH_JOIN builds its hash table on the larger trips input (99K rows) rather than the smaller zones table (265 rows) because the preserved side is zones; reversing the join order (e.g., by rewriting as a LEFT JOIN with zones first) might allow building the hash table on zones.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Move the payment_type = 2 filter into a derived table so the join condition is a clean equality without CAST, allowing the optimizer to use a more efficient hash join.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID FROM lake.trips WHERE payment_type = 2) t ON t.PULocationID = z.LocationID GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 0.98×, saving -0.1 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.98×, saving -0.1 ms, 1/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Pre-aggregate cash trips by PULocationID before joining to zones, reducing join input from 99K rows to at most 243 rows and eliminating string hashing in GROUP BY.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COALESCE(t.cnt, 0) AS cash_trips FROM ops.zones z LEFT JOIN (SELECT PULocationID, COUNT(*) AS cnt FROM lake.trips WHERE payment_type = 2 GROUP BY PULocationID) t ON t.PULocationID = z.LocationID ORDER BY z.LocationID
```
rows 265 vs 265 · median 2.33×, saving 2 ms, 3/3 pairs faster — missed: floor
timing: median 2.33×, saving 2 ms, 3/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h2 · Rewriter's note (model text): No change; the CAST(PULocationID AS BIGINT) is not present in the original SQL and cannot be removed from the query text.
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips FROM ops.zones z LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2 GROUP BY z.LocationID, z.Borough, z.Zone ORDER BY z.LocationID
```
rows 265 vs 265 · median 1.27×, saving 0.9 ms, 2/3 pairs faster — missed: floor
timing: median 1.27×, saving 0.9 ms, 2/3 pairs faster (noise floor 50 ms)

Playbook entries used: `mem-1`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
