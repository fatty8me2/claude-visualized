import { useEffect, useState } from 'react';
import type { PeerDeviceView, PeersView } from '@core/api';
import { useNow, usePeers } from '../hooks';
import { ago, clock } from '../util';

const FAILURE_TEXT: Record<string, string> = {
  'bad-code': 'someone entered a wrong code',
  locked: 'a pairing attempt was refused: too many wrong codes',
  expired: 'a pairing attempt used an expired code',
  'no-code': 'a pairing attempt came in while there was no code',
  busy: 'pairing attempts came in too fast',
};

function countdown(ms: number): string {
  // the two clocks (main and renderer) can differ by a few ms: never show more than the 10 minutes a code lives
  const s = Math.min(600, Math.max(0, Math.floor(ms / 1000)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ShareSection({ p, now }: { p: PeersView; now: number }) {
  const [port, setPort] = useState(String(p.port));
  const [copied, setCopied] = useState(false);
  useEffect(() => setPort(String(p.port)), [p.port]);
  const left = p.code ? p.code.expiresAt - now : 0;
  const viewers = p.devices.filter((d) => d.role === 'viewer');
  const watching = viewers.filter((d) => d.online).length;
  return (
    <section className="dev-card" data-testid="share-section">
      <header>
        <label className="dev-toggle">
          <input type="checkbox" data-testid="share-toggle" checked={p.sharing} onChange={(e) => void window.api.setSharing(e.target.checked)} />
          <b>Share with my other computers</b>
        </label>
        {p.sharing ? (
          p.listening ? (
            <span className="share-pill on" data-testid="sharing-indicator">
              ● sharing on port {p.port}
              {watching ? ` · ${watching} watching` : ''}
            </span>
          ) : (
            <span className="share-pill err">{p.error ?? 'starting…'}</span>
          )
        ) : (
          <span className="share-pill">off</span>
        )}
      </header>
      <p className="note">
        Lets computers you pair with see this computer&apos;s sessions, inbox and usage meters live. It is read-only: they can watch, never act on a session or
        a file. While sharing is off nothing listens on the network. The first time you turn it on, Windows or macOS asks whether to allow incoming connections:
        allow it on private networks.
      </p>
      {p.sharing && p.listening && (
        <div className="pair-code-box">
          {p.code && left > 0 ? (
            <>
              <div className="note">Enter this code on the other computer (Devices → Pair with code):</div>
              <div className="pair-code-row">
                <span className="pair-code" data-testid="pair-code">
                  {p.code.code}
                </span>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(p.code!.code).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? 'copied' : 'copy'}
                </button>
                <span className="note" data-testid="pair-countdown">
                  expires in {countdown(left)} · single use · {p.failuresLeft} wrong tries left
                </span>
              </div>
            </>
          ) : (
            <div className="note">
              {p.codeState === 'used'
                ? 'The code was used: a computer paired.'
                : p.codeState === 'locked'
                  ? 'The code was locked after too many wrong tries.'
                  : 'The pairing code expired.'}{' '}
              Generate a new one to pair another computer.
            </div>
          )}
          <div className="row">
            <button data-testid="new-code" onClick={() => void window.api.newPairingCode()}>
              new code
            </button>
            {p.lastPairFailure && (
              <span className="warn-text">
                {FAILURE_TEXT[p.lastPairFailure.reason] ?? 'a pairing attempt failed'} ({ago(p.lastPairFailure.at, now)})
              </span>
            )}
          </div>
        </div>
      )}
      <div className="row">
        <span>Port</span>
        <input style={{ width: 80 }} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} aria-label="Sharing port" />
        <button
          disabled={!port || Number(port) === p.port || Number(port) < 1024 || Number(port) > 65535}
          onClick={() => void window.api.setPeerPort(Number(port))}
        >
          apply
        </button>
        <span className="note">This computer is “{p.self.name}”.</span>
      </div>
    </section>
  );
}

function PairSection({ p }: { p: PeersView }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('47830');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const pair = async () => {
    setBusy(true);
    setResult(null);
    const r = await window.api.pairWith({ host: host.trim(), port: Number(port), code });
    setBusy(false);
    setResult(r.ok ? { ok: true, text: `Paired with ${r.name}. Its sessions show up in the sidebar.` } : { ok: false, text: r.error ?? 'Pairing failed.' });
    if (r.ok) setCode('');
  };
  const discovered = p.discovered.filter((d) => !d.paired);
  return (
    <section className="dev-card" data-testid="pair-section">
      <header>
        <b>Watch another computer</b>
      </header>
      <div className="dev-sub">On your network</div>
      {discovered.length === 0 ? (
        <div className="note">{p.discovering ? 'Looking for computers that are sharing…' : 'Discovery is off.'}</div>
      ) : (
        discovered.map((d) => (
          <div key={`${d.host}:${d.port}`} className="dev-row" data-testid="discovered">
            <span className="mdot on" />
            <b>{d.name}</b>
            <span className="note">
              {d.host}:{d.port}
            </span>
            <button
              onClick={() => {
                setHost(d.host);
                setPort(String(d.port));
              }}
            >
              use
            </button>
          </div>
        ))
      )}
      <div className="dev-sub">Pair with code</div>
      <div className="row pair-form">
        <input placeholder="host or IP (e.g. my-mac.local, a Tailscale name)" value={host} onChange={(e) => setHost(e.target.value)} data-testid="pair-host" />
        <input style={{ width: 70 }} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} data-testid="pair-port" aria-label="port" />
        <input
          style={{ width: 120 }}
          placeholder="XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void pair()}
          data-testid="pair-code-input"
          aria-label="pairing code"
        />
        <button
          className="primary"
          disabled={busy || !host.trim() || !port || code.replace(/[^0-9A-Za-z]/g, '').length !== 8}
          onClick={() => void pair()}
          data-testid="pair-submit"
        >
          {busy ? 'pairing…' : 'pair'}
        </button>
      </div>
      {result && (
        <div className={result.ok ? 'ok-text' : 'warn-text'} data-testid="pair-result">
          {result.text}
        </div>
      )}
      <p className="note">
        Over Tailscale, enter the other computer&apos;s Tailscale name (e.g. <code>my-mac.tailnet.ts.net</code>) or its 100.x address; nothing else is needed.
      </p>
    </section>
  );
}

function DeviceRow({ d, now }: { d: PeerDeviceView; now: number }) {
  const state =
    d.state === 'online'
      ? 'online'
      : d.state === 'connecting'
        ? 'connecting…'
        : d.state === 'revoked'
          ? 'un-paired on the other side'
          : d.offlineSince
            ? `offline since ${clock(d.offlineSince)}`
            : d.lastSeen
              ? `last seen ${ago(d.lastSeen, now)}`
              : 'offline';
  return (
    <div className="dev-row" data-testid="device-row" data-role={d.role} data-online={d.online}>
      <span className={`mdot ${d.online ? 'on' : 'off'}`} />
      <b>{d.name}</b>
      {d.role === 'host' && (
        <span className="note">
          {d.host}:{d.port}
        </span>
      )}
      <span className="note" title={d.error ?? undefined}>
        {state}
      </span>
      <button
        className="danger"
        onClick={() => {
          if (
            confirm(
              `Un-pair ${d.name}? ${d.role === 'host' ? 'You will stop seeing its sessions' : 'It will no longer be able to watch this computer'} until you pair again.`,
            )
          )
            void window.api.unpairDevice(d.key);
        }}
      >
        un-pair
      </button>
    </div>
  );
}

/** Devices: share this computer, pair with another, and the paired list. */
export function DevicesPage() {
  const p = usePeers();
  const now = useNow(1000);
  // listen for LAN beacons only while this page is open
  useEffect(() => {
    void window.api.setDiscovering(true);
    return () => void window.api.setDiscovering(false);
  }, []);
  if (!p) return <div className="empty">loading…</div>;
  const hosts = p.devices.filter((d) => d.role === 'host');
  const viewers = p.devices.filter((d) => d.role === 'viewer');
  return (
    <div className="devices-page" data-testid="devices-page">
      <div className="inbox-head">
        <h2>Devices</h2>
        <span className="sub">watch your sessions across computers</span>
      </div>
      <ShareSection p={p} now={now} />
      <PairSection p={p} />
      <section className="dev-card" data-testid="paired-section">
        <header>
          <b>Paired computers</b>
        </header>
        <div className="dev-sub">This computer watches</div>
        {hosts.length === 0 ? <div className="note">none yet</div> : hosts.map((d) => <DeviceRow key={d.key} d={d} now={now} />)}
        <div className="dev-sub">Can watch this computer</div>
        {viewers.length === 0 ? <div className="note">none yet</div> : viewers.map((d) => <DeviceRow key={d.key} d={d} now={now} />)}
      </section>
    </div>
  );
}
