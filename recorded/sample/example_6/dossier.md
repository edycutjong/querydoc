# Query Doctor — NO_SAFE_REWRITE

run `canon-example_6` · engine duckdb · llm nim · 2026-10-25T11:06:51.755Z

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
- Diagnoser's reading (model text, unverified): The query scans the entire payment_type column (≈495K rows) via a sequential scan and then performs a perfect hash aggregation. With only ~5 distinct payment_type values, the aggregation itself is cheap, so the dominant cost is reading and decompressing the payment_type column for every row.
- narrative: llm
- **h1** [falsified] (detector, plan node 8) No known pattern matched; the plan's most expensive operator is the candidate.
- **h2** [untested] (model claim, unverified, plan node 8) The SEQ_SCAN reads all 495,833 payment_type values from disk; if the table is partitioned or sorted by payment_type, partition pruning or a zone-map skip could avoid reading entire row groups.
- **h3** [falsified] (model claim, unverified, plan node 5) The PERFECT_HASH_GROUP_BY processes every row despite extremely low cardinality (5 groups); a pre-aggregated metadata cache or materialized view could answer this query without scanning the fact table.
- **h4** [untested] (model claim, unverified, plan node 6) The compression/decompression projections (nodes 6/7) add CPU overhead per row; using a dictionary-encoded column with direct aggregation on dictionary codes could eliminate the decompress step.
- **h5** [falsified] (model claim, unverified, plan node 6) Bypassing the decompression at plan node 6 by aggregating directly on dictionary-encoded payment_type codes will reduce total CPU cycles consumed by the query.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Wrapped the column projection in a derived table to potentially enable more efficient columnar scanning and aggregation pushdown
```sql
SELECT payment_type, COUNT(*) AS trips FROM (SELECT payment_type FROM lake.trips) t GROUP BY payment_type ORDER BY payment_type
```
rows 5 vs 5 · median 1×, saving 0 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 1×, saving 0 ms, 1/3 pairs faster (noise floor 50 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Original query retained as no pre-aggregated metadata cache or materialized view exists for payment_type counts; hypothesis h3 cannot be implemented without additional database objects.
```sql
SELECT payment_type, COUNT(*) AS trips FROM lake.trips GROUP BY payment_type ORDER BY payment_type
```
rows 5 vs 5 · median 1.06×, saving 0.1 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.06×, saving 0.1 ms, 2/3 pairs faster (noise floor 50 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h5 · Rewriter's note (model text): No rewrite possible: DuckDB does not expose dictionary-encoding internals to SQL, so the original query is already optimal for the logical plan.
```sql
SELECT payment_type, COUNT(*) AS trips FROM lake.trips GROUP BY payment_type ORDER BY payment_type
```
rows 5 vs 5 · median 1×, saving 0 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 1×, saving 0 ms, 1/3 pairs faster (noise floor 50 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
