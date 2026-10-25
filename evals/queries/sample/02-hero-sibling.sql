-- Same pattern, different measure: revenue touching each borough. Committed before it was ever run (playbook A/B protocol).
SELECT z.Borough, ROUND(SUM(t.total_amount), 2) AS revenue
FROM lake.trips t
JOIN ops.zones z ON z.LocationID = t.PULocationID OR z.LocationID = t.DOLocationID
GROUP BY z.Borough
ORDER BY z.Borough
