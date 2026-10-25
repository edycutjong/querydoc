-- A correlated scalar subquery on the small item dimension. First tried as the "no-gain control": it was NOT one — the Rewriter's
-- window-function rewrite was proven same-rows and ~1.7x faster on the instance (run 2026-10-25T09-28-28Z). Kept as a real second
-- ACCEPT on a shape we did not author a rewrite for.
SELECT COUNT(1) AS n
FROM   TPCDS_DB.item i
WHERE  i.i_current_price > (SELECT AVG(i2.i_current_price) FROM TPCDS_DB.item i2 WHERE i2.i_category = i.i_category)
