import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** A short message at the bottom of the window that goes away by itself. */
export function showToast(text: string, ms = 3500) {
  const id = nextId++;
  // the same message twice in a row just restarts its timer
  toasts = [...toasts.filter((t) => t.text !== text), { id, text }].slice(-3);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}

/** "Open in Claude": a session on another computer opens nothing here, it says where it runs. */
export async function openInClaude(id: string) {
  const r = await window.api.openInClaude(id);
  if (r.machine) showToast(`This session is running on ${r.machine}`);
  else if (!r.ok && r.error) showToast(`Could not open Claude: ${r.error}`);
}
