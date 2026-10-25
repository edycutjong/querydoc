# Query Doctor — ACCEPTED

run `live-correlated-avg-r1` · engine zetaris · llm nim · 2026-10-25T12:51:20.841Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.item i
WHERE  i.i_current_price > (SELECT AVG(i2.i_current_price) FROM TPCDS_DB.item i2 WHERE i2.i_category = i.i_category)
```

Pre-check: deterministic true, 1 row(s), fingerprint `5fe8e6cd05f1855a` (rows).

## Diagnosis
- pattern: `correlated_subquery` (deterministic detector)
- Diagnoser's reading (model text, unverified): The correlated subquery forces two full scans of the item table (nodes 1 and 3) and a broadcast hash join (node 10) that processes every outer row against the per-category averages, resulting in doubled I/O and a join that could be avoided with a single-pass aggregation.
- narrative: llm
- **h1** [falsified] (detector, plan node 14) A correlated subquery is re-evaluated per outer row (or decorrelated into a costly join). (matched: (select avg(i2.i_current_price) from tpcds_db.item i2 where i2.i_category = i.i_category))
- **h2** [confirmed] (model claim, unverified, plan node 1) Scanning the entire item table twice (nodes 1 and 3) doubles the I/O from S3; a single scan with a window function or a precomputed aggregate would halve the data read. — 1.44× median, 3/3 pairs faster
- **h3** [untested] (model claim, unverified, plan node 10) The broadcast hash join compares each outer row's price to the category average; if the outer table is large, the per-row comparison and hash lookup add CPU overhead that could be eliminated by pushing the filter into a single aggregated scan.
- **h4** [untested] (model claim, unverified, plan node 5) The partial aggregate (node 5) and subsequent shuffle (node 6) to compute category averages may cause unnecessary data movement; a map-side aggregation or a partition-by-category scan could avoid the shuffle.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Decorrelated the subquery by precomputing per-category averages in a CTE and joining once, eliminating the correlated subquery and second full scan.
```sql
WITH cat_avg AS (SELECT i_category, AVG(i_current_price) AS avg_price FROM TPCDS_DB.item WHERE i_category IS NOT NULL AND i_current_price IS NOT NULL GROUP BY i_category) SELECT COUNT(1) AS n FROM TPCDS_DB.item i JOIN cat_avg ca ON i.i_category = ca.i_category WHERE i.i_current_price > ca.avg_price AND i.i_current_price IS NOT NULL AND i.i_category IS NOT NULL
```
rows 1 vs 1 · median 1.1×, saving 1498.9 ms, 2/3 pairs faster — missed: ratio, floor
timing: median 1.1×, saving 1498.9 ms, 2/3 pairs faster (noise floor 1782.9 ms)

### Attempt 2 — ACCEPT
origin rewriter · hypothesis h2 · Rewriter's note (model text): Replaced correlated subquery with single scan using window function to compute per-category averages, eliminating second table scan and broadcast join.
```sql
SELECT COUNT(1) AS n FROM (SELECT i_current_price, AVG(i_current_price) OVER (PARTITION BY i_category) AS avg_price FROM TPCDS_DB.item WHERE i_current_price IS NOT NULL AND i_category IS NOT NULL) t WHERE i_current_price > avg_price
```
rows 1 vs 1
timing: median 1.44×, saving 3874.6 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-10`

## Verdict: ACCEPTED
