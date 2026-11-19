import { useEffect, useRef, useState } from 'react';
import { describeUpdate, shouldShowUpdatePopup, updatePopupModel, type UpdatePopupDismissal, type UpdateView } from '@core/updates';
import '../updatePopup.css';

// Window-shows counted for the whole renderer lifetime (the window is hidden to the tray, not reloaded), and the last "Later".
// Kept at module level so a remount does not bring a dismissed pop-up back; an app restart starts both afresh.
let showEpoch = 0;
let dismissed: UpdatePopupDismissal | null = null;

// The title bar's version button and update chip open the card on demand (openUpdateCard), whatever the state.
const openers = new Set<() => void>();
export function openUpdateCard() {
  for (const f of openers) f();
}

function useShowEpoch(): number {
  const [epoch, setEpoch] = useState(showEpoch);
  useEffect(
    () =>
      window.api.onWindowShown(() => {
        showEpoch += 1;
        setEpoch(showEpoch);
      }),
    [],
  );
  return epoch;
}

/**
 * The update card in the bottom-right corner. It pops up on its own when an update is found (version and release notes, then
 * download progress, then "Restart & update") and once after an update ("Updated to …"). Opened from the title bar it also
 * shows the plain state: up to date, checking, or why updates fail, with "Check now". "Update now" downloads and restarts in
 * one go. A copy that cannot update itself (a Mac app run from the .dmg) gets "Download" (the release page). Errors never pop
 * up on their own. "Later" (or Escape) hides it for this version until the window is opened again. Held back while a dialog
 * (settings, setup, tour) is open.
 */
export function UpdatePopup({ updates, enabled, suppressed }: { updates: UpdateView | null; enabled: boolean; suppressed: boolean }) {
  const epoch = useShowEpoch();
  const [opened, setOpened] = useState(false);
  const [, rerender] = useState(0);
  const card = useRef<HTMLDivElement | null>(null);
  const model = updatePopupModel(updates, opened);
  const visible = !!model && (opened || (!suppressed && shouldShowUpdatePopup(updates, { enabled, showEpoch: epoch, dismissed })));

  useEffect(() => {
    const open = () => setOpened(true);
    openers.add(open);
    return () => void openers.delete(open);
  }, []);

  const later = () => {
    if (model) dismissed = { version: model.version, showEpoch: epoch };
    setOpened(false);
    rerender((n) => n + 1);
  };
  const laterRef = useRef(later);
  laterRef.current = later;

  // Escape = Later, when focus is in the card or nowhere in particular (a text field or an open drawer keeps its own Escape)
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body && !card.current?.contains(a)) return;
      e.preventDefault();
      laterRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  if (!visible || !model || !updates) return null;
  const { stage, mode, version, releaseNotes, percent, releaseUrl } = model;
  const status = updates.status;
  const title =
    stage === 'ready'
      ? `Update ready: v${version}`
      : stage === 'updated'
        ? `Updated to v${version}`
        : stage === 'status'
          ? `Claude Visualized v${version}`
          : `Update available: v${version}`;
  const kicker =
    stage === 'ready'
      ? 'Ready to install'
      : stage === 'updated'
        ? 'Up to date'
        : stage === 'status'
          ? status === 'error'
            ? 'Updates'
            : 'Version'
          : 'New version';
  const line =
    stage === 'ready'
      ? 'Downloaded. Restart Claude Visualized to finish updating.'
      : stage === 'downloading'
        ? updates.installWhenReady
          ? 'Downloading. Claude Visualized restarts as soon as it is done.'
          : 'Downloading in the background. You can keep working.'
        : stage === 'updated'
          ? `You were on v${updates.updatedFrom}.`
          : stage === 'status'
            ? describeUpdate(updates)
            : mode === 'manual'
              ? `You have v${updates.currentVersion}. This copy cannot update itself: get the new version from the releases page.`
              : `You have v${updates.currentVersion}.`;
  const tone = stage === 'status' && status === 'error' ? 'error' : undefined;
  const reason = mode === 'manual' && (stage === 'found' || stage === 'status') ? updates.reason : undefined;
  const busy = status === 'checking';

  return (
    <div
      ref={card}
      className="upd-pop-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="upd-pop-title"
      aria-describedby="upd-pop-line"
      data-testid="update-popup"
      data-stage={stage}
      data-tone={tone}
    >
      <div className="upd-pop-glow" aria-hidden="true" />
      <div className="upd-pop-head">
        <span className="upd-pop-orb" aria-hidden="true">
          {stage === 'updated' || (stage === 'status' && updates.upToDate) ? '✓' : tone === 'error' ? '!' : '↑'}
        </span>
        <div className="upd-pop-titles">
          <div className="upd-pop-kicker">{kicker}</div>
          <h2 id="upd-pop-title" className="upd-pop-title" data-testid="update-popup-title">
            {title}
          </h2>
        </div>
      </div>
      <p id="upd-pop-line" className="upd-pop-line" data-testid="update-popup-line">
        {line}
      </p>
      {reason && <p className="upd-pop-reason">{reason}</p>}
      {releaseNotes && (stage === 'found' || stage === 'downloading' || stage === 'ready') && (
        <pre className="upd-pop-notes" data-testid="update-popup-notes">
          {releaseNotes}
        </pre>
      )}
      {(stage === 'downloading' || stage === 'ready') && (
        <div
          className="upd-pop-meter"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="update-popup-progress"
        >
          <div className="upd-pop-fill" style={{ width: `${percent}%` }} />
          <span className="upd-pop-pct">{stage === 'ready' ? 'ready' : `${percent}%`}</span>
        </div>
      )}
      <div className="upd-pop-actions">
        {(stage === 'updated' || stage === 'status') && (
          <a className="upd-pop-link" href={releaseUrl} target="_blank" rel="noreferrer" data-testid="update-popup-whatsnew">
            What&apos;s new
          </a>
        )}
        <button className="ghost" onClick={later} data-testid="update-popup-later">
          {stage === 'updated' || stage === 'status' ? 'Close' : 'Later'}
        </button>
        {stage === 'status' && mode !== 'disabled' && (
          <button className="primary upd-pop-go" disabled={busy} onClick={() => void window.api.checkForUpdates()} data-testid="update-popup-check">
            {busy ? 'Checking…' : 'Check now'}
          </button>
        )}
        {stage === 'ready' && (
          <button className="primary upd-pop-go" onClick={() => void window.api.installUpdate()} data-testid="update-popup-go">
            Restart &amp; update
          </button>
        )}
        {stage === 'downloading' && !updates.installWhenReady && (
          <button className="primary upd-pop-go" onClick={() => void window.api.updateNow()} data-testid="update-popup-go">
            Restart when done
          </button>
        )}
        {stage === 'found' && mode === 'manual' && (
          <a className="upd-pop-go upd-pop-linkbtn" href={releaseUrl} target="_blank" rel="noreferrer" data-testid="update-popup-go">
            Download
          </a>
        )}
        {stage === 'found' && mode === 'auto' && (
          <button className="primary upd-pop-go" onClick={() => void window.api.updateNow()} data-testid="update-popup-go">
            Update now
          </button>
        )}
      </div>
    </div>
  );
}
