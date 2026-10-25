// Builds data/sample/{trips,zones}.parquet from the public NYC TLC files. Provenance of the committed sample:
//   trips : yellow_tripdata_2024-01.parquet (https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2024-01.parquet)
//   zones : taxi_zone_lookup.csv            (https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv)
// Licence: NYC TLC open data (https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page). The subset is deterministic: January 2024
// pickups only, every row whose hash(pickup, dropoff, pickup zone, dropoff zone, fare, distance) falls in 1 of N buckets.
// usage: npx tsx scripts/make_sample.ts <yellow.parquet> <taxi_zone_lookup.csv> [keepOneIn=20]
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { SAMPLE_DIR } from "../src/engine/duckdb.js";

const [trips, zones, keep = "20"] = process.argv.slice(2);
if (!trips || !zones) {
  console.error("usage: npx tsx scripts/make_sample.ts <yellow.parquet> <taxi_zone_lookup.csv> [keepOneIn=20]");
  process.exit(2);
}
const n = Math.max(1, Number(keep));
const q = (p: string) => p.replace(/'/g, "''");
mkdirSync(SAMPLE_DIR, { recursive: true });
const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
await c.run(
  `COPY (SELECT * FROM read_parquet('${q(trips)}')
         WHERE tpep_pickup_datetime >= TIMESTAMP '2024-01-01' AND tpep_pickup_datetime < TIMESTAMP '2024-02-01'
           AND hash(tpep_pickup_datetime, tpep_dropoff_datetime, PULocationID, DOLocationID, fare_amount, trip_distance) % ${n} = 0
         ORDER BY tpep_pickup_datetime, tpep_dropoff_datetime, PULocationID, DOLocationID, fare_amount, trip_distance)
   TO '${q(join(SAMPLE_DIR, "trips.parquet"))}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000)`,
);
await c.run(`COPY (SELECT * FROM read_csv('${q(zones)}', header = true) ORDER BY LocationID) TO '${q(join(SAMPLE_DIR, "zones.parquet"))}' (FORMAT parquet, COMPRESSION zstd)`);
for (const f of ["trips.parquet", "zones.parquet"]) {
  const r = await c.runAndReadAll(`SELECT count(*) FROM read_parquet('${q(join(SAMPLE_DIR, f))}')`);
  console.log(`${f}: ${r.getRowsJson()[0]![0]} rows, ${statSync(join(SAMPLE_DIR, f)).size} bytes`);
}
