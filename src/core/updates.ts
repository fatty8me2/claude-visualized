// Pure pieces of the auto-update feature (state machine, platform/signing decision, error and release-notes handling).
// No electron imports, so it is unit-tested; src/main/updater.ts wires it to electron-updater.

export const RELEASES_URL = 'https://github.com/fatty8me2/claude-visualized/releases';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled';

/**
 * auto: download in the background and install on restart.
 * manual: we can see new versions but cannot install them ourselves (unsigned macOS): link to the release page.
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
}

export interface ModeDecision {
  mode: UpdateMode;
  reason?: string;
}

/**
 * Which update behaviour this run gets.
 * Windows: electron-updater only verifies the installer's publisher when the build sets a publisherName, so unsigned NSIS
 *   updates install fine (SmartScreen shows only for the very first manual install).
 * macOS: Squirrel.Mac refuses to apply an update to an app without a valid code signature, so unsigned builds just point to the release page.
 */
export function decideUpdateMode(i: ModeInput): ModeDecision {
  if (i.envDisabled) return { mode: 'disabled', reason: 'Updates are turned off for this run (CLAUDE_VIS_NO_UPDATES).' };
  if (!i.isPackaged && !i.feedOverride) return { mode: 'disabled', reason: 'Updates are disabled in development builds.' };
  if (i.platform === 'darwin' && !i.macSigned)
    return {
      mode: 'manual',
      reason: 'This Mac build is not signed with an Apple Developer ID, so it cannot update itself. New versions are downloaded from the releases page.',
    };
  return { mode: 'auto' };
}

export function initialUpdateView(currentVersion: string, decision: ModeDecision): UpdateView {
  return decision.mode === 'disabled'
    ? { status: 'disabled', mode: 'disabled', currentVersion, reason: decision.reason }
    : { status: 'idle', mode: decision.mode, currentVersion, reason: decision.reason };
}

export type UpdateAction =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string; releaseUrl?: string }
  | { type: 'not-available'; at: number }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string; at: number };

export function releaseUrlFor(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/** A 404 from the feed means "nothing published yet" (or a private repo): not worth an error message. */
export function isNoReleasesError(message: string): boolean {
  return /\b404\b|not found|cannot find (latest|channel)|ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS|CHANNEL_FILE_NOT_FOUND)|unable to find latest version/i.test(
    message,
  );
}

export function reduceUpdate(s: UpdateView, a: UpdateAction): UpdateView {
  if (s.status === 'disabled') return s;
  switch (a.type) {
    case 'checking':
      // a finished download or one in flight is not undone by a later check
      if (s.status === 'downloading' || s.status === 'downloaded') return s;
      return { ...s, status: 'checking', error: undefined, noReleases: undefined, upToDate: undefined };
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
        lastCheckedAt: a.at,
      };
    case 'progress':
      return { ...s, status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(a.percent))) };
    case 'downloaded':
      return { ...s, status: 'downloaded', version: a.version, percent: 100, error: undefined };
    case 'error':
      if (s.status === 'downloaded') return s; // keep offering the restart
      if (isNoReleasesError(a.message))
        return { ...s, status: 'idle', error: undefined, noReleases: true, upToDate: undefined, version: undefined, percent: undefined, lastCheckedAt: a.at };
      return { ...s, status: 'error', error: a.message.slice(0, 300), percent: undefined, lastCheckedAt: a.at };
  }
}

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
      return s.mode === 'manual' ? `Version ${s.version} is available. Download the new version from the releases page.` : `Version ${s.version} is available.`;
    case 'downloading':
      return `Downloading version ${s.version ?? ''} (${s.percent ?? 0}%)…`;
    case 'downloaded':
      return `Version ${s.version} is ready. Restart to update.`;
    case 'error':
      return `Could not check for updates: ${s.error ?? 'unknown error'}`;
    case 'idle':
      if (s.noReleases) return 'No releases published yet.';
      if (s.upToDate) return 'You are up to date.';
      return 'Not checked yet.';
  }
}
