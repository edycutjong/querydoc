# Query Doctor — ACCEPTED

run `run-2026-10-25T09-28-28Z` · engine zetaris · llm nim · 2026-10-25T09:28:28.406Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.item i
WHERE  i.i_current_price > (SELECT AVG(i2.i_current_price) FROM TPCDS_DB.item i2 WHERE i2.i_category = i.i_category)
```

Pre-check: deterministic true, 1 row(s), fingerprint `5fe8e6cd05f1855a` (rows).

## Diagnosis
- pattern: `correlated_subquery` (deterministic detector)
- The correlated subquery forces two full scans of the item table (nodes 1 and 3) and a broadcast hash join (node 10) that evaluates a per-row comparison against the broadcasted category averages, resulting in duplicated I/O and unnecessary join overhead.
- narrative: llm
- **h1** [confirmed] (detector, plan node 14) A correlated subquery is re-evaluated per outer row (or decorrelated into a costly join). (matched: (select avg(i2.i_current_price) from tpcds_db.item i2 where i2.i_category = i.i_category)) — 1.69× median, 3/3 pairs faster
- **h2** [untested] (llm, plan node 1) The outer query scans the entire item table (all rows, all categories) even though only the category and price are needed; a rewrite using a window function could compute the category average in a single pass and avoid this scan entirely.
- **h3** [untested] (llm, plan node 3) The subquery performs a second full scan of the same item table to compute per-category averages, duplicating the I/O of node 1; merging the two scans via a single aggregation or window function would eliminate this redundant read.
- **h4** [untested] (llm, plan node 10) The BroadcastHashJoin joins the full outer scan (node 1) with the broadcasted averages (node 9) on category and then filters on i_current_price > avg; this join processes every row from the outer scan and could be replaced by a simple per-row comparison after a window function, removing the join and broadcast overhead.

## Attempts
### Attempt 1 — ACCEPT
origin rewriter · hypothesis h1 · Replaced correlated subquery with a window function to compute per-category averages in a single scan, eliminating the second table scan and broadcast join.
```sql
SELECT COUNT(1) AS n FROM (SELECT i_current_price, AVG(i_current_price) OVER (PARTITION BY i_category) AS avg_price FROM TPCDS_DB.item WHERE i_category IS NOT NULL) sub WHERE i_current_price IS NOT NULL AND i_current_price > avg_price
```
rows 1 vs 1
timing: median 1.69×, saving 7604.1 ms, 3/3 pairs faster (noise floor 1782.9 ms)

## Verdict: ACCEPTED

