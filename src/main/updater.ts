import { app } from 'electron';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import {
  decideUpdateMode,
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

  constructor(private deps: UpdaterDeps) {
    const decision = decideUpdateMode({
      isPackaged: app.isPackaged,
      platform: process.platform,
      envDisabled: !!process.env.CLAUDE_VIS_NO_UPDATES,
      feedOverride: !!this.feedUrl,
      macSigned: MAC_SIGNED,
      macBlocker: this.mac?.blocker() ?? null,
    });
    this.view = initialUpdateView(app.getVersion(), decision);
    if (isNewerVersion(app.getVersion(), deps.previousVersion)) this.view = { ...this.view, updatedFrom: deps.previousVersion };
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
  }

  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
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

  /** "Restart & update": quit, install, relaunch. Only meaningful once downloaded. */
  install(): boolean {
    if (this.view.status !== 'downloaded' || !this.au) return false;
    if (this.mac) {
      if (!this.mac.launchSwap(true)) return false;
      this.deps.beforeInstall();
      app.quit();
      return true;
    }
    this.deps.beforeInstall();
    // not silent (shows the NSIS progress), and relaunch afterwards
    this.au.quitAndInstall(false, true);
    return true;
  }

  /** The app is quitting: a downloaded Mac update is put in place without reopening (Windows' installer does the same itself). */
  onQuit(): void {
    if (this.mac && this.view.status === 'downloaded') this.mac.launchSwap(false);
  }
}
