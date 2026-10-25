# Query Doctor — NO_SAFE_REWRITE

run `live-hero-trap-r1` · engine zetaris · llm nim · 2026-10-25T12:56:21.793Z

## Original
```sql
SELECT COUNT(1) AS n
FROM   TPCDS_DB.store_sales ss
LEFT JOIN TPCDS_DB.promotion p ON ss.ss_item_sk = p.p_item_sk
WHERE  ss.ss_customer_sk IS NULL
```

Pre-check: deterministic true, 1 row(s), fingerprint `e51f9da70057feb6` (rows).

## Diagnosis
- pattern: `unused_outer_join` (deterministic detector)
- Diagnoser's reading (model text, unverified): The query performs a completely unnecessary LEFT JOIN to the promotion table - the join preserves all store_sales rows (since it's LEFT) and no promotion columns are referenced in SELECT or WHERE, so the join cannot change the COUNT(1) result. Time is spent scanning promotion (300 rows), broadcasting it, and executing the join.
- narrative: llm
- **h1** [unproven] (detector, plan node 7) A LEFT JOIN whose columns are never read still costs a join; if the joined key is unique it cannot change the rows and can be removed. (matched: left join tpcds_db.promotion p on ss.ss_item_sk = p.p_item_sk)
- **h2** [unproven] (model claim, unverified, plan node 7) The BroadcastHashJoin LeftOuter is semantically redundant: removing it (and the promotion scan/broadcast) would produce identical results while eliminating the join, broadcast, and promotion I/O entirely.
- **h3** [untested] (model claim, unverified, plan node 4) Scanning the promotion table (node 4) with pushed IsNotNull filter is wasted I/O because the join result is never used; the scan could be removed if the optimizer recognized the unused outer join.
- **h4** [untested] (model claim, unverified, plan node 6) The BroadcastExchange (node 6) serializes and broadcasts the promotion relation to all executors, consuming network and memory for a relation that does not affect the final count.

## Attempts
### Attempt 1 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Removed unnecessary LEFT JOIN to promotion table since no promotion columns are referenced and the join cannot affect the row count of a LEFT JOIN with COUNT(1).
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["129752"] returned by the candidate, not by the original
first difference (rewrite only): `["129752"]`

### Attempt 2 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h1 · Rewriter's note (model text): Replace LEFT OUTER JOIN with LEFT SEMI JOIN to preserve row-count semantics while avoiding broadcast hash join overhead by eliminating duplicate matches from non-unique p_item_sk.
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT SEMI JOIN TPCDS_DB.promotion p ON ss.ss_item_sk = p.p_item_sk WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · rows differ (1 vs 1 rows); first differing row ["2853"] returned by the candidate, not by the original
first difference (rewrite only): `["2853"]`

### Attempt 3 — REJECT (ROW_DIFF)
origin rewriter · hypothesis h2 · Rewriter's note (model text): Removed the redundant LEFT JOIN to promotion table since no promotion columns are used and the join cannot affect COUNT(1) result
```sql
SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss WHERE ss.ss_customer_sk IS NULL
```
rows 1 vs 1 · refusal reused from ledger mem-11 — same original-result fingerprint; the candidate was not executed (unused_outer_join: rewrite changed the rows (ROW_DIFF). Removed unnecessary LEFT JOIN to promotion table since no promotion columns are referenced and the join cannot affect the row count of a LEFT JO)
first difference (rewrite only): `["129752"]`

Playbook entries used: `mem-3`, `mem-2`, `mem-1`, `mem-11`, `mem-12`

## Verdict: NO_SAFE_REWRITE — attempts_exhausted
(attempt summary / upstream message) #1 REJECT ROW_DIFF, #2 REJECT ROW_DIFF, #3 REJECT ROW_DIFF
