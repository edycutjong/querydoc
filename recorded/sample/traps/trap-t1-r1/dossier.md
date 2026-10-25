# Query Doctor — NO_SAFE_REWRITE

run `trap-t1-r1` · engine duckdb · llm nim · 2026-10-25T12:16:27.807Z

## Original
```sql
SELECT z.LocationID, z.Borough, z.Zone, COUNT(t.PULocationID) AS cash_trips
FROM ops.zones z
LEFT JOIN lake.trips t ON t.PULocationID = z.LocationID AND t.payment_type = 2
GROUP BY z.LocationID, z.Borough, z.Zone
ORDER BY z.LocationID
```

Pre-check: deterministic true, 265 row(s), fingerprint `43cbbebc33d85c2b` (rows).

> Sample mode: DuckDB on the committed NYC TLC subset. A different optimiser from Zetaris — speedups here say nothing about Zetaris.

## Diagnosis
- pattern: `outer_join_predicate` (deterministic detector)
- Diagnoser's reading (model text, unverified): The HASH_JOIN (node 8) processes ~99K filtered trips rows with a per-row CAST(PULocationID AS BIGINT) against only 265 zones rows, making the join build/probe and the cast the dominant CPU cost.
- narrative: llm
- **h1** [untested] (detector, plan node 8) A filter on the joined side sits in the ON clause of a LEFT JOIN; the join dominates the cost. (matched: left join lake.trips t on … and t.payment_type = 2)
- **h2** [untested] (model claim, unverified, plan node 8) The CAST(PULocationID AS BIGINT) in the join condition forces a per-row conversion on the 99K-row trips side; if PULocationID is already a compatible integer type, removing the cast would eliminate this CPU overhead.
- **h3** [untested] (model claim, unverified, plan node 8) The RIGHT HASH_JOIN builds a hash table on the 99K filtered trips rows instead of the 265-row zones table; reversing the build/probe order (e.g., by rewriting as LEFT JOIN or hinting) would reduce hash memory and probe time.
- **h4** [untested] (model claim, unverified, plan node 5) The SEQ_SCAN on trips reads all row groups despite only needing PULocationID and payment_type; if the table is partitioned or has zone maps on payment_type, predicate pushdown could skip irrelevant row groups and reduce I/O.

## Verdict: NO_SAFE_REWRITE — upstream
(upstream message) NIM timed out after 60000 ms (reasoning off)
