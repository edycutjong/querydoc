# Query Doctor — ACCEPTED

run `live-hero-r2` · engine zetaris · llm nim · 2026-10-25T13:03:09.628Z

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
- Diagnoser's reading (model text, unverified): The left outer join to the tiny promotion table (300 rows) is unnecessary for the COUNT(*) result, yet the plan broadcasts promotion and performs a hash join for every qualifying store_sales row, adding CPU and memory overhead.
- narrative: llm
- **h1** [confirmed] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_promo_sk = p.p_promo_sk) — 2.15× median, 3/3 pairs faster
- **h2** [untested] (model claim, unverified, plan node 7) The BroadcastHashJoin builds a hash table from the 300-row promotion table and probes it for each row from store_sales that passes the ss_customer_sk IS NULL filter; removing the join would eliminate this work without changing the result.
- **h3** [untested] (model claim, unverified, plan node 1) The Parquet scan pushes the IsNull(ss_customer_sk) filter, but if the column statistics do not effectively prune row groups (e.g., nulls are widespread), the scan may still read a large fraction of the store_sales table.
- **h4** [untested] (model claim, unverified, plan node 10) The Exchange (SinglePartition) collects partial counts from all partitions to a single node for final aggregation; this shuffle is small but could be avoided if the join were removed and the count pushed down further.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed the unnecessary LEFT JOIN to promotion table since no promotion columns are referenced in SELECT and the join cannot affect the row count of a LEFT JOIN when only counting rows from the left table.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1
timing: median 2.15×, saving 19437.6 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-12`, `mem-3`, `mem-2`, `mem-11`, `mem-1`

## Verdict: ACCEPTED
