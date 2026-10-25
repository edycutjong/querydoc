-- Query shape from trinodb/trino#2939, re-expressed on TPCDS_DB (see 01-hero.md).
-- An unused LEFT JOIN to a tiny table on its unique key: no column of `promotion` is read, the filter is on the left.
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk
WHERE  ss.ss_customer_sk IS NULL
