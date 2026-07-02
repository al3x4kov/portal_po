# Эпик E1 — Фундамент проекта

Ценность: рабочее монорепо со строгим тулингом и CI, чтобы все последующие задачи
шли с тестами и проверками «из коробки». Трассировка: NFR-1, NFR-8, DoD#6.

---

## T-101 · Настроить монорепо и тулинг · [M] · параллельно: да
- **Что:** инициализировать монорепо (workspaces) по структуре из `arch.md`:
  `packages/core`, `apps/server`, `apps/web`, `e2e/`.
- **Где:** корень репозитория, `package.json`, `tsconfig.base.json`.
- **Критерии приёмки:**
  - [ ] Workspaces настроены, `tsc -b` собирает все пакеты.
  - [ ] TypeScript в режиме `strict`.
  - [ ] ESLint + Prettier подключены, `npm run lint` и `npm run format:check` проходят.
  - [ ] Скрипты `build`, `lint`, `typecheck`, `test` в корне.
- **Тесты:** smoke — `tsc -b` и `lint` зелёные в CI.
- **Зависимости:** blocked by: — · blocks: всё остальное.
- **Трассировка:** NFR-1.

## T-102 · Настроить Vitest (core + server) · [S] · параллельно: да
- **Что:** конфигурация Vitest для unit/integration; пример теста; покрытие.
- **Где:** `vitest.config.ts` в `packages/core` и `apps/server`.
- **Критерии приёмки:**
  - [ ] `npm run test` запускает Vitest во всех пакетах.
  - [ ] Отчёт о покрытии (`--coverage`) включён.
  - [ ] Демонстрационный проходящий тест в `packages/core`.
- **Тесты:** сам инструмент тестирования (мета-задача).
- **Зависимости:** blocked by: — (можно параллельно с T-101) · blocks: E2…E5.
- **Трассировка:** NFR-8.

## T-103 · Настроить Playwright и CI-скелет · [M] · параллельно: да
- **Что:** Playwright + GitHub Actions пайплайн `lint → typecheck → unit → e2e`.
- **Где:** `playwright.config.ts`, `e2e/`, `.github/workflows/ci.yml`.
- **Критерии приёмки:**
  - [ ] Playwright поднимает server+web (webServer config) и гоняет демо-тест.
  - [ ] CI запускает все стадии и падает при любой красной.
  - [ ] Артефакты Playwright (trace/screenshots) сохраняются при падении.
- **Тесты:** демо E2E «страница открывается».
- **Зависимости:** blocked by: T-101 · blocks: E7.
- **Трассировка:** NFR-8, DoD#6.
