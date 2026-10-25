# Query Doctor — ACCEPTED

run `ui-20261025182354-dfzd` · engine zetaris · llm nim · 2026-10-25T18:23:54.283Z

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
- Diagnoser's reading (model text, unverified): The query executes a left outer join to the promotion table that does not affect the final count (only store_sales rows are counted), yet it broadcasts the promotion table and performs a hash join, adding unnecessary broadcast and join overhead.
- narrative: llm
- **h1** [confirmed] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_promo_sk = p.p_promo_sk) — 2.13× median, 3/3 pairs faster
- **h2** [untested] (model claim, unverified, plan node 7) The left outer join is semantically redundant because the SELECT only counts rows from store_sales and never references promotion columns; removing the join would eliminate the broadcast hash join entirely.
- **h3** [untested] (model claim, unverified, plan node 6) Broadcasting the promotion table (300 rows) incurs serialization and network distribution cost; if the join were removed, this exchange would be unnecessary.
- **h4** [untested] (model claim, unverified, plan node 9) The partial aggregation processes rows that have passed through the join, increasing row width and hash table size; eliminating the join would reduce aggregation input size and CPU.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed the left outer join to promotion table as its columns are not referenced and the join does not affect row count since p_promo_sk is unique.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1
timing: median 2.13×, saving 13934.6 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-12`, `mem-3`, `mem-2`, `mem-11`, `mem-1`

## Verdict: ACCEPTED
