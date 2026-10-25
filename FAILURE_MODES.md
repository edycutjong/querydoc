# Failure modes

What Query Doctor does when something goes wrong, and where it is still wrong. Every number comes from `evals/results.md`,
`recorded/live/README.md`, `DEMO.md` or `docs/DX-REPORT.md`; those files are generated or dated and are the evidence.

The design rule: **an error may cost a rewrite, never ship a wrong one.** The Verifier (`src/agents/verifier.ts`) is deterministic
code. An ACCEPT needs identical rows, a speedup ≥ 1.2×, a saving above the noise floor and a majority of timed pairs won. Anything
else is a REJECT, a REFUSED, or NOT_VERIFIABLE.

## 1. The model proposes a rewrite that changes the rows (designed for)

| Where seen | What happened | What the system did |
|---|---|---|
| Live, `hero-trap` (duplicated join key) | all 3 attempts changed the rows (two dropped the join, one swapped it for a LEFT SEMI JOIN) although the prompt carried the measured fact that the key is not unique | `REJECT/ROW_DIFF` ×3, case ends `NO_SAFE_REWRITE`, differing row shown |
| Live, `trap-t1` ×2 | LEFT→INNER and similar rewrites | `ROW_DIFF` caught each; no ACCEPT |
| Sample traps T2 / T3 (15 runs from an empty playbook) | first attempt changed rows in 4/5 (T2) and 5/5 (T3); T1 0/5 | every one refused, none shipped |
| Baseline arm (one plain model call, same Verifier, DuckDB, N=15) | 6/15 changed rows, 0/15 identical and faster | without a Verifier those 6 would ship |

Limit: the retry loop does **not** reliably learn from a refusal. On `hero-trap` all three attempts changed the rows. The ledger reuses refusals only for an identical pattern + schema; it is not a general fix.

## 2. The rewrite is correct but not faster (designed for)

`NOT_FASTER/no_gain` (median < 1.05×, or both the ratio gate and the saving floor missed) routes to `Diagnoser.revise` (next hypothesis, new one, or withdraw); `under_gate` (any other missed gate: ratio, saving floor, majority, pairs) is refused. The `no-gain` control ended `NO_SAFE_REWRITE` in 2 of 2 live runs. The honest output
is "no safe, faster rewrite found", not a weak ACCEPT.

## 3. The sample pack has no ACCEPT (known gap)

On the DuckDB sample engine all six recorded examples end `NO_SAFE_REWRITE` or `NOT_VERIFIABLE`: the model avoids the T1 trap, and the
sample hero (an OR-join) is rewritten into a pre-aggregation that double counts rows where pickup = dropoff and is refused. The
accepted rewrite with a speedup is **live Zetaris only** (`recorded/live/hero-r1`, `hero-r2`: 2.1× and 2.15×). A hand-written sample
rewrite benchmarks 16.24× faster with identical rows on DuckDB (`DEMO.md`); the Verifier's verdict on it is machine-dependent and not
recorded, and `output_examples/expected.json` allows `ACCEPTED` for examples 2, 4 and 6.

## 4. The Verifier cannot judge the query (fails closed → `NOT_VERIFIABLE`)

- The original returns different results between runs (pre-check, timing, or crossing the row cap), or uses `rand()`, `now()`,
  `current_*`, `uuid()`, sampling, or `LIMIT`/`TOP` without a total `ORDER BY`.
- A candidate with a top-level `LIMIT` and no depth-0 `ORDER BY`, or whose top-N has a tie at the cut (the tie probe reads k+1 rows).
- The result is vacuous (empty or all-NULL on both sides).
- The query is not a single read-only statement (`src/guard/sqlGuard.ts`): writes, DDL, multiple statements, external paths.

Known gaps in this family:
- The candidate lint checks a **top-level** `LIMIT` only; an inner unordered `LIMIT` is caught later by the timing-run result check.
- Float columns compare to 9 significant digits (`querydoc.config.json` `floatSigDigits`), so a rewrite that differs beyond the ninth
  digit is accepted as equal.
- **False ROW_DIFF (fails safe).** Above the row cap (10,000) the Verifier compares engine-side row hashes. There, `DECIMAL` scale
  (`1.50` vs `1.500000`) and `-0.0` vs `0.0` hash differently, while the transferred-rows path folds them. A rewrite can be refused
  although the values are equal. This costs a missed rewrite, never a wrong one.

## 5. Timing is noisy

Wall-clock on the local platform is noisy: the original's own five runs span 8.4 s on a ~35 s query, and the `SELECT 1` floor
(1.78 s) understates it. The rule needs a majority of alternating pairs to win, not a single run, and the saving must exceed the floor.
The hero's 2.11× (median of 10 per-pair ratios; p50s 32,442.6 → 16,428 ms) is one laptop over local JDBC; it says nothing about a hosted deployment.
NY_TAXI (CSV read in place) is far noisier than TPCDS (Parquet): a `COUNT` there took 200 s, so the live hero uses TPCDS (that 200 s figure is from an unlogged earlier probe).

## 6. External services fail

| Service | Behaviour |
|---|---|
| Zetaris unreachable or the JDBC sidecar dies | `GET /health` answers within 5 s (engine "busy" while a case runs); calls carry a deadline; the case errors with a message, no hang. `SAMPLE_MODE=true` needs none of it |
| Model unreachable / unauthorized | Nightshift unreachable or unauthorized falls back to the committed `llm-cache/` (trace shows `recorded_model`); with `LLM_PROVIDER=nim` a 401 or network failure throws and the case reports the error. A cache miss gives a partial dossier (`llm_unavailable`), never an invented rewrite |
| Model 5xx/429 after the retry cap | the call throws and the case reports the error. Not degraded to the cache (intended) |
| Meterless Nightshift not running | the adapter is built and mock-tested, but **was never run against a live Nightshift runtime** (see §8) |
| Another origin / DNS rebinding against live mode | live mode answers only on `localhost`, an IP literal or `QUERYDOC_ALLOWED_HOSTS` names (403 `UntrustedHost`); cross-origin writes are refused |

## 7. Environment-dependent behaviour

- `example_2`, `example_4` and `example_6` sample verdicts vary by machine (`expected.json` allowed sets). Timing-derived routing (`no_gain` vs `under_gate`) changes the carryover text, which
  can miss the committed `llm-cache`, giving `llm_unavailable` (partial). Both outcomes are in `output_examples/expected.json`'s
  allowed set. Informal local observations (logs not kept): 18/18 canonical runs at `--cpus=2` in one container; in `scripts/clean_clone.sh`, 2 of 3 environments ended partial.
- Live mode needs a JDK 17 on `PATH` (`javac` compiles the sidecar on first use; a JRE alone fails) and the Zetaris JDBC jar. The Docker
  image is keyless sample mode only.
- Informally, one in-container `vitest` run in 12 failed one test (name not captured); 11 reruns, including `--cpus=1`, passed. Possibly flaky,
  likely among the short-timeout sidecar tests.

## 8. What was not demonstrated

- **Meterless Nightshift live.** `src/adapters/nightshift.ts` follows the provider contract and has 16 mock-runtime tests in test/nightshift.test.ts, but no
  runtime was available here. Every recorded trace names `nim` (`sponsor_call.service`) and `llm-cache` entries record only the model: Nemotron 3 Ultra reached **directly** on
  NVIDIA's endpoint, the declared fallback (`LLM_PROVIDER=nim`). We do not claim a Nemotron-through-Nightshift run.
- **Zetaris through MCP.** The local platform has no MCP endpoint; we use JDBC, paste-only intake, SQL-aggregate profiles and `EXPLAIN`
  (`docs/DX-REPORT.md`). None of the four documented MCP tools is used.
- **A designed-by-others query set.** The evals use queries we wrote (hero, trap siblings, controls). N is small (live hero N=2; sample
  traps N=5; baseline N=3 per query) and the shares are not a rate on arbitrary workloads. The baseline arm was not run on Zetaris.
- **CI.** The workflow exists (`.github/workflows/ci.yml`); GitHub Actions did not run on the private repo (account billing), so its
  steps were replayed locally in a clean clone and in the built image. There is no green hosted run to cite.
- **Concurrency.** One case at a time per process; parallel runs would contaminate the timings.
