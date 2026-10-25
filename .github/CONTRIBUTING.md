# Contributing

Thanks for your interest in improving Query Doctor.

## Getting started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-change`
2. Install dependencies: `npm ci` (Node 22)
3. Copy the env template if you want live runs: `cp .env.example .env` (empty values = keyless sample mode)
4. Run it keyless: `docker build -t querydoc . && docker run --rm -p 8000:8000 -e SAMPLE_MODE=true querydoc`

## Before you open a PR
- `npm run typecheck` and `npm test` pass.
- Add or update tests for any behavior change. Name a regression test after the defect it pins.
- The Verifier decides; a model never does. A change that lets a model output become a verdict will not be merged.
- Keep commits conventional (`feat:`, `fix:`, `docs:`, `chore:`). Releases are cut automatically from them.

## Reporting bugs / requesting features
Open an issue with the templates. For a wrong verdict, include the original SQL, the candidate, and the trace id.
