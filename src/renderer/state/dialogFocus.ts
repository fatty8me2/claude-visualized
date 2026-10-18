import { useCallback, useEffect, useRef } from 'react';

/**
 * Modal dialog basics: Escape closes it, focus moves into it when it opens (the first button or field) and goes back to whatever
 * had it when it closes, and Tab stays inside. Returns a ref callback for the dialog element.
 */
export function useDialogFocus(onClose: () => void) {
  const el = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el.current) return;
      const items = [...el.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(
        (n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, []);
  return useCallback((node: HTMLElement | null) => {
    const opening = node && !el.current;
    el.current = node;
    // the close button is first in the header; start on the first real control instead when there is one
    if (opening) (node.querySelector<HTMLElement>('.primary, input, select') ?? node.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }, []);
}
