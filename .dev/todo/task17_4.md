# T4 — Модалки: requirement, link, picker, export-tasks, confirm

Читай сначала: .dev/todo/task17_common.md, макеты new_design/screens/{requirement-modal,link-modal,picker-modal,export-tasks-modal,confirm-dialog}.html.
Код: apps/web/src/components/{RequirementModal,LinkModal,ExportTasksModal,ConfirmDialog,Modal}.tsx (+picker — найди через graphify, где сейчас выбор требований) (+тесты).
ВНЕ СКОУПА: export-modal.html (PO не включил его в список внедрения) — ExportModal не переделывать, только если общие примитивы (toast/btn) затрагивают его косвенно.

## ConfirmDialog (confirm-dialog.html)
- Три уровня трения: 0 — без confirm (+toast), 1 — обычный confirm, 2 — ввод имени; busy-герундий на кнопке; у disabled-кнопки — причина (title/hint).

## RequirementModal (requirement-modal.html)
- max-w-3xl; постоянная зона «Основное» + табы «Описание / Связи / Справочно»; критичность — 5 сегментов (segmented control, цвета --crit-*); источник — select; AI-помощь: «Заменить/Дополнить».
- Сохранение изменений БЕЗ confirm + toast «Сохранено» (Undo не делаем — см. common). Confirm остаётся только для необратимого (удаление).

## LinkModal (link-modal.html)
- Цель — chip; выбор строки: галочка + рамка; список «первые 25 из N»; подсветка итоговой связи; порядок типов — по макету.

## Picker (picker-modal.html)
- «Выбрано 30 (видно 5)» + hint почему видно меньше; поиск; русские бейджи типов. СРЕДНИЙ род: «Выбрано», «оно».

## ExportTasksModal (export-tasks-modal.html)
- Шаги 1→2→3 с индикатором; «← Назад» из preview; новое имя пункта меню — как в макете.

## Приёмка
- Все состояния из макетов; средний род во всех текстах; компонентные тесты обновлены (табы, сегменты критичности, уровни confirm, шаги).
