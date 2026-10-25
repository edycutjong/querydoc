-- Hand-written rewrite of 01-hero (join elimination): promotion is joined on its unique key p_promo_sk and no column of it is
-- read, so the LEFT JOIN cannot change which rows are counted. The Verifier must ACCEPT this one. The agents write their own.
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
WHERE  ss.ss_customer_sk IS NULL
