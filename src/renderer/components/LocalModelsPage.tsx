import { useState } from 'react';
import { formatBytes, localSummary, memorySplit, serverKindName, unloadsIn, type LocalModelInfo, type LocalServerStatus } from '@core/localModels';
import { classifyModel, sameModel } from '@core/models';
import type { SessionView } from '@core/state';
import { formatTokens } from '@core/summarize';
import { useNow, useOverview } from '../hooks';
import { useLocalModels } from '../localStore';
import { agentName, ago } from '../util';
import { UsageMeters } from './UsageMeters';

interface UsedBy {
  session: string;
  sessionId: string;
  agent: string;
  at: number;
}

const RECENT_MS = 10 * 60_000;

/** Agents (in live sessions) that ran on this model recently. */
function usedBy(model: LocalModelInfo, views: SessionView[] | null, now: number): UsedBy[] {
  const out: UsedBy[] = [];
  for (const v of views ?? []) {
    for (const a of Object.values(v.agents)) {
      if (!a.model || classifyModel(a.model).provider === 'anthropic' || !sameModel(a.model, model.id)) continue;
      if (now - a.lastActivity > RECENT_MS && a.status !== 'running') continue;
      out.push({ session: v.title ?? 'untitled session', sessionId: v.id, agent: agentName(a), at: a.lastActivity });
    }
  }
  return out.sort((x, y) => y.at - x.at);
}

function MemBar({ m }: { m: LocalModelInfo }) {
  const split = memorySplit(m);
  if (!split) return <span className="lm-faint">{m.sizeBytes ? formatBytes(m.sizeBytes) : 'memory use not reported'}</span>;
  return (
    <span className="lm-mem" title={`${formatBytes(split.vram)} in GPU memory (VRAM), ${formatBytes(split.ram)} in system memory (RAM)`}>
      <span className="lm-bar" data-testid="mem-bar">
        <i className="vram" style={{ width: `${split.vramPct}%` }} />
      </span>
      <span data-testid="mem-text">
        {formatBytes(split.vram)} VRAM{split.ram > 0 ? ` + ${formatBytes(split.ram)} RAM` : ''}
        {split.ram <= 0 ? ' · 100% GPU' : split.vram <= 0 ? ' · CPU only' : ` · ${split.vramPct}% GPU`}
      </span>
    </span>
  );
}

function LoadedRow({ m, views, now }: { m: LocalModelInfo; views: SessionView[] | null; now: number }) {
  const users = usedBy(m, views, now);
  const unload = unloadsIn(m.expiresAt, now);
  return (
    <div className="lm-model" data-testid="loaded-model" data-model={m.id}>
      <div className="lm-model-head">
        <b>{m.id}</b>
        <span className="lm-label">{m.label}</span>
        {m.params && <span className="lm-pill">{m.params}</span>}
        {m.quant && <span className="lm-pill">{m.quant}</span>}
        {m.family && <span className="lm-pill">{m.family}</span>}
        {m.capabilities.filter((c) => c !== 'completion').map((c) => (
          <span key={c} className="lm-pill dim">{c}</span>
        ))}
      </div>
      <div className="lm-model-body">
        <MemBar m={m} />
        <span className="lm-ctx" data-testid="model-ctx" title={m.maxContext ? `model maximum ${formatTokens(m.maxContext)}` : undefined}>
          context {m.contextLength ? formatTokens(m.contextLength) : m.maxContext ? `max ${formatTokens(m.maxContext)}` : 'unknown'}
        </span>
        <span className="lm-unload" data-testid="model-unload">{unload ? `unloads in ${unload}` : m.expiresAt == null ? 'stays loaded / unknown' : ''}</span>
      </div>
      {users.length > 0 && (
        <div className="lm-used" data-testid="used-by">
          used by: {users.slice(0, 4).map((u) => `${u.session} / ${u.agent} (${ago(u.at, now)})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function ServerCard({ s, views, now }: { s: LocalServerStatus; views: SessionView[] | null; now: number }) {
  const [open, setOpen] = useState(false);
  const stats: [string, string][] = [];
  if (s.inFlight != null) stats.push(['requests in flight', String(s.inFlight)]);
  if (s.slots) stats.push(['slots busy', `${s.slots.busy}/${s.slots.total}`]);
  if (s.tokensPerSec?.generation != null) stats.push(['generation (avg, server-reported)', `${s.tokensPerSec.generation.toFixed(1)} tok/s`]);
  if (s.tokensPerSec?.prompt != null) stats.push(['prompt (avg, server-reported)', `${s.tokensPerSec.prompt.toFixed(1)} tok/s`]);
  return (
    <section className="lm-server up" data-testid="local-server" data-server={s.id}>
      <header>
        <span className="lm-dot up" />
        <b>{s.name}</b>
        {s.kind === 'openai' && <span className="lm-pill dim">{serverKindName(s.kind)}</span>}
        <span className="lm-url">{s.baseUrl}</span>
        {s.version && <span className="lm-pill">v{s.version}</span>}
        <span className="lm-faint" style={{ marginLeft: 'auto' }}>checked {ago(s.checkedAt, now)}</span>
      </header>
      {stats.length > 0 && (
        <div className="lm-stats">
          {stats.map(([k, v]) => (
            <span key={k}>
              {k} <b>{v}</b>
            </span>
          ))}
        </div>
      )}
      <h5>loaded now · {s.loaded.length}</h5>
      {s.loaded.length === 0 ? <div className="lm-faint">no model loaded in memory (the server loads one on the first request)</div> : s.loaded.map((m) => <LoadedRow key={m.id} m={m} views={views} now={now} />)}
      {s.installed.length > 0 && (
        <>
          <h5 className="lm-toggle" onClick={() => setOpen(!open)} data-testid="installed-toggle">
            {open ? '▾' : '▸'} installed · {s.installed.length}
          </h5>
          {open && (
            <div className="lm-installed" data-testid="installed-list">
              {s.installed.map((m) => (
                <div key={m.id} className={m.loaded ? 'loaded' : ''}>
                  <span className="n">{m.id}</span>
                  <span className="lm-faint">{[m.params, m.quant, m.sizeBytes ? formatBytes(m.sizeBytes) : null].filter(Boolean).join(' · ')}</span>
                  {m.loaded && <span className="lm-pill">loaded</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {s.notes.length > 0 && (
        <ul className="lm-notes">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Empty({ servers, onCheck, checking, onSettings }: { servers: LocalServerStatus[]; onCheck: () => void; checking: boolean; onSettings: () => void }) {
  return (
    <div className="lm-empty" data-testid="local-empty">
      <div className="lm-empty-title">No local model servers found on this computer</div>
      <ul className="lm-hints">
        <li>
          <b>Ollama</b>: install it from ollama.com, then run <code>ollama pull qwen2.5-coder:7b</code> (it listens on 127.0.0.1:11434).
        </li>
        <li>
          <b>LM Studio</b>: load a model, then start the local server from the Developer tab (127.0.0.1:1234).
        </li>
        <li>
          <b>llama.cpp, vLLM, Jan, LocalAI</b>: add their address under <a onClick={onSettings}>settings, local models</a>.
        </li>
      </ul>
      <div className="lm-actions">
        <button className="primary" data-testid="local-check" onClick={onCheck} disabled={checking}>
          {checking ? 'checking…' : 'check again'}
        </button>
        <button onClick={onSettings}>settings</button>
      </div>
      {servers.length > 0 && (
        <div className="lm-faint lm-checked">
          checked: {servers.map((s) => `${s.name} ${s.baseUrl} (${s.state === 'disabled' ? 'disabled' : s.state === 'checking' ? 'checking' : 'not running'})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

export function LocalModelsPage({ onOpenSession: _onOpenSession, onSettings }: { onOpenSession: (id: string) => void; onSettings: () => void }) {
  const { servers } = useLocalModels();
  const views = useOverview();
  const now = useNow(1000);
  const [checking, setChecking] = useState(false);
  const { up, loaded } = localSummary(servers);
  const ups = servers.filter((s) => s.state === 'up');
  const others = servers.filter((s) => s.state !== 'up');
  const check = () => {
    setChecking(true);
    void window.api.refreshLocalModels();
    setTimeout(() => setChecking(false), 1200);
  };
  return (
    <div className="overview localpage" data-testid="local-page">
      <div className="topbar">
        <div className="title">
          LOCAL MODELS{' '}
          <span className="proj">
            · {up} server{up === 1 ? '' : 's'} up · {loaded} model{loaded === 1 ? '' : 's'} loaded
          </span>
        </div>
        <UsageMeters />
        <div className="actions">
          <button onClick={check} disabled={checking} data-testid="local-refresh">
            ⟳ check again
          </button>
          <button onClick={onSettings}>⚙ settings</button>
        </div>
      </div>
      <div className="lm-body">
        <div className="lm-faint lm-privacy">Read-only status from the servers you configured; nothing from your sessions is sent to them.</div>
        {up === 0 ? (
          <Empty servers={servers} onCheck={check} checking={checking} onSettings={onSettings} />
        ) : (
          <>
            {ups.map((s) => (
              <ServerCard key={s.id} s={s} views={views} now={now} />
            ))}
            {others.length > 0 && (
              <div className="lm-others lm-faint">
                not running: {others.map((s) => `${s.name} (${s.baseUrl}${s.state === 'disabled' ? ', disabled' : ''})`).join(' · ')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
