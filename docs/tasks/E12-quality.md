# E12 — Качество: покрытие, E2E по матрице, README (QA/BE, TDD)

Основание: `docs/architecture/PLAN-dorabotka.md` §A4, §A5; `docs/architecture/test-situations.md`.

## T-1201 · Покрытие серверного слоя (A5, C4)
- `vitest.config.ts`: `coverage.include += apps/server/src/**` (исключить `main.ts`,
  чистые роут-биндинги). Порог server: `lines/statements ≥ 80%` (позже 90%).
- **Приёмка:** метрика показывает server; порог не роняет CI; дыры закрыты интеграц. тестами.

## T-1202 · E2E по матрице ситуаций (исх.10, QA)
- Playwright-сценарии для строк матрицы с типом **E**: S8,S14,S15,S17,S18,S19,S20,S22,S23,
  S24–S30. Использовать/обновить `data-testid` от FE.
- **Приёмка:** все новые сценарии зелёные; трассировки при падении сохраняются.

## T-1203 · README.md в корне (исх.15, E3)
- Для человека «с нуля»: что это, требования (Node ≥20), установка, локальный запуск
  (`npm run build` → `node apps/server/dist/main.js`), dev-режим, тесты/e2e, переменные
  окружения (PORT/HOST/PROJECTS_ROOT), краткое «как пользоваться», секция про MCP.
- **Приёмка:** новый пользователь по README поднимает приложение локально без доп. вопросов.

## DoD (общий для доработки)
- Зелёный CI: `format:check` → `lint` → `typecheck` → unit(+coverage) → e2e.
- `docs/overview/project.md` дополнен: xlsx-экспорт (только выгрузка), slug вместо id,
  единый слой видимости строк.
