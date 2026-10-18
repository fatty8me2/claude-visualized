import { EMPTY_PREFS, PREF_CAPS, toggleId, type SidebarPrefs } from '@core/sessionGroups';
import { createPersisted, strList } from './persisted';

/** Pinned and hidden sessions and collapsed project groups in the sidebar (remembered per machine). */
const store = createPersisted<SidebarPrefs>('cvis.sidebar.v1', EMPTY_PREFS, (raw) => {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { pinned: strList(o.pinned, PREF_CAPS.pinned), hidden: strList(o.hidden, PREF_CAPS.hidden), collapsed: strList(o.collapsed, PREF_CAPS.collapsed) };
});

export function useSidebarPrefs() {
  const [prefs, write] = store.use();
  return {
    prefs,
    togglePin: (id: string) => write((p) => ({ ...p, pinned: toggleId(p.pinned, id, PREF_CAPS.pinned) })),
    toggleHidden: (id: string) => write((p) => ({ ...p, hidden: toggleId(p.hidden, id, PREF_CAPS.hidden), pinned: p.pinned.filter((x) => x !== id) })),
    toggleGroup: (key: string) => write((p) => ({ ...p, collapsed: toggleId(p.collapsed, key, PREF_CAPS.collapsed) })),
  };
}
