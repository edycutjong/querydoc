# Query Doctor — NO_SAFE_REWRITE

run `run-2026-10-25T10-18-43Z-efaa` · engine zetaris · llm nim · 2026-10-25T10:18:43.774Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_item_sk = p.p_item_sk
WHERE  ss.ss_customer_sk IS NULL
```

Pre-check: deterministic true, 1 row(s), fingerprint `e51f9da70057feb6` (rows).

## Diagnosis
- pattern: `unused_outer_join` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query scans the large store_sales table with a filter on ss_customer_sk IS NULL, then performs a broadcast left outer join to promotion where the right key p_item_sk is not unique (293 rows, 291 distinct), causing row multiplication that inflates the input to the final aggregation.
- narrative: llm
- **h1** [unproven] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_item_sk = p.p_item_sk)
- **h2** [unproven] (model claim, unverified, plan node 7) The BroadcastHashJoin produces many more rows than the filtered store_sales input because promotion.p_item_sk has duplicate values, increasing the work for downstream aggregation.
- **h3** [untested] (model claim, unverified, plan node 1) The parquet scan of store_sales with pushed IsNull filter reads a large portion of the table; if the null fraction of ss_customer_sk is high, this scan dominates elapsed time.
- **h4** [untested] (model claim, unverified, plan node 9) The partial HashAggregate processes the multiplied row stream from the join; reducing the row count (e.g., by deduplicating the right side or eliminating the join if semantically valid) would shrink aggregation input.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed the LEFT JOIN to promotion since it does not affect the count result and the join key is not unique, eliminating unnecessary row multiplication and broadcast join overhead.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["129752"] returned by the candidate, not by the original
first difference (rewrite only): `["129752"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Added DISTINCT to promotion join key to eliminate row multiplication from non-unique p_item_sk while preserving all store_sales rows with null ss_customer_sk
```sql
SELECT COUNT(*) AS n FROM (SELECT ss.ss_item_sk FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL) ss LEFT JOIN (SELECT DISTINCT p_item_sk FROM TPCDS_DB.promotion WHERE p_item_sk IS NOT NULL) p ON ss.ss_item_sk = p.p_item_sk
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["129752"] returned by the candidate, not by the original
first difference (rewrite only): `["129752"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced left outer join with semi-join using IN subquery to eliminate row multiplication from duplicate promotion.p_item_sk values while preserving NULL-extended semantics for unmatched store_sales rows.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL AND ss.ss_item_sk IN (SELECT p_item_sk FROM TPCDS_DB.promotion WHERE p_item_sk IS NOT NULL)
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["2853"] returned by the candidate, not by the original
first difference (rewrite only): `["2853"]`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
#1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
