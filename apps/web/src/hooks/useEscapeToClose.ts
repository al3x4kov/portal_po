import { useEffect, useRef } from 'react';

/**
 * Единый стек оверлеев для Esc: нажатие закрывает ТОЛЬКО верхний из
 * смонтированных диалогов (Modal, ConfirmDialog, …), как Tab в стеке
 * фокус-ловушки {@link useFocusTrap}. Порядок в стеке = порядок монтирования =
 * порядок наложения, поэтому вложенный ConfirmDialog всегда «съедает» Esc у
 * модалки под собой — UX-10: одно нажатие не должно закрывать оба слоя и
 * терять введённые данные. Раньше каждый диалог слушал Esc на документе сам,
 * а корректность держалась на ручных заглушках вида `if (confirmOpen) return`
 * в каждой модалке.
 */
const escStack: Array<{ close: () => void }> = [];

/**
 * Закрывать оверлей по Esc, только когда он ВЕРХНИЙ в стеке. Регистрация —
 * один раз на mount (позиция в стеке отражает реальный порядок наложения,
 * даже когда `onClose` пересоздаётся на каждом рендере).
 */
export function useEscapeToClose(onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const entry = { close: (): void => onCloseRef.current() };
    escStack.push(entry);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && escStack[escStack.length - 1] === entry) entry.close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      const idx = escStack.indexOf(entry);
      if (idx >= 0) escStack.splice(idx, 1);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}
