#!/usr/bin/env bash
# Собирает zip-архив проекта для запуска на другом устройстве.
# По умолчанию кладёт архив на рабочий стол; можно указать каталог первым аргументом.
#   ./pack.sh                 → ~/Desktop/project_po-YYYY-MM-DD.zip
#   ./pack.sh /path/to/dir    → /path/to/dir/project_po-YYYY-MM-DD.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$HOME/Desktop}"
NAME="project_po-$(date +%Y-%m-%d)"
OUT="$OUT_DIR/$NAME.zip"

cd "$ROOT"
rm -f "$OUT"

echo "==> Packing $ROOT"
echo "==> Excluding: node_modules, dist, coverage, .git, Projects, *-out, отчёты"

zip -r -q "$OUT" . \
  -x '*/node_modules/*' 'node_modules/*' \
  -x '*/dist/*' 'dist/*' \
  -x '*/coverage/*' 'coverage/*' \
  -x '*.tsbuildinfo' \
  -x '.git/*' \
  -x 'Projects/*' \
  -x '*/playwright-report/*' 'playwright-report/*' \
  -x '*/test-results/*' 'test-results/*' \
  -x 'graphify-out/*' 'architect-out/*' 'design-out/*' \
  -x '*.DS_Store'

SIZE="$(du -h "$OUT" | cut -f1)"
echo "==> Готово: $OUT ($SIZE)"
echo "==> На новом устройстве: распакуйте и выполните  bash start.sh"
