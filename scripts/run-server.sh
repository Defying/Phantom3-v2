#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
ROOT="/Volumes/Carve/Projects/Phantom3-v2"
cd "$ROOT"
mkdir -p logs data
if [[ ! -d node_modules ]]; then
  npm install
fi
if [[ ! -f apps/web/dist/index.html ]]; then
  npm run build:web
fi
exec npm run start >> logs/server.log 2>&1
