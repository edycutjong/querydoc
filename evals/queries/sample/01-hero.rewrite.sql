SELECT Borough, COUNT(*) AS touches
FROM (
  SELECT z.Borough FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.PULocationID
  UNION ALL
  SELECT z.Borough FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.DOLocationID AND t.DOLocationID <> t.PULocationID
) GROUP BY Borough ORDER BY Borough
