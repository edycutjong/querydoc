-- The tempting rewrite: UNION ALL skips the deduplication; the two branches really do overlap and repeat rows.
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE trip_distance > 30
UNION ALL
SELECT PULocationID, payment_type, passenger_count FROM lake.trips WHERE fare_amount > 100
