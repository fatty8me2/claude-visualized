// Pure logic for "Sync my settings" (Google Drive / any synced folder). No fs, no Electron: unit-tested in tests/unit/settingsSync*.test.ts.
//
// Only an explicit ALLOWLIST of keys is ever written to the shared folder: layout / view preferences and a few app toggles. Everything
// else (anything from ~/.claude, Claude login or tokens, the peer-link key and paired devices, the history database, the hook port,
// window bounds, local model server URLs, the device name used for pairing) is NOT in the list, so it cannot be synced by accident.

export const SYNC_DIR_NAME = 'Claude Visualized';
export const SHARED_FILE = 'settings.json';

/** renderer localStorage keys that follow the user between computers (raw JSON text, stored as-is) */
export const SYNC_LS_KEYS = [
  'cvis.layout.v1', // panel arrangement, sizes, hidden panels, sidebar side
  'cvis.overview.v1', // overview grid layout and density
  'cvis.plan.v1', // plan rail open / side / width
  'cvis.graph.v1', // graph zoom, compact, hide finished
  'cvis.sidebar.v1', // pinned / hidden sessions, collapsed project groups
  'cv.insights.collapsed', // which insight folds are collapsed
  'cvis.activeOnly', // "Active only" filter
] as const;

/** app config values that sync (name -> type). Machine-specific ones (port, hotkey, login item, local model URLs ...) are deliberately absent. */
export const SYNC_CONFIG_KEYS = {
  followActive: 'boolean',
  notifyAttention: 'boolean',
  notifyAgentDone: 'boolean',
  miniAlwaysOnTop: 'boolean',
  autoDownloadUpdates: 'boolean',
} as const;

/** documented, and asserted by tests never to appear in the allowlist */
export const NEVER_SYNCED = [
  'port', // hook receiver port
  'peerPort',
  'shareEnabled',
  'launchAtLogin',
  'miniHotkey',
  'localModels', // server URLs of this machine
  'onboardingDone',
  'onboardingVersion',
  'bounds', // window position / size
  'peers', // peer link private key and paired devices (peers.json)
  'claude', // Claude Code data, login, tokens
  'history', // SQLite database
] as const;

export const LS_PREFIX = 'ls:';
export const CFG_PREFIX = 'cfg:';
export const lsKey = (k: string) => LS_PREFIX + k;
export const cfgKey = (k: string) => CFG_PREFIX + k;

const MAX_VALUE = 200_000;

export const ALLOWED_KEYS: readonly string[] = [...SYNC_LS_KEYS.map(lsKey), ...Object.keys(SYNC_CONFIG_KEYS).map(cfgKey)];
const ALLOWED = new Set(ALLOWED_KEYS);
export const isSyncKey = (k: string): boolean => ALLOWED.has(k);

export type SyncValue = string | boolean;
export interface SyncEntry {
  v: SyncValue;
  /** when this value was last changed (epoch ms) */
  t: number;
}
export type SyncEntries = Record<string, SyncEntry>;

export interface SyncDoc {
  format: 1;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  /** last time the writer changed a value */
  updatedAt: number;
  /** last time the writer synced (also a heartbeat) */
  lastSyncAt: number;
  entries: SyncEntries;
}

/** a value fit to be stored under `key`, or undefined (unknown key, wrong type, not JSON, too big) */
export function cleanValue(key: string, v: unknown): SyncValue | undefined {
  if (!isSyncKey(key)) return undefined;
  if (key.startsWith(CFG_PREFIX)) {
    const want = SYNC_CONFIG_KEYS[key.slice(CFG_PREFIX.length) as keyof typeof SYNC_CONFIG_KEYS];
    return typeof v === want ? (v as SyncValue) : undefined;
  }
  if (typeof v !== 'string' || v.length > MAX_VALUE) return undefined;
  try {
    JSON.parse(v);
    return v;
  } catch {
    return undefined;
  }
}

/** keep only allowlisted, well-typed entries (everything else in a file from Drive is ignored) */
export function sanitizeEntries(raw: unknown): SyncEntries {
  const out: SyncEntries = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSyncKey(k) || !e || typeof e !== 'object') continue;
    const { v, t } = e as { v?: unknown; t?: unknown };
    const val = cleanValue(k, v);
    if (val === undefined || typeof t !== 'number' || !Number.isFinite(t) || t < 0) continue;
    out[k] = { v: val, t };
  }
  return out;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** a settings file from the folder, or null when it is not valid JSON of the right shape (a half-synced or hand-broken file) */
export function parseSyncDoc(text: string): SyncDoc | null {
  try {
    const o = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.format !== 1 || !o.entries || typeof o.entries !== 'object') return null;
    return {
      format: 1,
      deviceId: str(o.deviceId, 64),
      deviceName: str(o.deviceName, 60),
      platform: str(o.platform, 20),
      updatedAt: num(o.updatedAt),
      lastSyncAt: num(o.lastSyncAt),
      entries: sanitizeEntries(o.entries),
    };
  } catch {
    return null;
  }
}

export const deviceFileName = (deviceId: string) => `settings.${deviceId}.json`;

// settings.json, settings.<id>.json, and the copies Drive / Dropbox / OneDrive make on conflict: "settings (1).json", "settings.<id> - Copy.json",
// "settings.<id> (conflicted copy 2026-01-01).json". Anything else is a different file and is ignored.
const FILE_RE = /^settings(?:\.([A-Za-z0-9_-]{6,64}))?(?:( \(\d+\))|( - Copy(?: \(\d+\))?)|( \([^)]*conflict[^)]*\)))?\.json$/i;

/** which group a file in the folder belongs to: device is null for the shared file; copy is true for a conflict copy */
export function parseSyncFileName(name: string): { device: string | null; copy: boolean } | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return { device: m[1] ?? null, copy: !!(m[2] || m[3] || m[4]) };
}

export interface FolderFile {
  name: string;
  text: string;
  mtimeMs: number;
}
export interface PickedDoc {
  doc: SyncDoc;
  name: string;
}

/** Per group (shared file / one per machine): the newest valid document among the file and its conflict copies. Broken JSON is skipped. */
export function pickNewest(files: FolderFile[]): { shared: PickedDoc | null; devices: Map<string, PickedDoc> } {
  const best = new Map<string, PickedDoc & { mtimeMs: number; copy: boolean }>();
  for (const f of files) {
    const p = parseSyncFileName(f.name);
    if (!p) continue;
    const doc = parseSyncDoc(f.text);
    if (!doc) continue;
    const key = p.device ?? '';
    const cur = best.get(key);
    const newer =
      !cur ||
      doc.updatedAt > cur.doc.updatedAt ||
      (doc.updatedAt === cur.doc.updatedAt && (f.mtimeMs > cur.mtimeMs || (f.mtimeMs === cur.mtimeMs && cur.copy && !p.copy)));
    if (newer) best.set(key, { doc, name: f.name, mtimeMs: f.mtimeMs, copy: p.copy });
  }
  const devices = new Map<string, PickedDoc>();
  let shared: PickedDoc | null = null;
  for (const [k, v] of best) {
    if (k === '') shared = { doc: v.doc, name: v.name };
    else devices.set(k, { doc: v.doc, name: v.name });
  }
  return { shared, devices };
}

/** last-writer-wins per key. `changed` lists the keys whose value differs from `base` afterwards (strictly newer wins; ties keep base). */
export function mergeEntries(base: SyncEntries, incoming: SyncEntries[]): { merged: SyncEntries; changed: string[] } {
  const merged: SyncEntries = { ...base };
  for (const inc of incoming) {
    for (const [k, e] of Object.entries(inc)) {
      const cur = merged[k];
      if (!cur || e.t > cur.t) merged[k] = { v: e.v, t: e.t };
    }
  }
  const changed = Object.keys(merged).filter((k) => !base[k] || base[k].v !== merged[k].v);
  return { merged, changed };
}

export function sameEntries(a: SyncEntries, b: SyncEntries): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && b[k].v === a[k].v && b[k].t === a[k].t);
}

/** the part of an app config that may leave this machine, as sync keys (anything not allowlisted is dropped) */
export function configValues(cfg: Record<string, unknown>): Record<string, SyncValue> {
  const out: Record<string, SyncValue> = {};
  for (const k of Object.keys(SYNC_CONFIG_KEYS)) {
    const v = cleanValue(cfgKey(k), cfg[k]);
    if (v !== undefined) out[cfgKey(k)] = v;
  }
  return out;
}

export function buildDoc(args: { deviceId?: string; deviceName?: string; platform?: string; entries: SyncEntries; now: number; updatedAt: number }): SyncDoc {
  return {
    format: 1,
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    ...(args.deviceName ? { deviceName: args.deviceName.slice(0, 60) } : {}),
    ...(args.platform ? { platform: args.platform } : {}),
    updatedAt: args.updatedAt,
    lastSyncAt: args.now,
    entries: sanitizeEntries(args.entries), // the last line of defence: nothing outside the allowlist is ever serialised
  };
}

// ---------- finding the synced folder ----------

export interface SyncFolder {
  kind: 'google' | 'other';
  label: string;
  /** the folder that will contain "Claude Visualized" (e.g. G:\My Drive) */
  path: string;
}

/** the few file operations detection needs (a fake in unit tests) */
export interface DetectFs {
  isDir(p: string): Promise<boolean>;
  listDir(p: string): Promise<string[]>;
}

export interface DetectArgs {
  platform: string;
  home: string;
  fs: DetectFs;
  /** test hook (CLAUDE_VIS_SYNC_ROOTS): used instead of scanning */
  testRoots?: string[];
  join: (...p: string[]) => string;
}

export async function detectSyncFolders(a: DetectArgs): Promise<SyncFolder[]> {
  if (a.testRoots) {
    const out: SyncFolder[] = [];
    for (const p of a.testRoots) if (await a.fs.isDir(p)) out.push({ kind: 'google', label: `Google Drive (test folder)`, path: p });
    return out;
  }
  const found: SyncFolder[] = [];
  const older = a.join(a.home, 'Google Drive'); // Backup and Sync, and Drive for desktop's "mirror" mode
  if (a.platform === 'win32') {
    // Drive for desktop mounts a virtual drive (G: by default, any letter possible) with a "My Drive" folder
    const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const hits = await Promise.all(
      letters.map(async (L) => {
        const p = a.join(`${L}:\\`, 'My Drive');
        return (await a.fs.isDir(p)) ? ({ kind: 'google', label: `Google Drive (${L}:)`, path: p } as SyncFolder) : null;
      }),
    );
    for (const h of hits) if (h) found.push(h);
    if (await a.fs.isDir(older)) found.push({ kind: 'google', label: 'Google Drive (Backup and Sync)', path: older });
  } else if (a.platform === 'darwin') {
    const cs = a.join(a.home, 'Library', 'CloudStorage');
    for (const name of await a.fs.listDir(cs)) {
      if (!name.startsWith('GoogleDrive-')) continue;
      const p = a.join(cs, name, 'My Drive');
      if (await a.fs.isDir(p)) found.push({ kind: 'google', label: `Google Drive (${name.slice('GoogleDrive-'.length)})`, path: p });
    }
    if (await a.fs.isDir(older)) found.push({ kind: 'google', label: 'Google Drive', path: older });
  } else if (await a.fs.isDir(older)) {
    found.push({ kind: 'google', label: 'Google Drive', path: older });
  }
  return found;
}

// ---------- what the UI sees ----------

export interface SyncMachineView {
  deviceId: string;
  name: string;
  platform?: string;
  lastSyncAt: number;
  self: boolean;
}

export interface SyncStatusView {
  enabled: boolean;
  /** the chosen folder (e.g. G:\My Drive) and the app's own folder inside it */
  root: string | null;
  folder: string | null;
  /** the folder is reachable right now (false when Drive is not running / the drive is unmounted) */
  available: boolean;
  error: string | null;
  lastSyncedAt: number | null;
  machines: SyncMachineView[];
  deviceName: string;
}

export type SyncChoice = 'drive' | 'local' | 'merge';

export interface SyncEnableResult {
  ok: boolean;
  error?: string;
  /** Drive already has settings from these machines: ask which to use, then call again with `choice` */
  needsChoice?: { machines: string[]; keys: number };
}

export interface SyncDetectView {
  folders: SyncFolder[];
  /** a Google Drive folder was found */
  driveFound: boolean;
}
