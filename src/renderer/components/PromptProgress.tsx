// The current prompt at a glance: one time bar from the prompt to its expected end, with where each subagent should
// finish, the shipping steps (commit, push, release) and when the work should be "ready for updates" (a published
// release that installed apps see at their next update check). Every future time is an estimate (src/core/eta.ts) and
// is labelled as one; hovering the strip shows the range and what it is based on.
import type { CSSProperties } from 'react';
import { firstLine } from '@core/activity';
import type { AgentMark, FinishLine, PromptEta, StageEta } from '@core/eta';
import { MAIN, type SessionView } from '@core/state';
import { agentBasis, agentLeftLabel, fmtClock, fmtLeft, fmtSpan } from '../eta';
import { famClass } from '../util';
import { Icon } from './Icon';

const LINE: Record<Exclude<FinishLine, 'turn'>, { label: string; title: string }> = {
  release: { label: 'ready for updates', title: 'The release is published: installed apps get it at their next update check' },
  push: { label: 'on GitHub', title: 'Pushed to GitHub' },
  commit: { label: 'committed', title: 'Committed' },
};

const CONFIDENCE: Record<PromptEta['confidence'], string> = { high: 'fairly sure', medium: 'rough', low: 'a guess' };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function agentTitle(view: SessionView, id: string): string {
  const a = view.agents[id];
  if (!a) return id;
  return firstLine(a.description, 60) || a.agentType || 'agent';
}

function phaseText(eta: PromptEta, stale: boolean): string {
  if (stale) return 'stopped';
  if (eta.state === 'done') return `done · took ${fmtSpan((eta.finishAt ?? eta.startedAt) - eta.startedAt)}`;
  if (eta.state === 'waiting') return 'waiting for you';
  const bits: string[] = [];
  if (eta.steps) bits.push(`step ${Math.min(eta.steps.total, eta.steps.done + Math.max(1, eta.steps.active))} of ${eta.steps.total}`);
  const running = eta.agents.filter((m) => m.state === 'running').length;
  if (running) bits.push(`${running} agent${running === 1 ? '' : 's'} running`);
  const shipping = eta.stages.find((s) => s.key !== 'work' && s.plan === 'turn' && s.state === 'active');
  if (shipping) bits.push(shipping.note ? `${shipping.key}: ${shipping.note}` : `${shipping.key} under way`);
  return bits.join(' · ') || 'working';
}

/** "ready for updates ≈ 3:49 PM", "✓ on GitHub 3:47 PM", "ready for updates after your go-ahead" */
function lineText(eta: PromptEta, stale: boolean): { text: string; cls: string; title: string } | null {
  if (eta.finishLine === 'turn') return null;
  const meta = LINE[eta.finishLine];
  const st = eta.stages.find((s) => s.key === eta.finishLine);
  if (!st) return null;
  if (st.state === 'done' && st.at) return { text: `${meta.label} ${fmtClock(st.at)}`, cls: 'done', title: meta.title };
  if (st.state === 'failed') return { text: `${eta.finishLine} failed`, cls: 'failed', title: `The last ${eta.finishLine} attempt failed` };
  if (eta.state === 'done' || stale) {
    if (st.plan === 'later')
      return { text: `${meta.label}: after your go-ahead`, cls: 'later', title: `${meta.title}. Asked for in the prompt but not done yet.` };
    return { text: st.note ? `${eta.finishLine}: ${st.note}` : `${meta.label}: not yet`, cls: 'later', title: meta.title };
  }
  if (st.at === null) return { text: `${meta.label} after the work`, cls: st.plan, title: meta.title };
  return {
    text: `${meta.label} ≈ ${fmtClock(st.at)}${st.plan === 'later' ? ' after your go-ahead' : ''}`,
    cls: st.plan,
    title:
      st.plan === 'later'
        ? `${meta.title}. It was asked for in the prompt but is not on the task list, so it usually comes in a later turn; this time assumes you say go right away.`
        : meta.title,
  };
}

function stageLine(s: StageEta, over: boolean): string {
  const when = s.at ? (s.state === 'done' ? fmtClock(s.at) : `≈ ${fmtClock(s.at)}`) : '';
  if (s.state === 'done') return `done ${when}${s.note && s.key !== 'work' ? ` · ${s.note}` : ''}`;
  if (s.state === 'skipped') return 'not in this turn';
  if (s.state === 'failed') return 'failed';
  if (s.plan === 'later') return over ? 'after your go-ahead' : `after your go-ahead${when ? `, ${when}` : ''}`;
  if (over) return s.note || 'not done';
  return [s.state === 'active' ? s.note || 'under way' : 'planned', when].filter(Boolean).join(' · ');
}

function AgentRow({ view, m, now }: { view: SessionView; m: AgentMark; now: number }) {
  const a = view.agents[m.id];
  const fam = famClass(a?.model);
  const status =
    m.state === 'done' || m.state === 'error'
      ? `${m.state === 'error' ? 'failed' : 'done'}${m.at ? ` ${fmtClock(m.at)}` : ''}`
      : m.eta
        ? `${agentLeftLabel(m.eta)}${m.eta.overdue || m.eta.paused ? '' : ` · ${fmtClock(m.eta.at)}`}`
        : `${fmtSpan(now - (a?.startedAt ?? now))} so far · nothing similar in the history yet`;
  return (
    <li className={`pp-arow ${fam} ${m.state}${m.eta?.overdue ? ' overdue' : ''}`} title={m.eta ? agentBasis(m.eta) : undefined}>
      <span className="pp-aname">
        <i className="pp-dot" aria-hidden />
        {agentTitle(view, m.id)}
      </span>
      <span className="pp-astat mono">{status}</span>
    </li>
  );
}

export interface PromptProgressProps {
  view: SessionView;
  eta: PromptEta;
  now: number;
  /** the session is no longer live and is not being replayed: a turn still marked as running has stopped */
  stale: boolean;
  onSelectAgent?: (id: string) => void;
}

export function PromptProgress({ view, eta, now, stale, onSelectAgent }: PromptProgressProps) {
  const t0 = eta.startedAt;
  const over = eta.state === 'done' || stale;
  const est = !over && eta.finishAt !== null;
  // the time axis: the prompt's start to whichever comes last (its end, the finish line, an agent due later), plus a margin
  const ends = [eta.finishAt ?? 0, ...eta.stages.map((s) => s.at ?? 0), ...eta.agents.map((m) => m.at ?? 0)];
  const last = over ? Math.max(eta.finishAt ?? view.lastActivity ?? now, ...ends) : Math.max(now, ...ends);
  const span = Math.max(60_000, (last - t0) * (over ? 1.02 : 1.06));
  const pct = (t: number) => `${(clamp01((t - t0) / span) * 100).toFixed(2)}%`;
  const nowAt = over ? (eta.finishAt ?? last) : now;
  const workAt = eta.workAt;
  const later = eta.stages.filter((s) => s.plan === 'later' && s.at !== null);
  const laterEnd = later.length ? Math.max(...later.map((s) => s.at!)) : null;
  const line = lineText(eta, stale);
  const left = est ? eta.finishAt! - now : null;
  const main = view.agents[MAIN];
  const style = { ['--pp-pos' as string]: pct(nowAt) } as CSSProperties;
  const shipStages = eta.stages.filter((s) => s.key !== 'work');
  const valueText = over
    ? `done at ${fmtClock(eta.finishAt ?? now)}`
    : est
      ? `about ${fmtLeft(left!).replace('~', '')} left, around ${fmtClock(eta.finishAt!)} (estimate)`
      : `${fmtSpan(now - t0)} so far, no estimate yet`;

  return (
    <section
      className={`pp ${famClass(main?.model)} st-${stale ? 'stale' : eta.state} conf-${eta.confidence}${est ? '' : ' no-est'}`}
      data-testid="prompt-progress"
      style={style}
      tabIndex={0}
      aria-label="Prompt progress"
    >
      <div className="pp-head">
        <span className="pp-eyebrow eyebrow">prompt</span>
        <span className="pp-phase" data-testid="pp-phase">
          {phaseText(eta, stale)}
        </span>
        <span className="pp-read" data-testid="pp-read">
          {over ? (
            <>
              <span className="pp-k">finished</span>
              <b>{fmtClock(eta.finishAt ?? now)}</b>
            </>
          ) : est ? (
            <>
              <b>{fmtLeft(left!)}</b>
              <span className="pp-at">· {fmtClock(eta.finishAt!)}</span>
            </>
          ) : (
            <>
              <b>{fmtSpan(now - t0)}</b>
              <span className="pp-at">so far · estimating…</span>
            </>
          )}
          {line && (
            <span className={`pp-line ${line.cls}`} title={line.title} data-testid="pp-line">
              {line.cls === 'done' && <Icon name="done" size="xs" />}
              {line.text}
            </span>
          )}
          {!over && (
            <span className="pp-est" title={`Estimate (${CONFIDENCE[eta.confidence]}). Hover the bar for what it is based on.`}>
              est.
            </span>
          )}
        </span>
      </div>

      <div
        className="pp-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={eta.fraction === null ? undefined : Math.round(eta.fraction * 100)}
        aria-valuetext={valueText}
      >
        <div className="pp-fill" style={{ width: pct(nowAt) }} />
        {est && workAt !== null && workAt > now && <div className="pp-proj" style={{ left: pct(now), width: `calc(${pct(workAt)} - ${pct(now)})` }} />}
        {est && eta.finishAt! > Math.max(now, workAt ?? 0) && (
          <div
            className="pp-shipseg"
            style={{ left: pct(Math.max(now, workAt ?? now)), width: `calc(${pct(eta.finishAt!)} - ${pct(Math.max(now, workAt ?? now))})` }}
          />
        )}
        {laterEnd !== null && (
          <div className="pp-later" style={{ left: pct(eta.finishAt ?? now), width: `calc(${pct(laterEnd)} - ${pct(eta.finishAt ?? now)})` }} />
        )}
        {!over && !est && <div className="pp-indet" style={{ left: pct(now) }} />}
        {eta.agents.map((m) =>
          m.at === null ? null : (
            <button
              key={m.id}
              className={`pp-agent ${famClass(view.agents[m.id]?.model)} ${m.state}${m.eta?.overdue ? ' overdue' : ''}`}
              style={{ left: pct(m.at) }}
              title={`${agentTitle(view, m.id)}: ${m.state === 'done' ? `done ${fmtClock(m.at)}` : m.state === 'error' ? `failed ${fmtClock(m.at)}` : `${agentLeftLabel(m.eta)} · ${fmtClock(m.at)} (est.)`}`}
              onClick={() => onSelectAgent?.(m.id)}
              aria-label={`agent ${agentTitle(view, m.id)}`}
              data-testid="pp-agent"
            />
          ),
        )}
        {shipStages.map((s) =>
          s.at === null ? null : (
            <i
              key={s.key}
              className={`pp-stage ${s.state} plan-${s.plan}`}
              style={{ left: pct(s.at) }}
              title={`${s.key}: ${stageLine(s, over)}`}
              data-testid={`pp-stage-${s.key}`}
            />
          ),
        )}
        {!over && <i className="pp-now" style={{ left: pct(now) }} aria-hidden />}
        {est && <i className={`pp-flag${eta.finishLine !== 'turn' && !later.length ? ' ship' : ''}`} style={{ left: pct(eta.finishAt!) }} aria-hidden />}
      </div>

      {shipStages.length > 0 && (
        <div className="pp-legend" aria-hidden>
          {shipStages.map((s) => (
            <span key={s.key} className={`pp-chip ${s.state} plan-${s.plan}`} title={stageLine(s, over)}>
              <i />
              {s.key}
              <span className="pp-cnote">
                {s.state === 'done' && s.at ? fmtClock(s.at) : s.plan === 'later' ? 'after go-ahead' : s.at && !over ? `≈ ${fmtClock(s.at)}` : s.note}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="pp-pop" role="tooltip" data-testid="pp-pop">
        {!over && eta.low !== null && eta.high !== null && (
          <div className="pp-range">
            likely <b className="mono">{fmtClock(eta.low)}</b> – <b className="mono">{fmtClock(eta.high)}</b>
            <span className="pp-conf">{CONFIDENCE[eta.confidence]}</span>
          </div>
        )}
        {eta.basis.length > 0 && (
          <ul className="pp-basis">
            {eta.basis.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {eta.agents.length > 0 && (
          <>
            <h5>agents</h5>
            <ul className="pp-agents">
              {[...eta.agents]
                .sort((x, y) => Number(y.state === 'running' || y.state === 'waiting') - Number(x.state === 'running' || x.state === 'waiting'))
                .slice(0, 12)
                .map((m) => (
                  <AgentRow key={m.id} view={view} m={m} now={now} />
                ))}
            </ul>
            {eta.agents.length > 12 && <div className="pp-more">+{eta.agents.length - 12} more</div>}
          </>
        )}
        {shipStages.length > 0 && (
          <>
            <h5>shipping</h5>
            <ul className="pp-ship">
              {shipStages.map((s) => (
                <li key={s.key} className={`${s.state} plan-${s.plan}`}>
                  <span className="pp-sk">{s.key}</span>
                  <span className="mono">{stageLine(s, over)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="pp-foot">
          Estimates from this session&apos;s pace and similar agents and prompts in this computer&apos;s history. Claude Code reports no progress of its own.
        </p>
      </div>
    </section>
  );
}
