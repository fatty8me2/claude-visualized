import { MAIN, type SessionView } from '@core/state';
import { CtxBar } from './ContextMeter';
import { formatDuration, formatTokens, modeLabel, modelLabel } from '@core/summarize';
import type { HookServerStatusView } from '@core/api';
import { tokensByProvider } from '@core/localModels';
import { isLocalModel, LocalTag } from './LocalBits';
import { estimateAgents, estimateTooltip, formatUSD } from '@core/pricing';
import { Icon } from './Icon';

export function ModePanel({ view, now, hookSrv }: { view: SessionView; now: number; hookSrv: HookServerStatusView | null }) {
  const m = modeLabel(view.mode);
  const plan = m.short === 'PLAN';
  const main = view.agents[MAIN];
  const done = view.todos.filter((t) => t.status === 'completed').length;
  const split = tokensByProvider(view.agents, view.totals);
  const t = split.claude;
  const lt = split.local;
  const allLocal = split.localAgents > 0 && t.in + t.out + t.cacheRead + t.cacheWrite === 0;
  const hookFresh = view.lastHookAt && now - view.lastHookAt < 10 * 60_000;
  const est = estimateAgents(view.agents);
  const byModel = Object.entries(view.costByModel ?? {}).filter(([, v]) => v > 0);
  const reportedTitle = [
    'As reported by Claude Code in the transcript (cost-state); only written at certain points',
    ...(byModel.length ? ['', 'by model:', ...byModel.map(([k, v]) => `  ${modelLabel(k)} $${v.toFixed(2)}`)] : []),
  ].join('\n');
  return (
    <div className="modepanel" data-tour="mode">
      <div
        className={`modebox ${plan ? 'plan' : 'build'}`}
        title={`${plan ? 'Plan mode: Claude reads and designs, nothing is changed.' : 'Build mode: Claude may edit files.'}\nIn Claude Code, shift+tab switches modes.`}
      >
        <span className="mode-ic">
          <Icon name={plan ? 'plan' : 'edit'} size="md" />
        </span>
        <div className="mode-tx">
          <div className="big">{plan ? 'PLAN MODE' : 'BUILD MODE'}</div>
          <div className="detail">{plan ? 'reads and designs, no edits' : m.detail}</div>
        </div>
        <div className="flip" aria-hidden>
          <span className={plan ? 'cur' : ''}>plan</span>
          <span className={plan ? '' : 'cur'}>build</span>
        </div>
      </div>

      <div className="section">
        <h4>
          <span>checklist</span>
          {view.todos.length > 0 && (
            <span>
              {done}/{view.todos.length}
            </span>
          )}
        </h4>
        {view.todos.length === 0 ? (
          <div className="empty-note">no tasks tracked yet</div>
        ) : (
          <>
            <div className="progress">
              <i style={{ width: `${(done / view.todos.length) * 100}%` }} />
            </div>
            {view.todos.map((td) => (
              <div key={td.id} className={`todo ${td.status}`}>
                <span className="tg">
                  <Icon name={td.status === 'completed' ? 'done' : td.status === 'in_progress' ? 'running' : 'idle'} size="xs" />
                </span>
                <span className="tx">{td.text}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="section">
        <h4>main agent</h4>
        <CtxBar agent={main} />
        <div className="kv">
          <span className="k">model</span>
          <span className="v">
            {modelLabel(main?.model)} {isLocalModel(main?.model) && <LocalTag />}
          </span>
          <span className="k">effort</span>
          <span className="v">{main?.effort ?? '—'}</span>
          <span className="k">tools used</span>
          <span className="v">{main?.toolCount ?? 0}</span>
          <span className="k">errors</span>
          <span className="v">{main?.errorCount ?? 0}</span>
        </div>
      </div>

      <div className="section">
        <h4>{split.localAgents > 0 ? 'tokens (Claude agents)' : 'tokens (all agents)'}</h4>
        <div className="kv">
          <span className="k">input</span>
          <span className="v">{formatTokens(t.in)}</span>
          <span className="k">output</span>
          <span className="v">{formatTokens(t.out)}</span>
          <span className="k">cache read</span>
          <span className="v">{formatTokens(t.cacheRead)}</span>
          <span className="k">cache write</span>
          <span className="v">{formatTokens(t.cacheWrite)}</span>
          <span className="k">{view.costUSD == null && est.usd > 0 && !allLocal ? 'cost est.' : 'cost'}</span>
          {allLocal ? (
            <span className="v">n/a</span>
          ) : view.costUSD != null ? (
            <span className="v" title={reportedTitle} data-testid="cost">
              ${view.costUSD.toFixed(2)}
            </span>
          ) : est.usd > 0 ? (
            <span className="v est" title={estimateTooltip(est)} data-testid="cost">
              ~{formatUSD(est.usd)}
              {est.unpriced.length ? '+' : ''}
            </span>
          ) : (
            <span className="v">—</span>
          )}
        </div>
      </div>

      {split.localAgents > 0 && (
        <div className="section" data-testid="local-tokens">
          <h4>
            <span>local tokens</span>
            <LocalTag title="Served by a local model: not counted against the 5-hour or weekly limits, no Anthropic cost" />
          </h4>
          <div className="kv">
            <span className="k">input</span>
            <span className="v">{formatTokens(lt.in)}</span>
            <span className="k">output</span>
            <span className="v">{formatTokens(lt.out)}</span>
            {lt.cacheRead + lt.cacheWrite > 0 && (
              <>
                <span className="k">cache</span>
                <span className="v">{formatTokens(lt.cacheRead + lt.cacheWrite)}</span>
              </>
            )}
            <span className="k">agents</span>
            <span className="v">{split.localAgents}</span>
          </div>
        </div>
      )}

      <div className="section">
        <h4>session</h4>
        <div className="kv">
          <span className="k">duration</span>
          <span className="v">{view.startedAt ? formatDuration((view.lastActivity ?? now) - view.startedAt) : '—'}</span>
          <span className="k">project</span>
          <span className="v" title={view.cwd ?? ''}>
            {view.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? '—'}
          </span>
          <span className="k">branch</span>
          <span className="v">{view.gitBranch || '—'}</span>
          <span className="k">client</span>
          <span className="v">{view.entrypoint ?? '—'}</span>
          <span className="k">version</span>
          <span className="v">{view.version ?? '—'}</span>
          <span className="k">hooks</span>
          <span className="v" style={{ color: hookFresh ? 'var(--ok)' : 'var(--muted)' }}>
            {hookFresh ? 'live' : hookSrv?.listening ? 'transcript only' : 'off'}
          </span>
        </div>
      </div>
    </div>
  );
}
