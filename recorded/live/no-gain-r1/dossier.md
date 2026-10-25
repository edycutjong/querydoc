# Query Doctor — NO_SAFE_REWRITE

run `live-no-gain-r1` · engine zetaris · llm nim · 2026-10-25T13:07:59.294Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.promotion p
WHERE  p.p_channel_tv = 'N'
```

Pre-check: deterministic true, 1 row(s), fingerprint `9b4161899e1b76a5` (rows).

## Diagnosis
- pattern: `other` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query scans the entire p_channel_tv column of the promotion table because no partitioning or indexing exists on the filter column, forcing a full column read and filter evaluation.
- narrative: llm
- **h1** [falsified] (detector, plan node 6) No known pattern matched; the plan's most expensive operator is the candidate.
- **h2** [falsified] (model claim, unverified, plan node 1) The Parquet scan reads all row groups of p_channel_tv; if the table is large and the predicate selectivity is low, I/O dominates. Partitioning the table by p_channel_tv or using a bloom filter could prune row groups.
- **h3** [untested] (model claim, unverified, plan node 2) The filter operator reapplies the same predicate after pushdown, suggesting incomplete pushdown or extra null checks; eliminating this filter via full pushdown would save CPU cycles.
- **h4** [untested] (model claim, unverified, plan node 4) Partial aggregation per partition and the subsequent single-partition shuffle (node 5) add overhead; if the number of partitions is high, reducing partitions or using a more efficient aggregation strategy could help.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replaced COUNT(1) with COUNT(*) for standard SQL syntax while maintaining identical semantics and execution plan.
```sql
SELECT COUNT(*) AS n FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N'
```
rows 1 vs 1 · median 0.98×, saving -218.5 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.98×, saving -218.5 ms, 1/3 pairs faster (noise floor 1782.9 ms)

### Attempt 2 — REJECT (ERROR)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Added explicit IS NOT NULL predicate to enable potential partition/row-group pruning if statistics exist
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.promotion WHERE p.p_channel_tv = 'N' AND p.p_channel_tv IS NOT NULL
```
rows 1 vs 0 · org.apache.hive.service.cli.HiveSQLException: com.zetaris.lightning.error.LightningException: <<<[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column or function parameter with name `p`.`p_channel_tv` cannot be resolved. Did you mean one of the following? [`promotion`.`p_channel_tv`, `promotion`.`p_channel_

### Attempt 3 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Removed unnecessary IS NOT NULL check and used COUNT(*) which is more idiomatic
```sql
SELECT COUNT(*) AS n FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N'
```
rows 1 vs 1 · median 1.01×, saving 127.2 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.01×, saving 127.2 ms, 2/3 pairs faster (noise floor 1782.9 ms)

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT ERROR, #3 REJECT NOT_FASTER
