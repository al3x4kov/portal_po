#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing dependencies..."
npm install

echo "==> Building (core + server + web)..."
npm run build

echo "==> Starting server on http://127.0.0.1:${PORT:-3000}"
exec node apps/server/dist/main.js
