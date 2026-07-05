# T1 — Дизайн-фундамент: токены v2 + общие примитивы

Читай сначала: .dev/todo/task17_common.md, new_design/tokens.css, new_design/style-guide.html.

## Цель
Перевести apps/web на токены v2 и общие паттерны, НЕ переделывая экраны (визуальная база для T2–T6). Все существующие тесты остаются зелёными (тексты не менять).

## Объём
1. Токены: обновить источник CSS-переменных apps/web (index.css или где сейчас живут токены — найди через graphify) до new_design/tokens.css: light+dark, `--header-height`, `--sidebar-width`, `--toast-offset`, `--text-min:11px`, критичность (--crit-*), семантические *-fg/*-bg.
2. Убедиться, что Tailwind-конфиг мапит токены (цвета/радиусы/тени), если так уже сделано — расширить недостающими.
3. Примитивы (переиспользуемые классы или компоненты — по текущей практике проекта):
   - кнопки btn-primary/secondary/ghost/danger, btn-sm, disabled, busy-состояние (спиннер + герундий);
   - .chip (≥11px), .badge, .spinner, .row-actions (hover/focus-within/coarse);
   - иконки: базовый набор Lucide (18/20, stroke-2) — либо dep lucide-react, либо локальный Icon-компонент с inline-SVG, как удобнее для дерева зависимостей;
   - Toast: позиция над FAB (`bottom: var(--toast-offset)`), error 8с + пауза по hover (проверить текущий Toast.tsx и доработать);
   - Modal: базовые размеры/радиусы/тени по style-guide (max-w варианты — понадобится max-w-3xl в T4);
   - :focus-visible глобально.
4. Компонентные тесты на новое поведение Toast (error 8с, hover-пауза) и busy-кнопки, если оформлены компонентом.

## Не делать
Не менять тексты, разметку страниц, e2e.
