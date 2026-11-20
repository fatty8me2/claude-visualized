// Pure pieces of the auto-update feature (state machine, platform/signing decision, error and release-notes handling).
// No electron imports, so it is unit-tested; src/main/updater.ts wires it to electron-updater.

export const RELEASES_URL = 'https://github.com/fatty8me2/claude-visualized/releases';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled';

/**
 * auto: download in the background and install on restart (Windows: NSIS; macOS: the app swaps its own bundle, see macUpdate.ts).
 * manual: we can see new versions but cannot install them ourselves (a Mac app run from the .dmg or a read-only folder): link
 *   to the release page.
 * disabled: updates are off in this run (dev build, CLAUDE_VIS_NO_UPDATES).
 */
export type UpdateMode = 'auto' | 'manual' | 'disabled';

export interface UpdateView {
  status: UpdateStatus;
  mode: UpdateMode;
  currentVersion: string;
  /** new version, for available / downloading / downloaded */
  version?: string;
  /** plain-text release notes snippet */
  releaseNotes?: string;
  percent?: number;
  error?: string;
  /** why updates are disabled, or the manual-mode explanation */
  reason?: string;
  /** a check found no releases at all (404: none published yet, or the repo is private) */
  noReleases?: boolean;
  /** the last check finished and this is the newest version */
  upToDate?: boolean;
  lastCheckedAt?: number;
  /** where to get the new version by hand */
  releaseUrl?: string;
  /** "Update now" was pressed: restart as soon as the download is done */
  installWhenReady?: boolean;
  /** this run is the first of a new version: the one that ran before it (for a one-time "Updated to …") */
  updatedFrom?: string;
  /**
   * macOS, right after a release: the new release is out but its Mac files (latest-mac.yml) are not attached yet (CI adds them
   * about ten minutes after the Windows build). Nothing to install yet; the app checks again soon.
   */
  pendingRelease?: boolean;
  /** the last attempt to install an update did not finish, and why (shown until a check says we are up to date) */
  installError?: string;
  /** manual mode on macOS where "Move to Applications" fixes it (translocated, or run from the disk image) */
  movable?: boolean;
}

export interface ModeInput {
  isPackaged: boolean;
  platform: string;
  /** CLAUDE_VIS_NO_UPDATES is set */
  envDisabled: boolean;
  /** CLAUDE_VIS_UPDATE_URL is set (tests only): allows updates in an unpackaged app */
  feedOverride: boolean;
  /** the macOS app carries a Developer ID signature. Flip this when signing is set up (see RELEASING.md). */
  macSigned: boolean;
  /** unsigned macOS: why the app cannot replace its own bundle (macSelfInstallBlocker), or null when it can */
  macBlocker?: string | null;
  /** unsigned macOS: the blocker is one "Move to Applications" fixes (macCanMoveToApplications) */
  macMovable?: boolean;
}

export interface ModeDecision {
  mode: UpdateMode;
  reason?: string;
  movable?: boolean;
}

/**
 * Which update behaviour this run gets.
 * Windows: electron-updater only verifies the installer's publisher when the build sets a publisherName, so unsigned NSIS
 *   updates install fine (SmartScreen shows only for the very first manual install).
 * macOS: Squirrel.Mac refuses to apply an update to an app without a valid code signature, so the unsigned app downloads the
 *   new .zip itself, checks it, and swaps its own bundle on restart (main/macUpdate.ts). When it cannot (run from the .dmg, a
 *   folder it may not write), it points to the release page.
 */
export function decideUpdateMode(i: ModeInput): ModeDecision {
  if (i.envDisabled) return { mode: 'disabled', reason: 'Updates are turned off for this run (CLAUDE_VIS_NO_UPDATES).' };
  if (!i.isPackaged && !i.feedOverride) return { mode: 'disabled', reason: 'Updates are disabled in development builds.' };
  if (i.platform === 'darwin' && !i.macSigned && i.macBlocker)
    return i.macMovable ? { mode: 'manual', reason: i.macBlocker, movable: true } : { mode: 'manual', reason: i.macBlocker };
  return { mode: 'auto' };
}

export function initialUpdateView(currentVersion: string, decision: ModeDecision): UpdateView {
  return decision.mode === 'disabled'
    ? { status: 'disabled', mode: 'disabled', currentVersion, reason: decision.reason }
    : { status: 'idle', mode: decision.mode, currentVersion, reason: decision.reason, ...(decision.movable ? { movable: true } : {}) };
}

export type UpdateAction =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string; releaseUrl?: string }
  | { type: 'not-available'; at: number }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string; at: number }
  | { type: 'install-when-ready'; on: boolean };

export function releaseUrlFor(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/** A 404 from the feed: the releases cannot be seen (a private or moved repo), or none are published yet. */
export function isNoReleasesError(message: string): boolean {
  return /\b404\b|not found|cannot find (latest|channel)|ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS|CHANNEL_FILE_NOT_FOUND)|unable to find latest version/i.test(
    message,
  );
}

/**
 * macOS right after a release: the latest release has no latest-mac.yml yet (the Windows build is published first and CI attaches
 * the Mac files about ten minutes later). electron-updater reports it as ERR_UPDATER_CHANNEL_FILE_NOT_FOUND naming latest-mac.yml.
 * That is "nothing to install yet", not a broken feed. A feed that cannot be seen at all (private or moved repo) fails earlier,
 * with "Unable to find latest version" / no published versions, and stays a visible error.
 */
export function isMacChannelPending(message: string): boolean {
  if (!/latest-mac\.yml/i.test(message)) return false;
  if (/unable to find latest version|ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS)|no published versions/i.test(message)) return false;
  return /cannot find|\b404\b|not found|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(message);
}

/** How soon to check again after isMacChannelPending (instead of the hourly check). */
export const PENDING_RELEASE_RECHECK_MS = 10 * 60_000;

export function reduceUpdate(s: UpdateView, a: UpdateAction): UpdateView {
  if (s.status === 'disabled') return s;
  switch (a.type) {
    case 'checking':
      // a finished download or one in flight is not undone by a later check
      if (s.status === 'downloading' || s.status === 'downloaded') return s;
      return { ...s, status: 'checking', error: undefined, noReleases: undefined, upToDate: undefined, pendingRelease: undefined };
    case 'available':
      if (s.status === 'downloaded' && s.version === a.version) return s;
      return {
        ...s,
        status: 'available',
        version: a.version,
        releaseNotes: a.releaseNotes,
        releaseUrl: a.releaseUrl ?? releaseUrlFor(a.version),
        percent: undefined,
        error: undefined,
        noReleases: undefined,
        upToDate: undefined,
        pendingRelease: undefined,
      };
    case 'not-available':
      if (s.status === 'downloading' || s.status === 'downloaded') return s;
      return {
        ...s,
        status: 'idle',
        version: undefined,
        releaseNotes: undefined,
        percent: undefined,
        error: undefined,
        noReleases: undefined,
        upToDate: true,
        pendingRelease: undefined,
        installError: undefined,
        lastCheckedAt: a.at,
      };
    case 'progress':
      return { ...s, status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(a.percent))) };
    case 'downloaded':
      return { ...s, status: 'downloaded', version: a.version, percent: 100, error: undefined };
    case 'install-when-ready':
      return a.on === !!s.installWhenReady ? s : { ...s, installWhenReady: a.on || undefined };
    case 'error':
      if (s.status === 'downloaded') return s; // keep offering the restart
      // the Mac files of a fresh release are not attached yet: calm, and re-checked soon (Updater)
      if (isMacChannelPending(a.message))
        return {
          ...s,
          status: 'idle',
          pendingRelease: true,
          error: undefined,
          noReleases: undefined,
          upToDate: undefined,
          version: undefined,
          percent: undefined,
          lastCheckedAt: a.at,
        };
      // a released app always has releases to find: a 404 means the feed went out of reach (e.g. the repo went private), and
      // that must be visible, or the app silently stops updating
      if (isNoReleasesError(a.message))
        return {
          ...s,
          status: 'error',
          error: NO_FEED_ERROR,
          noReleases: true,
          upToDate: undefined,
          version: undefined,
          percent: undefined,
          installWhenReady: undefined,
          lastCheckedAt: a.at,
        };
      return { ...s, status: 'error', error: a.message.slice(0, 300), percent: undefined, installWhenReady: undefined, lastCheckedAt: a.at };
  }
}

export const NO_FEED_ERROR = 'The releases could not be found (404). The repository may be private or moved, so this copy cannot see new versions.';

/** electron-updater gives release notes as a string (often HTML) or an array of {version, note}. Reduce to a short plain-text snippet. */
export function releaseNotesSnippet(notes: unknown, max = 400): string | undefined {
  let raw = '';
  if (typeof notes === 'string') raw = notes;
  else if (Array.isArray(notes))
    raw = notes
      .map((n) => (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string' ? (n as { note: string }).note : ''))
      .filter(Boolean)
      .join('\n\n');
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** One line for the Settings dialog. */
export function describeUpdate(s: UpdateView): string {
  switch (s.status) {
    case 'disabled':
      return s.reason ?? 'Updates are disabled.';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return s.mode === 'manual' ? `Version ${s.version} is available. Download it from the releases page.` : `Version ${s.version} is available.`;
    case 'downloading':
      return `Downloading version ${s.version ?? ''} (${s.percent ?? 0}%)…`;
    case 'downloaded':
      return `Version ${s.version} is ready. Restart to update.`;
    case 'error':
      return s.noReleases ? (s.error ?? NO_FEED_ERROR) : `Could not check for updates: ${s.error ?? 'unknown error'}`;
    case 'idle':
      if (s.pendingRelease) return 'A new version is being published. Checking again in a few minutes.';
      if (s.upToDate) return 'You are up to date.';
      return 'Not checked yet.';
  }
}

// ---- the "update available" pop-up (src/renderer/components/UpdatePopup.tsx) and the re-check when the window is shown again ----

/**
 * found: a new version is known (manual mode stays here); downloading: progress; ready: downloaded, restart to install;
 * updated: the first run of a new version; status: opened from the title bar with nothing pending (up to date, checking, error).
 */
export type UpdatePopupStage = 'found' | 'downloading' | 'ready' | 'updated' | 'status';

export interface UpdatePopupModel {
  stage: UpdatePopupStage;
  mode: UpdateMode;
  version: string;
  releaseNotes?: string;
  percent: number;
  releaseUrl?: string;
}

/**
 * What the pop-up shows for this state, or null when there is nothing to announce (idle, checking, error, disabled). `opened`:
 * the user opened it from the title bar, so a state with nothing to announce shows as 'status'.
 */
export function updatePopupModel(v: UpdateView | null, opened = false): UpdatePopupModel | null {
  if (!v) return null;
  const pending = v.mode !== 'disabled' && !!v.version;
  const stage: UpdatePopupStage | null =
    pending && v.status === 'available'
      ? 'found'
      : pending && v.status === 'downloading'
        ? 'downloading'
        : pending && v.status === 'downloaded'
          ? 'ready'
          : !opened && v.updatedFrom && (v.status === 'idle' || v.status === 'checking' || v.status === 'disabled')
            ? 'updated'
            : opened
              ? 'status'
              : null;
  if (!stage) return null;
  if (stage === 'updated' || stage === 'status')
    return { stage, mode: v.mode, version: v.currentVersion, percent: 0, releaseUrl: releaseUrlFor(v.currentVersion) };
  if (!v.version) return null;
  return {
    stage,
    mode: v.mode,
    version: v.version,
    releaseNotes: v.releaseNotes,
    percent: stage === 'ready' ? 100 : Math.max(0, Math.min(100, Math.round(v.percent ?? 0))),
    releaseUrl: v.releaseUrl ?? releaseUrlFor(v.version),
  };
}

/** "Later" was pressed for this version during this window-show (the renderer counts shows: app start and every re-show from the tray). */
export interface UpdatePopupDismissal {
  version: string;
  showEpoch: number;
}

/**
 * Whether the pop-up is up. It announces an update until "Later" is pressed; "Later" hides that version for the rest of this
 * window-show, and it comes back the next time the window is opened (app start, or re-shown from the tray) while still pending.
 */
export function shouldShowUpdatePopup(v: UpdateView | null, o: { enabled: boolean; showEpoch: number; dismissed: UpdatePopupDismissal | null }): boolean {
  if (!o.enabled) return false;
  const m = updatePopupModel(v);
  if (!m) return false;
  // "Updated to …" is said once: closing it is final for this run (the next run is no longer the first of the version)
  if (m.stage === 'updated') return !(o.dismissed && o.dismissed.version === m.version);
  return !(o.dismissed && o.dismissed.version === m.version && o.dismissed.showEpoch === o.showEpoch);
}

/** Minimum gap between checks triggered by re-showing the window (the 6-hourly timer still runs). */
export const RECHECK_ON_SHOW_MS = 30 * 60_000;

/**
 * When the window is shown again (from the tray), check now if the last check started at least `minGapMs` ago. Never while one
 * is running, before the first scheduled check, or when an update is already known (the pop-up already has something to show).
 */
export function shouldCheckOnShow(v: UpdateView, lastCheckAt: number | undefined, now: number, minGapMs = RECHECK_ON_SHOW_MS): boolean {
  if (v.mode === 'disabled' || lastCheckAt === undefined) return false;
  if (v.status === 'checking' || v.status === 'available' || v.status === 'downloading' || v.status === 'downloaded') return false;
  return now - lastCheckAt >= minGapMs;
}

// ---- the title bar's update chip (src/renderer/components/UpdateChip.tsx) ----

export type UpdateChipState = 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateChipModel {
  state: UpdateChipState;
  label: string;
  title: string;
}

/**
 * What the title bar shows next to the version, or null when there is nothing to act on. Only a feed that cannot be reached at
 * all (404) shows as an error there: a passing network failure is retried and stays in the update card.
 */
export function updateChipModel(v: UpdateView | null): UpdateChipModel | null {
  if (!v || v.mode === 'disabled') return null;
  switch (v.status) {
    case 'downloaded':
      return { state: 'ready', label: 'Restart to update', title: `Version ${v.version} is downloaded. Restart to finish updating.` };
    case 'downloading':
      return { state: 'downloading', label: `Updating ${v.percent ?? 0}%`, title: `Downloading version ${v.version ?? ''}…` };
    case 'available':
      return v.mode === 'manual'
        ? { state: 'available', label: `Get v${v.version}`, title: `Version ${v.version} is available on the releases page.` }
        : { state: 'available', label: `Update to v${v.version}`, title: `Version ${v.version} is available. Click to download it and restart.` };
    case 'error':
      if (v.noReleases) return { state: 'error', label: 'Updates unreachable', title: v.error ?? NO_FEED_ERROR };
      return v.installError ? { state: 'error', label: 'Update failed', title: v.installError } : null;
    default:
      return null;
  }
}

/** True when this run is the first of a newer version than the last one that ran (so it can say "Updated to …" once). */
export function isNewerVersion(current: string, previous: string | undefined): boolean {
  if (!previous) return false;
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number(n) || 0);
  const a = parse(current);
  const b = parse(previous);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// ---- installing by itself at a quiet moment, and coming back the way the window was ----

/** What the main process sees of the user, every AUTO_INSTALL_POLL_MS. */
export interface QuietInput {
  /** the main window exists and is shown (not hidden to the tray) */
  visible: boolean;
  minimized: boolean;
  /** one of the app's windows has keyboard focus */
  focused: boolean;
  /** seconds since the last keyboard or mouse input anywhere (powerMonitor.getSystemIdleTime) */
  idleSeconds: number;
}

/** No input for this long counts as away, even with the window in front. */
export const QUIET_IDLE_SECONDS = 120;
/** How often a downloaded update looks for a quiet moment. */
export const AUTO_INSTALL_POLL_MS = 30_000;

/**
 * A moment when restarting the app interrupts nobody: the window is hidden (tray), minimized or not focused, or the computer has
 * had no input for QUIET_IDLE_SECONDS. Never while the user is working in the window.
 */
export function isQuietMoment(q: QuietInput, minIdleSeconds = QUIET_IDLE_SECONDS): boolean {
  if (!q.visible || q.minimized || !q.focused) return true;
  return q.idleSeconds >= minIdleSeconds;
}

/**
 * Install a downloaded update by itself now: "Install updates automatically" is on, this copy can install (auto mode), the update
 * is downloaded, it is not the version whose install already failed (no restart loop), and it is a quiet moment.
 */
export function shouldAutoInstall(v: UpdateView, o: { enabled: boolean; quiet: boolean; failedVersion?: string }): boolean {
  return o.enabled && o.quiet && v.mode === 'auto' && v.status === 'downloaded' && !!v.version && v.version !== o.failedVersion;
}

/** How the window comes back after the update restart: as it was, without taking focus unless it had it. */
export type RestartWindow = 'normal' | 'inactive' | 'minimized' | 'hidden';

export function restartWindowState(q: Pick<QuietInput, 'visible' | 'minimized' | 'focused'>): RestartWindow {
  if (!q.visible) return 'hidden';
  if (q.minimized) return 'minimized';
  return q.focused ? 'normal' : 'inactive';
}

/** The one-shot file written just before an update restart (<userData>/restart-update.json) and read once at the next start. */
export interface RestartMarker {
  window: RestartWindow;
  /** the version being installed */
  version: string;
  at: number;
}

export const RESTART_MARKER_FILE = 'restart-update.json';
/** A marker older than this is not about this start (the install never relaunched; the user opened the app later). */
export const RESTART_MARKER_MAX_AGE_MS = 10 * 60_000;
const RESTART_WINDOWS: readonly RestartWindow[] = ['normal', 'inactive', 'minimized', 'hidden'];

/**
 * Read the marker at startup: how to show the window (only when the marker is fresh) and, when this run is still older than the
 * version the restart was installing, that version (its install did not take).
 */
export function readRestartMarker(text: string | null, now: number, currentVersion: string): { window: RestartWindow; failedVersion?: string } {
  if (!text) return { window: 'normal' };
  let m: Partial<RestartMarker> | null;
  try {
    m = JSON.parse(text) as Partial<RestartMarker> | null;
  } catch {
    return { window: 'normal' };
  }
  if (!m || typeof m !== 'object') return { window: 'normal' };
  const fresh = typeof m.at === 'number' && now - m.at >= 0 && now - m.at <= RESTART_MARKER_MAX_AGE_MS;
  const window: RestartWindow = fresh && RESTART_WINDOWS.includes(m.window as RestartWindow) ? (m.window as RestartWindow) : 'normal';
  const failedVersion = typeof m.version === 'string' && isNewerVersion(m.version, currentVersion) ? m.version : undefined;
  return failedVersion ? { window, failedVersion } : { window };
}

/** What to say when an update restart did not install `version`. */
export function installFailedMessage(version: string, reason?: string): string {
  const what = reason ? `Updating to v${version} did not finish: ${reason}.` : `Updating to v${version} did not finish.`;
  return `${what} It is downloaded again at the next check; "Restart & update" tries again.`;
}
