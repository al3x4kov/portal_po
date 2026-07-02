# project_po — разработка завершена (MVP)

Дата: 2026-06-29 · Путь: /Users/aleksandr/Documents/project_po (git, ветка master)

## Что построено
Локальный веб-портал «Управление требованиями для PO»: Node.js + TypeScript монорепо.
- **packages/core** — доменное ядро: типы, Zod, MD-сериализация, валидации, граф связей (циклы/родитель/каскад).
- **apps/server** — Fastify API: проекты, требования, связи, импорт/экспорт zip/tar.gz; ФС-инфра (pathSafe, atomicWrite); раздаёт SPA.
- **apps/web** — React+Vite+TS+Tailwind: все экраны и модалки по макетам docs/design/, дерево требований, токены light/dark.
- **e2e/** — Playwright E2E.
- **.github/workflows/ci.yml** — CI gate: lint → typecheck → unit → e2e + порог покрытия core ≥90%.

## Статус качества (проверено независимо на master)
- lint + format:check: OK
- typecheck: OK
- unit/component: **131 passed**
- Playwright E2E: **23 passed** (happy-path + краевые случаи по DoD)
- coverage packages/core: ~98.5% строк
- дефектов продукта не найдено

## Сделано волнами (3 агента по ролям)
E1 фундамент → E2 ядро → E3-E5 бэкенд → E6 фронтенд → E7 E2E+CI. Каждая волна
проверялась независимо (typecheck/lint/test) перед следующей.

## Как запустить локально
- Сборка: `npm run build`
- Сервер (раздаёт SPA + API): `node apps/server/dist/main.js` (env PORT, PROJECTS_ROOT)
- Dev фронта: `npm run dev -w @po/web` (proxy /api → сервер)
- Тесты: `npm test` (unit), `npm run e2e` (Playwright)

## Не входило в MVP / открытые вопросы
- WCAG-клавиатура (NFR-7), производительность ~1000 req (NFR-3), поповер описания (FR-7.4),
  варианты удаления узла с потомками (выбран «запрет») — см. project.md §7.
- web-бандл тянет gray-matter через barrel core (~475 КБ) — можно оптимизировать subpath-экспортом.
