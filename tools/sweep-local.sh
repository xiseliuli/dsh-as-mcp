#!/usr/bin/env bash
# Boot a throwaway harness with dsh-as-mcp 0.52.80 and run live-checks + acceptance.
# Throwaway DSH_HOME: the checks create real sessions, and they should not land in the
# operator's store. Credentials are copied (0600) so real model turns work.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || node -e 'console.log(require("'"$REPO"'/package.json").version)')"
TARBALL="/tmp/dsh-as-mcp-${VERSION}.tgz"
RUNTIME="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
WORK="$(mktemp -d /tmp/live-sweep-XXXXXX)"
export ACCEPTANCE_HOME="$WORK/dsh-home"
export DSH_HOME="$ACCEPTANCE_HOME"
PROFILE="sweep-$$"

mkdir -p "$ACCEPTANCE_HOME"
if [[ -f "$HOME/.dsh/.credentials.yaml" ]]; then
  cp "$HOME/.dsh/.credentials.yaml" "$ACCEPTANCE_HOME/.credentials.yaml"
  chmod 600 "$ACCEPTANCE_HOME/.credentials.yaml"
fi

read -r PLUGIN_PORT WEB_PORT < <(node -e '
  const net = require("node:net")
  const listen = () => new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
  ;(async () => {
    const first = await listen()
    const second = await listen()
    console.log(first.address().port, second.address().port)
    first.close(); second.close()
  })()
')

echo "work=$WORK plugin=$PLUGIN_PORT web=$WEB_PORT version=$VERSION"
"$RUNTIME/cli/bin/dsh" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
"$RUNTIME/cli/bin/dsh" plugin --profile "$PROFILE" add "$TARBALL" >/dev/null

cat > "$ACCEPTANCE_HOME/profiles/$PROFILE/cordis.patch.yml" <<EOF
- id: dsh-as-mcp
  config:
    http: { enabled: true, host: 127.0.0.1, port: ${PLUGIN_PORT}, path: /mcp, mountOnWebServer: false }
    tools: { workspace: true, session: true, files: true, shell: true, agentTools: true, usage: true }
    agentTools: { allow: [], deny: [] }
    session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 900000, scope: all }
    limits: { maxReadBytes: 1048576, shellTimeoutMs: 120000, agentToolTimeoutMs: 120000 }
    approval: { policy: inherit }

# The full sweep runs with the session-search index open; the stock web composition
# sets openAt: never, which is the deployment-level opt-in this checks against.
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: first-search
EOF

# The checks drive real agent turns, including a turn they cancel while its tool call is in
# flight. The stock policy is approval 'ask' — correct for a human at the app, but in a
# headless throwaway profile it parks the turn on a question no one answers, and the
# cancellation then has nothing to stop (measured on 0.52.80: the check settled at the 300 s
# prompt timeout with turn.aborted: false). `DSH_PERMISSION_MODE=danger-full-access` is the
# composition's own switch for a consistent sandbox+approval pair; patching only `approval`
# instead makes the permission service reject the mismatched preset at boot.
(cd "$WORK" && DSH_PERMISSION_MODE=danger-full-access "$RUNTIME/cli/bin/dsh" --profile "$PROFILE" --no-open --port "$WEB_PORT" >"$WORK/harness.log" 2>&1) &
HARNESS_PID=$!
echo "$HARNESS_PID" > "$WORK/pid"

for _ in $(seq 1 90); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${PLUGIN_PORT}") 2>/dev/null; then exec 3>&- 3<&-; break; fi
  sleep 1
done
if ! (exec 3<>"/dev/tcp/127.0.0.1/${PLUGIN_PORT}") 2>/dev/null; then
  echo "harness did not start"; tail -20 "$WORK/harness.log"; exit 1
fi
exec 3>&- 3<&-

URL="http://127.0.0.1:${PLUGIN_PORT}/mcp"
echo "$URL" > "$WORK/url"

echo "=== live-checks --with-model --with-subagent ==="
set +e
env -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
  node "$REPO/tools/live-checks.mjs" --url "$URL" --with-model --with-subagent >"$WORK/live-checks.log" 2>&1
LIVE_STATUS=$?
echo "live-checks exit=$LIVE_STATUS"
tail -4 "$WORK/live-checks.log"

echo "=== acceptance (exercise) ==="
env -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
  node "$REPO/scripts/exercise.mjs" --url "$URL" --dir "$WORK/files" >"$WORK/acceptance.log" 2>&1
EX_STATUS=$?
echo "acceptance exit=$EX_STATUS"
tail -4 "$WORK/acceptance.log"
set -e

kill "$HARNESS_PID" 2>/dev/null || true
wait "$HARNESS_PID" 2>/dev/null || true

echo "logs: $WORK/live-checks.log $WORK/acceptance.log"
if [[ $LIVE_STATUS -ne 0 || $EX_STATUS -ne 0 ]]; then
  echo "FAILED (live=$LIVE_STATUS acceptance=$EX_STATUS)"
  exit 1
fi
echo "SWEEP PASSED"
