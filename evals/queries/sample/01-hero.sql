-- Hero (sample pack): how many trips touched each borough, as pickup OR dropoff. The OR inside the JOIN condition defeats the
-- hash join; two equi-joins are the textbook rewrite (the second branch excludes pickup = dropoff so a trip is counted once per zone).
SELECT z.Borough, COUNT(*) AS touches
FROM lake.trips t
JOIN ops.zones z ON z.LocationID = t.PULocationID OR z.LocationID = t.DOLocationID
GROUP BY z.Borough
ORDER BY z.Borough
