# data/

| Path | What |
|---|---|
| `sample/trips.parquet` | NYC TLC yellow-cab trips, January 2024 pickups, a deterministic 1-in-6 subset: 495,833 rows (7.6 MiB) |
| `sample/zones.parquet` | TLC `taxi_zone_lookup.csv` as Parquet |
| `hmem/` | git-ignored, created at run time (the committed sample seed is `fixtures/hmem-seed/sample/`) |
| `runs/` | per-run output, git-ignored |

**Source.** `yellow_tripdata_2024-01.parquet` and `taxi_zone_lookup.csv` from the NYC Taxi & Limousine Commission trip record data
(https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page). Public open data, published for reuse by the NYC TLC.

**Subset rule.** Rows are kept when a hash of (pickup time, dropoff time, pickup zone, dropoff zone, fare, distance) falls in 1 of N
buckets (N = 6), so the subset is reproducible.

**Regenerate.** Download the two source files, then `npx tsx scripts/make_sample.ts <yellow.parquet> <taxi_zone_lookup.csv> 6`.

**Registered in Zetaris?** No. The sample engine is DuckDB and never touches Zetaris. The live path queries the Zetaris platform's own
`TPCDS_DB` and `NY_TAXI` sources (both from `s3a://zetaris-public-dataset`; table list and counts in `docs/zetaris-tables.json`).
No data from the event's Zetaris instance is committed here.
