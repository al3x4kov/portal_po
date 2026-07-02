# E8 — OpenSpec-хранилище (BE, TDD)

Основание: `docs/architecture/ADR-001-openspec-storage.md`. Данных на диске нет → без миграции.
Строим **от тестов**: сначала тесты по критериям, затем реализация до зелёного.

## T-801 · `@po/core`: доменные типы slug
- `Requirement.id: ULID` → `Requirement.slug: string`; `Link.targetId` → `targetSlug`.
- Новый `domain/slug.ts`: `toSlug(name)` (транслит+кебаб, `[a-z0-9-]`), `dedupe(slug, existing)`.
- **Приёмка:** slug стабилен, только `[a-z0-9-]`, дедуп `-2/-3`; unit S7, S21.

## T-802 · `@po/core`: сериализация OpenSpec
- Переписать `md/markdown.ts`: `serialize/parse` в формат `### Requirement:` + метаданные-
  булиты + тело-описание + `#### Scenario:` + `#### Links` (см. ADR §3).
- **Приёмка:** round-trip без потерь (S1); ParseError на S2–S6; сценарии опциональны.

## T-803 · `@po/core`: граф по slug
- `graph/uniqueness.ts`, `integrity.ts`, `cascade.ts` — перевести с `id` на `slug`.
- **Приёмка:** S8–S16 зелёные (self-link, цикл, один родитель, каскад, висячие ссылки).

## T-804 · server: репозитории
- `FsRequirementRepo`: путь `openspec/specs/{functions|nfr}/<slug>.md`; `loadAll` сканирует
  обе папки; `write/delete` по slug; битые файлы флагятся (не краш).
- `FsProjectRepo`: манифест `openspec/project.md` (frontmatter: name, schemaVersion, createdAt).
- **Приёмка:** интеграционные тесты на временной директории (S4, S23); pathSafe (S21).

## T-805 · server: сервисы и роуты
- `RequirementService`/`LinkService` — оперируют slug; `check-name` возвращает и будущий slug.
- Роуты требований/связей — обновить контракты (slug вместо id), zod-схемы.
- **Приёмка:** существующие server-тесты адаптированы и зелёные; контракт задокументирован.

## Definition of Done E8
- `npm test` зелёный, покрытие новых модулей ≥90%.
- `format:check` + `lint` + `typecheck` — OK.
- `graphify update .` выполнен.
