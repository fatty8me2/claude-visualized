// The unsigned macOS self-update: the pure decisions, the download checks, and the swap script itself (run with sh, with
// ditto / open / xattr stubbed, so it runs on any machine that has a POSIX shell).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAC_SWAP_SCRIPT, bundleParent, macAssetUrl, macBundlePath, macSelfInstallBlocker, macZipAsset } from '@core/macUpdate';
import { MacSelfUpdater } from '../../src/main/macUpdate';

const RELEASES = 'https://github.com/o/r/releases';

describe('pure pieces', () => {
  it('finds the bundle of the running executable', () => {
    expect(macBundlePath('/Applications/Claude Visualized.app/Contents/MacOS/Claude Visualized')).toBe('/Applications/Claude Visualized.app');
    expect(macBundlePath('/Users/me/Apps/X.app/Contents/MacOS/X')).toBe('/Users/me/Apps/X.app');
    expect(macBundlePath('C:\\Program Files\\x.exe')).toBeNull();
    expect(macBundlePath('/usr/local/bin/electron')).toBeNull();
    expect(bundleParent('/Applications/Claude Visualized.app')).toBe('/Applications');
  });
  it('says why a copy cannot replace itself, and nothing when it can', () => {
    expect(macSelfInstallBlocker('/Applications/C.app', true)).toBeNull();
    expect(macSelfInstallBlocker(null, true)).toMatch(/not running from an app bundle/);
    expect(macSelfInstallBlocker('/private/var/folders/x/AppTranslocation/ABC/d/C.app', true)).toMatch(/Move Claude Visualized to Applications/);
    expect(macSelfInstallBlocker('/Volumes/Claude Visualized 0.12.2/C.app', true)).toMatch(/disk image/);
    expect(macSelfInstallBlocker('/Applications/C.app', false)).toMatch(/cannot write to \/Applications/);
  });
  it('picks the .zip from the feed and builds its URL', () => {
    const files = [
      { url: 'C-1.0.0-mac-universal.dmg', sha512: 'a' },
      { url: 'C-1.0.0-mac-universal.zip', sha512: 'b', size: 9 },
    ];
    expect(macZipAsset(files)).toEqual(files[1]);
    expect(macZipAsset([{ url: 'x.dmg', sha512: 'a' }])).toBeNull();
    expect(macZipAsset(undefined)).toBeNull();
    expect(macAssetUrl(RELEASES, '1.0.0', 'C 1.zip')).toBe(`${RELEASES}/download/v1.0.0/C%201.zip`);
    expect(macAssetUrl(RELEASES, '1.0.0', 'C.zip', 'http://127.0.0.1:9/feed')).toBe('http://127.0.0.1:9/feed/C.zip');
    expect(macAssetUrl(RELEASES, '1.0.0', 'https://cdn/x.zip')).toBe('https://cdn/x.zip');
  });
});

describe('MacSelfUpdater.download', () => {
  const dirs: string[] = [];
  const servers: http.Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const serve = async (body: Buffer) => {
    const s = http.createServer((_q, r) => r.writeHead(200, { 'content-length': String(body.length) }).end(body));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
  };
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-macupd-'));
    dirs.push(d);
    return d;
  };

  it('refuses a release without a .zip', async () => {
    const u = new MacSelfUpdater(tmp(), '/Applications/C.app/Contents/MacOS/C');
    await expect(u.download({ version: '1.0.0', files: [{ url: 'x.dmg', sha512: 'a' }] }, () => {})).rejects.toThrow(/no macOS \.zip/);
  });
  it('refuses a download whose checksum does not match, after reporting progress', async () => {
    const body = Buffer.alloc(200_000, 7);
    const feed = await serve(body);
    const u = new MacSelfUpdater(tmp(), '/Applications/C.app/Contents/MacOS/C', feed);
    const seen: number[] = [];
    const wrong = crypto.createHash('sha512').update('something else').digest('base64');
    await expect(u.download({ version: '1.0.0', files: [{ url: 'C.zip', sha512: wrong, size: body.length }] }, (p) => seen.push(p))).rejects.toThrow(
      /checksum/,
    );
    expect(seen.at(-1)).toBe(100);
    expect(u.ready).toBeNull();
    expect(u.launchSwap(true)).toBe(false);
  });
});

// the swap script, for real: needs a POSIX sh (macOS, Linux, or Git for Windows)
const sh = (() => {
  for (const c of ['sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']) {
    if (spawnSync(c, ['-c', 'exit 0']).status === 0) return c;
  }
  return null;
})();

describe.skipIf(!sh)('the swap script', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** a folder with an "installed" app, a staged new one, stub tools on PATH, and the script */
  function setup(dittoFails = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-swap-'));
    dirs.push(root);
    const p = (...s: string[]) => path.join(root, ...s).replace(/\\/g, '/');
    fs.mkdirSync(p('Applications', 'C.app', 'Contents'), { recursive: true });
    fs.writeFileSync(p('Applications', 'C.app', 'Contents', 'v'), 'old');
    fs.mkdirSync(p('staged', 'C.app', 'Contents'), { recursive: true });
    fs.writeFileSync(p('staged', 'C.app', 'Contents', 'v'), 'new');
    fs.mkdirSync(p('bin'));
    fs.writeFileSync(p('bin', 'ditto'), dittoFails ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o755 });
    fs.writeFileSync(p('bin', 'open'), `#!/bin/sh\necho "$1" >> "${p('opened')}"\n`, { mode: 0o755 });
    fs.writeFileSync(p('bin', 'xattr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(p('swap.sh'), MAC_SWAP_SCRIPT);
    return { root, p };
  }
  // (cd + pwd turns C:/… into a PATH-safe /c/… under Git for Windows); a failed swap exits 1 on purpose, so no execFileSync
  const swap = (p: (...s: string[]) => string, relaunch: boolean) => {
    const r = spawnSync(sh!, [
      '-c',
      `PATH="$(cd "${p('bin')}" && pwd):$PATH" sh "${p('swap.sh')}" 999999 "${p('Applications', 'C.app')}" "${p('staged', 'C.app')}" ${relaunch ? 1 : 0} "${p('log')}"`,
    ]);
    if (r.error) throw r.error;
    return r.status;
  };

  it('puts the new bundle in place, cleans up, and reopens on "Restart & update"', () => {
    const { p } = setup();
    expect(swap(p, true)).toBe(0);
    expect(fs.readFileSync(p('Applications', 'C.app', 'Contents', 'v'), 'utf8')).toBe('new');
    expect(fs.existsSync(p('Applications', 'C.app.cv-old'))).toBe(false);
    expect(fs.existsSync(p('Applications', 'C.app.cv-new'))).toBe(false);
    expect(fs.existsSync(p('staged', 'C.app'))).toBe(false);
    expect(fs.readFileSync(p('opened'), 'utf8').trim()).toBe(p('Applications', 'C.app'));
    expect(fs.readFileSync(p('log'), 'utf8')).toMatch(/updated/);
  });
  it('on quit, swaps without reopening', () => {
    const { p } = setup();
    swap(p, false);
    expect(fs.readFileSync(p('Applications', 'C.app', 'Contents', 'v'), 'utf8')).toBe('new');
    expect(fs.existsSync(p('opened'))).toBe(false);
  });
  it('a failed copy leaves the old app untouched and still reopens it', () => {
    const { p } = setup(true);
    expect(swap(p, true)).toBe(1);
    expect(fs.readFileSync(p('Applications', 'C.app', 'Contents', 'v'), 'utf8')).toBe('old');
    expect(fs.existsSync(p('Applications', 'C.app.cv-new'))).toBe(false);
    expect(fs.readFileSync(p('opened'), 'utf8').trim()).toBe(p('Applications', 'C.app'));
    expect(fs.readFileSync(p('log'), 'utf8')).toMatch(/copy failed/);
  });
});
