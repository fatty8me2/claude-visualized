import { useCallback, useEffect, useState } from 'react';
import type { SyncChoice, SyncDetectView, SyncStatusView } from '@core/settingsSync';
import '../sync.css';

const DRIVE_URL = 'https://www.google.com/drive/download/';

function ago(t: number | null, now: number): string {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Settings section: sync layouts and preferences through a folder that Google Drive for desktop (or Dropbox, OneDrive ...) keeps in sync. */
export function SyncSettings() {
  const [st, setSt] = useState<SyncStatusView | null>(null);
  const [det, setDet] = useState<SyncDetectView | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ root: string; machines: string[]; keys: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const detect = useCallback(async () => {
    const d = await window.api.syncDetect();
    setDet(d);
    setPicked((p) => (p && (d.folders.some((f) => f.path === p) || p === custom) ? p : (d.folders[0]?.path ?? custom)));
  }, [custom]);

  useEffect(() => {
    void window.api.syncStatus().then(setSt);
    void detect();
    const off = window.api.onSyncStatus(setSt);
    const tick = window.setInterval(() => setNow(Date.now()), 5000);
    return () => {
      off();
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const turnOn = async (root: string, choice?: SyncChoice) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await window.api.syncEnable(root, choice);
      if (!r.ok) setErr(r.error ?? 'Could not turn sync on.');
      else if (r.needsChoice) setAsk({ root, ...r.needsChoice });
      else setAsk(null);
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    const p = await window.api.syncPickFolder();
    if (p) {
      setCustom(p);
      setPicked(p);
    }
  };

  if (!st || !det) return null;
  const choices = [...det.folders, ...(custom && !det.folders.some((f) => f.path === custom) ? [{ kind: 'other' as const, label: 'Chosen folder', path: custom }] : [])];

  return (
    <div className="sync" data-testid="sync-settings">
      <h3 className="dlg-sec">Sync</h3>
      {st.enabled ? (
        <>
          <p className="note sync-lead">Your layouts and preferences follow you to your other computers through this folder. Drive does the syncing; nothing is sent by this app.</p>
          <div className="sync-card" data-testid="sync-card">
            <div className="row">
              <span className={`pill ${st.available && !st.error ? 'ok' : 'warn'}`} data-testid="sync-state">
                {st.available && !st.error ? 'synced' : 'folder not reachable'}
              </span>
              <span className="sync-path" title={st.folder ?? ''} data-testid="sync-folder">
                {st.folder}
              </span>
            </div>
            {st.error && (
              <p className="sync-warn" data-testid="sync-error">
                {st.error} Your settings stay on this computer and sync again when it is back.
              </p>
            )}
            <div className="row">
              <span>Last synced</span>
              <b data-testid="sync-last">{ago(st.lastSyncedAt, now)}</b>
            </div>
            <div className="sync-machines" data-testid="sync-machines">
              <div className="note">Computers using this folder</div>
              {st.machines.length === 0 && <div className="note">none yet</div>}
              {st.machines.map((m) => (
                <div className="sync-machine" key={m.deviceId} data-testid="sync-machine">
                  <span className="sync-dot" data-on={m.self || now - m.lastSyncAt < 30 * 60_000} />
                  <span className="sync-mname">
                    {m.name}
                    {m.self ? ' (this computer)' : ''}
                  </span>
                  <span className="note">{m.self ? ago(st.lastSyncedAt, now) : ago(m.lastSyncAt, now)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="row">
            <button
              onClick={async () => {
                setBusy(true);
                setSt(await window.api.syncNow());
                setBusy(false);
              }}
              disabled={busy}
              data-testid="sync-now"
            >
              Sync now
            </button>
            <button onClick={() => void window.api.syncOpenFolder()}>Show folder</button>
            <button className="danger" onClick={() => void window.api.syncDisable()} data-testid="sync-off">
              Turn off
            </button>
          </div>
          <p className="note">Turning sync off leaves the files in the folder, so you can turn it on again later.</p>
        </>
      ) : ask ? (
        <div className="sync-card" data-testid="sync-ask">
          <p className="sync-lead">
            This folder already has settings from <b>{ask.machines.join(', ') || 'another computer'}</b>. Which should this computer use?
          </p>
          <div className="sync-choices">
            <button className="primary" disabled={busy} onClick={() => void turnOn(ask.root, 'drive')} data-testid="sync-choice-drive">
              Use the settings from Drive
              <span className="note">this computer's layout is replaced</span>
            </button>
            <button disabled={busy} onClick={() => void turnOn(ask.root, 'local')} data-testid="sync-choice-local">
              Keep this computer's settings
              <span className="note">Drive's copy is replaced</span>
            </button>
            <button disabled={busy} onClick={() => void turnOn(ask.root, 'merge')} data-testid="sync-choice-merge">
              Merge
              <span className="note">the most recent change wins, per setting</span>
            </button>
          </div>
          <div className="row">
            <button onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="note sync-lead">
            Keep your layouts and preferences the same on all your computers. Uses a folder that Google Drive for desktop already syncs: no account, sign-in or
            network code in this app.
          </p>
          {!det.driveFound && (
            <div className="sync-card sync-install" data-testid="sync-install">
              <b>Google Drive for desktop not found</b>
              <span className="note">Install it and sign in, then come back here. You can also choose any other synced folder (Dropbox, OneDrive, iCloud Drive).</span>
              <div className="row">
                <a className="sync-link" href={DRIVE_URL} target="_blank" rel="noreferrer" data-testid="sync-install-link">
                  Install Google Drive for desktop
                </a>
                <button onClick={() => void detect()} data-testid="sync-check">
                  Check again
                </button>
              </div>
            </div>
          )}
          {choices.length > 0 && (
            <div className="sync-folders" role="radiogroup" aria-label="Synced folder" data-testid="sync-folders">
              {choices.map((f) => (
                <label className={`sync-folder ${picked === f.path ? 'on' : ''}`} key={f.path}>
                  <input type="radio" name="sync-folder" checked={picked === f.path} onChange={() => setPicked(f.path)} />
                  <span className="sync-flabel">{f.label}</span>
                  <span className="sync-path" title={f.path}>
                    {f.path}
                  </span>
                </label>
              ))}
            </div>
          )}
          {err && <p className="sync-warn">{err}</p>}
          <div className="row">
            <button className="primary" disabled={!picked || busy} onClick={() => picked && void turnOn(picked)} data-testid="sync-on">
              Turn on sync
            </button>
            <button onClick={() => void choose()} data-testid="sync-pick">
              Choose another folder…
            </button>
          </div>
        </>
      )}
      <details className="sync-what">
        <summary>What is synced</summary>
        <p className="note">
          Synced: panel layout, overview grid, plan rail, graph view options, pinned and hidden sessions, collapsed sections, and a few switches (notifications,
          follow active session, mini view on top, auto-update). Never synced: anything in <code>~/.claude</code>, your Claude login, the peer-link key and paired
          computers, the history database, the hook port, window position, local model server addresses and this computer's name.
        </p>
      </details>
    </div>
  );
}
