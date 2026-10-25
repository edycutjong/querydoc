# 01 — hero: an unused LEFT JOIN to a tiny table (query shape from trinodb/trino#2939)

**Source:** https://github.com/trinodb/trino/issues/2939 — "select count(1) for left join is slow even when right table is tiny
and no dupes" (open since 2020). The reporter counted rows over a 702M-row table `LEFT JOIN`ed to an 87-row table with a unique
key, filtered on the left side. With the join it took 26 s, without it 6 s. **Those are the issue's numbers (Trino on S3
Parquet), not ours.**

**Re-expressed on the Zetaris sample data** (`TPCDS_DB`, Parquet on `s3a://zetaris-public-dataset`):

| Issue | Here | Why |
|---|---|---|
| 702M-row fact table | `TPCDS_DB.store_sales` | the largest sales fact table on the instance (2,880,404 rows; `inventory`, 11,745,000, is a stock snapshot) |
| 87-row table, unique key, no dupes | `TPCDS_DB.promotion` (300 rows), key `p_promo_sk` (300 distinct) | tiny, unique key |
| `count(1)` with no right-side column used | `COUNT(1)`, nothing read from `promotion` | the join cannot change which rows are counted… |
| filter on the left table | `WHERE ss.ss_customer_sk IS NULL` | …as long as the key is unique |

**Measured here** (run `2026-10-25T07-40-47Z`, `docs/DX-REPORT.md`): original median 35.7 s over 5 runs; in 3 alternating pairs
the join-free form ran 17.9–22.2 s against 33.8–38.3 s, both returning a count of 129,752. The plan keeps the join
(`BroadcastHashJoin LeftOuter BuildRight`).

**Trap sibling** — `01-hero-trap-dupkey.sql`: the same table joined on `p_item_sk`, which repeats (291 distinct values in 300
rows). There the join does multiply rows: 129,776 with it, 129,752 without. Dropping that join is the rewrite that must be
REJECTED.
