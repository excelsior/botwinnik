#!/usr/bin/env bash
# Starts `npm run dev` in the background, for a dev container's
# postStartCommand. The server restarts by itself whenever the code or
# config.ini changes, and its output goes to dev-server.log.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci
nohup setsid npm run dev > dev-server.log 2>&1 < /dev/null &
echo "Botwinnik is starting with hot reload; its output goes to dev-server.log."
