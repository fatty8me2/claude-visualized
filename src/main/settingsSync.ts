// SettingsSync: keeps the allowlisted preferences (see core/settingsSync.ts) in step with a folder that Google Drive for desktop (or Dropbox,
// OneDrive, iCloud ...) syncs. No network code of our own: this only reads and writes ordinary files.
//   <folder>/Claude Visualized/settings.<deviceId>.json   one per machine: that machine's values + name + last sync time
//   <folder>/Claude Visualized/settings.json              the merged result, so a brand-new machine can start from it
// Last writer wins per key (timestamps). The folder is polled (Drive does not always raise file events). A missing folder (Drive not running)
// is a status, never an error that escapes. This file has no Electron imports so it can run in unit tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ALLOWED_KEYS,
  LS_PREFIX,
  SHARED_FILE,
  SYNC_DIR_NAME,
  buildDoc,
  cfgKey,
  cleanValue,
  configValues,
  deviceFileName,
  isSyncKey,
  lsKey,
  mergeEntries,
  parseSyncFileName,
  pickNewest,
  sameEntries,
  type FolderFile,
  type SyncChoice,
  type SyncEnableResult,
  type SyncEntries,
  type SyncMachineView,
  type SyncStatusView,
  type SyncValue,
} from '@core/settingsSync';

export interface SettingsSyncOptions {
  /** where this machine keeps its own sync state (never in the shared folder) */
  stateFile: string;
  deviceName: string;
  platform: string;
  /** the current app config (only allowlisted values are read from it) */
  getConfig: () => Record<string, unknown>;
  /** apply allowlisted config values that arrived from another machine */
  applyConfig: (patch: Record<string, boolean>) => void;
  /** renderer localStorage values to write (key -> raw JSON text) */
  pushToRenderer: (values: Record<string, string>) => void;
  onStatus: (s: SyncStatusView) => void;
  pollMs?: number;
  debounceMs?: number;
  now?: () => number;
}

interface State {
  format: 1;
  deviceId: string;
  enabled: boolean;
  root: string | null;
  baselined: boolean;
  entries: SyncEntries;
  /** what the renderer / config is known to hold, so "someone changed it here" is told apart from "it arrived from Drive" */
  mirror: Record<string, SyncValue>;
  lastSyncedAt: number | null;
}

const HEARTBEAT_MS = 10 * 60_000;

export class SettingsSync {
  private st: State;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private dirty = false;
  private updatedAt = 0;
  private available = false;
  private error: string | null = null;
  private machines: SyncMachineView[] = [];
  private cache = new Map<string, { sig: string; text: string }>();
  private lastOwnSig = '';
  private lastWriteAt = 0;
  private stopped = false;

  constructor(private o: SettingsSyncOptions) {
    this.st = this.load();
  }

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  private load(): State {
    const fresh: State = { format: 1, deviceId: crypto.randomBytes(8).toString('hex'), enabled: false, root: null, baselined: false, entries: {}, mirror: {}, lastSyncedAt: null };
    try {
      const j = JSON.parse(fs.readFileSync(this.o.stateFile, 'utf8')) as Partial<State>;
      if (typeof j.deviceId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(j.deviceId)) return fresh;
      const entries: SyncEntries = {};
      for (const [k, e] of Object.entries(j.entries ?? {})) {
        const v = cleanValue(k, (e as { v?: unknown })?.v);
        const t = (e as { t?: unknown })?.t;
        if (v !== undefined && typeof t === 'number') entries[k] = { v, t };
      }
      const mirror: Record<string, SyncValue> = {};
      for (const [k, raw] of Object.entries(j.mirror ?? {})) {
        const v = cleanValue(k, raw);
        if (v !== undefined) mirror[k] = v;
      }
      return {
        format: 1,
        deviceId: j.deviceId,
        enabled: !!j.enabled && typeof j.root === 'string',
        root: typeof j.root === 'string' ? j.root : null,
        baselined: !!j.baselined,
        entries,
        mirror,
        lastSyncedAt: typeof j.lastSyncedAt === 'number' ? j.lastSyncedAt : null,
      };
    } catch {
      return fresh;
    }
  }

  private saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
  }

  private saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.o.stateFile), { recursive: true });
      const tmp = `${this.o.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.st));
      fs.renameSync(tmp, this.o.stateFile);
    } catch (e) {
      console.error('sync state save failed', e);
    }
  }

  get deviceId(): string {
    return this.st.deviceId;
  }
  private dir(): string | null {
    return this.st.root ? path.join(this.st.root, SYNC_DIR_NAME) : null;
  }

  status(): SyncStatusView {
    return {
      enabled: this.st.enabled,
      root: this.st.root,
      folder: this.dir(),
      available: this.st.enabled && this.available,
      error: this.st.enabled ? this.error : null,
      lastSyncedAt: this.st.lastSyncedAt,
      machines: this.machines,
      deviceName: this.o.deviceName,
    };
  }
  private emit() {
    this.o.onStatus(this.status());
  }

  // ---------- life cycle ----------

  start() {
    this.reportConfig(this.o.getConfig());
    if (this.st.enabled) void this.begin();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.timer = this.debounce = this.saveTimer = null;
    this.saveNow();
  }

  private async begin() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.cycle(), this.o.pollMs ?? 4000);
    this.timer.unref?.();
    await this.cycle();
  }

  // ---------- local changes ----------

  /** renderer localStorage values (raw key -> raw text). `all` is the first call after a window loads: it also pushes pending remote values. */
  report(values: Record<string, string | null>, all = false) {
    let changed = false;
    for (const [raw, text] of Object.entries(values)) {
      const key = lsKey(raw);
      if (!isSyncKey(key) || text === null) continue;
      changed = this.note(key, cleanValue(key, text)) || changed;
    }
    if (all) this.st.baselined = true;
    if (changed) this.localChanged();
    this.reconcileRenderer();
  }

  reportConfig(cfg: Record<string, unknown>) {
    let changed = false;
    for (const [key, v] of Object.entries(configValues(cfg))) changed = this.note(key, v) || changed;
    if (changed) this.localChanged();
  }

  /** the renderer / config now holds `v` for `key`: if that is news to the sync state, it is a local edit */
  private note(key: string, v: SyncValue | undefined): boolean {
    if (v === undefined) return false;
    if (this.st.mirror[key] === v) return false;
    this.st.mirror[key] = v;
    this.saveSoon();
    if (this.st.entries[key]?.v === v) return false;
    this.st.entries[key] = { v, t: this.st.baselined ? this.now() : 0 };
    return true;
  }

  private localChanged() {
    this.updatedAt = this.now();
    this.dirty = true;
    this.saveSoon();
    if (!this.st.enabled) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.cycle(), this.o.debounceMs ?? 1000);
    this.debounce.unref?.();
  }

  /** push values in `entries` that the window / config does not hold yet */
  private reconcileRenderer() {
    const ls: Record<string, string> = {};
    const cfg: Record<string, boolean> = {};
    for (const [k, e] of Object.entries(this.st.entries)) {
      if (this.st.mirror[k] === e.v) continue;
      if (k.startsWith(LS_PREFIX)) ls[k.slice(LS_PREFIX.length)] = e.v as string;
      else cfg[k.slice('cfg:'.length)] = e.v as boolean;
    }
    if (Object.keys(cfg).length) {
      for (const k of Object.keys(cfg)) this.st.mirror[cfgKey(k)] = cfg[k];
      this.saveSoon();
      this.o.applyConfig(cfg);
    }
    if (Object.keys(ls).length) this.o.pushToRenderer(ls);
  }

  // ---------- enabling ----------

  async enable(root: string, choice?: SyncChoice): Promise<SyncEnableResult> {
    try {
      if (!(await fs.promises.stat(root)).isDirectory()) return { ok: false, error: 'That is not a folder.' };
    } catch {
      return { ok: false, error: 'That folder is not reachable. Is Google Drive running?' };
    }
    const remote = await this.readFolder(path.join(root, SYNC_DIR_NAME), false);
    const others = [...remote.devices].filter(([id]) => id !== this.st.deviceId);
    const keys = new Set<string>();
    for (const [, p] of others) for (const k of Object.keys(p.doc.entries)) keys.add(k);
    for (const k of Object.keys(remote.shared?.doc.entries ?? {})) keys.add(k);
    if (keys.size > 0 && !choice) {
      return { ok: true, needsChoice: { machines: others.map(([, p]) => p.doc.deviceName || 'another computer'), keys: keys.size } };
    }
    this.st.root = root;
    this.st.enabled = true;
    this.cache.clear();
    this.lastOwnSig = '';
    const t = this.now();
    if (choice === 'local' || keys.size === 0) {
      // this machine's settings go to Drive and replace what is there
      for (const k of Object.keys(this.st.entries)) this.st.entries[k] = { ...this.st.entries[k], t };
    } else if (choice === 'drive') {
      // Drive's settings replace this machine's wherever Drive has a value
      const incoming = [remote.shared?.doc.entries ?? {}, ...others.map(([, p]) => p.doc.entries)];
      const merged = mergeEntries({}, incoming).merged;
      for (const [k, e] of Object.entries(merged)) this.st.entries[k] = { v: e.v, t: e.t };
      for (const k of Object.keys(this.st.entries)) if (!merged[k]) this.st.entries[k] = { ...this.st.entries[k], t };
    } // 'merge': newest per key wins; values never tracked before count as oldest
    this.dirty = true;
    this.updatedAt = t;
    this.saveNow();
    this.reconcileRenderer();
    await this.begin();
    this.emit();
    return { ok: true };
  }

  disable() {
    this.st.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.saveNow();
    this.emit();
  }

  async syncNow() {
    await this.cycle();
  }

  // ---------- the folder ----------

  private async readFolder(dir: string, useCache: boolean) {
    const names = (await fs.promises.readdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [] as string[];
      throw e;
    })).filter((n) => parseSyncFileName(n));
    const files: FolderFile[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        const s = await fs.promises.stat(full);
        if (!s.isFile() || s.size > 1_000_000) continue;
        const sig = `${s.mtimeMs}:${s.size}`;
        const c = useCache ? this.cache.get(name) : undefined;
        const text = c && c.sig === sig ? c.text : await fs.promises.readFile(full, 'utf8');
        this.cache.set(name, { sig, text });
        seen.add(name);
        files.push({ name, text, mtimeMs: s.mtimeMs });
      } catch {
        /* vanished or locked while Drive was writing it: next poll */
      }
    }
    for (const n of [...this.cache.keys()]) if (!seen.has(n)) this.cache.delete(n);
    return pickNewest(files);
  }

  private async cycle(): Promise<void> {
    if (this.stopped || !this.st.enabled || !this.st.root) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.cycleOnce();
    } catch (e) {
      this.available = false;
      this.error = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'The folder is not reachable. Is Google Drive running?' : `Sync problem: ${(e as Error).message}`;
    } finally {
      this.running = false;
      this.emit();
    }
    if (this.again) {
      this.again = false;
      void this.cycle();
    }
  }

  private async cycleOnce() {
    const root = this.st.root!;
    try {
      if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('not a folder');
    } catch {
      this.available = false;
      this.error = 'The folder is not reachable. Is Google Drive running?';
      return;
    }
    const dir = this.dir()!;
    const remote = await this.readFolder(dir, true);

    // 1. take in what other machines wrote
    const others = [...remote.devices].filter(([id]) => id !== this.st.deviceId);
    const incoming = [remote.shared?.doc.entries ?? {}, ...others.map(([, p]) => p.doc.entries)];
    const { merged, changed } = mergeEntries(this.st.entries, incoming);
    if (!sameEntries(merged, this.st.entries)) {
      this.st.entries = merged;
      this.dirty = true;
      this.updatedAt = Math.max(this.updatedAt, ...Object.values(merged).map((e) => e.t));
      this.saveSoon();
      if (changed.length) this.reconcileRenderer();
    }

    // 2. publish ours (atomic temp + rename) when something changed or as a heartbeat
    const now = this.now();
    const ownSig = JSON.stringify(Object.entries(this.st.entries).sort(([a], [b]) => (a < b ? -1 : 1)));
    const own = remote.devices.get(this.st.deviceId);
    const ownMissing = !own;
    if (this.dirty || ownSig !== this.lastOwnSig || ownMissing || now - this.lastWriteAt > HEARTBEAT_MS) {
      const doc = buildDoc({
        deviceId: this.st.deviceId,
        deviceName: this.o.deviceName,
        platform: this.o.platform,
        entries: this.st.entries,
        now,
        updatedAt: this.updatedAt || now,
      });
      await fs.promises.mkdir(dir, { recursive: true });
      const needOwn = this.dirty || ownMissing || ownSig !== this.lastOwnSig || !own || !sameEntries(own.doc.entries, this.st.entries) || now - this.lastWriteAt > HEARTBEAT_MS;
      if (needOwn) await this.writeAtomic(dir, deviceFileName(this.st.deviceId), doc);
      if (!remote.shared || !sameEntries(remote.shared.doc.entries, this.st.entries)) {
        await this.writeAtomic(dir, SHARED_FILE, { ...doc, deviceId: undefined, deviceName: undefined, platform: undefined });
      }
      this.lastOwnSig = ownSig;
      this.lastWriteAt = now;
      this.dirty = false;
    }

    this.available = true;
    this.error = null;
    this.st.lastSyncedAt = now;
    this.saveSoon();
    const list: SyncMachineView[] = [{ deviceId: this.st.deviceId, name: this.o.deviceName, platform: this.o.platform, lastSyncAt: now, self: true }];
    for (const [id, p] of others) list.push({ deviceId: id, name: p.doc.deviceName || 'Another computer', platform: p.doc.platform, lastSyncAt: p.doc.lastSyncAt, self: false });
    this.machines = list;
  }

  private async writeAtomic(dir: string, name: string, doc: unknown) {
    const tmp = path.join(dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2));
      await fs.promises.rename(tmp, path.join(dir, name));
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  /** for tests */
  get allowedKeys(): readonly string[] {
    return ALLOWED_KEYS;
  }
}
