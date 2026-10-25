-- The same join elimination applied to the trap sibling: here p_item_sk repeats, the LEFT JOIN multiplies rows, and dropping it
-- changes the count. The Verifier must REJECT this one (ROW_DIFF) without timing it.
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
WHERE  ss.ss_customer_sk IS NULL
