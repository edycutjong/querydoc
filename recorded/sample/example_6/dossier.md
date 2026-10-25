# Query Doctor — NO_SAFE_REWRITE

run `canon-example_6` · engine duckdb · llm nim · 2026-10-25T12:13:09.616Z

## Original
```sql
SELECT payment_type, COUNT(*) AS trips
FROM lake.trips
GROUP BY payment_type
ORDER BY payment_type
```

Pre-check: deterministic true, 5 row(s), fingerprint `d8710a873f8bd21d` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `other` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query performs a full sequential scan of 495,833 rows from the trips table followed by a hash aggregation on payment_type. The scan dominates execution time since every row must be read and processed despite only 5 distinct groups in the result.
- narrative: llm
- **h1** [falsified] (detector, plan node 8) No known pattern matched; the plan's most expensive operator is the candidate.
- **h2** [unproven] (model claim, unverified, plan node 4) The PERFECT_HASH_GROUP_BY builds a hash table for only 5 groups but still processes 495,833 rows individually; a pre-aggregated metadata cache or materialized view would avoid the scan entirely.
- **h3** [falsified] (model claim, unverified, plan node 6) Multiple PROJECTION nodes compress/decompress payment_type between operators, adding per-row CPU overhead; fusing projections or using a more direct encoding path could reduce per-row cost.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): No rewrite applied - original query is already optimal for full table aggregation with 5 distinct groups; no partitioning, indexing, or filtering opportunities exist without additional schema information.
```sql
SELECT payment_type, COUNT(*) AS trips FROM lake.trips GROUP BY payment_type ORDER BY payment_type
```
rows 5 vs 5 · median 0.91×, saving -0.1 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.91×, saving -0.1 ms, 0/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): No change — verified no projection fusion optimization possible in DuckDB for this query structure; original SQL is already optimal for the given execution pattern
```sql
SELECT payment_type, COUNT(*) AS trips FROM lake.trips GROUP BY payment_type ORDER BY payment_type
```
rows 5 vs 5 · median 1.05×, saving 0.1 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.05×, saving 0.1 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Added a redundant GROUP BY to force a two-phase aggregation, testing if partial aggregation reduces hash table overhead despite identical logical result.
```sql
SELECT payment_type, COUNT(*) AS trips FROM (SELECT payment_type FROM lake.trips GROUP BY payment_type) GROUP BY payment_type ORDER BY payment_type
```
rows 5 vs 5 · rows differ (5 vs 5 rows); first differing row ["0","23773"] returned by the original, missing from the candidate
first difference (orig only): `["0","23773"]`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT ROW_DIFF
