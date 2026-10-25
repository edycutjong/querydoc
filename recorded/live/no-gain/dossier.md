# Query Doctor — NO_SAFE_REWRITE

run `run-2026-10-25T10-35-00Z-4d45` · engine zetaris · llm nim · 2026-10-25T10:35:00.320Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.promotion p
WHERE  p.p_channel_tv = 'N'
```

Pre-check: deterministic true, 1 row(s), fingerprint `9b4161899e1b76a5` (rows).

## Diagnosis
- pattern: `other` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query performs a full scan of the promotion table with a filter on p_channel_tv = 'N'. The scan (node 1) reads all Parquet row groups because the table is not partitioned or sorted by p_channel_tv, making predicate pushdown ineffective at the file/row-group level. The downstream aggregation (nodes 4, 6) and shuffle (node 5) are trivial in comparison.
- narrative: llm
- **h1** [falsified] (detector, plan node 6) No known pattern matched; the plan's most expensive operator is the candidate.
- **h2** [falsified] (model claim, unverified, plan node 1) The scan reads the entire promotion table because p_channel_tv is not a partition column and Parquet row-group statistics do not prune any row groups; rewriting the table to partition by p_channel_tv or sorting by it would allow file-level pruning and reduce I/O.
- **h3** [falsified] (model claim, unverified, plan node 2) The filter operator (node 2) re-evaluates the same predicate after the scan, indicating that the pushed filter may not be fully applied at the Parquet page level (e.g., due to missing statistics or dictionary encoding); collecting column statistics or using a more selective predicate could reduce CPU time spent filtering.
- **h4** [untested] (model claim, unverified, plan node 4) The partial hash aggregate (node 4) processes a large number of rows because the filter selectivity is high (many rows have p_channel_tv = 'N'), making the counting loop the dominant CPU cost; if the selectivity is indeed high, a materialized view or pre-aggregated table would avoid scanning the detail rows.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed redundant IS NOT NULL check since equality filter already implies non-null
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N'
```
rows 1 vs 1 · median 0.9×, saving -960 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.9×, saving -960 ms, 1/3 pairs faster (noise floor 1782.9 ms)

### Attempt 2 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): No rewrite possible without DDL changes; partitioning or sorting by p_channel_tv requires table restructuring which cannot be expressed in a SELECT-only statement.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N'
```
rows 1 vs 1 · median 1.01×, saving 68 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.01×, saving 68 ms, 2/3 pairs faster (noise floor 1782.9 ms)

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Added explicit IS NOT NULL predicate to potentially enable better Parquet page-level filtering via statistics
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N' AND p_channel_tv IS NOT NULL
```
rows 1 vs 1 · median 1.01×, saving 75.1 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.01×, saving 75.1 ms, 2/3 pairs faster (noise floor 1782.9 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
#1 REJECT NOT_FASTER, #2 REJECT NOT_FASTER, #3 REJECT NOT_FASTER
