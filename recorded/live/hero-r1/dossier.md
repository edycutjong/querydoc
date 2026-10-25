# Query Doctor — ACCEPTED

run `live-hero-r1` · engine zetaris · llm nim · 2026-10-25T12:58:44.862Z

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
- Diagnoser's reading (model text, unverified): The query scans store_sales for rows where ss_customer_sk IS NULL and then performs a left outer join to promotion, but the join is unnecessary because promotion.p_promo_sk is unique and no columns from promotion are used in the output; the join adds broadcast, hash build, and probe overhead on top of the scan.
- narrative: llm
- **h1** [confirmed] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_promo_sk = p.p_promo_sk) — 2.1× median, 3/3 pairs faster
- **h2** [untested] (model claim, unverified, plan node 7) The BroadcastHashJoin (left outer) is redundant: the right side (promotion) has a unique key (p_promo_sk) and no promotion columns are referenced, so removing the join would eliminate the broadcast exchange, hash table build, and probe without changing the result.
- **h3** [untested] (model claim, unverified, plan node 1) The Parquet scan of store_sales with pushed IsNull predicate still reads all row groups containing null ss_customer_sk; if the fraction of nulls is high, this scan dominates runtime, but the join adds additional per-row processing cost.
- **h4** [untested] (model claim, unverified, plan node 2) The Filter node simply passes through rows after the scan's predicate pushdown; its cost is negligible compared to the scan and join.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed unnecessary LEFT JOIN to promotion since no promotion columns are referenced and p_promo_sk is unique, so the join cannot change the row count.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1
timing: median 2.1×, saving 16943.9 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-12`, `mem-3`, `mem-2`, `mem-11`, `mem-1`

## Verdict: ACCEPTED
