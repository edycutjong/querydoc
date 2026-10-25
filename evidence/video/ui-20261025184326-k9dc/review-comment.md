### Query Doctor — suggested rewrite (approved by analytics engineer)

# Query Doctor — ACCEPTED

run `ui-20261025184326-k9dc` · engine zetaris · llm nim · 2026-10-25T18:43:26.184Z

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
- Diagnoser's reading (model text, unverified): The query performs an unnecessary LEFT JOIN with the promotion table when only counting filtered rows from store_sales; the join does not affect the result since no promotion columns are used and the LEFT JOIN preserves all left-side rows.
- narrative: llm
- **h1** [confirmed] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_promo_sk = p.p_promo_sk) — 2.32× median, 3/3 pairs faster
- **h2** [untested] (model claim, unverified, plan node 7) The BroadcastHashJoin (LeftOuter) is semantically redundant: the query only counts rows from store_sales after the ss_customer_sk IS NULL filter, and the LEFT JOIN cannot change that count because it preserves all left rows and no promotion columns are referenced. Eliminating the join would remove the promotion scan, broadcast, and join entirely.
- **h3** [untested] (model claim, unverified, plan node 4) Scanning the promotion table (node 4) and applying the IsNotNull filter (node 5) is wasted I/O because the join result is never used; the 300-row promotion table is read and broadcast (node 6) for no reason.
- **h4** [untested] (model claim, unverified, plan node 1) The store_sales scan (node 1) with pushed IsNull filter is the only necessary operation; all downstream nodes (2-11) are overhead introduced by the unused join and the distributed aggregation framework.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed unnecessary LEFT JOIN to promotion table since its columns are not referenced and the join cannot affect the row count of the filtered store_sales rows.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1
timing: median 2.32×, saving 21490.5 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-12`, `mem-3`, `mem-2`, `mem-23`, `mem-11`, `mem-1`

## Verdict: ACCEPTED
