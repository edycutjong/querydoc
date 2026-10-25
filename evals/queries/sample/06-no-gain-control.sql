-- Honesty control: trips per payment type. DuckDB already runs this optimally; an obvious equivalent rewrite measures no gain.
SELECT payment_type, COUNT(*) AS trips
FROM lake.trips
GROUP BY payment_type
ORDER BY payment_type
