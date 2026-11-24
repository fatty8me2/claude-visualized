import { MAIN, type SessionView } from '@core/state';
import { formatTokens, modelLabel, toolLabel } from '@core/summarize';
import type { HookServerStatusView } from '@core/api';
import { estimateAgents, estimateTooltip, formatUSD } from '@core/pricing';
import { useRef } from 'react';
import { displayStatus } from '../util';
import { WORK_HELP, workCounts } from '@core/work';
import '../chrome.css';
import { addUsage, tokensByProvider } from '@core/localModels';

/** A value whose changed characters roll in (one-shot CSS transform/opacity; no timers, no state). Text content stays the plain value. */
function Roll({ v, className }: { v: string; className?: string }) {
  const prev = useRef(v);
  const was = prev.current;
  prev.current = v;
  return (
    <b className={className}>
      {Array.from(v).map((c, i) => (
        <span key={`${i}:${c}`} className={was !== v && was[i] !== c ? 'rc roll' : undefined}>
          {c}
        </span>
      ))}
    </b>
  );
}

/** One lamp per agent (up to 10): one glows and breathes for each agent that is working right now. */
function Lamps({ agents, running }: { agents: number; running: number }) {
  const n = Math.min(agents, 10);
  if (n === 0) return null;
  return (
    <span className="sb-lamps" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < running ? 'on' : undefined} style={{ animationDelay: `${(i % 5) * 0.18}s` }} />
      ))}
    </span>
  );
}

export function StatusBar({ view, now, hookSrv, replaying }: { view: SessionView; now: number; hookSrv: HookServerStatusView | null; replaying: boolean }) {
  const main = view.agents[MAIN];
  const work = workCounts(view.agents, now);
  const running = work.working;
  const st = main ? displayStatus(main, now) : 'idle';
  const split = tokensByProvider(view.agents, view.totals);
  // hosted tokens: Claude's, or Gemini's in an Antigravity session (neither is local)
  const t = addUsage(split.claude, split.gemini);
  const lt = split.local;
  const hooksLive = view.lastHookAt && now - view.lastHookAt < 10 * 60_000;
  const plan = view.mode === 'plan';
  const est = view.costUSD == null ? estimateAgents(view.agents) : null;
  return (
    <div className="statusbar" data-testid="statusbar">
      <span>
        mode <b className={plan ? 'mode-plan' : 'mode-build'}>[{plan ? 'plan' : 'build'}]</b>
      </span>
      <span className={running > 0 ? 'sb-agents live' : 'sb-agents'} title={WORK_HELP} data-testid="sb-agents">
        agents <Lamps agents={work.total} running={running} />
        <Roll v={`[${running} working${work.idle ? ` · ${work.idle} idle` : ''}]`} />
      </span>
      <span className="sb-grow">
        {modelLabel(main?.model).toLowerCase()}{' '}
        <b>
          [{st}
          {main?.currentTool ? ` · ${toolLabel(main.currentTool.name)}` : ''}]
        </b>
      </span>
      <span>
        tokens <Roll v={formatTokens(t.in + t.out + t.cacheRead + t.cacheWrite)} />
      </span>
      {split.localAgents > 0 && (
        <span title="Tokens served by local models: not counted against Anthropic limits">
          local tokens <Roll className="local-num" v={formatTokens(lt.in + lt.out + lt.cacheRead + lt.cacheWrite)} />
        </span>
      )}
      {view.costUSD != null ? (
        <span title="As reported by Claude Code">
          cost <Roll v={`$${view.costUSD.toFixed(2)}`} />
        </span>
      ) : est && est.usd > 0 ? (
        <span title={estimateTooltip(est)}>
          cost est. <Roll v={`~${formatUSD(est.usd)}`} />
        </span>
      ) : null}
      <span className="spacer" />
      {replaying && <span className="hl">● replay</span>}
      <span>
        hooks{' '}
        <b className={hooksLive ? 'ok' : ''}>
          {hooksLive ? '● live' : hookSrv?.listening ? `○ :${hookSrv.port}` : hookSrv?.error ? '✗ ' + hookSrv.error : '○ off'}
        </b>
      </span>
      {view.warnings > 0 && <span title="Transcript lines this version doesn't understand (ignored)">unparsed {view.warnings}</span>}
      <span>{view.version ? `${view.entrypoint === 'opencode' ? 'opencode' : view.entrypoint === 'antigravity' ? 'agy' : 'cc'} ${view.version}` : ''}</span>
    </div>
  );
}
