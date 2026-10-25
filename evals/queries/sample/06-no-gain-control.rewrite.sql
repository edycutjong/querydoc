SELECT payment_type, COUNT(*) AS trips
FROM (SELECT payment_type FROM lake.trips) q
GROUP BY payment_type
ORDER BY payment_type
