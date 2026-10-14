import { useEffect, useMemo, useState } from 'react';
import '../history.css';
import { allTokens, formatUsd, ioTokens, RANGES, type HistoryStatus, type HistorySummary, type RangeKey, type SearchResult } from '@core/history';
import { GOAL_INFO } from '@core/goal';
import { classifyModel } from '@core/models';
import { formatTokens } from '@core/summarize';
import { BarList, familyColor, FamilyLegend, Heatmap, TokenBars } from './HistoryCharts';

const RANGE_LABEL: Record<RangeKey, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'all time' };
const nf = (n: number) => n.toLocaleString('en-US');

function useHistoryStatus(): HistoryStatus | null {
  const [s, setS] = useState<HistoryStatus | null>(null);
  useEffect(() => {
    let live = true;
    void window.api.historyStatus().then((v) => live && setS(v));
    const off = window.api.onHistory((v) => setS(v));
    return () => {
      live = false;
      off();
    };
  }, []);
  return s;
}

function bytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
}

function StatusLine({ s, onRebuild }: { s: HistoryStatus | null; onRebuild: () => void }) {
  if (!s) return <div className="hist-status">starting…</div>;
  const busy = s.state === 'indexing' || s.state === 'starting';
  const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  return (
    <div className="hist-status" data-testid="history-status" data-state={s.state}>
      {s.state === 'error' ? (
        <span className="hist-err" title={s.error ?? ''}>
          index problem: {(s.error ?? '').split('\n')[0]}
        </span>
      ) : busy ? (
        <span data-testid="history-progress">
          {s.phase === 'scan' || s.total === 0 ? 'looking for sessions…' : s.phase === 'rollup' ? 'finishing…' : `indexing ${s.done}/${s.total} sessions`}
          {s.total > 0 && (
            <span className="hist-progress">
              <i style={{ width: `${pct}%` }} />
            </span>
          )}
        </span>
      ) : (
        <span>
          <span className="hist-ok">●</span> {nf(s.sessions)} sessions · {nf(s.docs)} searchable passages · {bytes(s.dbBytes)} local index
          {s.lastRunAt && ` · updated ${new Date(s.lastRunAt).toLocaleTimeString([], { hour12: false })}`}
        </span>
      )}
      <button
        onClick={onRebuild}
        disabled={busy}
        title="Delete the local index and read every transcript again. Your Claude data is never modified."
        data-testid="history-rebuild"
      >
        rebuild index
      </button>
    </div>
  );
}

function Kpi({ id, label, value, sub, title }: { id: string; label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="hist-kpi" data-testid="history-kpi" data-kpi={id} title={title}>
      <div className="hist-kpi-label">{label}</div>
      <div className="hist-kpi-value">{value}</div>
      {sub && <div className="hist-kpi-sub">{sub}</div>}
    </div>
  );
}

function Snippet({ parts }: { parts: { text: string; hit: boolean }[] }) {
  return <>{parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

function SearchResults({ q, res, busy, onOpen }: { q: string; res: SearchResult | null; busy: boolean; onOpen: (id: string) => void }) {
  if (!q.trim()) return null;
  return (
    <section className="hist-panel hist-results" data-testid="history-results">
      <h4>
        search results{' '}
        {res && !res.empty && (
          <span className="hist-dim">
            · {res.hits.length}
            {res.hits.length >= 40 ? '+' : ''} {busy ? '· searching…' : ''}
          </span>
        )}
      </h4>
      {res?.empty && <div className="hist-empty-line">Type a word or a "quoted phrase".</div>}
      {res && !res.empty && res.hits.length === 0 && !busy && <div className="hist-empty-line">No matches for "{q}".</div>}
      {res?.hits.map((h, i) => (
        <button
          key={`${h.sessionId}:${i}`}
          className="hist-hit"
          data-testid="history-hit"
          data-session={h.sessionId}
          onClick={() => onOpen(h.sessionId)}
          title="Open this session"
        >
          <span className="hist-hit-head">
            <b>{h.title}</b>
            <span className="hist-dim">{h.project}</span>
            <span className="hist-dim">{new Date(h.ts).toLocaleString([], { hour12: false, dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className={`hist-kind kind-${h.kind}`}>{h.kind === 'assistant' ? 'reply' : h.kind}</span>
            <span className="hist-dim">{h.agent}</span>
          </span>
          <span className="hist-hit-snip">
            <Snippet parts={h.snippet} />
          </span>
        </button>
      ))}
    </section>
  );
}

export function HistoryPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const status = useHistoryStatus();
  const [range, setRange] = useState<RangeKey>('30d');
  const [by, setBy] = useState<'day' | 'week'>('day');
  const [withCache, setWithCache] = useState(false);
  const [sum, setSum] = useState<HistorySummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const indexing = status?.state === 'indexing';

  // summary: on range change, when a pass finishes, and every couple of seconds while the first index is still filling it in
  useEffect(() => {
    let live = true;
    const load = () =>
      window.api
        .historySummary({ range, groupBy: by })
        .then((v) => {
          if (live) {
            setSum(v);
            setErr(null);
          }
        })
        .catch((e) => live && setErr(String(e?.message ?? e)));
    void load();
    const t = indexing ? setInterval(() => void load(), 2000) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [range, by, indexing, status?.lastRunAt]);

  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      window.api
        .historySearch({ q, limit: 40 })
        .then((r) => live && setRes(r))
        .catch(() => live && setRes({ q, hits: [], empty: false }))
        .finally(() => live && setSearching(false));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, status?.lastRunAt]);

  const present = useMemo(() => {
    const s = new Set<string>();
    for (const g of sum?.groups ?? [])
      for (const f of Object.keys(withCache ? g.byFamilyAll : g.byFamily)) if ((withCache ? g.byFamilyAll : g.byFamily)[f] > 0) s.add(f);
    return s;
  }, [sum, withCache]);

  const k = sum?.kpis;
  const empty = !!sum && !!k && k.sessions === 0 && k.tokens.messages === 0;

  return (
    <div className="hist" data-testid="history-page">
      <header className="hist-head">
        <h2>History</h2>
        <div className="hist-seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)} data-testid={`range-${r}`}>
              {r}
            </button>
          ))}
        </div>
        <input
          className="hist-search"
          type="search"
          placeholder="search every session: prompts, replies, tool calls…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="history-search"
          spellCheck={false}
        />
      </header>
      <StatusLine s={status} onRebuild={() => void window.api.historyRebuild()} />

      <SearchResults q={q} res={res} busy={searching} onOpen={onOpenSession} />

      {err && <div className="hist-err">Could not read the history index: {err}</div>}
      {!sum && !err && <div className="hist-empty">Reading the index…</div>}
      {empty && (
        <div className="hist-empty" data-testid="history-empty">
          {indexing
            ? 'Indexing your sessions for the first time. Numbers appear here as they are read.'
            : `No sessions in the last ${RANGE_LABEL[range]}. Try a longer range.`}
        </div>
      )}

      {sum && k && !empty && (
        <>
          <div className="hist-kpis">
            <Kpi
              id="tokens"
              label="tokens"
              value={formatTokens(ioTokens(k.tokens))}
              sub={`in ${formatTokens(k.tokens.tokensIn)} · out ${formatTokens(k.tokens.tokensOut)} · cache ${formatTokens(k.tokens.cacheRead + k.tokens.cacheWrite)}`}
              title={`${nf(ioTokens(k.tokens))} input+output tokens, ${nf(k.tokens.cacheRead)} cache-read and ${nf(k.tokens.cacheWrite)} cache-write tokens, ${nf(k.tokens.messages)} messages`}
            />
            <Kpi
              id="cost"
              label="cost · reported"
              value={k.costSessions > 0 ? formatUsd(k.costUsd) : 'n/a'}
              sub={k.costSessions > 0 ? `from ${k.costSessions} of ${k.sessions} sessions` : 'no session reported a cost'}
              title="Only sessions whose transcript contains a cost record count. Nothing is estimated."
            />
            <Kpi id="sessions" label="sessions" value={nf(k.sessions)} sub={`${nf(k.tokens.messages)} messages`} />
            <Kpi id="agents" label="agents spawned" value={nf(k.agents)} sub="subagents and workflow agents" />
            <Kpi id="days" label="active days" value={nf(k.activeDays)} sub={sum.fromDay ? `of ${RANGE_LABEL[range]}` : 'with any activity'} />
          </div>

          <section className="hist-panel">
            <div className="hist-panel-head">
              <h4>tokens per {by} by model</h4>
              <div className="hist-seg small">
                <button className={by === 'day' ? 'on' : ''} onClick={() => setBy('day')}>
                  day
                </button>
                <button className={by === 'week' ? 'on' : ''} onClick={() => setBy('week')}>
                  week
                </button>
              </div>
              <div className="hist-seg small" title="Cache reads are re-sent context and dwarf everything else, so they are off by default">
                <button className={!withCache ? 'on' : ''} onClick={() => setWithCache(false)}>
                  in + out
                </button>
                <button className={withCache ? 'on' : ''} onClick={() => setWithCache(true)} data-testid="with-cache">
                  + cache
                </button>
              </div>
            </div>
            <TokenBars groups={sum.groups} by={by} all={withCache} />
            <FamilyLegend present={present} />
          </section>

          <div className="hist-grid2">
            <section className="hist-panel">
              <h4>by project · tokens in + out</h4>
              <BarList
                testId="history-projects"
                color="var(--other)"
                rows={sum.byProject
                  .slice(0, 8)
                  .map((g) => ({ key: g.key, label: g.label, value: ioTokens(g), title: `${nf(allTokens(g))} tokens incl. cache, ${g.messages} messages` }))}
              />
            </section>
            <section className="hist-panel">
              <h4>by model · tokens in + out</h4>
              <BarList
                testId="history-models"
                rows={sum.byModel.slice(0, 8).map((g) => {
                  const c = classifyModel(g.key);
                  const fam = Object.keys(g.byFamily)[0] ?? 'other';
                  return {
                    key: g.key,
                    label: (
                      <>
                        <span className="hist-trunc">{g.label}</span>
                        {c.provider === 'local' && <span className="local-tag">⌂ local</span>}
                      </>
                    ),
                    value: ioTokens(g),
                    color: familyColor(fam),
                    title: g.key,
                  };
                })}
              />
            </section>
            <section className="hist-panel">
              <h4>top tools · calls</h4>
              <BarList
                testId="history-tools"
                color="var(--other)"
                fmt={nf}
                rows={sum.tools.map((t) => ({ key: t.tool, label: t.tool, value: t.count, title: t.tool }))}
              />
            </section>
            <section className="hist-panel">
              <h4>what the agents were doing · agents by goal</h4>
              <BarList
                testId="history-goals"
                color="var(--other)"
                fmt={nf}
                rows={sum.goals.map((g) => ({
                  key: g.goal,
                  label: `${GOAL_INFO[g.goal].glyph} ${GOAL_INFO[g.goal].word}`,
                  value: g.count,
                  title: GOAL_INFO[g.goal].title,
                }))}
              />
            </section>
          </div>

          <section className="hist-panel">
            <h4>busiest hours · messages by weekday and hour</h4>
            <Heatmap grid={sum.heat} />
          </section>
          <div className="hist-foot">
            Built from your transcripts into a local index ({status?.engine ?? 'sqlite'} {status?.sqliteVersion}). Nothing leaves this computer and Claude's own
            files are never changed.
          </div>
        </>
      )}
    </div>
  );
}
