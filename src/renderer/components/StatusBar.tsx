import { MAIN, type SessionView } from '@core/state';
import { formatTokens, modelLabel, toolLabel } from '@core/summarize';
import type { HookServerStatusView } from '@core/api';
import { displayStatus } from '../util';

export function StatusBar({ view, now, hookSrv, replaying }: { view: SessionView; now: number; hookSrv: HookServerStatusView | null; replaying: boolean }) {
  const main = view.agents[MAIN];
  const subs = Object.values(view.agents).filter((a) => a.kind === 'agent');
  const running = subs.filter((a) => a.status === 'running').length;
  const st = main ? displayStatus(main, now) : 'idle';
  const t = view.totals;
  const hooksLive = view.lastHookAt && now - view.lastHookAt < 10 * 60_000;
  return (
    <div className="statusbar">
      <span>
        mode <b className="hl">[{view.mode === 'plan' ? 'plan' : 'build'}]</b>
      </span>
      <span>
        subagents <b>[{running}/{subs.length}]</b>
      </span>
      <span>
        {modelLabel(main?.model).toLowerCase()} <b>[{st}{main?.currentTool ? ` · ${toolLabel(main.currentTool.name)}` : ''}]</b>
      </span>
      <span>
        tokens <b>{formatTokens(t.in + t.out + t.cacheRead + t.cacheWrite)}</b>
      </span>
      {view.costUSD != null && (
        <span>
          cost <b>${view.costUSD.toFixed(2)}</b>
        </span>
      )}
      <span className="spacer" />
      {replaying && <span className="hl">● replay</span>}
      <span>
        hooks{' '}
        <b className={hooksLive ? 'ok' : ''}>{hooksLive ? '● live' : hookSrv?.listening ? `○ :${hookSrv.port}` : hookSrv?.error ? '✗ ' + hookSrv.error : '○ off'}</b>
      </span>
      {view.warnings > 0 && <span title="Transcript lines this version doesn't understand (ignored)">unparsed {view.warnings}</span>}
      <span>{view.version ? `cc ${view.version}` : ''}</span>
    </div>
  );
}
