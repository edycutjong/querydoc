-- Query Doctor patch for run ui-20261025182908-scdm, approved by analytics engineer
-- verified by execution on zetaris: same rows, 2.11× median
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL;
