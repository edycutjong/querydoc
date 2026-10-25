-- Honesty control: a 300-row dimension filtered on one column. There is nothing to win; any rewrite sits inside the timing noise
-- floor, so the Verifier must refuse to call it faster. Expected: NO_SAFE_REWRITE (not faster).
SELECT COUNT(1) AS n
FROM   TPCDS_DB.promotion p
WHERE  p.p_channel_tv = 'N'
