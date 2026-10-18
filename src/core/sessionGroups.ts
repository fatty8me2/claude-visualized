// Sidebar grouping: pinned sessions, hidden sessions and recent sessions grouped by project. Pure, so it is unit-tested
// (tests/unit/sessionGroups.test.ts); the preferences themselves live in renderer/state/sidebarPrefs.ts.

import type { SessionSummary } from './state';

export interface SidebarPrefs {
  pinned: string[];
  hidden: string[];
  /** collapsed project groups (group keys, see groupKey) */
  collapsed: string[];
}

export const PREF_CAPS = { pinned: 50, hidden: 500, collapsed: 200 } as const;

export const EMPTY_PREFS: SidebarPrefs = { pinned: [], hidden: [], collapsed: [] };

/** Case-insensitive match on title, project, folder, branch, machine and the start of the id. Empty query matches all. */
export function matchSession(s: SessionSummary, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  return [s.title, s.project, s.cwd, s.gitBranch, s.machine, s.id.slice(0, 8)].some((f) => !!f && f.toLowerCase().includes(query));
}

export const groupKey = (s: Pick<SessionSummary, 'machine' | 'project'>) => `${s.machine ?? ''}|${s.project}`;

export interface ProjectGroup {
  key: string;
  project: string;
  machine?: string;
  sessions: SessionSummary[];
  /** newest activity in the group */
  newest: number;
  collapsed: boolean;
}

export interface GroupedRecent {
  pinned: SessionSummary[];
  groups: ProjectGroup[];
  hidden: SessionSummary[];
  /** sessions left out by the cap */
  overflow: number;
}

/**
 * Split recent (not live) sessions into pinned, hidden and per-project groups. Groups are ordered by their newest session and
 * sessions within a group by recency. The cap applies to what lands in groups, after pinned and hidden are taken out.
 */
export function groupRecent(recent: SessionSummary[], prefs: SidebarPrefs, cap = 120): GroupedRecent {
  const pinnedSet = new Set(prefs.pinned);
  const hiddenSet = new Set(prefs.hidden);
  const collapsedSet = new Set(prefs.collapsed);
  const byRecency = [...recent].sort((a, b) => b.mtime - a.mtime);
  const pinned = byRecency.filter((s) => pinnedSet.has(s.id) && !hiddenSet.has(s.id));
  const hidden = byRecency.filter((s) => hiddenSet.has(s.id));
  const rest = byRecency.filter((s) => !pinnedSet.has(s.id) && !hiddenSet.has(s.id));
  const kept = rest.slice(0, cap);
  const map = new Map<string, ProjectGroup>();
  for (const s of kept) {
    const key = groupKey(s);
    let g = map.get(key);
    if (!g) {
      g = { key, project: s.project, machine: s.machine, sessions: [], newest: s.mtime, collapsed: collapsedSet.has(key) };
      map.set(key, g);
    }
    g.sessions.push(s);
    if (s.mtime > g.newest) g.newest = s.mtime;
  }
  const groups = [...map.values()].sort((a, b) => b.newest - a.newest);
  return { pinned, groups, hidden, overflow: rest.length - kept.length };
}

/** Add or remove `id`; beyond `cap` the oldest entries go first. */
export function toggleId(list: string[], id: string, cap: number): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  const next = [...list, id];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
