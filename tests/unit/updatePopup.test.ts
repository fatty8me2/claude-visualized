import { describe, expect, it } from 'vitest';
import {
  initialUpdateView,
  RECHECK_ON_SHOW_MS,
  reduceUpdate,
  shouldCheckOnShow,
  shouldShowUpdatePopup,
  updatePopupModel,
  type UpdateView,
} from '@core/updates';

const idle = (over: Partial<UpdateView> = {}): UpdateView => ({ ...initialUpdateView('0.10.4', { mode: 'auto' }), ...over });
const available = reduceUpdate(idle(), { type: 'available', version: '0.11.0', releaseNotes: 'Faster things' });

describe('updatePopupModel', () => {
  it('nothing to announce while idle, checking, on error or when disabled', () => {
    expect(updatePopupModel(null)).toBeNull();
    expect(updatePopupModel(idle())).toBeNull();
    expect(updatePopupModel(reduceUpdate(idle(), { type: 'checking' }))).toBeNull();
    expect(updatePopupModel(reduceUpdate(available, { type: 'error', message: 'boom', at: 1 }))).toBeNull();
    expect(updatePopupModel(initialUpdateView('0.10.4', { mode: 'disabled' }))).toBeNull();
  });
  it('found -> downloading -> ready, carrying version, notes and percent', () => {
    expect(updatePopupModel(available)).toMatchObject({ stage: 'found', version: '0.11.0', releaseNotes: 'Faster things', mode: 'auto' });
    const dl = reduceUpdate(available, { type: 'progress', percent: 42.4 });
    expect(updatePopupModel(dl)).toMatchObject({ stage: 'downloading', percent: 42 });
    const ready = reduceUpdate(dl, { type: 'downloaded', version: '0.11.0' });
    expect(updatePopupModel(ready)).toMatchObject({ stage: 'ready', percent: 100 });
  });
  it('manual mode (unsigned macOS) stays at found with the release page', () => {
    const m = reduceUpdate(idle({ mode: 'manual' }), { type: 'available', version: '0.11.0' });
    expect(updatePopupModel(m)).toMatchObject({ stage: 'found', mode: 'manual', releaseUrl: expect.stringContaining('/tag/v0.11.0') });
  });
});

describe('shouldShowUpdatePopup', () => {
  const o = { enabled: true, showEpoch: 3, dismissed: null };
  it('shows a pending update, not when notifications are off', () => {
    expect(shouldShowUpdatePopup(available, o)).toBe(true);
    expect(shouldShowUpdatePopup(available, { ...o, enabled: false })).toBe(false);
    expect(shouldShowUpdatePopup(idle(), o)).toBe(false);
  });
  it('"Later" hides that version for this window-show only', () => {
    const dismissed = { version: '0.11.0', showEpoch: 3 };
    expect(shouldShowUpdatePopup(available, { ...o, dismissed })).toBe(false);
    // still hidden when the download finishes in the same window-show
    const ready = reduceUpdate(reduceUpdate(available, { type: 'progress', percent: 10 }), { type: 'downloaded', version: '0.11.0' });
    expect(shouldShowUpdatePopup(ready, { ...o, dismissed })).toBe(false);
    // the window is opened again: back
    expect(shouldShowUpdatePopup(available, { ...o, showEpoch: 4, dismissed })).toBe(true);
    // a newer version is news even in the same window-show
    const newer = reduceUpdate(available, { type: 'available', version: '0.12.0' });
    expect(shouldShowUpdatePopup(newer, { ...o, dismissed })).toBe(true);
  });
});

describe('shouldCheckOnShow', () => {
  const now = 10 * RECHECK_ON_SHOW_MS;
  it('not before the first check, not when disabled', () => {
    expect(shouldCheckOnShow(idle(), undefined, now)).toBe(false);
    expect(shouldCheckOnShow(initialUpdateView('0.10.4', { mode: 'disabled' }), 0, now)).toBe(false);
  });
  it('only when the last check is at least 30 minutes old', () => {
    expect(shouldCheckOnShow(idle({ upToDate: true }), now - RECHECK_ON_SHOW_MS + 1, now)).toBe(false);
    expect(shouldCheckOnShow(idle({ upToDate: true }), now - RECHECK_ON_SHOW_MS, now)).toBe(true);
    expect(shouldCheckOnShow(idle({ status: 'error', error: 'x' }), now - RECHECK_ON_SHOW_MS, now)).toBe(true);
    expect(shouldCheckOnShow(idle(), now - 5, now, 0)).toBe(true);
  });
  it('never while checking or when an update is already known', () => {
    const old = now - 2 * RECHECK_ON_SHOW_MS;
    expect(shouldCheckOnShow(reduceUpdate(idle(), { type: 'checking' }), old, now)).toBe(false);
    expect(shouldCheckOnShow(available, old, now)).toBe(false);
    expect(shouldCheckOnShow(reduceUpdate(available, { type: 'progress', percent: 5 }), old, now)).toBe(false);
  });
});
