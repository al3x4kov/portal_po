#!/usr/bin/env bash
set -euo pipefail

# Портал требует Node.js >= 20 (см. package.json engines / CLAUDE.md).
if ! command -v node >/dev/null 2>&1; then
  echo "Ошибка: Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Ошибка: требуется Node.js >= 20, найдена $(node --version). Обновите Node.js: https://nodejs.org" >&2
  exit 1
fi

echo "==> Installing dependencies..."
npm install

echo "==> Building (core + server + web)..."
npm run build

echo "==> Starting server on http://127.0.0.1:${PORT:-3000}"
exec node apps/server/dist/main.js
