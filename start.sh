#!/usr/bin/env bash
# Start Darkroom on Linux (also used by start.command on macOS).
# Installs dependencies on first run, then serves http://127.0.0.1:4600.
# Any arguments are passed to `darkroom serve`, e.g. ./start.sh --port 4700
set -euo pipefail

cd "$(dirname "$0")"

# Shells launched from a file manager may not have the user's PATH; look in the
# usual places for Node before giving up.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Darkroom needs Node.js 20.11 or newer: https://nodejs.org" >&2
  exit 1
fi

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)'; then
  echo "Darkroom needs Node.js 20.11 or newer; found $(node --version)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install --omit=dev
fi

exec node src/cli.js serve "$@"
