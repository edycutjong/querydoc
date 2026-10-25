-- T3: zones that never received a drop-off whose rate code equals the zone id, per pickup zone. RatecodeID has NULLs, so NOT IN
-- over a subquery that returns a NULL yields no row for that zone.
SELECT z.LocationID, z.Zone
FROM ops.zones z
WHERE z.LocationID NOT IN (SELECT t.RatecodeID FROM lake.trips t WHERE t.PULocationID = z.LocationID)
ORDER BY z.LocationID
