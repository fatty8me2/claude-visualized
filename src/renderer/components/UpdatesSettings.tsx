import { useEffect, useState } from 'react';
import type { AppConfigView } from '@core/api';
import { describeUpdate, updateChipModel, type UpdateView } from '@core/updates';
import { openUpdateCard } from './UpdatePopup';

export function useUpdates(): UpdateView | null {
  const [u, set] = useState<UpdateView | null>(null);
  useEffect(() => {
    void window.api.getUpdates().then(set);
    return window.api.onUpdates(set);
  }, []);
  return u;
}

/**
 * The title bar's update corner: the version (opens the update card) and, while there is something to do, a glowing chip:
 * "Update to vX" (one click downloads and restarts), "Updating 42%", "Restart to update", or "Updates unreachable".
 */
export function UpdateChip() {
  const u = useUpdates();
  if (!u) return null;
  const chip = updateChipModel(u);
  const go = () => {
    if (chip?.state === 'ready') void window.api.installUpdate();
    else if (chip?.state === 'available' && u.mode === 'auto') void window.api.updateNow();
    else openUpdateCard();
  };
  return (
    <span className="tb-upd">
      <button className="tb-upd-ver" data-testid="tb-version" onClick={openUpdateCard} title="Version and updates">
        v{u.currentVersion}
      </button>
      {chip && (
        <button className="tb-upd-chip" data-testid="tb-update" data-state={chip.state} title={chip.title} onClick={go}>
          <i aria-hidden>{chip.state === 'error' ? '!' : chip.state === 'ready' ? '⟳' : '↑'}</i>
          {chip.label}
          {chip.state === 'downloading' && <b className="tb-upd-fill" style={{ width: `${u.percent ?? 0}%` }} aria-hidden />}
        </button>
      )}
    </span>
  );
}

/** Settings section: version, state, check now, auto-download toggle, release notes, restart. */
export function UpdatesSettings({ config }: { config: AppConfigView }) {
  const u = useUpdates();
  const [checking, setChecking] = useState(false);
  if (!u) return null;
  const busy = checking || u.status === 'checking' || u.status === 'downloading';
  const check = async () => {
    setChecking(true);
    try {
      await window.api.checkForUpdates();
    } finally {
      setChecking(false);
    }
  };
  const tone = u.status === 'error' ? 'err' : u.status === 'downloaded' || u.status === 'available' ? 'ok' : '';
  return (
    <div data-testid="updates-settings">
      <h3 className="dlg-sec">Updates</h3>
      <div className="row">
        <span>
          Current version <b data-testid="update-current">{u.currentVersion}</b>
        </span>
        <span className={`pill ${tone}`} data-testid="update-status" data-status={u.status}>
          {u.status}
        </span>
        <button disabled={u.status === 'disabled' || busy} onClick={() => void check()}>
          Check now
        </button>
        {u.status === 'downloaded' && (
          <button className="primary" onClick={() => void window.api.installUpdate()}>
            Restart &amp; update
          </button>
        )}
        {u.status === 'available' && u.mode === 'auto' && (
          <button className="primary" onClick={() => void window.api.updateNow()}>
            Update to v{u.version} now
          </button>
        )}
        {u.status === 'available' && u.mode === 'manual' && (
          <a href={u.releaseUrl} target="_blank" rel="noreferrer">
            <button className="primary">Download the new version</button>
          </a>
        )}
      </div>
      <p className="note" data-testid="update-line">
        {describeUpdate(u)}
      </p>
      {u.mode === 'manual' && u.status !== 'disabled' && <p className="note">{u.reason}</p>}
      {u.releaseNotes && (u.status === 'available' || u.status === 'downloading' || u.status === 'downloaded') && (
        <pre className="update-notes" data-testid="update-notes">
          {u.releaseNotes}
        </pre>
      )}
      <label className="chk">
        <input
          type="checkbox"
          checked={config.autoDownloadUpdates}
          disabled={u.mode !== 'auto'}
          onChange={(e) => void window.api.setConfig({ autoDownloadUpdates: e.target.checked })}
        />
        Automatically download updates (installed when you restart the app)
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={config.notifyUpdates ?? true}
          disabled={u.mode === 'disabled'}
          onChange={(e) => void window.api.setConfig({ notifyUpdates: e.target.checked })}
        />
        Notify me when an update is available (a pop-up when the app opens)
      </label>
    </div>
  );
}
