# Query Doctor — NO_SAFE_REWRITE

run `live-trap-t1-r1` · engine zetaris · llm nim · 2026-10-25T13:16:04.442Z

## Original
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk AND p.p_channel_tv = 'N'
WHERE  ss.ss_customer_sk IS NULL
```

Pre-check: deterministic true, 1 row(s), fingerprint `30b488920fa9b61b` (rows).

## Diagnosis
- pattern: `outer_join_predicate` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query spends most time scanning the store_sales table to find rows where ss_customer_sk IS NULL, which likely reads a large volume of data from S3. The subsequent broadcast join and aggregations are lightweight because the promotion table is tiny (300 rows).
- narrative: llm
- **h1** [unproven] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join tpcds_db.promotion p on … and p.p_channel_tv = ')
- **h2** [unproven] (model claim, unverified, plan node 1) The scan of store_sales with pushed filter IsNull(ss_customer_sk) still reads a significant fraction of the table because many rows have null ss_customer_sk, making I/O the dominant cost.
- **h3** [untested] (model claim, unverified, plan node 8) The left outer broadcast hash join processes every filtered store_sales row; if the filtered dataset is large, the CPU cost of probing the broadcasted promotion hash table could be non-trivial despite the small build side.
- **h4** [untested] (model claim, unverified, plan node 10) The partial hash aggregate (counting per partition) adds overhead of serialization and the subsequent single-partition exchange (node 11) if the number of partitions is high, though this is usually minor compared to the scan.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Moved p.p_channel_tv = 'N' from ON clause to WHERE clause, turning LEFT JOIN into INNER JOIN equivalent while preserving semantics due to null-rejecting predicate on the preserved side.
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk WHERE ss.ss_customer_sk IS NULL AND p.p_channel_tv = 'N'
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["63812","63812"] returned by the candidate, not by the original
first difference (rewrite only): `["63812","63812"]`

### Attempt 2 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-filter the promotion table to only TV='N' rows in a subquery before the LEFT JOIN, reducing the broadcast size and join probe cost while preserving LEFT JOIN semantics.
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN (SELECT p_promo_sk FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N') p ON ss.ss_promo_sk = p.p_promo_sk WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · median 1.09×, saving 3120 ms, 2/3 pairs faster — missed: ratio
timing: median 1.09×, saving 3120 ms, 2/3 pairs faster (noise floor 1782.9 ms)

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Moved p.p_channel_tv = 'N' from ON clause to WHERE clause to potentially enable earlier filtering and reduce I/O on store_sales scan.
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk WHERE ss.ss_customer_sk IS NULL AND p.p_channel_tv = 'N'
```
rows 1 vs 1 · refusal reused from ledger mem-18 — same original-result fingerprint; the candidate was not executed (outer_join_predicate: rewrite changed the rows (ROW_DIFF). Moved p.p_channel_tv = 'N' from ON clause to WHERE clause, turning LEFT JOIN into INNER JOIN equivalent while preserving semantics due to nul)
first difference (rewrite only): `["63812","63812"]`

Playbook entries used: `mem-8`, `mem-9`, `mem-18`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT NOT_FASTER, #3 REJECT ROW_DIFF
