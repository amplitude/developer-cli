#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(pnpm --dir "$ROOT" cli --)

BASE_URL="${AMP_API_BASE_URL:-https://developer-api.amplitude.com}"
BASE_URL="${BASE_URL%/}"

# A credential must resolve: an active profile (amp auth login), AMP_TOKEN, or
# AMP_PROFILE. Probe via `amp auth token`, which exits non-zero when nothing
# resolves.
if ! "${CLI[@]}" --base-url "$BASE_URL" auth token >/dev/null 2>&1; then
  echo "ERROR: No credential resolves. Run \`amp auth login\` or set AMP_TOKEN before running smoke tests."
  exit 1
fi

echo "==> Smoke: health ($BASE_URL)"
health_status="$(curl -s -o /tmp/amp-health.json -w '%{http_code}' "$BASE_URL/health")"
if [[ "$health_status" != "200" ]]; then
  echo "FAIL: /health returned $health_status"
  cat /tmp/amp-health.json
  exit 1
fi
echo "OK: /health"

echo "==> Smoke: context"
"${CLI[@]}" --base-url "$BASE_URL" context

echo "==> Smoke: projects list"
"${CLI[@]}" --base-url "$BASE_URL" projects list --limit 3

echo "==> Smoke passed (read-only checks). For write checks, run manually with a disposable project."
echo "See docs/cli.md for the full checklist."
