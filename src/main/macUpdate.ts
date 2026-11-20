// The unsigned macOS app updating itself (see src/core/macUpdate.ts for why and how). Download the release's .zip, check its
// sha512 against the feed, unpack it with ditto into userData/mac-update, and on quit hand the swap to a detached shell script.
// Everything stays in the user's own folders; nothing runs with more rights than the app has.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAC_SWAP_SCRIPT,
  bundleParent,
  lastSwapOutcome,
  macAssetUrl,
  macBlockerKind,
  macBundlePath,
  macCanMoveToApplications,
  macSelfInstallBlocker,
  macZipAsset,
  type FeedFile,
  type SwapOutcome,
} from '@core/macUpdate';
import { RELEASES_URL } from '@core/updates';

const run = promisify(execFile);

export interface MacFeedInfo {
  version: string;
  files?: FeedFile[];
}

export class MacSelfUpdater {
  readonly bundle: string | null;
  private readonly dir: string;
  /** the unpacked new bundle, once downloaded and checked */
  private staged: { version: string; app: string } | null = null;
  private launched = false;

  constructor(
    userData: string,
    execPath: string = process.execPath,
    private feedOverride?: string,
  ) {
    this.bundle = macBundlePath(execPath);
    this.dir = path.join(userData, 'mac-update');
  }

  private parentWritable(): boolean {
    let writable = false;
    if (this.bundle) {
      try {
        fs.accessSync(bundleParent(this.bundle), fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }
    return writable;
  }

  /** Why this copy cannot update itself, or null when it can. */
  blocker(): string | null {
    return macSelfInstallBlocker(this.bundle, this.parentWritable());
  }

  /** The blocker is one "Move to Applications" fixes (translocated, or run from the disk image). */
  movable(): boolean {
    return macCanMoveToApplications(macBlockerKind(this.bundle, this.parentWritable()));
  }

  /** How the last swap went (swap.log), or null when there was none or it has no outcome. */
  lastOutcome(): SwapOutcome | null {
    try {
      return lastSwapOutcome(fs.readFileSync(path.join(this.dir, 'swap.log'), 'utf8'));
    } catch {
      return null;
    }
  }

  get ready(): string | null {
    return this.staged?.version ?? null;
  }

  /** Download, verify and unpack `info`'s .zip. Rejects with a readable message on any problem. */
  async download(info: MacFeedInfo, onProgress: (percent: number) => void): Promise<void> {
    const asset = macZipAsset(info.files);
    if (!asset) throw new Error(`Release ${info.version} has no macOS .zip to update from.`);
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    await fs.promises.mkdir(this.dir, { recursive: true });
    const zip = path.join(this.dir, 'update.zip');
    const url = macAssetUrl(RELEASES_URL, info.version, asset.url, this.feedOverride);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(zip);
    let got = 0;
    let lastPct = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) onProgress((lastPct = pct));
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    if (hash.digest('base64') !== asset.sha512) throw new Error('The download did not match its checksum, so it was not installed.');
    const unpacked = path.join(this.dir, 'app');
    await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    await fs.promises.rm(zip, { force: true });
    const name = (await fs.promises.readdir(unpacked)).find((f) => f.endsWith('.app'));
    if (!name) throw new Error('The download held no app.');
    const app = path.join(unpacked, name);
    const plist = path.join(app, 'Contents', 'Info.plist');
    const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
    if (stdout.trim() !== info.version) throw new Error(`The download is version ${stdout.trim() || '?'}, not ${info.version}.`);
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
    this.staged = { version: info.version, app };
  }

  /**
   * Start the swap: a detached script waits for this process to exit, puts the new bundle in place and, with `relaunch`, opens
   * it (`'background'`: without taking focus, for an automatic update). The caller quits the app right after. Returns false
   * when there is nothing to install.
   */
  launchSwap(relaunch: boolean | 'background'): boolean {
    if (!this.staged || !this.bundle || this.launched) return false;
    const script = path.join(this.dir, 'swap.sh');
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
    const log = path.join(this.dir, 'swap.log');
    const child = spawn(
      '/bin/sh',
      [script, String(process.pid), this.bundle, this.staged.app, relaunch === 'background' ? 'bg' : relaunch ? '1' : '0', log, this.staged.version],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    child.unref();
    this.launched = true;
    return true;
  }
}
