import { useEffect, type RefObject } from 'react';

/**
 * Stack of currently-mounted trap containers. Only the top-most trap reacts to
 * Tab, so nested dialogs (e.g. a ConfirmDialog opened from inside a Modal) don't
 * fight over focus — the inner one wins while it is open (UX-5).
 */
const trapStack: HTMLElement[] = [];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

interface FocusTrapOptions {
  /** Element to focus when the trap mounts (e.g. the safe "Cancel" button). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Return focus to the previously-focused element on unmount (default true). */
  returnFocus?: boolean;
}

/**
 * Keeps keyboard focus inside `containerRef` while it is mounted (UX-5, WCAG
 * 2.4.3 / 2.1.2): moves focus in on open, cycles Tab / Shift+Tab within the
 * container, and restores focus to the trigger on close. Escape handling stays
 * with each dialog (this hook is focus-only).
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: FocusTrapOptions = {},
): void {
  const { initialFocus, returnFocus = true } = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    trapStack.push(container);

    // Move focus inside — unless something in the container is already focused
    // (e.g. an `autoFocus`ed field), which we must not steal.
    const alreadyInside =
      document.activeElement != null &&
      document.activeElement !== document.body &&
      document.activeElement !== container &&
      container.contains(document.activeElement);
    if (!alreadyInside) {
      const target = initialFocus?.current ?? focusableWithin(container)[0] ?? container;
      target.focus();
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      // Only the top-most trap manages Tab (nested dialogs take precedence).
      if (trapStack[trapStack.length - 1] !== container) return;

      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || active == null || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || active == null || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const idx = trapStack.indexOf(container);
      if (idx >= 0) trapStack.splice(idx, 1);
      if (returnFocus && previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
    // Refs are stable and `returnFocus` is constant per call site, so this runs
    // once per mount (the trap's whole lifecycle).
  }, [containerRef, initialFocus, returnFocus]);
}
