# E9 — Экспорт в Excel (.xlsx) (BE + FE, TDD)

Основание: `docs/architecture/PLAN-dorabotka.md` §A2. Библиотека `exceljs`.

## T-901 · server: `ExcelExportService`
- Чистая функция `buildWorkbook(reqs: Requirement[]): Workbook` → буфер `.xlsx`.
- Лист `Requirements`: `slug,type,name,criticality,implemented,target,description,scenarios`.
- Лист `Links`: `from,type,to` — только прямые стороны пар (PARENT_OF/RELATES_TO/DEPENDS_ON).
- **Приёмка (unit, S18):** 2 листа, корректные заголовки, число строк = число требований/связей.

## T-902 · server: эндпоинт
- `GET /api/projects/:id/export.xlsx` → правильные `Content-Type`/`Content-Disposition`.
- **Приёмка:** интеграционный тест — 200, тело начинается с сигнатуры zip `PK\x03\x04`.

## T-903 · FE: кнопка в меню «Экспорт»
- Добавить «Excel (.xlsx)» рядом с zip/tar.gz (FR-5.3). Скачивание файла.
- **Приёмка:** компонентный тест на пункт меню; E2E S18 (скачивание, непустой файл).

## DoD
- Импорт xlsx НЕ поддерживается (только выгрузка) — согласовано (A6#6).
- Тесты зелёные, покрытие сервиса ≥90%.
