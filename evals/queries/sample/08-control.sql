-- Control (a different pattern from 01/02): trips with an above-average fare for their pickup zone, per borough.
SELECT z.Borough, COUNT(*) AS above_average_trips
FROM lake.trips t
JOIN ops.zones z ON z.LocationID = t.PULocationID
WHERE t.fare_amount > (SELECT AVG(t2.fare_amount) FROM lake.trips t2 WHERE t2.PULocationID = t.PULocationID)
GROUP BY z.Borough
ORDER BY z.Borough
