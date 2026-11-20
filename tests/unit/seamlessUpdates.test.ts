// Seamless updates: the quiet-moment rule, the restart marker, the calm "Mac files not attached yet" state, the install-failed
// state and "Move to Applications" (all pure, src/core/updates.ts and src/core/macUpdate.ts).
import { describe, expect, it } from 'vitest';
import {
  decideUpdateMode,
  describeUpdate,
  initialUpdateView,
  installFailedMessage,
  isMacChannelPending,
  isQuietMoment,
  NO_FEED_ERROR,
  QUIET_IDLE_SECONDS,
  readRestartMarker,
  reduceUpdate,
  RESTART_MARKER_MAX_AGE_MS,
  restartWindowState,
  shouldAutoInstall,
  shouldCheckOnShow,
  updateChipModel,
  updatePopupModel,
  type QuietInput,
  type UpdateView,
} from '@core/updates';
import { lastSwapOutcome, macBlockerKind, macCanMoveToApplications } from '@core/macUpdate';

const idle = (over: Partial<UpdateView> = {}): UpdateView => ({ ...initialUpdateView('0.14.0', { mode: 'auto' }), ...over });
const ready = (over: Partial<UpdateView> = {}): UpdateView => idle({ status: 'downloaded', version: '0.15.0', percent: 100, ...over });
const active: QuietInput = { visible: true, minimized: false, focused: true, idleSeconds: 3 };

// What electron-updater 6 really says (GitHubProvider / GenericProvider), with the HttpError text it appends.
const MAC_PENDING_GITHUB =
  'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/o/r/releases/download/v0.15.0/latest-mac.yml): HttpError: 404 \n"method: GET url: https://github.com/o/r/releases/download/v0.15.0/latest-mac.yml\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n"';
const MAC_PENDING_GENERIC = 'Cannot find channel "latest-mac.yml" update info: HttpError: 404 Not Found';
const PRIVATE_REPO =
  'Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: 404 \n"method: GET url: https://github.com/o/r/releases/latest"';
const WIN_CHANNEL_MISSING =
  'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v0.15.0/latest.yml): HttpError: 404';

describe('the quiet moment', () => {
  it('never while the user is working in the window', () => {
    expect(isQuietMoment(active)).toBe(false);
    expect(isQuietMoment({ ...active, idleSeconds: QUIET_IDLE_SECONDS - 1 })).toBe(false);
  });
  it('hidden to the tray, minimized or in the background counts as not in use', () => {
    expect(isQuietMoment({ ...active, visible: false })).toBe(true);
    expect(isQuietMoment({ ...active, minimized: true })).toBe(true);
    expect(isQuietMoment({ ...active, focused: false })).toBe(true);
  });
  it('two minutes without input counts as away, even with the window in front', () => {
    expect(isQuietMoment({ ...active, idleSeconds: 120 })).toBe(true);
    expect(isQuietMoment({ ...active, idleSeconds: 119 })).toBe(false);
  });
  it('installs only a downloaded update, in auto mode, when enabled, quiet, and not the version that already failed', () => {
    expect(shouldAutoInstall(ready(), { enabled: true, quiet: true })).toBe(true);
    expect(shouldAutoInstall(ready(), { enabled: false, quiet: true })).toBe(false);
    expect(shouldAutoInstall(ready(), { enabled: true, quiet: false })).toBe(false);
    expect(shouldAutoInstall(ready({ mode: 'manual' }), { enabled: true, quiet: true })).toBe(false);
    expect(shouldAutoInstall(idle({ status: 'downloading', version: '0.15.0' }), { enabled: true, quiet: true })).toBe(false);
    expect(shouldAutoInstall(idle({ status: 'available', version: '0.15.0' }), { enabled: true, quiet: true })).toBe(false);
    expect(shouldAutoInstall(ready(), { enabled: true, quiet: true, failedVersion: '0.15.0' })).toBe(false);
    expect(shouldAutoInstall(ready({ version: '0.15.1' }), { enabled: true, quiet: true, failedVersion: '0.15.0' })).toBe(true);
  });
});

describe('the restart marker', () => {
  it('remembers how the window was', () => {
    expect(restartWindowState({ visible: false, minimized: false, focused: false })).toBe('hidden');
    expect(restartWindowState({ visible: true, minimized: true, focused: false })).toBe('minimized');
    expect(restartWindowState({ visible: true, minimized: false, focused: false })).toBe('inactive');
    expect(restartWindowState({ visible: true, minimized: false, focused: true })).toBe('normal');
  });
  it('a fresh marker brings the window back as it was; the new version running means it worked', () => {
    const text = JSON.stringify({ window: 'hidden', version: '0.15.0', at: 1_000 });
    expect(readRestartMarker(text, 1_000 + 20_000, '0.15.0')).toEqual({ window: 'hidden' });
  });
  it('a stale marker does not hide a window the user opened later', () => {
    const text = JSON.stringify({ window: 'hidden', version: '0.15.0', at: 1_000 });
    expect(readRestartMarker(text, 1_000 + RESTART_MARKER_MAX_AGE_MS + 1, '0.15.0')).toEqual({ window: 'normal' });
    expect(readRestartMarker(text, 0, '0.15.0')).toEqual({ window: 'normal' }); // clock went back
  });
  it('still running the old version: that install did not take', () => {
    const text = JSON.stringify({ window: 'inactive', version: '0.15.0', at: 1_000 });
    expect(readRestartMarker(text, 2_000, '0.14.0')).toEqual({ window: 'inactive', failedVersion: '0.15.0' });
  });
  it('no marker, garbage or a bad window value is a normal start', () => {
    expect(readRestartMarker(null, 1, '0.14.0')).toEqual({ window: 'normal' });
    expect(readRestartMarker('{nope', 1, '0.14.0')).toEqual({ window: 'normal' });
    expect(readRestartMarker('null', 1, '0.14.0')).toEqual({ window: 'normal' });
    expect(readRestartMarker(JSON.stringify({ window: 'fullscreen', version: '0.14.0', at: 1 }), 1, '0.14.0')).toEqual({ window: 'normal' });
  });
});

describe('a fresh release whose Mac files are not attached yet', () => {
  it('classifies the real electron-updater messages', () => {
    expect(isMacChannelPending(MAC_PENDING_GITHUB)).toBe(true);
    expect(isMacChannelPending(MAC_PENDING_GENERIC)).toBe(true);
    expect(isMacChannelPending('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND: Cannot find latest-mac.yml in the latest release artifacts')).toBe(true);
    expect(isMacChannelPending(PRIVATE_REPO)).toBe(false);
    expect(isMacChannelPending('No published versions on GitHub')).toBe(false);
    expect(isMacChannelPending(WIN_CHANNEL_MISSING)).toBe(false);
    expect(isMacChannelPending('getaddrinfo ENOTFOUND github.com')).toBe(false);
  });
  it('is calm: idle, no error, no chip, and says a new version is on its way', () => {
    const s = reduceUpdate(reduceUpdate(idle(), { type: 'checking' }), { type: 'error', message: MAC_PENDING_GITHUB, at: 7 });
    expect(s).toMatchObject({ status: 'idle', pendingRelease: true, lastCheckedAt: 7 });
    expect(s.error).toBeUndefined();
    expect(s.noReleases).toBeUndefined();
    expect(s.upToDate).toBeUndefined();
    expect(updateChipModel(s)).toBeNull();
    expect(updatePopupModel(s)).toBeNull();
    expect(describeUpdate(s)).toMatch(/being published/);
    // the next check clears it, and finding the release replaces it
    expect(reduceUpdate(s, { type: 'checking' }).pendingRelease).toBeUndefined();
    expect(reduceUpdate(s, { type: 'available', version: '0.15.0' }).pendingRelease).toBeUndefined();
    // re-showing the window may still re-check it
    expect(shouldCheckOnShow(s, 0, 60 * 60_000)).toBe(true);
  });
  it('a whole feed out of reach is still the visible error', () => {
    const s = reduceUpdate(idle(), { type: 'error', message: PRIVATE_REPO, at: 1 });
    expect(s).toMatchObject({ status: 'error', noReleases: true, error: NO_FEED_ERROR });
    expect(updateChipModel(s)).toMatchObject({ label: 'Updates unreachable' });
  });
});

describe('an update that did not install', () => {
  const msg = installFailedMessage('0.15.0', 'the new version could not be copied next to the old one');
  it('says which version and why', () => {
    expect(msg).toMatch(/^Updating to v0\.15\.0 did not finish: the new version could not be copied/);
    expect(installFailedMessage('0.15.0')).toMatch(/^Updating to v0\.15\.0 did not finish\. /);
  });
  it('shows as "Update failed" in the title bar, and stays next to the retry until we are up to date', () => {
    let s = idle({ status: 'error', error: msg, installError: msg });
    expect(updateChipModel(s)).toMatchObject({ state: 'error', label: 'Update failed', title: msg });
    s = reduceUpdate(s, { type: 'checking' });
    s = reduceUpdate(s, { type: 'available', version: '0.15.0' });
    s = reduceUpdate(s, { type: 'downloaded', version: '0.15.0' });
    expect(s.installError).toBe(msg);
    expect(updateChipModel(s)).toMatchObject({ state: 'ready' });
    const up = reduceUpdate(reduceUpdate(idle({ installError: msg }), { type: 'checking' }), { type: 'not-available', at: 1 });
    expect(up.installError).toBeUndefined();
  });
  it('reads the swap log: the last entry decides', () => {
    const ok = 'Thu Nov 20 10:00:00 PST 2026 update to 0.15.0: /u/mac-update/app/C.app -> /Applications/C.app\nupdated\n';
    const copy = 'Thu Nov 20 10:00:00 PST 2026 update to 0.15.0: /u/mac-update/app/C.app -> /Applications/C.app\ncopy failed\n';
    const swap = 'Fri Nov 21 09:00:00 PST 2026 update to 0.15.1: /u/a/C.app -> /Applications/C.app\nswap failed: putting the old version back\n';
    const aside = 'Fri Nov 21 09:00:00 PST 2026 update to 0.15.1: /u/a/C.app -> /Applications/C.app\ncould not move the old version aside\n';
    const quit = 'Fri Nov 21 09:00:00 PST 2026 update to 0.15.1: /u/a/C.app -> /Applications/C.app\nthe app did not quit; update left for next time\n';
    expect(lastSwapOutcome(ok)).toEqual({ ok: true, version: '0.15.0' });
    expect(lastSwapOutcome(copy)).toMatchObject({ ok: false, version: '0.15.0', reason: expect.stringMatching(/could not be copied/) });
    expect(lastSwapOutcome(copy + swap)).toMatchObject({ ok: false, version: '0.15.1', reason: expect.stringMatching(/old one was restored/) });
    expect(lastSwapOutcome(aside)).toMatchObject({ ok: false, reason: expect.stringMatching(/moved aside/) });
    expect(lastSwapOutcome(quit)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not quit/) });
    expect(lastSwapOutcome(copy + ok.replace('0.15.0', '0.15.1'))).toEqual({ ok: true, version: '0.15.1' });
    // logs from before the version was recorded, an entry still running, nothing at all
    expect(lastSwapOutcome('Thu Nov 20 10:00:00 PST 2026 update: /a/C.app -> /Applications/C.app\ncopy failed\n')).toEqual({
      ok: false,
      version: undefined,
      reason: expect.any(String),
    });
    expect(lastSwapOutcome('Thu Nov 20 10:00:00 PST 2026 update to 0.15.0: /a/C.app -> /Applications/C.app\n')).toBeNull();
    expect(lastSwapOutcome('')).toBeNull();
  });
});

describe('Move to Applications', () => {
  it('is offered for a translocated copy or one run from the disk image, not for an unwritable folder', () => {
    expect(macBlockerKind('/private/var/folders/x/AppTranslocation/ABC/d/C.app', true)).toBe('translocated');
    expect(macBlockerKind('/Volumes/Claude Visualized 0.15.0/C.app', false)).toBe('dmg');
    expect(macBlockerKind('/opt/C.app', false)).toBe('unwritable');
    expect(macBlockerKind(null, true)).toBe('no-bundle');
    expect(macBlockerKind('/Applications/C.app', true)).toBeNull();
    expect(macCanMoveToApplications('translocated')).toBe(true);
    expect(macCanMoveToApplications('dmg')).toBe(true);
    expect(macCanMoveToApplications('unwritable')).toBe(false);
    expect(macCanMoveToApplications('no-bundle')).toBe(false);
    expect(macCanMoveToApplications(null)).toBe(false);
  });
  it('rides on the manual mode decision into the view', () => {
    const base = { isPackaged: true, platform: 'darwin', envDisabled: false, feedOverride: false, macSigned: false };
    const d = decideUpdateMode({ ...base, macBlocker: 'disk image', macMovable: true });
    expect(d).toEqual({ mode: 'manual', reason: 'disk image', movable: true });
    expect(initialUpdateView('0.14.0', d)).toMatchObject({ mode: 'manual', movable: true });
    expect(decideUpdateMode({ ...base, macBlocker: 'cannot write', macMovable: false })).toEqual({ mode: 'manual', reason: 'cannot write' });
    expect(initialUpdateView('0.14.0', { mode: 'auto' }).movable).toBeUndefined();
  });
});
