import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogKind, SessionView } from '@core/state';
import { agentName, clock, famClass } from '../util';
import { Icon, type IconName } from './Icon';
import '../log.css';

const GROUPS: { key: string; label: string; kinds: LogKind[] }[] = [
  { key: 'prompts', label: 'prompts', kinds: ['prompt'] },
  { key: 'tools', label: 'tools', kinds: ['tool', 'tool-error'] },
  { key: 'agents', label: 'agents', kinds: ['agent', 'done'] },
  { key: 'text', label: 'replies', kinds: ['text'] },
  { key: 'other', label: 'events', kinds: ['mode', 'model', 'notice', 'attention'] },
];

const KIND_ICON: Record<LogKind, IconName> = {
  prompt: 'chevronRight',
  tool: 'tool',
  'tool-error': 'error',
  agent: 'agent',
  done: 'done',
  mode: 'plan',
  model: 'model',
  text: 'text',
  notice: 'notice',
  attention: 'warn',
};

/** fixed row height (see .log-row in theme.css): lets the list render only the rows in view */
const ROW_H = 20;
const OVERSCAN = 10;
const BODY_PAD = 4;

export function LogPanel({ view, agentFilter, onAgentFilter }: { view: SessionView; agentFilter: string | null; onAgentFilter: (id: string | null) => void }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ prompts: true, tools: true, agents: true, text: false, other: true });
  const [q, setQ] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  // only the newest lines animate: remember the highest seq already drawn and flag anything above it for ~900ms
  const seenSeq = useRef<number | null>(null);
  const freshAt = useRef<Map<number, number>>(new Map());

  const kinds = useMemo(() => new Set(GROUPS.filter((g) => enabled[g.key]).flatMap((g) => g.kinds)), [enabled]);
  const query = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      view.log
        .filter((l) => kinds.has(l.kind) && (!agentFilter || l.agentId === agentFilter) && (!query || l.text.toLowerCase().includes(query)))
        .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
        .slice(-600),
    [view.log, kinds, agentFilter, query],
  );

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  });

  useLayoutEffect(() => {
    const max = rows.length ? rows[rows.length - 1].seq : 0;
    const prev = seenSeq.current;
    const now = performance.now();
    for (const [k, t] of freshAt.current) if (now - t > 900) freshAt.current.delete(k);
    if (prev !== null && max > prev) {
      // a burst (replay jump, big backlog) is not a stream: animate the last few lines only
      const added = rows.filter((r) => r.seq > prev).slice(-8);
      for (const r of added) freshAt.current.set(r.seq, now);
    }
    seenSeq.current = max;
  }, [rows]);
  const isFresh = (seq: number) => {
    const prev = seenSeq.current;
    if (freshAt.current.has(seq)) return true;
    return prev !== null && seq > prev && rows.length - rows.findIndex((r) => r.seq === seq) <= 8;
  };

  // window of rows to draw: stuck to the bottom the window is computed from the end, so a push never flashes empty space
  const contentH = rows.length * ROW_H + BODY_PAD * 2;
  const top = stick ? Math.max(0, contentH - viewH) : scrollTop;
  const first = Math.max(0, Math.floor((top - BODY_PAD) / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + viewH - BODY_PAD) / ROW_H) + OVERSCAN);

  // the option list only changes when agents come or go, not on every push
  const agentsKey = Object.values(view.agents)
    .map((a) => `${a.id}|${a.kind}|${a.agentType}`)
    .join(',');
  const agentOptions = useMemo(
    () =>
      Object.values(view.agents).map((a) => (
        <option key={a.id} value={a.id}>
          {agentName(a)} {a.kind === 'agent' ? `· ${a.id.slice(0, 7)}` : ''}
        </option>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentsKey],
  );
  return (
    <div className="log" data-tour="log">
      <div className="log-head">
        <span className="lbl">session log</span>
        <span className={`log-live ${stick ? 'on' : ''}`} title={stick ? 'Following the newest line' : 'Scrolled back; new lines keep arriving'}>
          <i />
          {stick ? 'live' : 'paused'}
          <b>{rows.length}</b>
        </span>
        <div className="seg log-kinds" role="group" aria-label="Kinds of log lines">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              className={`chip g-${g.key} ${enabled[g.key] ? 'on' : ''}`}
              aria-pressed={enabled[g.key]}
              onClick={() => setEnabled({ ...enabled, [g.key]: !enabled[g.key] })}
            >
              {g.label}
            </button>
          ))}
        </div>
        <select value={agentFilter ?? ''} onChange={(e) => onAgentFilter(e.target.value || null)} className={agentFilter ? 'filtered' : ''}>
          <option value="">all agents</option>
          {agentOptions}
        </select>
        <div className="field log-filter">
          <Icon name="search" size="xs" />
          <input placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          {q && (
            <button className="field-clear" aria-label="Clear filter" onClick={() => setQ('')}>
              <Icon name="close" size="xs" />
            </button>
          )}
        </div>
      </div>
      {!stick && rows.length > 0 && (
        <button
          className="log-jump"
          onClick={() => {
            setStick(true);
            const el = bodyRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <Icon name="chevronDown" size="xs" />
          latest
        </button>
      )}
      <div
        className="log-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        <div style={{ paddingTop: first * ROW_H, paddingBottom: (rows.length - last) * ROW_H }}>
          {rows.slice(first, last).map((l, k) => {
            const a = view.agents[l.agentId];
            const long = l.text.length > 70;
            const flip = (first + k) * ROW_H + BODY_PAD - top < 96;
            return (
              <div
                key={l.seq}
                className={`log-row k-${l.kind} ${famClass(a?.model)} ${isFresh(l.seq) ? 'fresh' : ''} ${long ? 'long' : ''} ${flip ? 'flip' : ''}`}
                data-full={long ? l.text.slice(0, 600) : undefined}
                onClick={() => onAgentFilter(agentFilter === l.agentId ? null : l.agentId)}
                title={long ? undefined : agentFilter === l.agentId ? 'Click to show every agent again' : `Click to show only ${agentName(a)}`}
              >
                <span className="ts">{clock(l.ts)}</span>
                <span className="who" title={l.agentId}>
                  {agentName(a)}
                </span>
                <span className="msg" title={long ? undefined : l.text}>
                  <span className="kind">
                    <Icon name={KIND_ICON[l.kind] ?? 'notice'} size="xs" />
                  </span>
                  {l.text}
                </span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <div className="empty-note log-empty">{view.log.length ? 'no lines match the filters' : 'nothing yet'}</div>}
      </div>
    </div>
  );
}
