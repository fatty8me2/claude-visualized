// The agent drawer's section for a Kiln run (a task Claude handed to the local model, src/core/kiln.ts): how it went, what it
// changed, how fast the local model was, and its answer. Class prefix: kiln-
import { useEffect, useState } from 'react';
import type { KilnStatusView } from '@core/api';
import type { KilnInfo } from '@core/events';
import { formatDuration, formatTokens } from '@core/summarize';
import { CopyButton } from './CopyButton';
import '../kiln.css';

const base = (p: string) => p.split(/[\\/]/).pop() || p;

export function KilnPanel({ k }: { k: KilnInfo }) {
  const state = !k.finished ? 'run' : k.ok ? 'ok' : 'bad';
  const local = k.promptTokens + k.completionTokens;
  return (
    <section className={`kiln-panel kiln-${state}`} data-testid="kiln-panel">
      <h4>
        <span className="kiln-mark" aria-hidden>
          ◆
        </span>
        Kiln · local model
        <span className="kiln-state" data-testid="kiln-state">
          {state === 'run' ? 'working' : state === 'ok' ? 'finished' : 'failed'}
        </span>
      </h4>
      <div className="kiln-chips">
        {k.model && <span className="chip">{k.model}</span>}
        {k.profile && <span className="chip">profile {k.profile}</span>}
        {k.effort && <span className="chip">effort {k.effort}</span>}
        {k.readonly && <span className="chip kiln-ro">read-only</span>}
      </div>
      {k.error && (
        <div className="kiln-err" data-testid="kiln-error">
          {k.error}
        </div>
      )}
      {k.finished && (
        <div className="kiln-tiles">
          <div>
            <span className="tk">steps</span>
            <b>{k.steps}</b>
          </div>
          <div title={`${formatTokens(k.promptTokens)} prompt + ${formatTokens(k.completionTokens)} output tokens, run on your machine`}>
            <span className="tk">local tokens</span>
            <b data-testid="kiln-tokens">{formatTokens(local)}</b>
          </div>
          <div>
            <span className="tk">speed</span>
            <b>{k.tokensPerSec ? `${k.tokensPerSec.toFixed(0)} tok/s` : '—'}</b>
          </div>
          <div>
            <span className="tk">took</span>
            <b>{k.seconds ? formatDuration(k.seconds * 1000) : '—'}</b>
          </div>
        </div>
      )}
      {k.finished && local > 0 && (
        <div className="kiln-saved" data-testid="kiln-saved">
          {formatTokens(local)} tokens ran on your machine instead of Claude · $0
        </div>
      )}
      {k.filesChanged.length > 0 && (
        <div className="kiln-files" data-testid="kiln-files">
          <span className="tk">files changed · {k.filesChanged.length}</span>
          <div className="chips">
            {k.filesChanged.slice(0, 30).map((f) => (
              <span key={f} className="chip" data-tone="text" title={f}>
                {base(f)}
              </span>
            ))}
            {k.filesChanged.length > 30 && <span className="more">+{k.filesChanged.length - 30} more</span>}
          </div>
          {k.diffStat && <pre className="kiln-diff">{k.diffStat}</pre>}
        </div>
      )}
      {k.finished && k.answer && (
        <div className="kiln-answer">
          <span className="tk">
            answer
            <CopyButton text={k.answer} title="Copy the local model's answer" />
          </span>
          <div className="kiln-answer-text">{k.answer}</div>
        </div>
      )}
      {k.finished && !k.readonly && k.filesChanged.length > 0 && <div className="kiln-note">Claude is asked to review this diff and re-run the tests.</div>}
    </section>
  );
}

/** Kiln's row on the Local models page: its last model check and its newest run. Hidden until Kiln has written anything. */
export function KilnStatusRow({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [v, setV] = useState<KilnStatusView | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      window.api
        ?.getKilnStatus?.()
        .then((x) => live && setV(x))
        .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!v || !v.enabled || (!v.found && !v.runs)) return null;
  const c = v.check;
  const l = v.last;
  const ago = (t: number) => `${formatDuration(Math.max(0, Date.now() - t))} ago`;
  return (
    <div className="kiln-status" data-testid="kiln-status">
      <span className={`kiln-dot ${c ? (c.reachable ? 'ok' : 'bad') : ''}`} />
      <b>Kiln</b>
      {c ? (
        <span title={c.detail || c.baseUrl}>
          profile {c.profile} · {c.model} · {c.reachable ? 'server reachable' : 'server not reachable'}{' '}
          <span className="kiln-muted">(checked {ago(c.ts)})</span>
        </span>
      ) : (
        <span className="kiln-muted">no model check yet</span>
      )}
      <span data-testid="kiln-runs">
        {v.runs} hand-off{v.runs === 1 ? '' : 's'}
        {v.running ? ` · ${v.running} running` : ''}
      </span>
      {l && (
        <span className="kiln-muted">
          last: {l.title} · {l.ok === null ? 'working' : l.ok ? `finished${l.seconds ? ` in ${formatDuration(l.seconds * 1000)}` : ''}` : 'failed'}
          {l.tokensPerSec ? ` · ${l.tokensPerSec.toFixed(0)} tok/s` : ''} · {ago(l.at)}{' '}
          {l.sessionId && (
            <button className="link" onClick={() => onOpen(l.sessionId!)} data-testid="kiln-open-last">
              open
            </button>
          )}
        </span>
      )}
    </div>
  );
}
