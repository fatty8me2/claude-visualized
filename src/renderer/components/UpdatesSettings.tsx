import { useEffect, useState } from 'react';
import type { AppConfigView } from '@core/api';
import { describeUpdate, type UpdateView } from '@core/updates';

export function useUpdates(): UpdateView | null {
  const [u, set] = useState<UpdateView | null>(null);
  useEffect(() => {
    void window.api.getUpdates().then(set);
    return window.api.onUpdates(set);
  }, []);
  return u;
}

/** Subtle "update ready" pill: restart when the download is done, or a link to the release page on unsigned macOS. */
export function UpdatePill({ updates }: { updates: UpdateView | null }) {
  if (!updates) return null;
  if (updates.status === 'downloaded')
    return (
      <button
        className="update-pill"
        data-testid="update-pill"
        title="Restart Claude Visualized to finish updating"
        onClick={() => void window.api.installUpdate()}
      >
        ↑ v{updates.version} ready · restart
      </button>
    );
  if (updates.status === 'available' && updates.mode === 'manual')
    return (
      <a className="update-pill" data-testid="update-pill" href={updates.releaseUrl} target="_blank" rel="noreferrer" title="Open the release page">
        ↑ v{updates.version} available · download
      </a>
    );
  return null;
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
      <h3 style={{ marginTop: 8 }}>Updates</h3>
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
          <button className="primary" onClick={() => void window.api.downloadUpdate()}>
            Download v{u.version}
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
    </div>
  );
}
