# output_examples

What the code produced for each `input_examples/example_N.json` in a **keyless replay of the recorded `llm-cache/`** after the canonical pass (`npm run record`). Nothing in the pipeline or the server ever reads these files; `test/replay-parity.test.ts` re-runs the inputs offline and compares against `expected.json` (the canonical verdict and the explicit set of verdicts a timing-derived replay may end in).
