# Sample-pack trap repeats

Recorded 2026-10-25T12:11:01.800Z · model nvidia/nemotron-3-ultra-550b-a55b · each run from an empty playbook, cache writes off, 5 runs per trap.

| Trap | Runs | First attempt refused for a row difference (k of N) | First attempts |
|---|---|---|---|
| T1 | 5 | 0 of 5 | none; REJECT/NOT_FASTER/under_gate; REJECT/NOT_FASTER/under_gate; REJECT/NOT_FASTER/under_gate; REJECT/NOT_FASTER/under_gate |
| T2 | 5 | 4 of 5 | REJECT/ROW_DIFF; REJECT/ROW_DIFF; REJECT/NOT_FASTER/no_gain; REJECT/ROW_DIFF; REJECT/ROW_DIFF |
| T3 | 5 | 5 of 5 | REJECT/ROW_DIFF; REJECT/ROW_DIFF; REJECT/ROW_DIFF; REJECT/ROW_DIFF; REJECT/ROW_DIFF |
