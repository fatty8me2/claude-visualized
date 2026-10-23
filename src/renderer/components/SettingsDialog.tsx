import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useDialogFocus } from '../state/dialogFocus';
import { LocalModelsSettings } from './LocalModelsSettings';
import { SyncSettings } from './SyncSettings';
import { UpdatesSettings } from './UpdatesSettings';
import type { PingStatsSummary } from '@core/pingStats';
import type { AppConfigView, HookPreviewView, HookServerStatusView, HookStateView, SystemInfoView } from '@core/api';
import '../dialogs.css';

const STATE_TEXT: Record<string, [string, string]> = {
  installed: ['installed', 'ok'],
  partial: ['partially installed', 'warn'],
  none: ['not installed', ''],
  'other-port': ['installed for a different port', 'warn'],
  error: ['cannot read settings', 'err'],
};

export function SettingsDialog({
  config,
  hookSrv,
  onClose,
  onSetup,
}: {
  config: AppConfigView;
  hookSrv: HookServerStatusView | null;
  onClose: () => void;
  onSetup: () => void;
}) {
  const [hs, setHs] = useState<HookStateView | null>(null);
  const [preview, setPreview] = useState<HookPreviewView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState(String(config.port));
  const [sys, setSys] = useState<SystemInfoView | null>(null);
  const [hotkey, setHotkey] = useState(config.miniHotkey);
  const [hotkeyMsg, setHotkeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // closing plays the scale+fade out first, then really closes (Escape, the close button and a click on the scrim all come here)
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(onClose, reduce ? 0 : 160);
  };

  useEffect(() => {
    void window.api.getSystemInfo().then(setSys);
    return window.api.onSystemInfo(setSys);
  }, []);
  const applyHotkey = async () => {
    const r = await window.api.applyHotkey(hotkey);
    setHotkeyMsg(r.ok ? { ok: true, text: `Registered ${r.accelerator}` } : { ok: false, text: r.error ?? 'Could not register that shortcut.' });
    if (r.ok && r.accelerator) setHotkey(r.accelerator);
  };
  const loginName = window.api.platform === 'darwin' ? 'Start at login' : 'Start with Windows';

  const refresh = () => void window.api.hookState().then(setHs);
  useEffect(refresh, [config.port]);

  const doPreview = async (action: 'install' | 'uninstall') => {
    setResult(null);
    try {
      setPreview(await window.api.hookPreview(action));
    } catch (e) {
      setResult(`Could not preview: ${(e as Error).message}`);
    }
  };
  const doApply = async () => {
    if (!preview) return;
    setBusy(true);
    const r = await window.api.hookApply(preview.action);
    setBusy(false);
    setResult(
      r.ok
        ? `Done. ${r.backup ? `Backup saved to ${r.backup}` : 'No previous settings file to back up.'} Takes effect in new Claude Code sessions.`
        : `Failed: ${r.error}`,
    );
    setPreview(null);
    refresh();
  };
  const set = (patch: Partial<AppConfigView>) => void window.api.setConfig(patch);
  const st = hs ? STATE_TEXT[hs.state] : null;

  return (
    <div className={`overlay dlg-overlay ${closing ? 'closing' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        className={`dialog panel-raised dlg ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={useDialogFocus(close)}
      >
        <div className="row dialog-head">
          <h3 id="settings-title" className="dlg-title">
            Live hooks &amp; settings
          </h3>
          <button className="btn-icon ghost" onClick={close} aria-label="close" title="Close (Esc)">
            <Icon name="close" />
          </button>
        </div>
        <p>
          Without hooks, the app reads Claude Code's transcript files (about a second behind, no setup). Installing hooks makes Claude Code send each event to
          this app instantly (tool starts, permission prompts, subagent start/stop, plan/build mode). Hooks only talk to <code>127.0.0.1:{config.port}</code>;
          if the app isn't running they fail instantly and Claude Code carries on.
        </p>
        <p className="note">
          While this app is closed, Claude Code may note "hook failed: connection refused" for these hooks. That's harmless; remove the hooks here if you stop
          using the app.
        </p>
        <div className="row">
          <span>receiver:</span>
          {hookSrv?.listening ? <span className="pill ok">listening on :{hookSrv.port}</span> : <span className="pill err">{hookSrv?.error ?? 'stopped'}</span>}
          <span className="note">{hookSrv?.received ? `${hookSrv.received} events received` : 'no events yet'}</span>
        </div>
        <div className="row">
          <span>hooks in settings.json:</span>
          {st && <span className={`pill ${st[1]}`}>{st[0]}</span>}
          <span className="note" title={hs?.settingsFile}>
            {hs?.settingsFile}
          </span>
        </div>
        <div className="row">
          <span>usage-limit status line:</span>
          {hs?.statusLine === 'ours' ? (
            <span className="pill ok">installed</span>
          ) : hs?.statusLine === 'other' ? (
            <span className="pill warn">you have your own status line</span>
          ) : (
            <span className="pill">not installed</span>
          )}
          <span className="note">
            {hs?.statusLine === 'other'
              ? 'kept as-is; the 5-hour / weekly meters read your usage from Claude instead'
              : 'feeds the 5-hour / weekly meters; installed together with the hooks'}
          </span>
        </div>
        {hs?.error && <p style={{ color: 'var(--err)' }}>{hs.error}</p>}
        <div className="row">
          <button className="primary" disabled={hs?.state === 'error'} onClick={() => doPreview('install')}>
            {hs?.state === 'installed' ? 'Reinstall hooks…' : 'Install hooks…'}
          </button>
          <button disabled={!hs || hs.state === 'none' || hs.state === 'error'} onClick={() => doPreview('uninstall')}>
            Remove hooks…
          </button>
          {hs?.settingsFile && <button onClick={() => window.api.openPath(hs.settingsFile)}>Show file</button>}
        </div>
        {preview && (
          <>
            <p>
              {preview.changed ? (
                <>
                  Review the <code>hooks</code> section of <code>{preview.settingsFile}</code>. Everything else in the file is kept as-is, and a backup is
                  written first.
                </>
              ) : (
                'Nothing would change.'
              )}
            </p>
            <div className="diff">
              <div>
                <div className="note">before</div>
                <pre>{preview.before}</pre>
              </div>
              <div>
                <div className="note">after</div>
                <pre>{preview.after}</pre>
              </div>
            </div>
            <div className="row">
              <button className={preview.action === 'install' ? 'primary' : 'danger'} disabled={busy || !preview.changed} onClick={doApply}>
                {preview.action === 'install' ? 'Write hooks to settings.json' : 'Remove hooks from settings.json'}
              </button>
              <button onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </>
        )}
        {result && <p style={{ color: result.startsWith('Done') ? 'var(--ok)' : 'var(--err)' }}>{result}</p>}

        <h3 className="dlg-sec">App</h3>
        <label className="chk">
          <input type="checkbox" checked={config.notifyAttention} onChange={(e) => set({ notifyAttention: e.target.checked })} />
          Notify me when a session needs input (permission prompts — needs hooks)
        </label>
        <label className="chk">
          <input type="checkbox" checked={config.notifyAgentDone} onChange={(e) => set({ notifyAgentDone: e.target.checked })} />
          Notify me when a subagent finishes
        </label>
        <label className="chk" data-testid="set-usage-ping">
          <input type="checkbox" checked={config.usagePing} onChange={(e) => set({ usagePing: e.target.checked })} />
          Keep the usage meters exact: while a Claude Code session is active, send a tiny request to Claude about every 10 minutes (a few dozen tokens) and read my limits from the reply
        </label>
        <PingCost />
        <label className="chk">
          <input type="checkbox" checked={config.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} />
          Closing the window keeps the app running in the tray
        </label>
        <label className="chk">
          <input type="checkbox" checked={config.miniAlwaysOnTop} onChange={(e) => set({ miniAlwaysOnTop: e.target.checked })} />
          Mini view stays on top of other windows
        </label>
        <label className="chk">
          <input type="checkbox" checked={config.launchAtLogin} onChange={(e) => set({ launchAtLogin: e.target.checked })} />
          {loginName} (opens hidden in the tray)
          {sys && sys.login !== 'active' && (
            <span className="note"> {sys.login === 'dev' ? '— takes effect in the installed app' : '— disabled in this run'}</span>
          )}
        </label>
        <div className="row">
          <span>Mini view hotkey</span>
          <input
            style={{ width: 190 }}
            aria-label="Mini view hotkey"
            value={hotkey}
            onChange={(e) => {
              setHotkey(e.target.value);
              setHotkeyMsg(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void applyHotkey()}
          />
          <button disabled={!hotkey.trim() || (hotkey.trim() === config.miniHotkey && sys?.hotkey.registered !== false)} onClick={() => void applyHotkey()}>
            Apply
          </button>
          {hotkeyMsg ? (
            <span style={{ color: hotkeyMsg.ok ? 'var(--ok)' : 'var(--err)' }}>{hotkeyMsg.text}</span>
          ) : sys && !sys.hotkey.registered && sys.hotkey.error ? (
            <span style={{ color: 'var(--err)' }}>{sys.hotkey.error}</span>
          ) : (
            <span className="note">toggles the mini view from anywhere, e.g. CommandOrControl+Alt+V</span>
          )}
        </div>
        <div className="row">
          <button data-testid="settings-run-setup" onClick={onSetup}>
            Run setup again
          </button>
        </div>
        <div className="row">
          <span>Receiver port</span>
          <input style={{ width: 90 }} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
          <button disabled={!port || Number(port) === config.port || Number(port) < 1024 || Number(port) > 65535} onClick={() => set({ port: Number(port) })}>
            Apply
          </button>
          <span className="note">after changing the port, reinstall hooks</span>
        </div>

        <SyncSettings />

        <UpdatesSettings config={config} />

        <LocalModelsSettings config={config.localModels} />
      </div>
    </div>
  );
}

const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** What the usage pings have cost so far (tokens from the replies, est. at Haiku list price). Local only. */
function PingCost() {
  const [s, setS] = useState<PingStatsSummary | null>(null);
  useEffect(() => {
    const load = () => void window.api.pingStats().then(setS);
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const row = (label: string, b: PingStatsSummary['all']) => `${label}: ${b.n} pings, ${b.input} in / ${b.output} out tokens, est. ${usd(b.costUsd)}`;
  return (
    <div className="note" data-testid="ping-cost" style={{ margin: '0 0 8px 24px' }}>
      <div data-testid="ping-cost-today">{row('today', s.today)}</div>
      <div>{row('last 7 days', s.week)}</div>
      <div data-testid="ping-cost-all">{row('all time', s.all)}</div>
      <div>{s.lastAt ? `last ping ${new Date(s.lastAt).toLocaleString()}` : 'no ping yet'}</div>
      <button
        data-testid="ping-cost-reset"
        onClick={() => {
          void window.api.resetPingStats().then(() => window.api.pingStats().then(setS));
        }}
      >
        Reset counter
      </button>
    </div>
  );
}
