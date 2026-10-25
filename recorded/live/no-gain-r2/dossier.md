# Query Doctor — NO_SAFE_REWRITE

run `live-no-gain-r2` · engine zetaris · llm nim · 2026-10-25T13:11:30.387Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.promotion p
WHERE  p.p_channel_tv = 'N'
```

Pre-check: deterministic true, 1 row(s), fingerprint `9b4161899e1b76a5` (rows).

## Diagnosis
- pattern: `other` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query spends most of its time scanning the promotion table and applying the filter p_channel_tv = 'N'. Even though the scan pushes down the filter, the column is not a partition key, so many row groups may be read if statistics are missing or if the predicate selectivity is high (i.e., a large fraction of rows match 'N').
- narrative: llm
- **h1** [falsified] (detector, plan node 6) No known pattern matched; the plan's most expensive operator is the candidate.
- **h2** [falsified] (model claim, unverified, plan node 1) The Parquet scan reads a large portion of the table because p_channel_tv lacks partitioning or min/max statistics, causing unnecessary I/O; adding partitioning or a bloom filter on p_channel_tv would reduce data read.
- **h3** [untested] (model claim, unverified, plan node 4) The partial aggregate processes a high volume of rows because the filter selectivity is high (most rows satisfy p_channel_tv='N'), making the aggregation CPU-bound; a more selective predicate or pre-aggregation would reduce the row count.
- **h4** [unproven] (model claim, unverified, plan node 6) The final aggregate and preceding exchange are trivially small (single long per partition), but if the number of partitions is very large the shuffle coordination could add overhead; reducing the number of partitions before the exchange would cut that cost.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): No rewrite applied because no indexed or partitioning optimizations are available for the p_channel_tv column; the original query already uses predicate pushdown effectively.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.promotion p WHERE p.p_channel_tv = 'N'
```
rows 1 vs 1 · median 0.93×, saving -518.7 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.93×, saving -518.7 ms, 0/3 pairs faster (noise floor 1782.9 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Added explicit IS NOT NULL predicate to potentially improve partition pruning and predicate pushdown in Parquet scan
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.promotion p WHERE p.p_channel_tv = 'N' AND p.p_channel_tv IS NOT NULL
```
rows 1 vs 1 · median 0.94×, saving -577.9 ms, 0/3 pairs faster — missed: ratio, floor, majority
timing: median 0.94×, saving -577.9 ms, 0/3 pairs faster (noise floor 1782.9 ms)

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h4 · Rewriter's note (model text): Added pre-aggregation by the filtered column p_channel_tv to reduce the number of partial count partitions before the final shuffle exchange.
```sql
SELECT COUNT(1) AS n FROM (SELECT 1 FROM TPCDS_DB.promotion p WHERE p.p_channel_tv = 'N' AND p.p_channel_tv IS NOT NULL GROUP BY p.p_channel_tv) t
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["1"] returned by the candidate, not by the original
first difference (rewrite only): `["1"]`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT ROW_DIFF
