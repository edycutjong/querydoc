-- The tempting rewrite: NOT EXISTS is faster and ignores NULLs, so zones with a NULL rate code come back.
SELECT z.LocationID, z.Zone
FROM ops.zones z
WHERE NOT EXISTS (SELECT 1 FROM lake.trips t WHERE t.PULocationID = z.LocationID AND t.RatecodeID = z.LocationID)
ORDER BY z.LocationID
