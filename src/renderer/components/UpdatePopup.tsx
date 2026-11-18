import { useEffect, useRef, useState } from 'react';
import { shouldShowUpdatePopup, updatePopupModel, type UpdatePopupDismissal, type UpdateView } from '@core/updates';
import '../updatePopup.css';

// Window-shows counted for the whole renderer lifetime (the window is hidden to the tray, not reloaded), and the last "Later".
// Kept at module level so a remount does not bring a dismissed pop-up back; an app restart starts both afresh.
let showEpoch = 0;
let dismissed: UpdatePopupDismissal | null = null;

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
 * "Update available" card in the bottom-right corner: the version and release notes, download progress, then "Restart & update".
 * Unsigned macOS (manual mode) gets "Download" (the release page). Errors never pop up. "Later" (or Escape) hides it for this
 * version until the window is opened again. Held back while a dialog (settings, setup, tour) is open.
 */
export function UpdatePopup({ updates, enabled, suppressed }: { updates: UpdateView | null; enabled: boolean; suppressed: boolean }) {
  const epoch = useShowEpoch();
  const [, rerender] = useState(0);
  const card = useRef<HTMLDivElement | null>(null);
  const model = updatePopupModel(updates);
  const visible = !suppressed && shouldShowUpdatePopup(updates, { enabled, showEpoch: epoch, dismissed });

  const later = () => {
    if (!model) return;
    dismissed = { version: model.version, showEpoch: epoch };
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

  if (!visible || !model) return null;
  const { stage, mode, version, releaseNotes, percent, releaseUrl } = model;
  const title = stage === 'ready' ? `Update ready: v${version}` : `Update available: v${version}`;
  const line =
    stage === 'ready'
      ? 'Downloaded. Restart Claude Visualized to finish updating.'
      : stage === 'downloading'
        ? 'Downloading in the background. You can keep working.'
        : mode === 'manual'
          ? 'This Mac build cannot update itself. Get the new version from the releases page.'
          : `You have v${updates?.currentVersion ?? ''}.`;

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
    >
      <div className="upd-pop-glow" aria-hidden="true" />
      <div className="upd-pop-head">
        <span className="upd-pop-orb" aria-hidden="true">
          ↑
        </span>
        <div className="upd-pop-titles">
          <div className="upd-pop-kicker">{stage === 'ready' ? 'Ready to install' : 'New version'}</div>
          <h2 id="upd-pop-title" className="upd-pop-title" data-testid="update-popup-title">
            {title}
          </h2>
        </div>
      </div>
      <p id="upd-pop-line" className="upd-pop-line">
        {line}
      </p>
      {releaseNotes && (
        <pre className="upd-pop-notes" data-testid="update-popup-notes">
          {releaseNotes}
        </pre>
      )}
      {stage !== 'found' && (
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
        <button className="ghost" onClick={later} data-testid="update-popup-later">
          Later
        </button>
        {stage === 'ready' && (
          <button className="primary upd-pop-go" onClick={() => void window.api.installUpdate()}>
            Restart &amp; update
          </button>
        )}
        {stage === 'found' && mode === 'manual' && (
          <a className="upd-pop-go upd-pop-linkbtn" href={releaseUrl} target="_blank" rel="noreferrer">
            Download
          </a>
        )}
        {stage === 'found' && mode === 'auto' && (
          <button className="primary upd-pop-go" onClick={() => void window.api.downloadUpdate()}>
            Download
          </button>
        )}
      </div>
    </div>
  );
}
