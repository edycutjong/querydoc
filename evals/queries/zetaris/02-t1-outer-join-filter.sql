-- T1 (seed-data §Trap queries) on TPCDS_DB: the promotion filter sits in the ON clause of a LEFT JOIN, so unmatched store_sales rows
-- are kept with a NULL promotion. Moving `p_channel_tv = 'N'` to WHERE turns it into an inner join and drops those rows. Whether
-- the Rewriter reaches for that is the model's call, not scripted.
SELECT COUNT(p.p_promo_sk) AS promo_rows, COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk AND p.p_channel_tv = 'N'
WHERE  ss.ss_customer_sk IS NULL
