#!/usr/bin/env bash
# Clean-clone tests: clone the repo as committed (nothing untracked comes along), build the image from the clone, and run the shipped
# examples 1-3 under three environments. Needs docker and curl; no credentials anywhere.
#   1  no .env at all, only -e SAMPLE_MODE=true          (the Hub self-test)
#   2  an unedited `cp .env.example .env`, passed with --env-file (every value empty)
#   3  a fully populated .env (placeholder credentials for every variable) — the examples carry sample_mode, so they stay on DuckDB
# Usage: scripts/clean_clone.sh [repo-path-or-url]   (default: the repository this script lives in)
set -euo pipefail
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
WORK="$(mktemp -d)"
IMG="querydoc-cleanclone"
trap 'docker rm -f qd-cc >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
git clone --quiet --no-hardlinks "$SRC" "$WORK/repo"
cd "$WORK/repo"
echo "cloned $(git rev-parse --short HEAD) into $WORK/repo"
docker build -q -t "$IMG" . >/dev/null
echo "image built"

run_scenario() { # name, docker args...
  local name="$1"; shift
  docker rm -f qd-cc >/dev/null 2>&1 || true
  docker run -d --name qd-cc -p 8099:8000 "$@" "$IMG" >/dev/null
  for _ in $(seq 1 60); do curl -sf localhost:8099/health >/dev/null && break; sleep 1; done
  curl -sf localhost:8099/health >/dev/null || { docker logs qd-cc | tail -30; echo "FAIL $name: no /health"; exit 1; }
  for n in 1 2 3; do
    curl -sf -X POST localhost:8099/run -H 'Content-Type: application/json' -d @input_examples/example_$n.json -o "$WORK/out$n.json"
    echo -n "[$name] "; node scripts/assert-verdict.mjs "$WORK/out$n.json" "example_$n"
  done
  curl -sf -H 'Accept: text/html' localhost:8099/ | grep -q 'Query Doctor' || { echo "FAIL $name: UI not served"; exit 1; }
  curl -sf localhost:8099/web/app.js >/dev/null || { echo "FAIL $name: web/app.js missing"; exit 1; }
  echo "[$name] UI served"
}

run_scenario "1 no .env, SAMPLE_MODE=true" -e SAMPLE_MODE=true
cp .env.example .env
run_scenario "2 unedited .env.example" --env-file .env
cat > .env <<'EOF'
ZETARIS_MODE=local-jdbc
ZETARIS_JDBC_URL=jdbc:zetaris://127.0.0.1:1/placeholder
ZETARIS_JDBC_JAR=/nonexistent/zetaris-jdbc.jar
ZETARIS_JDBC_DRIVER_CLASS=com.example.Driver
ZETARIS_USER=placeholder
ZETARIS_PASSWORD=placeholder
METERLESS_BASE_URL=http://127.0.0.1:1/v1
METERLESS_RUNTIME_TOKEN=placeholder-token-not-real
METERLESS_MODEL=meterless/deep
LLM_PROVIDER=
NVIDIA_API_KEY=
SAMPLE_MODE=
EOF
run_scenario "3 fully populated .env" --env-file .env
echo "CLEAN CLONE: ALL PASS ($(git rev-parse --short HEAD))"
