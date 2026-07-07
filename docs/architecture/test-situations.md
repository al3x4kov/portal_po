# Матрица ситуаций «корректно / некорректно» (A4, исх. 10)

Каждая строка → автотест. Тип: **U** unit (`@po/core`/server), **E** e2e (Playwright).
Владелец: BE (unit/интеграция), QA (e2e).

Колонка **«Тест (файл::имя)»** `[ДОБАВЛЕНО — BA-7]` даёт трассировку «ситуация → автотест».
Для **S10–S13, S16** явный **S-тег** проставлен в имени соответствующего теста (QA-волна,
BA-7), поэтому клетка ссылается прямо на него. Строки трассируются на шаги product use cases
§10 `project.md` (PUC-3/6/8/9/10).

## Хранилище / парсинг OpenSpec
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S1 | serialize→parse требования (round-trip) | без потерь (все поля, сценарии, links) | U | `core/test/markdown.test.ts::round-trips without loss` (PUC-6) |
| S2 | Файл с `implemented:false` без target | ParseError (правило 2.4) | U | `core/test/markdown.test.ts::S2 implemented=false without target → ParseError` (PUC-6) |
| S3 | Файл с `implemented:true` + target | ParseError (target запрещён) | U | `core/test/markdown.test.ts::S3 implemented=true WITH target → ParseError` (PUC-6) |
| S4 | Битый заголовок (нет `### Requirement:`) | ParseError, не краш; файл помечен broken | U | `core/test/markdown.test.ts::S4 missing "### Requirement:" header → ParseError` |
| S5 | Описание >5000 симв | ошибка валидации | U | `core/test/markdown.test.ts::S5 description longer than 5000 chars → ParseError` (PUC-6) |
| S6 | Сценарий без WHEN/THEN | сохраняется, но флаг «неполный сценарий» (warn) | U | `core/test/markdown.test.ts::S6 an incomplete scenario … is saved but flagged` (PUC-6) |

## Slug / уникальность
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S7 | Два ФТ с именами, дающими один slug | второй получает `-2` | U | `core/test/slug.test.ts::appends -2 for the first collision` (PUC-6) |
| S8 | Дубль имени в одном типе (case-insensitive) | отклонить (uniqueness) | U/E | `core/test/uniqueness.test.ts::rejects a case-insensitive duplicate` · `e2e/tests/edge-cases.spec.ts::S8 duplicate requirement name … blocked` (PUC-6) |
| S9 | Одинаковое имя в разных типах (FUNCTION/NFR) | разрешить | U | `core/test/uniqueness.test.ts::allows the same name under a different type` (PUC-6) |
| S10 | Переименование `name` | slug/файл не меняются, связи целы | U | `core/test/uniqueness.test.ts::S10 allows a self-rename (own id excluded; slug/file/links stay intact)` (PUC-6) |

## Целостность связей
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S11 | Self-link | отклонить | U | `core/test/integrity.test.ts::S11 rejects a self link` · `apps/mcp/test/tools.test.ts::S11 link_requirements self-link → SELF_LINK error` (PUC-8) |
| S12 | Цикл PARENT_OF/CHILD_OF | отклонить | U | `core/test/integrity.test.ts::S12 rejects a hierarchy cycle and reports the path` (PUC-8) |
| S13 | Второй родитель | отклонить (один родитель) | U | `core/test/integrity.test.ts::S13 rejects adding a second, different parent` (PUC-8) |
| S14 | Удаление требования | каскадная чистка обратных ссылок | U/E | `core/test/cascade.test.ts::removes the deleted requirement and strips all back-references` · `e2e/tests/edge-cases.spec.ts::S14 deleting a requirement cleans up reverse links` (PUC-9) |
| S15 | Удаление узла с потомками | запрет + подсказка (FR-9.3) | E | `core/test/cascade.test.ts::rejects deleting a node that still has children (FR-9.3)` · `e2e/tests/edge-cases.spec.ts::S15 deleting a node with children is blocked with a hint` (PUC-9) |
| S16 | Связь на несуществующий slug | отклонить (нет висячих) | U | `apps/server/test/links.test.ts::S16 rejects a link to a nonexistent target (no dangling references, 404)` (PUC-8) |

## Импорт / экспорт
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S17 | Экспорт zip → импорт | round-trip идентичен | E | `e2e/tests/import-export.spec.ts::S17 round-trip preserves requirements and links (.zip)` · `apps/server/test/archive.test.ts::round-trips export(zip)…` (PUC-3/10) |
| S18 | Экспорт `.xlsx` | валидный xlsx (PK-заголовок), лист Requirements/Links непустые | U/E | `apps/server/test/excel-export.test.ts::produces a valid xlsx buffer (PK signature)` · `e2e/tests/xlsx-export.spec.ts::S18 Excel export downloads a valid non-empty .xlsx` (PUC-10) |
| S19 | Импорт xlsx | не поддержан (ясная ошибка/скрыт в UI) | E | `e2e/tests/edge-cases.spec.ts::S19 importing an .xlsx is not supported (rejected client-side)` (PUC-3) |
| S20 | Экспорт tar.gz | round-trip | E | `e2e/tests/import-export.spec.ts::S20 round-trip preserves requirements and links (.targz)` · `apps/server/test/archive.test.ts::round-trips export(targz)…` (PUC-3/10) |
| S35 | Импорт архива с циклом `PARENT_OF` (файлы валидны, граф нет) | отклонить с перечнем нарушений; каталог не создан, temp пуст (SA-3/FR-3.4) | U | `core/test/importIntegrity.test.ts::reports a PARENT_OF/CHILD_OF cycle with its path` · `apps/server/test/archive-integrity.test.ts::S35 rejects a PARENT_OF hierarchy cycle` (PUC-3) |
| S36 | Импорт архива с висячим `targetSlug` (ссылка в никуда) | отклонить с перечнем нарушений; каталог не создан, temp пуст (SA-3) | U | `core/test/importIntegrity.test.ts::reports a dangling targetSlug (link into nowhere)` · `apps/server/test/archive-integrity.test.ts::S36 rejects a dangling targetSlug (link into nowhere)` (PUC-3) |
| S37 | Импорт архива со вторым родителем | отклонить (один родитель) с перечнем нарушений; каталог не создан (SA-3) | U | `core/test/importIntegrity.test.ts::reports a requirement with a second parent` · `apps/server/test/archive-integrity.test.ts::S37 rejects a requirement with a second parent` (PUC-3) |
| S38 | Импорт архива с self-link | отклонить с перечнем нарушений; каталог не создан (SA-3) | U | `core/test/importIntegrity.test.ts::reports a self-link` · `apps/server/test/archive-integrity.test.ts::S38 rejects a self-link` (PUC-3) |

## ФС-безопасность
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S21 | slug/имя проекта с `../` или сепаратором | отклонить (pathSafe, NFR-5) | U | `core/test/slug.test.ts::strips path separators and traversal (S21)` · `apps/server/test/pathSafe.test.ts::rejects ".." traversal` |
| S22 | Имя проекта с запрещёнными символами ОС | отклонить | U/E | `e2e/tests/edge-cases.spec.ts::S22 project name with OS-forbidden characters is rejected` |
| S23 | Отсутствует `Projects/` | автосоздаётся | U/E | `e2e/tests/edge-cases.spec.ts::S23 Projects/ is recreated automatically when missing` (PUC-3) |

## UI: видимость строк (единый слой — коллизия A6#4)
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S24 | «Раскрыть все» (по умолчанию) | все узлы видны | E | `e2e/tests/tree-visibility.spec.ts::S24 "Раскрыть все" (default) shows every node` |
| S25 | «Скрыть зависимости» | связанные функции сворачиваются | E | `e2e/tests/tree-visibility.spec.ts::S25 "Скрыть зависимости" collapses linked children` |
| S26 | Поиск по названию, совпадение на потомке | видны потомок + все его предки | E | `e2e/tests/tree-visibility.spec.ts::S26 search matching a child reveals the child and its ancestors` |
| S27 | Фильтр критичности (мультиселект) | видны совпадения + их предки | E | `e2e/tests/tree-visibility.spec.ts::S27 criticality filter draft applied on "Применить"` |
| S28 | Поиск + фильтр + сворачивание вместе | согласованный набор `visibleRows`, без «сирот» | E | `e2e/tests/tree-visibility.spec.ts::S28 search ∩ criticality ∩ collapse yields consistent set` |
| S29 | Пустой результат поиска | явное empty-состояние | E | `e2e/tests/tree-visibility.spec.ts::S29 empty states: no-match search + filtered-out section` |
| S30 | Клик по «Описание» (длинный текст) | раскрытие/поповер, без обрезки | E | `e2e/tests/tree-visibility.spec.ts::S30 clicking "Описание" opens drawer with full, untruncated text` |

## MCP / AI-API
| # | Ситуация | Ожидание | Тип | Тест (файл::имя) |
|---|----------|----------|-----|------------------|
| S31 | `list_requirements` на пустом проекте | пустой массив, не ошибка | U | `apps/mcp/test/tools.test.ts::list_requirements on an empty project → empty array (not an error)` (PUC-6) |
| S32 | `create_requirement` с невалидными полями | доменная ошибка → MCP error, файл не создан | U | `apps/mcp/test/tools.test.ts::create_requirement with invalid criticality → error, no file created` (PUC-6) |
| S33 | `link_requirements` цикл | ошибка целостности через MCP | U | `apps/mcp/test/tools.test.ts::link_requirements cycle → CYCLE integrity error` (PUC-8) |
| S34 | `export_project` | путь к архиву/бинарь, round-trip | U | `apps/mcp/test/tools.test.ts::export_project (zip) writes a valid archive and returns its path` (PUC-10) |

---

## Трассировка на product use cases

S1–S38 связаны с шагами PUC-3 (импорт), PUC-6 (создание/редактирование), PUC-8 (связывание),
PUC-9 (удаление), PUC-10 (экспорт) — см. §10 `docs/overview/project.md` (SA-3). Отметка PUC
указана в скобках в колонке теста.
