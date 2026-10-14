import { describe, expect, it } from 'vitest';
import {
  decideUpdateMode,
  describeUpdate,
  initialUpdateView,
  isNoReleasesError,
  reduceUpdate,
  releaseNotesSnippet,
  type ModeInput,
  type UpdateView,
} from '@core/updates';

const base: ModeInput = { isPackaged: true, platform: 'win32', envDisabled: false, feedOverride: false, macSigned: false };
const idle = (over: Partial<UpdateView> = {}): UpdateView => ({ ...initialUpdateView('0.1.0', { mode: 'auto' }), ...over });

describe('decideUpdateMode', () => {
  it('auto on packaged unsigned Windows (NSIS does not need a signature)', () => {
    expect(decideUpdateMode(base)).toEqual({ mode: 'auto' });
  });
  it('disabled by env var, even with a feed override', () => {
    expect(decideUpdateMode({ ...base, envDisabled: true, feedOverride: true }).mode).toBe('disabled');
  });
  it('disabled in dev unless a test feed is given', () => {
    expect(decideUpdateMode({ ...base, isPackaged: false }).mode).toBe('disabled');
    expect(decideUpdateMode({ ...base, isPackaged: false, feedOverride: true }).mode).toBe('auto');
  });
  it('unsigned macOS is manual, signed macOS is auto', () => {
    const d = decideUpdateMode({ ...base, platform: 'darwin' });
    expect(d.mode).toBe('manual');
    expect(d.reason).toMatch(/not signed/);
    expect(decideUpdateMode({ ...base, platform: 'darwin', macSigned: true }).mode).toBe('auto');
  });
});

describe('reduceUpdate', () => {
  it('walks check -> available -> downloading -> downloaded', () => {
    let s = idle();
    s = reduceUpdate(s, { type: 'checking' });
    expect(s.status).toBe('checking');
    s = reduceUpdate(s, { type: 'available', version: '0.2.0', releaseNotes: 'notes' });
    expect(s).toMatchObject({ status: 'available', version: '0.2.0', releaseNotes: 'notes' });
    expect(s.releaseUrl).toContain('/tag/v0.2.0');
    s = reduceUpdate(s, { type: 'progress', percent: 41.6 });
    expect(s).toMatchObject({ status: 'downloading', percent: 42 });
    s = reduceUpdate(s, { type: 'downloaded', version: '0.2.0' });
    expect(s).toMatchObject({ status: 'downloaded', percent: 100 });
  });
  it('up to date goes back to idle', () => {
    const s = reduceUpdate(reduceUpdate(idle(), { type: 'checking' }), { type: 'not-available', at: 5 });
    expect(s).toMatchObject({ status: 'idle', upToDate: true, lastCheckedAt: 5 });
    expect(describeUpdate(s)).toMatch(/up to date/);
  });
  it('a later check never undoes a downloaded update', () => {
    const d = idle({ status: 'downloaded', version: '0.2.0' });
    expect(reduceUpdate(d, { type: 'checking' })).toBe(d);
    expect(reduceUpdate(d, { type: 'not-available', at: 1 })).toBe(d);
    expect(reduceUpdate(d, { type: 'error', message: 'net down', at: 1 })).toBe(d);
  });
  it('404 / no releases is not an error', () => {
    const s = reduceUpdate(idle(), { type: 'error', message: 'Cannot find latest.yml in the latest release artifacts (404)', at: 3 });
    expect(s).toMatchObject({ status: 'idle', noReleases: true });
    expect(s.error).toBeUndefined();
    expect(describeUpdate(s)).toBe('No releases published yet.');
  });
  it('other failures are errors, truncated', () => {
    const s = reduceUpdate(idle(), { type: 'error', message: 'x'.repeat(1000), at: 3 });
    expect(s.status).toBe('error');
    expect(s.error!.length).toBe(300);
  });
  it('disabled stays disabled', () => {
    const d = initialUpdateView('0.1.0', { mode: 'disabled', reason: 'off' });
    expect(reduceUpdate(d, { type: 'checking' })).toBe(d);
    expect(describeUpdate(d)).toBe('off');
  });
  it('manual mode describes the release page', () => {
    const s = reduceUpdate(idle({ mode: 'manual' }), { type: 'available', version: '0.3.0' });
    expect(describeUpdate(s)).toMatch(/releases page/);
  });
});

describe('helpers', () => {
  it('classifies no-release errors', () => {
    expect(isNoReleasesError('HttpError: 404 Not Found')).toBe(true);
    expect(isNoReleasesError('Unable to find latest version on GitHub')).toBe(true);
    expect(isNoReleasesError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')).toBe(true);
    expect(isNoReleasesError('getaddrinfo ENOTFOUND github.com')).toBe(false);
  });
  it('reduces release notes to plain text', () => {
    expect(releaseNotesSnippet('<p>Fixes &amp; things</p><ul><li>one</li><li>two</li></ul>')).toBe('Fixes & things\n- one\n- two');
    expect(
      releaseNotesSnippet([
        { version: '1', note: 'a' },
        { version: '2', note: 'b' },
      ]),
    ).toBe('a\n\nb');
    expect(releaseNotesSnippet(null)).toBeUndefined();
    expect(releaseNotesSnippet('y'.repeat(500))!.length).toBe(401);
  });
});
