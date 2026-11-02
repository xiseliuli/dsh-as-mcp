#!/usr/bin/env bash
#
# Release checklist for dsh-as-mcp, in the order the rounds actually run it.
#
# Every step here is one this project has gotten wrong at least once: a typecheck
# skipped after a client-half edit, a tarball packed before a rebuild, a reinstall
# at the same path that pnpm treated as already-installed, an install with no
# rollback note, a packaged `tools/` directory that should stay maintainer-only.
# The script exists so the checklist is executable instead of remembered.
#
# Usage:
#   tools/release.sh                     # typecheck, tests, build, pack to /tmp
#   tools/release.sh --live URL          # ...then run tools/live-checks.mjs there
#   tools/release.sh --live URL --with-subagent
#   tools/release.sh --install           # ...then pack into ~/.dsh/packages and
#                                        # install into the desktop profile, with a
#                                        # rollback directory alongside
#   tools/release.sh --skip-tests        # for a docs-only round
#
# Exit code is non-zero on the first failing step. Nothing is installed unless
# --install is passed.
set -euo pipefail

cd "$(dirname "$0")/.."

LIVE_URL=""
LIVE_ARGS=()
INSTALL=0
SKIP_TESTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)
      LIVE_URL="${2:?--live needs a URL}"
      shift 2
      ;;
    --with-subagent)
      LIVE_ARGS+=(--with-subagent)
      shift
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

VERSION="$(node -e 'console.log(require("./package.json").version)')"
TARBALL="/tmp/dsh-as-mcp-${VERSION}.tgz"
DESKTOP="$HOME/.dsh/profiles/desktop"
RUNTIME="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"

step "version ${VERSION}"

step "typecheck (host + client)"
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.client.json --noEmit

if [[ $SKIP_TESTS -eq 0 ]]; then
  step "tests"
  # The proxy variables make Node's fetch route a loopback request through a
  # corporate proxy on some machines; every test suite runs without them.
  env -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
    ./node_modules/.bin/vitest run
else
  step "tests (skipped)"
fi

step "build (server + client bundles)"
./node_modules/.bin/tsdown
node scripts/build-client.mjs

step "pack"
rm -f "$TARBALL"
npm pack --pack-destination /tmp >/dev/null
[[ -f "$TARBALL" ]] || fail "npm pack did not produce $TARBALL"

# The published package is a runtime artifact: `tools/` is maintainer-only, and a
# shipped `src/` or `tests/` directory is a mistake this check has caught before.
if tar tzf "$TARBALL" | grep -qE '^package/(tools|src|tests)/'; then
  tar tzf "$TARBALL" | grep -E '^package/(tools|src|tests)/' | head -5
  fail "the package contains maintainer-only directories"
fi

if [[ -n "$LIVE_URL" ]]; then
  step "live checks against $LIVE_URL"
  env -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
    node tools/live-checks.mjs --url "$LIVE_URL" "${LIVE_ARGS[@]}"
fi

if [[ $INSTALL -eq 1 ]]; then
  [[ -d "$DESKTOP" ]] || fail "no desktop profile at $DESKTOP"
  [[ -x "$RUNTIME/cli/bin/dsh" ]] || fail "no DSH runtime at $RUNTIME"

  INSTALLED="$(DESKTOP="$DESKTOP" node -e 'try { console.log(require(process.env.DESKTOP + "/node_modules/dsh-as-mcp/package.json").version) } catch { console.log("none") }' 2>/dev/null || true)"
  if [[ "$INSTALLED" == "$VERSION" ]]; then
    # Reinstalling the same file path is a no-op in pnpm: it reports success and
    # leaves the previous contents linked. A rebuild needs a new version path or a
    # removed dependency, so refuse instead of pretending it installed.
    fail "the desktop profile already has ${VERSION}; bump the version before installing again"
  fi

  step "install into the desktop profile"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$HOME/.dsh/backups/dsh-as-mcp-${VERSION}-pre-restart-${STAMP}"
  mkdir -p "$BACKUP"
  cp "$DESKTOP"/package.json "$DESKTOP"/pnpm-lock.yaml "$DESKTOP"/cordis.patch.yml "$BACKUP"/
  cat > "$BACKUP/ROLLBACK.md" <<EOF
# Rollback: desktop profile before restarting onto dsh-as-mcp ${VERSION}

Current dependency: \`~/.dsh/packages/dsh-as-mcp-${VERSION}.tgz\`.
Previous version: ${INSTALLED}.

  cd ~/.dsh/profiles/desktop
  DSH_HOME=\$DSH_HOME "$RUNTIME/cli/bin/dsh" plugin --profile desktop add ~/.dsh/packages/dsh-as-mcp-${INSTALLED}.tgz
EOF
  echo "rollback directory: $BACKUP"

  npm pack --pack-destination "$HOME/.dsh/packages" >/dev/null
  # `plugin add` runs the pnpm DSH pins; DSH_HOME must be set for the harness CLI.
  DSH_HOME="${DSH_HOME:-$HOME/.dsh}" "$RUNTIME/cli/bin/dsh" plugin --profile desktop add \
    "$HOME/.dsh/packages/dsh-as-mcp-${VERSION}.tgz"
  DESKTOP="$DESKTOP" VERSION="$VERSION" node -e '
    const installed = require(process.env.DESKTOP + "/node_modules/dsh-as-mcp/package.json").version
    if (installed !== process.env.VERSION) {
      console.error(`desktop profile has ${installed}, expected ${process.env.VERSION}`)
      process.exit(1)
    }
    console.log(`installed in the desktop profile: ${installed} (takes effect after a DSH restart)`)
  '
fi

printf '\n\033[32mrelease checks passed\033[0m — %s\n' "$TARBALL"
