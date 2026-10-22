import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  ALLOWED_KEYS,
  NEVER_SYNCED,
  SYNC_CONFIG_KEYS,
  SYNC_LS_KEYS,
  buildDoc,
  configValues,
  detectSyncFolders,
  mergeEntries,
  parseSyncDoc,
  parseSyncFileName,
  pickNewest,
  sanitizeEntries,
  type DetectFs,
  type SyncEntries,
} from '@core/settingsSync';
import { SettingsSync } from '../../src/main/settingsSync';

const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 1, deviceId: 'aaaaaaaa', updatedAt: 1, lastSyncAt: 1, entries: { 'cfg:followActive': { v: false, t: 5 } }, ...over });

describe('allowlist', () => {
  it('only holds layout/view prefs and a few toggles, never anything machine-specific or secret', () => {
    for (const bad of NEVER_SYNCED) {
      for (const k of ALLOWED_KEYS) expect(k.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    expect(Object.keys(SYNC_CONFIG_KEYS)).not.toContain('port');
    expect(SYNC_LS_KEYS).toContain('cvis.overview.v1');
  });

  it('configValues drops everything but the allowlisted toggles', () => {
    const v = configValues({
      port: 47821,
      peerPort: 1,
      shareEnabled: true,
      launchAtLogin: true,
      miniHotkey: 'X',
      localModels: { ollama: { url: 'http://192.168.1.5:11434' } },
      oauthToken: 'secret',
      followActive: false,
      notifyAttention: true,
    });
    expect(Object.keys(v).sort()).toEqual(['cfg:followActive', 'cfg:notifyAttention']);
  });

  it('secrets are never serialised: buildDoc and sanitizeEntries drop unknown keys, wrong types and non-JSON', () => {
    const dirty = {
      'ls:cvis.layout.v1': { v: '{"a":1}', t: 1 },
      'ls:peers.json': { v: '{"priv":"SECRET"}', t: 1 },
      'cfg:port': { v: true, t: 1 },
      'ls:cvis.page': { v: '"x"', t: 1 },
      'ls:cvis.plan.v1': { v: 'not json {', t: 1 },
      'cfg:notifyAgentDone': { v: 'yes', t: 1 },
      'ls:token': { v: '"sk-ant-secret"', t: 1 },
    };
    const d = buildDoc({ deviceId: 'abcdef12', entries: dirty as unknown as SyncEntries, now: 2, updatedAt: 1 });
    expect(Object.keys(d.entries)).toEqual(['ls:cvis.layout.v1']);
    expect(JSON.stringify(d)).not.toMatch(/SECRET|secret|priv|port/);
  });
});

describe('file names and conflict copies', () => {
  it('recognises settings files and the copies cloud clients make', () => {
    expect(parseSyncFileName('settings.json')).toEqual({ device: null, copy: false });
    expect(parseSyncFileName('settings (1).json')).toEqual({ device: null, copy: true });
    expect(parseSyncFileName('settings.abc12345.json')).toEqual({ device: 'abc12345', copy: false });
    expect(parseSyncFileName('settings.abc12345 (2).json')).toEqual({ device: 'abc12345', copy: true });
    expect(parseSyncFileName('settings.abc12345 - Copy.json')).toEqual({ device: 'abc12345', copy: true });
    expect(parseSyncFileName('settings.abc12345 (conflicted copy 2026-01-02).json')).toEqual({ device: 'abc12345', copy: true });
    expect(parseSyncFileName('notes.json')).toBeNull();
    expect(parseSyncFileName('.settings.json.1234.tmp')).toBeNull();
  });

  it('picks the newest valid document per group and ignores broken JSON', () => {
    const files = [
      { name: 'settings.json', text: doc({ updatedAt: 10, entries: { 'cfg:followActive': { v: true, t: 10 } } }), mtimeMs: 1 },
      { name: 'settings (1).json', text: doc({ updatedAt: 20, entries: { 'cfg:followActive': { v: false, t: 20 } } }), mtimeMs: 2 },
      { name: 'settings (2).json', text: '{"format":1,"entries":{', mtimeMs: 999 },
      { name: 'settings.dev11111.json', text: 'garbage', mtimeMs: 5 },
      { name: 'settings.dev22222.json', text: doc({ deviceId: 'dev22222' }), mtimeMs: 5 },
    ];
    const r = pickNewest(files);
    expect(r.shared?.name).toBe('settings (1).json');
    expect(r.devices.has('dev11111')).toBe(false);
    expect(r.devices.get('dev22222')?.doc.entries['cfg:followActive'].v).toBe(false);
  });

  it('an unknown format or shape is rejected', () => {
    expect(parseSyncDoc('{"format":2,"entries":{}}')).toBeNull();
    expect(parseSyncDoc('[]')).toBeNull();
    expect(parseSyncDoc('')).toBeNull();
    expect(parseSyncDoc('\uFEFF' + doc())).not.toBeNull();
    expect(sanitizeEntries({ 'cfg:followActive': { v: true, t: -4 } })).toEqual({});
  });
});

describe('merge', () => {
  it('last writer wins per key; ties keep the local value', () => {
    const base: SyncEntries = { 'cfg:followActive': { v: true, t: 10 }, 'cfg:notifyAttention': { v: true, t: 50 } };
    const inc: SyncEntries = {
      'cfg:followActive': { v: false, t: 20 },
      'cfg:notifyAttention': { v: false, t: 50 },
      'cfg:notifyAgentDone': { v: true, t: 1 },
    };
    const { merged, changed } = mergeEntries(base, [inc]);
    expect(merged['cfg:followActive']).toEqual({ v: false, t: 20 });
    expect(merged['cfg:notifyAttention'].v).toBe(true);
    expect(merged['cfg:notifyAgentDone'].v).toBe(true);
    expect(changed.sort()).toEqual(['cfg:followActive', 'cfg:notifyAgentDone']);
  });
});

describe('detection (fake file system)', () => {
  const fakeFs = (dirs: Record<string, string[]>): DetectFs => ({
    isDir: async (p) => p in dirs,
    listDir: async (p) => dirs[p] ?? [],
  });
  const join = path.posix.join;

  it('Windows: finds Drive on whatever letter, and the old Google Drive folder', async () => {
    const r = await detectSyncFolders({
      platform: 'win32',
      home: 'C:/Users/me',
      join: (...p) => (p[0].endsWith(':\\') ? p[0] + p[1] : path.posix.join(...p)),
      fs: fakeFs({ 'H:\\My Drive': [], 'C:/Users/me/Google Drive': [] }),
    });
    expect(r.map((f) => f.path)).toEqual(['H:\\My Drive', 'C:/Users/me/Google Drive']);
    expect(r[0].label).toContain('H:');
  });

  it('macOS: lists every signed-in account under CloudStorage', async () => {
    const cs = '/Users/me/Library/CloudStorage';
    const r = await detectSyncFolders({
      platform: 'darwin',
      home: '/Users/me',
      join,
      fs: fakeFs({
        [cs]: ['GoogleDrive-a@example.com', 'GoogleDrive-b@example.com', 'Dropbox'],
        [`${cs}/GoogleDrive-a@example.com/My Drive`]: [],
        [`${cs}/GoogleDrive-b@example.com/My Drive`]: [],
      }),
    });
    expect(r.map((f) => f.label)).toEqual(['Google Drive (a@example.com)', 'Google Drive (b@example.com)']);
  });

  it('nothing installed: empty list', async () => {
    expect(await detectSyncFolders({ platform: 'darwin', home: '/Users/me', join, fs: fakeFs({}) })).toEqual([]);
    expect(await detectSyncFolders({ platform: 'win32', home: 'C:/x', join: path.join, fs: fakeFs({}) })).toEqual([]);
  });

  it('test roots replace scanning', async () => {
    const r = await detectSyncFolders({ platform: 'win32', home: '', join, fs: fakeFs({ '/t/drive': [] }), testRoots: ['/t/drive', '/t/missing'] });
    expect(r.map((f) => f.path)).toEqual(['/t/drive']);
  });
});

describe('SettingsSync engine (temp folders)', () => {
  const mk = (root: string, name: string, cfg: Record<string, unknown> = {}) => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sync-ud-'));
    const pushed: Record<string, string>[] = [];
    const applied: Record<string, boolean>[] = [];
    const s = new SettingsSync({
      stateFile: path.join(ud, 'sync-state.json'),
      deviceName: name,
      platform: 'test',
      getConfig: () => cfg,
      applyConfig: (p) => applied.push(p),
      pushToRenderer: (v) => pushed.push(v),
      onStatus: () => {},
      pollMs: 100_000,
      debounceMs: 100_000,
    });
    return { s, ud, pushed, applied, root };
  };
  const drive = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sync-drive-'));
  const LAYOUT = JSON.stringify({ arrangement: 'wide' });

  it('writes only allowlisted keys, atomically, and a second machine picks them up', async () => {
    const root = drive();
    const a = mk(root, 'PC', { port: 1, followActive: false, peerToken: 'SECRET' });
    a.s.start();
    a.s.report({ 'cvis.layout.v1': LAYOUT, 'peers.json': '{"priv":"SECRET"}', 'cvis.page': '"x"' }, true);
    expect(await a.s.enable(root)).toEqual({ ok: true });
    const dir = path.join(root, 'Claude Visualized');
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual([`settings.${a.s.deviceId}.json`, 'settings.json']);
    for (const f of files) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(txt).not.toMatch(/SECRET|peerToken|"port"/);
    }
    const b = mk(root, 'Mac');
    b.s.start();
    b.s.report({}, true);
    const r = await b.s.enable(root);
    expect(r.needsChoice?.machines).toEqual(['PC']);
    expect((await b.s.enable(root, 'drive')).ok).toBe(true);
    expect(b.pushed.at(-1)).toEqual({ 'cvis.layout.v1': LAYOUT });
    expect(b.applied.at(-1)).toEqual({ followActive: false });
    a.s.stop();
    b.s.stop();
  });

  it('a change on one machine reaches the other (newest wins), survives a conflict copy and broken JSON, and a vanished folder never throws', async () => {
    const root = drive();
    const a = mk(root, 'PC');
    const b = mk(root, 'Mac');
    for (const m of [a, b]) {
      m.s.start();
      m.s.report({ 'cvis.layout.v1': LAYOUT }, true);
    }
    await a.s.enable(root);
    await b.s.enable(root, 'merge');
    await a.s.syncNow();
    const L2 = JSON.stringify({ arrangement: 'tall' });
    await new Promise((r) => setTimeout(r, 5));
    a.s.report({ 'cvis.layout.v1': L2 });
    await a.s.syncNow();
    await b.s.syncNow();
    expect(b.pushed.at(-1)).toEqual({ 'cvis.layout.v1': L2 });

    // a cloud client writes a conflict copy with newer data, plus a truncated file
    const dir = path.join(root, 'Claude Visualized');
    const newer = JSON.stringify({ arrangement: 'stack' });
    fs.writeFileSync(
      path.join(dir, `settings.${a.s.deviceId} (1).json`),
      JSON.stringify({ format: 1, updatedAt: Date.now() + 5000, lastSyncAt: 1, entries: { 'ls:cvis.layout.v1': { v: newer, t: Date.now() + 5000 } } }),
    );
    fs.writeFileSync(path.join(dir, 'settings (3).json'), '{"format":1,"entr');
    await b.s.syncNow();
    expect(b.pushed.at(-1)).toEqual({ 'cvis.layout.v1': newer }); // the newest valid copy of A's file wins; the truncated file is ignored

    fs.rmSync(root, { recursive: true, force: true });
    await expect(b.s.syncNow()).resolves.toBeUndefined();
    expect(b.s.status().available).toBe(false);
    expect(b.s.status().error).toMatch(/not reachable/);
    a.s.stop();
    b.s.stop();
  });
});
