# Query Doctor — NO_SAFE_REWRITE

run `live-trap-t1-r2` · engine zetaris · llm nim · 2026-10-25T13:23:13.633Z

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
- Diagnoser's reading (model text, unverified): The query spends most time scanning and filtering store_sales (node 1) for ss_customer_sk IS NULL; the left table after filtering is still large enough to dominate runtime, while the broadcast join (node 8) and aggregations (nodes 10, 12) are trivial because the right side (promotion) is only ~300 rows.
- narrative: llm
- **h1** [falsified] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join tpcds_db.promotion p on … and p.p_channel_tv = ')
- **h2** [untested] (model claim, unverified, plan node 1) The IsNull(ss_customer_sk) predicate is not selective enough, causing a near-full scan of the store_sales fact table; adding a partition filter or indexing on ss_customer_sk would reduce I/O.
- **h3** [unproven] (model claim, unverified, plan node 8) The left outer broadcast join forces a hash lookup for every qualifying store_sales row even though the build side is tiny; converting to an inner join (if semantically valid) or pre-aggregating the left side before the join could cut CPU.
- **h4** [untested] (model claim, unverified, plan node 11) The single-partition exchange between the two hash aggregates (nodes 10 → 12) serializes the final reduction; since the result is just two scalars, a local aggregation on the driver after collecting partials would avoid the shuffle.

## Attempts
### Attempt 1 — REJECT (NOT_FASTER/no_gain)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Pre-filtered promotion table in a subquery to keep only TV='N' rows before the left join, reducing broadcast size and join probe work while preserving original ON-clause semantics.
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN (SELECT p_promo_sk FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N') p ON ss.ss_promo_sk = p.p_promo_sk WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · median 0.83×, saving -5793.9 ms, 1/3 pairs faster — missed: ratio, floor, majority
timing: median 0.83×, saving -5793.9 ms, 1/3 pairs faster (noise floor 1782.9 ms)

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Added IS NOT NULL filter on ss_promo_sk to skip hash table probes for null join keys and reduce probe volume.
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk AND p.p_channel_tv = 'N' WHERE ss.ss_customer_sk IS NULL AND ss.ss_promo_sk IS NOT NULL
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["63812","65122"] returned by the candidate, not by the original
first difference (rewrite only): `["63812","65122"]`

### Attempt 3 — REJECT (NOT_FASTER/under_gate)
origin rewriter · hypothesis h3 · Rewriter's note (model text): Pre-filtered promotion table in a subquery to keep only TV='N' rows before the left join, reducing broadcast size and join probe work while preserving original ON-clause semantics.
```sql
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN (SELECT p_promo_sk FROM TPCDS_DB.promotion WHERE p_channel_tv = 'N') p ON ss.ss_promo_sk = p.p_promo_sk WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · median 1.08×, saving 2024.4 ms, 3/3 pairs faster — missed: ratio
timing: median 1.08×, saving 2024.4 ms, 3/3 pairs faster (noise floor 1782.9 ms)

Playbook entries used: `mem-8`, `mem-18`, `mem-9`, `mem-20`, `mem-21`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT NOT_FASTER, #2 REJECT ROW_DIFF, #3 REJECT NOT_FASTER
