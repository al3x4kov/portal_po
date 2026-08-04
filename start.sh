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

echo "==> Installing dependencies (npm install)..."
if [ -d node_modules ]; then
  echo "    node_modules уже есть — npm доустановит только недостающее (обычно быстро)."
else
  echo "    Первый запуск: npm скачает ~0.5 ГБ зависимостей. Это может занять несколько минут —"
  echo "    ниже каждые 10 секунд будет строка прогресса, тишина в остальное время нормальна."
fi

# npm install молчит между warning'ами, поэтому рядом работает «пульс»: раз в 10 с
# печатаем, сколько уже скачано (размер node_modules и число пакетов верхнего уровня).
npm install --no-audit --no-fund &
NPM_PID=$!
(
  while kill -0 "$NPM_PID" 2>/dev/null; do
    sleep 10
    if [ -d node_modules ] && kill -0 "$NPM_PID" 2>/dev/null; then
      SIZE="$(du -sh node_modules 2>/dev/null | awk '{print $1}')"
      PKGS="$(find node_modules -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')"
      echo "    ... установка идёт: ~${SIZE:-0B} в node_modules, пакетов: ${PKGS}"
    fi
  done
) &
HEARTBEAT_PID=$!
NPM_STATUS=0
wait "$NPM_PID" || NPM_STATUS=$?
kill "$HEARTBEAT_PID" 2>/dev/null || true
wait "$HEARTBEAT_PID" 2>/dev/null || true
if [ "$NPM_STATUS" -ne 0 ]; then
  echo "Ошибка: npm install завершился с кодом $NPM_STATUS (см. вывод выше)." >&2
  exit "$NPM_STATUS"
fi
echo "    Зависимости установлены."

echo "==> Building (core + server + web)..."
npm run build

echo "==> Starting server on http://127.0.0.1:${PORT:-3000}"
exec node apps/server/dist/main.js
