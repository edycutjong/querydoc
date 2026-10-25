-- Trap sibling of 01-hero: the same tiny table, joined on p_item_sk, which is NOT unique in TPCDS_DB.promotion
-- (300 rows, 291 distinct p_item_sk — docs/DX-REPORT.md). Dropping this join changes the count; the rewrite must be refused.
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_item_sk = p.p_item_sk
WHERE  ss.ss_customer_sk IS NULL
