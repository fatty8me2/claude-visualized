import { useState } from 'react';
import type { SshHostView } from '@core/sshRemote';
import { useSshHosts } from '../hooks';
import { clock } from '../util';

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function HostRow({ h }: { h: SshHostView }) {
  const [confirming, setConfirming] = useState(false);
  const on = h.state === 'online' || h.state === 'syncing';
  const state =
    h.state === 'online'
      ? `online · ${h.sessions} session${h.sessions === 1 ? '' : 's'}`
      : h.state === 'syncing'
        ? `copying ${size(h.pendingBytes)}…`
        : h.state === 'connecting'
          ? 'connecting…'
          : h.offlineSince
            ? `offline since ${clock(h.offlineSince)}`
            : 'offline';
  return (
    <div className="sshm-host" data-testid="ssh-host" data-state={h.state}>
      <div className="dev-row">
        <span className={`mdot ${on ? 'on' : 'off'}`} />
        <b>{h.name}</b>
        <span className="note">
          {h.target}
          {h.port ? `:${h.port}` : ''}
        </span>
        <span className="note">{state}</span>
        {confirming ? (
          <span className="dev-confirm">
            <span className="note">Its sessions leave the sidebar and the copy of its transcripts on this computer is deleted.</span>
            <button className="danger" onClick={() => void window.api.removeSshHost(h.id)}>
              remove {h.name}
            </button>
            <button onClick={() => setConfirming(false)}>cancel</button>
          </span>
        ) : (
          <button className="danger" onClick={() => setConfirming(true)}>
            remove
          </button>
        )}
      </div>
      {h.state === 'offline' && h.error && (
        <div className="warn-text sshm-error" data-testid="ssh-error">
          {h.error}
        </div>
      )}
    </div>
  );
}

/** Devices: computers watched over SSH, with nothing installed on them. */
export function SshHosts() {
  const hosts = useSshHosts();
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    const r = await window.api.addSshHost({ target: target.trim(), port: port ? Number(port) : null, label: label.trim() || undefined });
    if (!r.ok) return setError(r.error ?? 'Could not add that computer.');
    setTarget('');
    setPort('');
    setLabel('');
  };
  return (
    <section className="dev-card" data-testid="ssh-section">
      <header>
        <b>Watch a computer without the app</b>
      </header>
      <p className="note">
        For a Mac or Linux computer you can already reach with <code>ssh</code>. Nothing is installed there: this computer logs in with your own SSH key, reads
        its Claude Code transcripts and keeps a copy of the recent ones in its app data folder. It is read-only, and it never asks for or stores a password.
        Usage meters stay per computer.
      </p>
      {hosts && hosts.length > 0 && hosts.map((h) => <HostRow key={h.id} h={h} />)}
      <div className="row pair-form">
        <input
          placeholder="user@host (e.g. me@my-mac, a Tailscale name or 100.x address)"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && target.trim() && void add()}
          data-testid="ssh-target"
          aria-label="SSH target"
        />
        <input style={{ width: 70 }} placeholder="22" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} aria-label="SSH port" />
        <input style={{ width: 150 }} placeholder="name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="name" />
        <button className="primary" disabled={!target.trim()} onClick={() => void add()} data-testid="ssh-add">
          add
        </button>
      </div>
      {error && (
        <div className="warn-text" data-testid="ssh-add-error">
          {error}
        </div>
      )}
      <p className="note">
        On a Mac, turn on System Settings → General → Sharing → Remote Login. If this computer has never connected to it, run <code>ssh user@host</code> once in
        a terminal first and accept its key.
      </p>
    </section>
  );
}
