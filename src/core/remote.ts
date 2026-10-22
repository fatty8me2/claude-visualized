// Peer link (see docs/PEER-LINK.md): how another computer's sessions, inbox and usage merge with this one's.
// Pure: no Electron, no Node APIs, so the renderer can use the id helpers too.

import { compareItems, type InboxItem } from './inbox';
import type { SessionSummary, SessionView } from './state';
import { resolveWindow, type UsageView } from './usage';

export const REMOTE_PREFIX = 'remote:';

/** Remote session (and inbox item) ids are namespaced so they can never clash with local ones. */
export function remoteId(deviceId: string, id: string): string {
  return `${REMOTE_PREFIX}${deviceId}:${id}`;
}

export function isRemoteId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(REMOTE_PREFIX);
}

export function parseRemoteId(id: string): { deviceId: string; id: string } | null {
  if (!isRemoteId(id)) return null;
  const rest = id.slice(REMOTE_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { deviceId: rest.slice(0, i), id: rest.slice(i + 1) };
}

/** Recent (not live) sessions a sharer sends besides the live ones. */
export const SHARED_RECENT = 50;

/** What a sharer sends about its own sessions: live ones plus the most recent, without local paths or desktop-app ids. */
export function shareableSummaries(local: readonly SessionSummary[]): SessionSummary[] {
  const live = local.filter((s) => s.live);
  const recent = local
    .filter((s) => !s.live)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SHARED_RECENT);
  return [...live, ...recent].map((s) => ({ ...s, file: '', desktopId: null, machine: undefined, deviceId: undefined, offlineSince: undefined }));
}

export interface RemoteHostData {
  deviceId: string;
  machine: string;
  /** null while connected */
  offlineSince: number | null;
  summaries: readonly SessionSummary[];
}

export function namespaceSummary(s: SessionSummary, host: RemoteHostData): SessionSummary {
  const offline = host.offlineSince !== null;
  return {
    ...s,
    id: remoteId(host.deviceId, s.id),
    file: '',
    desktopId: null,
    machine: host.machine,
    deviceId: host.deviceId,
    offlineSince: host.offlineSince,
    // a session we can no longer see is not shown as live
    live: offline ? false : s.live,
    running: offline ? 0 : s.running,
    waiting: offline ? false : s.waiting,
  };
}

/** Local summaries first (as they were), then every host's, namespaced. */
export function mergeSummaries(local: readonly SessionSummary[], hosts: readonly RemoteHostData[]): SessionSummary[] {
  const out = [...local];
  for (const h of hosts) for (const s of h.summaries) out.push(namespaceSummary(s, h));
  return out;
}

export function namespaceView<T extends SessionView>(v: T, deviceId: string, machine: string): T {
  return { ...v, id: remoteId(deviceId, v.id), machine };
}

export interface RemoteInbox {
  deviceId: string;
  machine: string;
  items: readonly InboxItem[];
}

/**
 * Local items plus every connected host's, namespaced and labelled by machine. Remote usage items are left out (usage is merged with
 * mergeUsage and the local derivation raises the usage items). Ids dismissed here are hidden; nothing is sent back to the host.
 */
export function mergeInbox(local: readonly InboxItem[], remotes: readonly RemoteInbox[], dismissed: ReadonlySet<string> = new Set()): InboxItem[] {
  const out: InboxItem[] = [...local];
  for (const r of remotes) {
    for (const i of r.items) {
      if (i.kind === 'usage' || i.sessionId === null) continue;
      const id = remoteId(r.deviceId, i.id);
      if (dismissed.has(id)) continue;
      out.push({ ...i, id, sessionId: remoteId(r.deviceId, i.sessionId), machine: r.machine });
    }
  }
  return out.sort(compareItems);
}

const fresher = resolveWindow;

/**
 * Usage meters across machines (one account): each window takes the freshest reading from any machine, and the API state shows "ok"
 * if any machine's usage API answered, so an expired login here is covered by a machine that is logged in. The first view is the local one.
 */
export function mergeUsage(local: UsageView, remotes: readonly UsageView[]): UsageView {
  if (remotes.length === 0) return local;
  const all = [local, ...remotes];
  const out: UsageView = { ...local };
  for (const u of remotes) {
    out.fiveHour = fresher(out.fiveHour, u.fiveHour);
    out.sevenDay = fresher(out.sevenDay, u.sevenDay);
    out.spend = fresher(out.spend, u.spend);
    if (u.statuslineAt && (!out.statuslineAt || u.statuslineAt > out.statuslineAt)) out.statuslineAt = u.statuslineAt;
  }
  const okApi = all.filter((u) => u.api?.state === 'ok').sort((a, b) => (b.api?.at ?? 0) - (a.api?.at ?? 0))[0];
  if (okApi) {
    out.api = okApi.api;
    out.models = okApi.models;
  }
  return out;
}
