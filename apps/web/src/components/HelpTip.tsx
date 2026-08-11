import { useId, useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  /** Доступное имя кнопки-иконки, например «Что такое Reach». */
  label: string;
  testid?: string;
  /** Текст мини-инструкции (короткие строки переводом через \n сохраняются). */
  children: string;
}

/** Ширина карточки подсказки (px) — участвует в клампе по вьюпорту. */
const TIP_WIDTH = 240;
/** Минимальный отступ подсказки от краёв вьюпорта (px). */
const TIP_MARGIN = 8;

/**
 * Иконка-вопросик с мини-инструкцией по наведению (запрос PO: не все знакомы
 * с RICE-оценкой). Подсказка раскрывается по hover И по фокусу с клавиатуры
 * (доступность NFR-7: иконка — настоящая кнопка в табе-порядке), закрывается
 * по уходу мыши/фокуса и по Esc. Управляется состоянием, а не CSS-hover'ом,
 * чтобы поведение было тестируемым и одинаковым для мыши и клавиатуры.
 *
 * Позиционирование — `fixed` с клампом по вьюпорту: absolute-вариант клипался
 * overflow'ом скролл-контейнера модалки у крайних колонок (Reach у левого
 * края, Effort у правого), обрезая текст инструкции.
 */
export function HelpTip({ label, testid, children }: HelpTipProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipId = useId();

  /** Открыть подсказку над иконкой, не выходя за края вьюпорта. */
  function openAt(target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : TIP_WIDTH;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - TIP_WIDTH / 2, TIP_MARGIN),
      Math.max(viewportWidth - TIP_WIDTH - TIP_MARGIN, TIP_MARGIN),
    );
    setPos({ top: rect.top - 6, left });
    setOpen(true);
  }

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={(e) => openAt(e.currentTarget)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="inline-flex cursor-help items-center rounded-full align-middle"
        style={{ color: 'var(--color-text-3)' }}
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        data-testid={testid}
        onFocus={(e) => openAt(e.currentTarget)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <span
          id={tipId}
          role="tooltip"
          data-testid={testid ? `${testid}-tip` : undefined}
          className="pointer-events-none fixed z-[70] -translate-y-full whitespace-pre-line rounded-lg border p-2.5 text-left text-xs font-normal leading-snug shadow-lg"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            width: TIP_WIDTH,
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-2)',
          }}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
