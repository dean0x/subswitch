#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Pack the tarball from the repo root
cd "${REPO_ROOT}"
TARBALL="$(npm pack --json 2>/dev/null | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d)[0].filename)")"
TARBALL_ABS="${REPO_ROOT}/${TARBALL}"

# Set up a temp install directory with cleanup on all exit paths
TMPDIR_INSTALL="$(mktemp -d)"
SERVE_PID=""

cleanup() {
  if [ -n "${SERVE_PID}" ]; then
    kill "${SERVE_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMPDIR_INSTALL}"
  rm -f "${TARBALL_ABS}"
}
trap cleanup EXIT

echo "Smoke: installing ${TARBALL} into ${TMPDIR_INSTALL}"
cd "${TMPDIR_INSTALL}"
npm install --save "${TARBALL_ABS}" >/dev/null 2>&1

# doctor exits 0 even when TLS probes fail — CI-safe
node_modules/.bin/subswitch doctor

# Start serve on isolated port 4941 to avoid dev-instance clash
echo '{"port": 4941}' > subswitch.config.json
SUBSWITCH_CONFIG="${TMPDIR_INSTALL}/subswitch.config.json" node_modules/.bin/subswitch serve &
SERVE_PID="$!"

# Poll up to 50 × 0.2 s = 10 s for the health endpoint
ATTEMPTS=0
MAX=50
until BODY="$(curl -sf "http://127.0.0.1:4941/__subswitch/health" 2>/dev/null)"; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "${ATTEMPTS}" -ge "${MAX}" ]; then
    echo "Smoke: health endpoint did not respond after ${MAX} attempts" >&2
    exit 1
  fi
  sleep 0.2
done

if ! echo "${BODY}" | grep -q '"name":"subswitch"'; then
  echo "Smoke: unexpected health response: ${BODY}" >&2
  exit 1
fi

echo "Smoke: OK — ${BODY}"
