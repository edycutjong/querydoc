# Query Doctor — NOT_VERIFIABLE

run `canon-example_5` · engine duckdb · llm none · 2026-10-25T12:16:27.803Z

## Original
```sql
SELECT VendorID, tpep_pickup_datetime, fare_amount FROM lake.trips LIMIT 20
```

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Verdict: NOT_VERIFIABLE
(upstream message) LIMIT without a top-level ORDER BY
