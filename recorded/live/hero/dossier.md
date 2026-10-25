# Query Doctor — ACCEPTED

run `run-2026-10-25T09-07-19Z` · engine zetaris · llm nim · 2026-10-25T09:07:19.560Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk
WHERE  ss.ss_customer_sk IS NULL
```

Pre-check: deterministic true, 1 row(s), fingerprint `87cd00c56c06b340` (rows).

## Diagnosis
- pattern: `unused_outer_join` (deterministic detector)
- The query executes an unnecessary LEFT JOIN with the promotion table (broadcast hash join) after filtering store_sales on ss_customer_sk IS NULL, adding broadcast and join overhead without affecting the final count since no promotion columns are used.
- narrative: llm
- **h1** [confirmed] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_promo_sk = p.p_promo_sk) — 2.1× median, 3/3 pairs faster
- **h2** [untested] (llm, plan node 7) The LEFT JOIN is redundant because the query only counts rows from store_sales after the filter and does not reference any columns from promotion; removing the join would eliminate the broadcast hash join and its build-side overhead.
- **h3** [untested] (llm, plan node 6) Broadcasting the promotion table (300 rows) incurs unnecessary network serialization and memory overhead for a join that does not change the result cardinality.
- **h4** [untested] (llm, plan node 4) Scanning the promotion table with a pushed IsNotNull filter wastes I/O and CPU cycles because the join result is not needed for the final aggregation.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Removed the LEFT JOIN to promotion because its primary key is unique and no promotion columns are used, so the join does not affect the row count.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1
timing: median 2.1×, saving 13268 ms, 3/3 pairs faster (noise floor 1782.9 ms)

## Verdict: ACCEPTED

