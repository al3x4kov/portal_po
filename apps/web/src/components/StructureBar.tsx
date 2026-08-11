import { MOVE_OP_HOTKEY, MOVE_OP_LABEL, type MoveOption } from '../lib/structureMoves';

/** Одна запись журнала перемещений за сеанс (для самоконтроля, макет П6). */
export interface MoveHistoryEntry {
  time: string;
  name: string;
  from: string;
  to: string;
}

interface StructureBarProps {
  /** Имя выбранной строки; null — строка ещё не выбрана. */
  selectedName: string | null;
  /** Имя текущего родителя выбранной строки («корень» — если его нет). */
  currentParentName: string | null;
  /** Уровень строки (1 = корень) и глубина дерева — «уровень 2 из 5». */
  level?: number;
  depth?: number;
  /** Сколько потомков переедет вместе со строкой. */
  descendants?: number;
  /** Операции выбранной строки — те же, что и стрелки в строке. */
  options?: MoveOption[];
  /** Ошибка последнего перемещения (конфликт, обрыв сети) — вместо статуса. */
  error?: { message: string; canRetry: boolean } | null;
  /** Есть ли что отменять (Ctrl+Z / кнопка). */
  canUndo: boolean;
  onUndo: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onExit: () => void;
  history: MoveHistoryEntry[];
  busy?: boolean;
}

/**
 * Нижняя панель режима структуры. На время режима заменяет обычную панель
 * действий («+ Функция», AI-подгрузка) и отвечает на один вопрос: что именно
 * изменится и что уже изменилось. Никаких модалок — перемещение слишком частая
 * операция, чтобы прерывать её диалогом (диалог остаётся только для переезда
 * раздела с потомками).
 */
export function StructureBar({
  selectedName,
  currentParentName,
  level,
  depth,
  descendants = 0,
  options = [],
  error = null,
  canUndo,
  onUndo,
  onRetry,
  onDismissError,
  onExit,
  history,
  busy = false,
}: StructureBarProps): React.ReactElement {
  const available = options.filter((o) => !o.disabledReason);
  const blocked = options.filter((o) => o.disabledReason);

  return (
    <div
      className="sticky bottom-0 border-t px-4 py-2.5"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="structure-bar"
    >
      {error ? (
        <div
          className="mb-2 rounded-lg px-3 py-2 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
          data-testid="structure-error"
        >
          {error.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {selectedName ? (
          <>
            <span className="badge" style={{ background: 'var(--color-surface-2)' }}>
              ⠿ {selectedName}
            </span>
            <span style={{ color: 'var(--color-text-3)' }}>сейчас в</span>
            <strong data-testid="structure-current-parent">
              {currentParentName ?? 'корне раздела'}
            </strong>
            {level && depth ? (
              <span className="badge" style={{ background: 'var(--color-surface-2)' }}>
                уровень {level} из {depth}
              </span>
            ) : null}
            <span className="badge" style={{ background: 'var(--color-surface-2)' }}>
              потомков переедет: {descendants}
            </span>
            <span className="badge" style={{ background: 'var(--color-surface-2)' }}>
              1 связь CHILD_OF
            </span>
          </>
        ) : (
          <span style={{ color: 'var(--color-text-2)' }} data-testid="structure-hint">
            Возьмите строку за ручку ⠿ и перетащите, либо выберите её и пользуйтесь стрелками
          </span>
        )}

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {error?.canRetry ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="structure-retry"
              onClick={onRetry}
            >
              Обновить дерево и повторить
            </button>
          ) : null}
          {error ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="structure-dismiss-error"
              onClick={onDismissError}
            >
              Оставить как на диске
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="structure-undo"
            disabled={!canUndo || busy}
            onClick={onUndo}
          >
            Отменить последнее (Ctrl+Z)
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="structure-exit"
            onClick={onExit}
          >
            Выйти из режима
          </button>
        </span>
      </div>

      {/* Доступные операции и причины недоступных — рядом, не по одной в подсказке. */}
      {selectedName ? (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]"
          style={{ color: 'var(--color-text-3)' }}
          data-testid="structure-ops"
        >
          {available.map((o) => (
            <span key={o.op} data-testid={`structure-op-${o.op}`}>
              <span className="mono">{MOVE_OP_HOTKEY[o.op]}</span> {MOVE_OP_LABEL[o.op]} —{' '}
              <span style={{ color: 'var(--color-text-2)' }}>{o.parentName}</span>
            </span>
          ))}
          {blocked.map((o) => (
            <span key={o.op} data-testid={`structure-blocked-${o.op}`}>
              <span className="mono">{MOVE_OP_HOTKEY[o.op]}</span> недоступно: {o.disabledReason}
            </span>
          ))}
          {/* Esc — единственный способ снять выбор, а с ним и перехват Tab
              внутри дерева. Без подписи его не найти. */}
          <span data-testid="structure-hotkey-esc">
            <span className="mono">Esc</span> снять выбор строки
          </span>
          <span>Порядок внутри родителя алфавитный — «вверх/вниз» переносит в соседний раздел</span>
        </div>
      ) : null}

      {history.length > 0 ? (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]"
          style={{ color: 'var(--color-text-3)' }}
          data-testid="structure-history"
        >
          <span>За сеанс:</span>
          {history.map((h, i) => (
            <span key={`${h.time}-${i}`}>
              <span className="mono">{h.time}</span> «{h.name}»: {h.from} → {h.to}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
