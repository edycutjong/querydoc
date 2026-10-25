# Security

Query Doctor is a read-only analysis tool. It never applies a rewrite; it reports one.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security → Report a vulnerability), or email the maintainer listed on the
GitHub profile. Please do not file a public issue for an exploitable bug. Expect a first reply within a few days.

## What the code enforces

- **Read-only SQL.** `src/guard/sqlGuard.ts` accepts one statement and refuses writes, DDL, multiple statements and external paths,
  for the original and every candidate. The DuckDB sample engine also locks external access.
- **Credentials** are read from the environment or `~/.config/querydoc/*.env`, never from the tree. `.env.example` has empty values.
  CI runs gitleaks on every push.
- **Live-mode API.** Binds `127.0.0.1` by default; answers only on `localhost`, an IP literal or `QUERYDOC_ALLOWED_HOSTS` names
  (DNS-rebinding guard); cross-origin writes are refused. The Docker image sets `HOST=0.0.0.0` and runs sample mode.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities at the last release commit.

## Known limits

See `FAILURE_MODES.md`. The API has no authentication: run live mode on a trusted machine only.
