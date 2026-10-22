import { SYNC_LS_KEYS } from '@core/settingsSync';

/**
 * Settings sync, renderer side. The layout / view preferences live in localStorage (each component keeps its own in-memory copy), so this
 * watches only the allowlisted keys, tells the main process when one changes, and writes values that arrived from another computer.
 * After such a write the window reloads once so every component picks the new values up.
 */
export function startSyncBridge(): () => void {
  const read = (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const seen: Record<string, string | null> = {};
  for (const k of SYNC_LS_KEYS) seen[k] = read(k);
  void window.api.syncReport({ ...seen }, true);

  const poll = window.setInterval(() => {
    const changed: Record<string, string | null> = {};
    for (const k of SYNC_LS_KEYS) {
      const v = read(k);
      if (v !== seen[k]) {
        seen[k] = v;
        changed[k] = v;
      }
    }
    if (Object.keys(changed).length) void window.api.syncReport(changed);
  }, 1500);

  const off = window.api.onSyncApply((values) => {
    let wrote = false;
    for (const [k, v] of Object.entries(values)) {
      if (!(SYNC_LS_KEYS as readonly string[]).includes(k) || typeof v !== 'string' || read(k) === v) continue;
      try {
        localStorage.setItem(k, v);
        seen[k] = v;
        wrote = true;
      } catch {
        /* storage unavailable */
      }
    }
    if (!wrote) return;
    const applied: Record<string, string | null> = {};
    for (const k of SYNC_LS_KEYS) applied[k] = seen[k];
    void window.api.syncReport(applied).finally(() => window.location.reload());
  });
  return () => {
    window.clearInterval(poll);
    off();
  };
}
