import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import {
  AUTO_INSTALL_POLL_MS,
  decideUpdateMode,
  installFailedMessage,
  isQuietMoment,
  PENDING_RELEASE_RECHECK_MS,
  RESTART_MARKER_FILE,
  restartWindowState,
  shouldAutoInstall,
  type QuietInput,
  type RestartMarker,
  initialUpdateView,
  isNewerVersion,
  RECHECK_ON_SHOW_MS,
  reduceUpdate,
  releaseNotesSnippet,
  shouldCheckOnShow,
  type UpdateAction,
  type UpdateView,
} from '@core/updates';
import { MacSelfUpdater, type MacFeedInfo } from './macUpdate';
import { testOverride } from './paths';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 60 * 60_000;

/** Flip to true once the macOS build is signed with a Developer ID (then Squirrel.Mac can update it). See RELEASING.md. */
const MAC_SIGNED = false;

export interface UpdaterDeps {
  /** "Automatically download updates" from the config */
  autoDownload: () => boolean;
  /** called with every new state (broadcast + tray) */
  onChange: (v: UpdateView) => void;
  /** lets the window-close handler stand aside while the installer takes over */
  beforeInstall: () => void;
  /** the version that ran before this one (config.lastRunVersion) */
  previousVersion?: string;
  /** "Install updates automatically" from the config */
  autoInstall: () => boolean;
  /** the main window and the user's activity, for the quiet-moment check (isQuietMoment) */
  quiet: () => QuietInput;
  /** an update restart into this version did not install it (readRestartMarker): never auto-install it again in this run */
  failedVersion?: string;
}

/**
 * Wraps electron-updater. All decisions live in src/core/updates.ts; this only translates its events into actions.
 * GitHub Releases feed in production (build.publish); CLAUDE_VIS_UPDATE_URL swaps in a generic feed for tests.
 */
export class Updater {
  private view: UpdateView;
  private au: AppUpdater | null = null;
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private busy = false;
  /** when the last check started (undefined until the first scheduled or manual one) */
  private lastCheckAt: number | undefined;
  private readonly recheckMs = process.env.CLAUDE_VIS_UPDATE_RECHECK_MS ? Number(process.env.CLAUDE_VIS_UPDATE_RECHECK_MS) : RECHECK_ON_SHOW_MS;
  private readonly feedUrl = process.env.CLAUDE_VIS_UPDATE_URL;
  /** unsigned macOS: the app replaces its own bundle (Squirrel.Mac would refuse) */
  private readonly mac: MacSelfUpdater | null =
    process.platform === 'darwin' && !MAC_SIGNED ? new MacSelfUpdater(app.getPath('userData'), process.execPath, this.feedUrl) : null;
  /** the release the last check found (what the Mac self-update downloads) */
  private latest: MacFeedInfo | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  /** a version whose install did not take (auto-install skips it; "Restart & update" still tries) */
  private failedVersion: string | undefined;
  private installing = false;
  /** test only: download() and install() only pretend, and install() writes what it would do to this file */
  private readonly fakeInstall = testOverride('CLAUDE_VIS_UPDATE_FAKE_INSTALL');
  private readonly quietPollMs = Number(testOverride('CLAUDE_VIS_UPDATE_QUIET_MS')) || AUTO_INSTALL_POLL_MS;

  constructor(private deps: UpdaterDeps) {
    const decision = decideUpdateMode({
      isPackaged: app.isPackaged,
      platform: process.platform,
      envDisabled: !!process.env.CLAUDE_VIS_NO_UPDATES,
      feedOverride: !!this.feedUrl,
      macSigned: MAC_SIGNED,
      macBlocker: this.mac?.blocker() ?? null,
      macMovable: this.mac?.movable() ?? false,
    });
    this.view = initialUpdateView(app.getVersion(), decision);
    if (isNewerVersion(app.getVersion(), deps.previousVersion)) this.view = { ...this.view, updatedFrom: deps.previousVersion };
    // a restart that did not install the new version: say why (macOS: the swap script's log), and do not retry it on our own
    const swap = this.mac?.lastOutcome();
    const swapFailed = swap && !swap.ok && swap.version && isNewerVersion(swap.version, app.getVersion()) ? swap : null;
    this.failedVersion = swapFailed?.version ?? deps.failedVersion;
    if (this.failedVersion && this.view.mode !== 'disabled') {
      const msg = installFailedMessage(this.failedVersion, swapFailed?.reason);
      this.view = { ...this.view, status: 'error', error: msg, installError: msg };
    }
  }

  get state(): UpdateView {
    return this.view;
  }

  private dispatch(a: UpdateAction) {
    const next = reduceUpdate(this.view, a);
    if (next === this.view) return;
    this.view = next;
    this.deps.onChange(next);
  }

  /** Schedule the first check (about 30 s after start) and the 6-hourly ones. No-op when updates are disabled. */
  start() {
    if (this.view.mode === 'disabled') return;
    this.first = setTimeout(() => void this.check(), process.env.CLAUDE_VIS_UPDATE_DELAY_MS ? Number(process.env.CLAUDE_VIS_UPDATE_DELAY_MS) : FIRST_CHECK_MS);
    this.every = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.first.unref();
    this.every.unref();
    this.quietTimer = setInterval(() => this.autoInstallIfQuiet(), this.quietPollMs);
    this.quietTimer.unref();
  }

  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    if (this.quietTimer) clearInterval(this.quietTimer);
    if (this.soon) clearTimeout(this.soon);
  }

  /** A downloaded update installs itself when nobody is using the window (see isQuietMoment / shouldAutoInstall). */
  private autoInstallIfQuiet() {
    if (this.installing || this.view.status !== 'downloaded') return;
    const quiet = isQuietMoment(this.deps.quiet());
    if (shouldAutoInstall(this.view, { enabled: this.deps.autoInstall(), quiet, failedVersion: this.failedVersion })) this.install(true);
  }

  private async updater(): Promise<AppUpdater> {
    if (this.au) return this.au;
    // electron-updater is CommonJS with a lazy `autoUpdater` getter: depending on the bundler interop it sits on the namespace or on `default`
    const mod = (await import('electron-updater')) as unknown as { autoUpdater?: AppUpdater; default?: { autoUpdater?: AppUpdater } };
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!autoUpdater) throw new Error('electron-updater did not load');
    autoUpdater.autoDownload = false; // we start downloads ourselves so the config toggle and mac "manual" mode are honoured
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    if (this.feedUrl) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl });
    }
    autoUpdater.on('checking-for-update', () => this.dispatch({ type: 'checking' }));
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.latest = { version: info.version, files: info.files };
      this.dispatch({ type: 'available', version: info.version, releaseNotes: releaseNotesSnippet(info.releaseNotes) });
      if (this.view.mode === 'auto' && this.deps.autoDownload()) void this.download();
    });
    autoUpdater.on('update-not-available', () => this.dispatch({ type: 'not-available', at: Date.now() }));
    autoUpdater.on('download-progress', (p) => this.dispatch({ type: 'progress', percent: p.percent }));
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => this.onDownloaded(info.version));
    autoUpdater.on('error', (e: Error) => this.dispatch({ type: 'error', message: String(e?.message ?? e), at: Date.now() }));
    this.au = autoUpdater;
    return autoUpdater;
  }

  /** Check now (on demand, or from the timers). Never throws: failures become state. */
  async check(): Promise<UpdateView> {
    if (this.view.mode === 'disabled' || this.busy) return this.view;
    if (this.view.status === 'downloading' || this.view.status === 'downloaded') return this.view;
    this.busy = true;
    this.lastCheckAt = Date.now();
    try {
      const au = await this.updater();
      await au.checkForUpdates();
    } catch (e) {
      // electron-updater also emits 'error' for most failures; the reducer treats a repeat as the same state
      this.dispatch({ type: 'error', message: (e as Error).message, at: Date.now() });
    } finally {
      this.busy = false;
    }
    // a fresh release whose Mac files are not attached yet: look again in ten minutes rather than in an hour
    if (this.view.pendingRelease && !this.soon) {
      this.soon = setTimeout(() => {
        this.soon = null;
        void this.check();
      }, PENDING_RELEASE_RECHECK_MS);
      this.soon.unref();
    }
    return this.view;
  }

  /**
   * The main window was shown again (from the tray): check now if the last check is older than 30 minutes. Does nothing before
   * the first scheduled check, while one is running, or when an update is already known. See shouldCheckOnShow.
   */
  checkIfStale(now = Date.now()): void {
    if (this.busy || !shouldCheckOnShow(this.view, this.lastCheckAt, now, this.recheckMs)) return;
    void this.check();
  }

  /** Start the download (when "Automatically download updates" is off, or for a retry). Manual mode never downloads. */
  async download(): Promise<UpdateView> {
    if (this.view.mode !== 'auto' || this.view.status !== 'available' || !this.au) return this.view;
    this.dispatch({ type: 'progress', percent: 0 });
    try {
      if (this.fakeInstall) {
        this.onDownloaded(this.view.version ?? '0.0.0');
        return this.view;
      }
      if (this.mac) {
        const info = this.latest;
        if (!info) throw new Error('No release to download.');
        await this.mac.download(info, (percent) => this.dispatch({ type: 'progress', percent }));
        this.onDownloaded(info.version);
      } else await this.au.downloadUpdate();
    } catch (e) {
      this.dispatch({ type: 'error', message: (e as Error).message, at: Date.now() });
    }
    return this.view;
  }

  private onDownloaded(version: string) {
    this.dispatch({ type: 'downloaded', version });
    if (this.view.installWhenReady) this.install();
  }

  /** One click: restart now when the update is downloaded, otherwise download it and restart as soon as it is done. */
  async updateNow(): Promise<UpdateView> {
    if (this.view.mode !== 'auto') return this.view;
    if (this.view.status === 'downloaded') {
      this.install();
      return this.view;
    }
    if (this.view.status !== 'available' && this.view.status !== 'downloading') return this.view;
    this.dispatch({ type: 'install-when-ready', on: true });
    if (this.view.status === 'available') await this.download();
    return this.view;
  }

  /**
   * Quit, install, relaunch. Only meaningful once downloaded. `auto`: the app chose a quiet moment by itself, so nothing is shown
   * (Windows: silent installer) and the new version does not take focus (macOS: reopened in the background). Either way a one-shot
   * marker tells the next start how the window was (hidden to the tray stays hidden) and which version it should be.
   */
  install(auto = false): boolean {
    if (this.view.status !== 'downloaded' || !this.au || this.installing) return false;
    const marker: RestartMarker = { window: restartWindowState(this.deps.quiet()), version: this.view.version ?? '', at: Date.now() };
    if (this.fakeInstall) {
      this.installing = true;
      fs.writeFileSync(this.fakeInstall, JSON.stringify({ auto, ...marker }));
      return true;
    }
    if (this.mac) {
      if (!this.mac.launchSwap(auto ? 'background' : true)) return false;
      this.installing = true;
      writeRestartMarker(marker);
      this.deps.beforeInstall();
      app.quit();
      return true;
    }
    this.installing = true;
    writeRestartMarker(marker);
    this.deps.beforeInstall();
    // the automatic one is silent; "Restart & update" shows the installer's progress. Both relaunch afterwards.
    this.au.quitAndInstall(auto, true);
    return true;
  }

  /**
   * macOS manual mode that "Move to Applications" fixes (translocated, or run from the disk image): Electron copies the app to
   * /Applications, quits and opens the moved copy, which then updates itself.
   */
  moveToApplications(): { ok: boolean; error?: string } {
    if (process.platform !== 'darwin' || !this.view.movable) return { ok: false, error: 'This copy does not need moving.' };
    try {
      return app.moveToApplicationsFolder() ? { ok: true } : { ok: false, error: 'The move was cancelled.' };
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'The app could not be moved.' };
    }
  }

  /** The app is quitting: a downloaded Mac update is put in place without reopening (Windows' installer does the same itself). */
  onQuit(): void {
    if (this.mac && this.view.status === 'downloaded') this.mac.launchSwap(false);
  }
}

function writeRestartMarker(m: RestartMarker) {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), RESTART_MARKER_FILE), JSON.stringify(m));
  } catch (e) {
    console.error('restart marker write failed', e);
  }
}

/** Read and delete the restart marker (once, at startup). */
export function takeRestartMarker(): string | null {
  const file = path.join(app.getPath('userData'), RESTART_MARKER_FILE);
  try {
    const text = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
    return text;
  } catch {
    return null;
  }
}
