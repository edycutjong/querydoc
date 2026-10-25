-- LIMIT without ORDER BY: which rows come back is not defined, so nothing can be verified against it.
SELECT VendorID, tpep_pickup_datetime, fare_amount FROM lake.trips LIMIT 20
