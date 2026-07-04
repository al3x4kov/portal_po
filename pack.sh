#!/usr/bin/env bash
# Собирает zip-архив проекта для запуска на другом устройстве.
# По умолчанию кладёт архив на рабочий стол; можно указать каталог первым аргументом.
#   ./pack.sh                 → ~/Desktop/project_po-YYYY-MM-DD.zip
#   ./pack.sh /path/to/dir    → /path/to/dir/project_po-YYYY-MM-DD.zip
#
# В архив ВКЛЮЧЁН пример проекта Projects/Jenkins — при первом старте портала
# пользователь сразу видит один описанный проект. Остальное содержимое Projects/
# (личные проекты, .ai-config.json с API-ключом, .locks) НИКОГДА не пакуется.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$HOME/Desktop}"
NAME="project_po-$(date +%Y-%m-%d)"
OUT="$OUT_DIR/$NAME.zip"

cd "$ROOT"
rm -f "$OUT"

echo "==> Packing $ROOT"
echo "==> Excluding: node_modules, dist, coverage, .git, Projects (кроме Jenkins), артефакты сессий/отчёты"

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
  -x '.dev/*' '.claude/*' '.playwright-mcp/*' \
  -x 'demo-out/*' 'extract-out/*' \
  -x 'e2e/demo/*' 'playwright.demo.config.ts' \
  -x 'mockserver-ca.pem' '*.log' \
  -x '*.DS_Store'

# Пример проекта для первого запуска: ТОЛЬКО Projects/Jenkins.
# Секреты (.ai-config.json) и служебные каталоги (.locks) сюда не попадают,
# т.к. добавляется только поддерево Jenkins; .DS_Store отфильтрован явно.
zip -r -q "$OUT" Projects/Jenkins -x '*.DS_Store'

if unzip -l "$OUT" | grep -q 'ai-config'; then
  echo "ОШИБКА: в архив попал .ai-config.json (секрет). Архив удалён." >&2
  rm -f "$OUT"
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "==> Готово: $OUT ($SIZE)"
echo "==> В архиве пример проекта: Projects/Jenkins"
echo "==> На новом устройстве: распакуйте и выполните  bash start.sh  (нужен Node.js ≥ 20)"
