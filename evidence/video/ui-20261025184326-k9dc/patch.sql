-- Query Doctor patch for run ui-20261025184326-k9dc, approved by analytics engineer
-- verified by execution on zetaris: same rows, 2.32× median
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL;
