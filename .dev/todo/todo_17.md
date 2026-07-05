Задачи:
0) graphify update . → ориентация по графу; определить, какие экраны/файлы затрагиваются.
0) Разложить задачи на 2 трека:
   - НЕЗАВИСИМЫЕ (можно параллельно сразу) — простые UI/логика без новых контрактов;
   - СКВОЗНЫЕ (по конвейеру с гейтами) — меняют содержание/контракт/несколько слоёв.
1) <краткая задача 1 ...>
2) <краткая задача 2 ...>

Правила выполнения (для всех задач):
- Каждый субагент ОБЯЗАН сначала graphify query/explain, потом читать/менять файлы; после — graphify update.
- Владение файлами: backend-агент = @po/core + apps/server (+их тесты); frontend-агент = apps/web; QA = e2e/. Контракт — один в @po/core (Zod), фронт его только потребляет.
- TDD на бэке; тесты обновлять по ходу (unit/component/integration/e2e).
- Финал каждой задачи: прогон format:check→lint→typecheck→unit(coverage)→e2e; фиксы; обновить docs/RELEASE_NOTES.md; graphify update; коммит.
- В коммит — ТОЛЬКО файлы задачи; не тащить чужие untracked-артефакты (demo-out/, extract-out/ и т.п.). Пуш — только по явной просьбе.

---
2. Канонический конвейер (цепочка ролей и артефактов)

Развилка на входе: сначала решаем, простая задача или сквозная.

A. Независимая задача (быстрый трек):
Оркестратор пишет мелкую спеку (.dev/todo/taskN.md)
      → frontend-ts-senior (или backend-node-senior) реализует + свои тесты
      → playwright-qa-senior E2E
      → финал (тесты/notes/commit)
Запускается сразу, параллельно с design-фазой сквозной задачи.

B. Сквозная задача (полный конвейер с гейтами):
senior-po (skill)      → спек содержания/поведения + бриф дизайнеру   [.dev/design/*-spec.md]
   ↓
designer (skill)       → HTML+Tailwind макет + примеры                [design-out/*]  (проверить скриншотом)
   ↓
senior-po (валидация)  → принять макет, закрыть открытые вопросы (решения PO)
   ↓
architect (skill)      → декомпозиция + ЕДИНЫЙ API-контракт           [architect-out/*/BACKLOG.md]
   ↓  (Волна 1) backend-node-senior — контракт @po/core + сервер, TDD  (владелец контракта)
   ↓  (Волна 2) frontend-ts-senior — UI + проброс контракта
   ↓  (Волна 3) playwright-qa-senior — матрица сценариев + скриншоты
   ↓
senior-po (проверка реализации) → соответствие спеку/решениям
   ↓
финал: полный прогон тестов → фиксы → RELEASE_NOTES → graphify update → commit

Ключ к порядку волн: frontend заблокирован backend'ом, потому что контракт (типы/Zod) рождается в @po/core, а его пишет и владеет backend-агент. Поэтому backend → frontend → QA идут строго последовательно; параллелится только независимый трек A.

---
3. Инварианты, которые делают это повторяемым

- Один контракт, один владелец. Общие типы/валидация — в @po/core; меняет их только backend-агент → нет конфликтов файлов между агентами.
- Гейты = точки, где решает PO. После дизайна и после реализации — явная валидация PO (закрытие открытых вопросов, а не «молча достроили»).
- Артефакт на каждой фазе (спек → макет → BACKLOG → код → тесты → release notes). Каждый — вход для следующего агента; агент читает вход, а не переизобретает.
- graphify как обязательный первый шаг в каждом промпте субагенту (иначе он грепает вслепую).
- Границы коммита явно: только файлы задачи; architect-out//design-out/ в этом репо gitignore’ятся (эфемерные), их markdown-первоисточники дублируются в .dev/.
- Фиксация вне-скоупа. Найденные попутно баги/несоответствия — не молчим:  чиним отдельной задачей

---

Постановка:

Список переработанных экранов, которые нужно воплотить в жизнь:
file:///Users/aleksandr/Documents/project_po/new_design/screens/start.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/new-project.html - Вместо "Будет создан каталог:" писать "Будет создан проект:"
file:///Users/aleksandr/Documents/project_po/new_design/screens/import.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/open-existing.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/confirm-dialog.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/desc-panel.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/requirement-modal.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/link-modal.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/picker-modal.html - только текстовки в падеже не "она моя", а "оно мое" - учитывай это везде на обновленных экранах
file:///Users/aleksandr/Documents/project_po/new_design/screens/export-tasks-modal.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/ai-page.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/chat-widget.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/ai-import-modal.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/dashboard.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/graph-view.html
file:///Users/aleksandr/Documents/project_po/new_design/screens/main-tree.html - в целом выглядит красиво, но только текстовки в падеже не "она моя", а "оно мое" - учитывай это везде на обновленных ) и мне категорически не нравится, что с таким подходом имеено текста в колонки будет мало влезать, я бы растягивал во всю ширину всю область, что ниже "Портал поставщика

/Users/po/Projects/Портал_поставщика
· копируется по клику" и думаю шрифт чуть мульче