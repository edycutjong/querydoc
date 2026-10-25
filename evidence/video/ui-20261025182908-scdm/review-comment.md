### Query Doctor — suggested rewrite (approved by analytics engineer)

# Query Doctor — ACCEPTED

run `ui-20261025182908-scdm` · engine zetaris · llm nim · 2026-10-25T18:29:08.084Z

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
- Diagnoser's reading (model text, unverified): The query executes an unnecessary LEFT JOIN to the promotion table (300 rows) when only counting store_sales rows where ss_customer_sk IS NULL; the join adds broadcast and hash-join overhead without affecting the count.
- narrative: llm
- **h1** [confirmed] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_promo_sk = p.p_promo_sk) — 2.11× median, 3/3 pairs faster
- **h2** [untested] (model claim, unverified, plan node 7) The LEFT JOIN is semantically redundant for COUNT(*) because no columns from promotion are selected and a LEFT JOIN cannot reduce the left-side row count; removing the join would eliminate the broadcast and join entirely.
- **h3** [untested] (model claim, unverified, plan node 6) Broadcasting the 300-row promotion table is wasted work if the join is removed; the broadcast exchange and build-side preparation would disappear.
- **h4** [untested] (model claim, unverified, plan node 1) The scan of store_sales with pushed IsNull(ss_customer_sk) filter is the remaining dominant cost; its runtime depends on the selectivity of ss_customer_sk IS NULL and the table size.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed the unnecessary LEFT JOIN to promotion table since its columns are not referenced in the SELECT and the join cannot affect the row count when counting rows from the left table with a LEFT JOIN.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1
timing: median 2.11×, saving 17597.5 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-12`, `mem-3`, `mem-2`, `mem-11`, `mem-1`

## Verdict: ACCEPTED
