import { MAIN, type SessionView } from '@core/state';
import { formatTokens, modelLabel, toolLabel } from '@core/summarize';
import type { HookServerStatusView } from '@core/api';
import { estimateAgents, estimateTooltip, formatUSD } from '@core/pricing';
import { displayStatus } from '../util';
import { tokensByProvider } from '@core/localModels';

export function StatusBar({ view, now, hookSrv, replaying }: { view: SessionView; now: number; hookSrv: HookServerStatusView | null; replaying: boolean }) {
  const main = view.agents[MAIN];
  const subs = Object.values(view.agents).filter((a) => a.kind === 'agent');
  const running = subs.filter((a) => a.status === 'running').length;
  const st = main ? displayStatus(main, now) : 'idle';
  const split = tokensByProvider(view.agents, view.totals);
  const t = split.claude;
  const lt = split.local;
  const hooksLive = view.lastHookAt && now - view.lastHookAt < 10 * 60_000;
  const plan = view.mode === 'plan';
  const est = view.costUSD == null ? estimateAgents(view.agents) : null;
  return (
    <div className="statusbar">
      <span>
        mode <b className={plan ? 'mode-plan' : 'mode-build'}>[{plan ? 'plan' : 'build'}]</b>
      </span>
      <span>
        subagents{' '}
        <b>
          [{running}/{subs.length}]
        </b>
      </span>
      <span className="sb-grow">
        {modelLabel(main?.model).toLowerCase()}{' '}
        <b>
          [{st}
          {main?.currentTool ? ` · ${toolLabel(main.currentTool.name)}` : ''}]
        </b>
      </span>
      <span>
        tokens <b>{formatTokens(t.in + t.out + t.cacheRead + t.cacheWrite)}</b>
      </span>
      {split.localAgents > 0 && (
        <span title="Tokens served by local models: not counted against Anthropic limits">
          local tokens <b className="local-num">{formatTokens(lt.in + lt.out + lt.cacheRead + lt.cacheWrite)}</b>
        </span>
      )}
      {view.costUSD != null ? (
        <span title="As reported by Claude Code">
          cost <b>${view.costUSD.toFixed(2)}</b>
        </span>
      ) : est && est.usd > 0 ? (
        <span title={estimateTooltip(est)}>
          cost est. <b>~{formatUSD(est.usd)}</b>
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
      <span>{view.version ? `cc ${view.version}` : ''}</span>
    </div>
  );
}
