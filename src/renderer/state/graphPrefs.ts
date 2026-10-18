import { useCallback } from 'react';
import type { CompactPref } from '@core/graphZoom';
import { createPersisted, strList } from './persisted';

/** How the agent graph is shown, for every session (remembered per machine). */
export interface GraphPrefs {
  /** 'fit' scales to the panel (never below the readable floor); a number is a fixed zoom */
  zoom: 'fit' | number;
  /** compact cards: automatic when fit would shrink full cards below the readable floor */
  compact: CompactPref;
  hideFinished: boolean;
}

const store = createPersisted<GraphPrefs>('cvis.graph.v1', { zoom: 'fit', compact: 'auto', hideFinished: false }, (raw) => {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    zoom: typeof o.zoom === 'number' && o.zoom > 0 ? o.zoom : 'fit',
    compact: o.compact === 'on' || o.compact === 'off' ? o.compact : 'auto',
    hideFinished: o.hideFinished === true,
  };
});

export function useGraphPrefs(): [GraphPrefs, (patch: Partial<GraphPrefs>) => void] {
  const [prefs, write] = store.use();
  const set = useCallback((patch: Partial<GraphPrefs>) => write((p) => ({ ...p, ...patch })), [write]);
  return [prefs, set];
}

/** Per session: which finished-agent groups the user opened. The newest 20 sessions are kept. */
type Folds = Record<string, { expanded: string[]; at: number }>;
const folds = createPersisted<Folds>('cvis.graph.sessions.v1', {}, (raw) => {
  const out: Folds = {};
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw as Record<string, { expanded?: unknown; at?: unknown }>))
      out[k] = { expanded: strList(v?.expanded, 200), at: typeof v?.at === 'number' ? v.at : 0 };
  return out;
});
const EMPTY: string[] = [];

export function useExpandedGroups(sessionId: string): [ReadonlySet<string>, (next: string[]) => void] {
  const [all, write] = folds.use();
  const list = all[sessionId]?.expanded ?? EMPTY;
  const set = useCallback(
    (next: string[]) =>
      write((cur) => {
        const out: Folds = { ...cur, [sessionId]: { expanded: next, at: Date.now() } };
        const keys = Object.keys(out).sort((a, b) => out[b].at - out[a].at);
        for (const k of keys.slice(20)) delete out[k];
        return out;
      }),
    [write, sessionId],
  );
  return [expandedSet(list), set];
}

// one Set per list identity, so memo'd layout keys stay stable between renders
const setCache = new WeakMap<string[], ReadonlySet<string>>();
function expandedSet(list: string[]): ReadonlySet<string> {
  let s = setCache.get(list);
  if (!s) {
    s = new Set(list);
    setCache.set(list, s);
  }
  return s;
}
