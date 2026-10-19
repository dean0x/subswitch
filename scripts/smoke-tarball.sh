#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Set up a temp install directory with cleanup on all exit paths
TMPDIR_INSTALL="$(mktemp -d)"
SERVE_PID=""

cleanup() {
  if [ -n "${SERVE_PID}" ]; then
    kill "${SERVE_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMPDIR_INSTALL}"
}
trap cleanup EXIT

# Keep packaging artifacts inside this run's temporary directory too.
cd "${REPO_ROOT}"
TARBALL="$(npm pack --pack-destination "${TMPDIR_INSTALL}" --json 2>/dev/null | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d)[0].filename)")"
TARBALL_ABS="${TMPDIR_INSTALL}/${TARBALL}"

echo "Smoke: installing ${TARBALL} into ${TMPDIR_INSTALL}"
cd "${TMPDIR_INSTALL}"
npm install --save "${TARBALL_ABS}" >/dev/null 2>&1

# Verify the packaged binary resolves and prints version; --version always exits 0.
# (doctor exits non-zero when preflight checks fail — expected in CI where no proxy
# is running and no codex auth is configured.)
VERSION_OUT="$(node_modules/.bin/subswitch --version)"
echo "  subswitch version: ${VERSION_OUT}"

# Read the shipped example as a consumer and validate it through metadata-only discovery.
# This command does not read credentials, contact a provider, or start a native client.
node <<'NODE'
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const packageRoot = dirname(require.resolve("subswitch/package.json"));
const examplePath = join(packageRoot, "subswitch.wave1.example.json");
const example = JSON.parse(readFileSync(examplePath, "utf8"));
assert.equal(example.configVersion, 2);
const discovery = JSON.parse(execFileSync(process.execPath, [
  join(packageRoot, "dist/cli.js"), "models", "--schema-version", "3", "--client", "all", "--json",
], { encoding: "utf8", env: { ...process.env, SUBSWITCH_CONFIG: examplePath } }));
assert.equal(discovery.schemaVersion, 3);
const route = discovery.routes.find(route => route.id === "kimi-work");
assert.ok(route, "the installed example must expose its documented route");
assert.deepEqual(route.targets, [example.routes[route.id].primary, ...example.routes[route.id].fallbacks]);
assert.equal(discovery.providers.find(provider => provider.id === "kimi").compatibility, "live-unverified");
console.log("  packaged Wave1 example: valid config and route discovery (live-unverified)");
NODE

# Ask the OS for an available port; never assume a developer port is unused.
SMOKE_PORT="$(node -e 'const net=require("node:net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
node -e 'const fs=require("node:fs");fs.writeFileSync("subswitch.config.json",JSON.stringify({port:Number(process.argv[1]),providers:{codex:{authFile:process.cwd()+"/unused-auth.json"}}}),{mode:0o600});' "${SMOKE_PORT}"
SUBSWITCH_CONFIG="${TMPDIR_INSTALL}/subswitch.config.json" node_modules/.bin/subswitch serve &
SERVE_PID="$!"

wait_for_health() {
  # Poll up to 50 × 0.2 s = 10 s for the health endpoint
  ATTEMPTS=0
  MAX=50
  until BODY="$(curl --max-time 1 -sf "http://127.0.0.1:${SMOKE_PORT}/__subswitch/health" 2>/dev/null)"; do
    if ! kill -0 "${SERVE_PID}" 2>/dev/null; then
      echo "Smoke: the isolated server exited before becoming healthy" >&2
      exit 1
    fi
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "${ATTEMPTS}" -ge "${MAX}" ]; then
      echo "Smoke: health endpoint did not respond after ${MAX} attempts" >&2
      exit 1
    fi
    sleep 0.2
  done

  if ! kill -0 "${SERVE_PID}" 2>/dev/null; then
    echo "Smoke: the health response was not from the running test server" >&2
    exit 1
  fi

  if ! echo "${BODY}" | grep -q '"name":"subswitch"'; then
    echo "Smoke: unexpected health response: ${BODY}" >&2
    exit 1
  fi

  echo "Smoke: OK — ${BODY}"
}

wait_for_health

# Exercise the installed reverse CLI without touching native user configuration.
kill "${SERVE_PID}"
wait "${SERVE_PID}"
SERVE_PID=""
CODEX_HOME="${TMPDIR_INSTALL}/native-codex" XDG_CONFIG_HOME="${TMPDIR_INSTALL}/user-config" \
  node_modules/.bin/subswitch init --client both --yes --port "${SMOKE_PORT}" >/dev/null
node -e 'const fs=require("node:fs");const p="subswitch.config.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.codexIngress.claude.authFile=process.cwd()+"/unused-claude-auth.json";fs.writeFileSync(p,JSON.stringify(c),{mode:0o600});'
SUBSWITCH_CONFIG="${TMPDIR_INSTALL}/subswitch.config.json" node_modules/.bin/subswitch models --client codex --json > reverse-models.json
node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("reverse-models.json","utf8"));if(!m.enabled||!m.models.some(x=>x.id==="claude-sonnet-5"))process.exit(1);if(!fs.readFileSync("native-codex/config.toml","utf8").includes("openai_base_url"))process.exit(1);'
SUBSWITCH_CONFIG="${TMPDIR_INSTALL}/subswitch.config.json" node_modules/.bin/subswitch serve &
SERVE_PID="$!"
wait_for_health
if ! echo "${BODY}" | grep -q '"translationAvailable":true'; then
  echo "Smoke: packaged reverse routing is not enabled" >&2
  exit 1
fi
