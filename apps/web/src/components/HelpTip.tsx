import { useId, useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  /** Доступное имя кнопки-иконки, например «Что такое Reach». */
  label: string;
  testid?: string;
  /** Текст мини-инструкции (короткие строки переводом через \n сохраняются). */
  children: string;
}

/**
 * Иконка-вопросик с мини-инструкцией по наведению (запрос PO: не все знакомы
 * с RICE-оценкой). Подсказка раскрывается по hover И по фокусу с клавиатуры
 * (доступность NFR-7: иконка — настоящая кнопка в табе-порядке), закрывается
 * по уходу мыши/фокуса и по Esc. Управляется состоянием, а не CSS-hover'ом,
 * чтобы поведение было тестируемым и одинаковым для мыши и клавиатуры.
 */
export function HelpTip({ label, testid, children }: HelpTipProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="inline-flex cursor-help items-center rounded-full align-middle"
        style={{ color: 'var(--color-text-3)' }}
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        data-testid={testid}
        onFocus={() => setOpen(true)}
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
          className="absolute left-1/2 bottom-full z-50 mb-1.5 w-60 -translate-x-1/2 whitespace-pre-line rounded-lg border p-2.5 text-left text-xs font-normal leading-snug shadow-lg"
          style={{
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
