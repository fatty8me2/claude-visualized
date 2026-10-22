import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { MAIN, type SessionView } from '@core/state';
import { GOAL_INFO, type Goal } from '@core/goal';
import { sessionInsights } from '@core/sessionInsights';
import { formatTokens, modelFamily } from '@core/summarize';
import { formatUSD } from '@core/pricing';
import { Icon, type IconName } from '../Icon';

const LS_KEY = 'cv.insights.collapsed';
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function Fold({
  id,
  title,
  aside,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`section ins-sec ${open ? '' : 'closed'}`} data-testid={`ins-${id}`}>
      <h4>
        <button className="ins-fold" aria-expanded={open} onClick={() => onToggle(id)}>
          <span className="ins-chev" aria-hidden>
            ▾
          </span>
          {title}
        </button>
        {aside != null && <span className="ins-aside">{aside}</span>}
      </h4>
      {open && children}
    </div>
  );
}

const fmtRate = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1));
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function splitPath(p: string): { base: string; dir: string } {
  const parts = p.split(/[\\/]/).filter(Boolean);
  const base = parts.pop() ?? p;
  return { base, dir: parts.slice(-3).join('/') };
}

function Strip({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const W = 240;
  const H = 38;
  const step = W / data.length;
  return (
    <svg
      className="ins-strip"
      viewBox={`0 0 ${W} ${H + 1}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="tool calls per minute, last 30 minutes"
      data-testid="ins-strip"
    >
      <line className="ins-axis" x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} />
      {data.map((c, i) => {
        const h = c ? Math.max(2, (c / max) * (H - 2)) : 0;
        return (
          <rect key={i} className={`ins-bar ${i === data.length - 1 ? 'now' : ''}`} x={i * step + 0.5} y={H - h} width={step - 1.5} height={h}>
            <title>{`${data.length - 1 - i === 0 ? 'this minute' : `${data.length - 1 - i} min ago`}: ${c} calls`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

const STATES = ['running', 'waiting', 'done', 'error'] as const;

export function Insights({ view, now, onSelectAgent }: { view: SessionView; now: number; onSelectAgent?: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const n = { ...c, [id]: !c[id] };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(n));
      } catch {
        /* storage unavailable: the state stays in memory */
      }
      return n;
    });
  }, []);
  const [copied, setCopied] = useState<string | null>(null);

  // rates move slowly: recompute when the view changes or every 15 s, not on every clock tick
  const tick = Math.floor(now / 15_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ins = useMemo(() => sessionInsights(view, now), [view, tick]);
  const open = (id: string) => !collapsed[id];

  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(p);
    setTimeout(() => setCopied((c) => (c === p ? null : c)), 1500);
  };

  const agentName = (id: string) => {
    if (id === MAIN) return 'main';
    const a = view.agents[id];
    return a ? a.description || a.agentType || id : id;
  };
  const dot = (id: string) => <i className={`ins-dot fam-${modelFamily(view.agents[id]?.model)}`} title={agentName(id)} />;

  const peak = Math.max(0, ...ins.toolsPerMin);
  const total = ins.toolsPerMin.reduce((a, b) => a + b, 0);
  const cur = ins.toolsPerMin[ins.toolsPerMin.length - 1] ?? 0;
  const ag = ins.agents;
  const maxTool = Math.max(1, ...ins.topTools.map((t) => t.count));
  const goals = ins.goalMix.filter((g) => g.running + g.done + g.error > 0);
  const maxGoal = Math.max(1, ...goals.map((g) => g.running + g.done + g.error));
  const c = ins.context;
  const urgent = c.minutesToCompact != null && c.minutesToCompact < 15;
  const noBurn = ins.burn.tokensPerMin === 0 && ins.burn.toolsPerMin === 0 && ins.burn.costPerHour == null;

  return (
    <>
      <Fold id="activity" title="activity" aside={total > 0 ? `${total} calls / 30 min` : undefined} open={open('activity')} onToggle={toggle}>
        {total === 0 ? (
          <div className="empty-note">no tool calls in the last 30 minutes</div>
        ) : (
          <>
            <Strip data={ins.toolsPerMin} />
            <div className="ins-axis-l">
              <span>30 min ago</span>
              <span>now</span>
            </div>
            <div className="kv">
              <span className="k">this minute</span>
              <span className="v">{cur}/min</span>
              <span className="k">peak</span>
              <span className="v">{peak}/min</span>
              {ins.busyShare != null && (
                <>
                  <span className="k">busy</span>
                  <span className="v" title="Share of the session with at least one agent working">
                    {Math.round(ins.busyShare * 100)}%
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </Fold>

      <Fold id="burn" title="burn rate" open={open('burn')} onToggle={toggle}>
        {noBurn && c.pct == null ? (
          <div className="empty-note">no usage measured yet</div>
        ) : (
          <>
            <div className="kv">
              <span className="k">tokens</span>
              <span className="v">{formatTokens(Math.round(ins.burn.tokensPerMin))}/min</span>
              <span className="k">tool calls</span>
              <span className="v">{fmtRate(ins.burn.toolsPerMin)}/min</span>
              <span className="k">cost est.</span>
              <span className="v est">{ins.burn.costPerHour != null ? `~${formatUSD(ins.burn.costPerHour)}/h` : '—'}</span>
            </div>
            {c.pct != null && (
              <div
                className={`ins-forecast ${urgent ? 'warn' : ''}`}
                data-testid="ins-forecast"
                title="Estimated from how fast the main context has grown recently"
              >
                <Icon name={urgent ? 'warn' : 'running'} size="xs" />
                {c.minutesToCompact != null ? (
                  <span>
                    auto-compact in ~<b>{Math.max(1, Math.round(c.minutesToCompact))}</b> min
                  </span>
                ) : (
                  <span>context stable</span>
                )}
              </div>
            )}
          </>
        )}
      </Fold>

      <Fold id="agents" title="agents" aside={ag.total} open={open('agents')} onToggle={toggle}>
        {ag.total === 0 ? (
          <div className="empty-note">no agents yet</div>
        ) : (
          <>
            <div className="ins-seg" role="img" aria-label={STATES.map((k) => `${ag[k]} ${k}`).join(', ')}>
              {STATES.map((k) => (ag[k] > 0 ? <i key={k} className={`s-${k}`} style={{ flexGrow: ag[k] }} /> : null))}
            </div>
            <div className="ins-legend">
              {STATES.map((k) => (
                <span key={k} className={ag[k] === 0 ? 'zero' : ''}>
                  <i className={`s-${k}`} />
                  <b>{ag[k]}</b> {k}
                </span>
              ))}
            </div>
            {goals.length > 0 && (
              <div className="ins-goals">
                {goals.map((g) => {
                  const n = g.running + g.done + g.error;
                  const info = GOAL_INFO[g.goal as Goal];
                  return (
                    <div
                      key={g.goal}
                      className={`ins-goal g-${g.goal}`}
                      title={`${info?.title ?? g.goal}: ${g.running} running, ${g.done} done, ${g.error} failed`}
                    >
                      <span className="gl">
                        <Icon name={g.goal as IconName} size="xs" />
                        {info?.word ?? g.goal}
                      </span>
                      <span className="gb" style={{ width: `${(n / maxGoal) * 100}%` }}>
                        {g.done > 0 && <i className="done" style={{ flexGrow: g.done }} />}
                        {g.running > 0 && <i className="run" style={{ flexGrow: g.running }} />}
                        {g.error > 0 && <i className="err" style={{ flexGrow: g.error }} />}
                      </span>
                      <span className="gn">{n}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Fold>

      <Fold id="tools" title="top tools" open={open('tools')} onToggle={toggle}>
        {ins.topTools.length === 0 ? (
          <div className="empty-note">no tool calls yet</div>
        ) : (
          <div className="ins-tools">
            {ins.topTools.map((t) => (
              <div key={t.name} className="ins-tool" title={`${t.name}: ${t.count} calls`}>
                <span className="tn">{t.name}</span>
                <span className="tb">
                  <i style={{ width: `${(t.count / maxTool) * 100}%` }} />
                </span>
                <span className="tc">{t.count}</span>
              </div>
            ))}
          </div>
        )}
      </Fold>

      <Fold id="files" title="recent files" open={open('files')} onToggle={toggle}>
        {ins.recentFiles.length === 0 ? (
          <div className="empty-note">no files touched yet</div>
        ) : (
          <div className="ins-list">
            {ins.recentFiles
              .filter((f, i, all) => all.findIndex((x) => x.path === f.path) === i)
              .map((f) => {
                const { base, dir } = splitPath(f.path);
                return (
                  <button
                    key={`${f.agentId}|${f.path}`}
                    className="ins-row"
                    onClick={() => void copyPath(f.path)}
                    title={`${f.path}\n${agentName(f.agentId)}\nclick to copy the path`}
                    data-testid="ins-file"
                  >
                    {dot(f.agentId)}
                    <span className="fn">{base}</span>
                    <span className={`fd ${copied === f.path ? 'copied' : ''}`}>{copied === f.path ? 'copied' : dir}</span>
                  </button>
                );
              })}
          </div>
        )}
      </Fold>

      <Fold id="errors" title="recent errors" aside={ins.recentErrors.length || undefined} open={open('errors')} onToggle={toggle}>
        {ins.recentErrors.length === 0 ? (
          <div className="empty-note">no failures</div>
        ) : (
          <div className="ins-list">
            {ins.recentErrors.map((e, i) => (
              <button
                key={`${e.ts}|${i}`}
                className="ins-row err"
                onClick={() => onSelectAgent?.(e.agentId)}
                title={`${e.text}\n${agentName(e.agentId)}\nclick to open this agent`}
                data-testid="ins-error"
              >
                <span className="et">{clock(e.ts)}</span>
                <span className="en">
                  {dot(e.agentId)}
                  {agentName(e.agentId)}
                </span>
                <span className="ex">{e.text}</span>
              </button>
            ))}
          </div>
        )}
      </Fold>
    </>
  );
}
