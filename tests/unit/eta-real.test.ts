// Backtest of the time estimates (src/core/eta.ts) on this machine's real sessions, read-only.
// Folds recent sessions event by event and, every simulated minute, asks for the estimate of the prompt and of each running
// agent; then compares with when they really finished. Prints error tables, no transcript text.
// Priors come from a temp copy of the app's history index (%APPDATA%\Claude Visualized\history.db), so they include the
// sessions being tested: the agent numbers are a little flattering.
// Run: ETA_REAL=1 npx vitest run tests/unit/eta-real.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEtas, NO_PRIORS, promptEta, type EtaPriors } from '@core/eta';
import type { AgentEvent } from '@core/events';
import { apply } from '@core/reducer';
import { newSession, type SessionState } from '@core/state';
import { HistoryDb } from '../../src/main/historyDb';
import { SessionWatcher } from '../../src/main/watcher';

const root = path.join(process.env.CLAUDE_VIS_HOME ?? path.join(os.homedir(), '.claude'), 'projects');
const appDb = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'Library/Application Support'), 'Claude Visualized', 'history.db');
const SESSIONS = Number(process.env.ETA_SESSIONS ?? 40);
const MIN = 60_000;

function loadPriors(): EtaPriors {
  if (!fs.existsSync(appDb)) return NO_PRIORS;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-eta-real-'));
  const copy = path.join(tmp, 'history.db');
  fs.copyFileSync(appDb, copy);
  for (const s of ['-wal', '-shm']) if (fs.existsSync(appDb + s)) fs.copyFileSync(appDb + s, copy + s);
  const db = new HistoryDb(copy);
  try {
    return db.etaPriors(Date.now());
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function recentSessions(): { id: string; file: string }[] {
  const all: { id: string; file: string; mtime: number; size: number }[] = [];
  for (const p of fs.readdirSync(root)) {
    const dir = path.join(root, p);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const st = fs.statSync(path.join(dir, f));
      all.push({ id: f.slice(0, -6), file: path.join(dir, f), mtime: st.mtimeMs, size: st.size });
    }
  }
  return all
    .filter((s) => s.size > 150_000)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SESSIONS);
}

async function backlog(id: string, file: string): Promise<AgentEvent[]> {
  const w = new SessionWatcher(id, file);
  let events: AgentEvent[] = [];
  w.backlogSink = (e) => (events = e);
  await w.poll();
  return events;
}

interface Sample {
  /** share of the real duration that had passed */
  progress: number;
  /** estimated remaining / real remaining */
  ratio: number;
  /** |estimated - real| finish, minutes */
  absMin: number;
  confidence: string;
  inRange: boolean;
  /** what drove the estimate, for the breakdown */
  tags: string[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

function table(name: string, samples: Sample[]) {
  const rows: string[] = [];
  const buckets: [string, (s: Sample) => boolean][] = [
    ['0-25%', (s) => s.progress < 0.25],
    ['25-50%', (s) => s.progress >= 0.25 && s.progress < 0.5],
    ['50-75%', (s) => s.progress >= 0.5 && s.progress < 0.75],
    ['75-100%', (s) => s.progress >= 0.75],
    ['high', (s) => s.confidence === 'high'],
    ['medium', (s) => s.confidence === 'medium'],
    ['low', (s) => s.confidence === 'low'],
    ...[...new Set(samples.flatMap((s) => s.tags))].sort().map((t): [string, (s: Sample) => boolean] => [t, (s) => s.tags.includes(t)]),
    ...[...new Set(samples.flatMap((s) => s.tags))]
      .sort()
      .map((t): [string, (s: Sample) => boolean] => [`${t}@75+`, (s) => s.tags.includes(t) && s.progress >= 0.75]),
    ['all', () => true],
  ];
  for (const [label, f] of buckets) {
    const b = samples.filter(f);
    if (!b.length) continue;
    const logErr = b.map((s) => Math.abs(Math.log(Math.max(s.ratio, 0.01))));
    rows.push(
      `${name.padEnd(7)} ${label.padEnd(18)} n=${String(b.length).padStart(5)}  median ratio=${median(b.map((s) => s.ratio)).toFixed(2)}  median |log ratio|=${median(logErr).toFixed(2)}  median |err|=${median(b.map((s) => s.absMin)).toFixed(1)} min  in range=${((100 * b.filter((s) => s.inRange).length) / b.length).toFixed(0)}%`,
    );
  }
  return rows.join('\n');
}

describe.skipIf(!process.env.ETA_REAL)('time estimates on real sessions', () => {
  it('backtests prompt and agent estimates', async () => {
    const priors = loadPriors();
    console.log(`priors: ${Object.keys(priors.agents).length} agent groups, ${priors.turns.length} past prompts`);
    const promptSamples: Sample[] = [];
    const agentSamples: Sample[] = [];
    let turns = 0;
    let withSteps = 0;
    let shipped = 0;
    const shipOutcome = new Map<string, number>();
    for (const { id, file } of recentSessions()) {
      const events = await backlog(id, file);
      if (!events.length) continue;
      // pass 1: the real end of every turn and of every agent
      const s: SessionState = newSession(id);
      const turnEnd = new Map<number, number>();
      for (const e of events) {
        apply(s, e);
        const t0 = s.turnStartedAt;
        if (t0 && e.ts >= t0) {
          const busy = s.agents.main.status === 'running' || Object.values(s.agents).some((a) => a.kind === 'agent' && a.status === 'running');
          if (busy || !turnEnd.has(t0)) turnEnd.set(t0, Math.max(turnEnd.get(t0) ?? 0, e.ts));
        }
      }
      const agentEnd = new Map(Object.values(s.agents).map((a) => [a.id, a.endedAt]));
      // every shipping command of the main agent (the state keeps only the newest SHIP_CAP)
      const allShip = events.flatMap((e) => (e.k === 'tool.start' && e.ref.agentId === null && e.ship ? e.ship.map((kind) => ({ kind, at: e.ts })) : []));
      // pass 2: ask every simulated minute
      const r: SessionState = newSession(id);
      let next = 0;
      const seenTurns = new Set<number>();
      const expected = new Map<number, string>();
      for (const e of events) {
        apply(r, e);
        if (!e.ts || e.ts < next) continue;
        next = e.ts + MIN;
        const now = e.ts;
        const t0 = r.turnStartedAt;
        const end = t0 ? turnEnd.get(t0) : undefined;
        if (t0 && end && end - t0 >= 5 * MIN && now < end) {
          const view = { ...r, agents: r.agents };
          const p = promptEta(view, now, priors);
          if (p && p.finishLine !== 'turn' && !expected.has(t0))
            expected.set(
              t0,
              `${p.finishLine}/${p.stages.find((x) => x.key === p.finishLine)?.plan}/${r.ship.some((x) => x.at >= t0 - 1000 && x.at <= now) ? 'started' : r.todos.some((x) => (x.startedAt ?? 0) >= t0 - 5000 || (x.doneAt ?? 0) >= t0 - 5000) ? 'todos-now' : 'todos-old'}`,
            );
          if (!seenTurns.has(t0)) {
            seenTurns.add(t0);
            turns++;
            if (p?.steps) withSteps++;
          }
          if (p?.state === 'running' && p.finishAt !== null) {
            const real = end - now;
            promptSamples.push({
              progress: (now - t0) / (end - t0),
              ratio: (p.finishAt - now) / Math.max(real, 1000),
              absMin: Math.abs(p.finishAt - end) / MIN,
              confidence: p.confidence,
              inRange: p.low! <= end && end <= p.high!,
              tags: [
                p.steps ? 'steps' : 'no-steps',
                p.agents.some((m) => m.state === 'running') ? 'agents' : 'no-agents',
                p.stages.some((st) => st.key !== 'work' && st.plan === 'turn' && (st.state === 'pending' || st.state === 'active')) ? 'ship-left' : 'no-ship',
              ],
            });
          }
        }
        const etas = agentEtas(r.agents, now, priors);
        for (const a of Object.values(r.agents)) {
          if (a.kind !== 'agent' || a.status !== 'running') continue;
          const realEnd = agentEnd.get(a.id);
          if (!realEnd || realEnd <= now || realEnd - a.startedAt < MIN) continue;
          const est = etas.get(a.id);
          if (!est) continue;
          agentSamples.push({
            progress: (now - a.startedAt) / (realEnd - a.startedAt),
            ratio: est.remaining / Math.max(realEnd - now, 1000),
            absMin: Math.abs(est.at - realEnd) / MIN,
            confidence: est.confidence,
            inRange: est.low <= realEnd && realEnd <= est.high,
            tags: [est.overdue ? 'overdue' : 'normal'],
          });
        }
      }
      if (r.ship.length) shipped++;
      // did the turns that were expected to ship actually do it before they ended?
      for (const [t0, line] of expected) {
        const end = turnEnd.get(t0) ?? t0;
        const kinds = new Set(allShip.filter((e) => e.at >= t0 - 1000 && e.at <= end + 1000).map((e) => e.kind));
        const kind = line.split('/')[0];
        const did = kind === 'release' ? kinds.has('publish') : kind === 'push' ? kinds.has('push') || kinds.has('pr') : kinds.has('commit');
        const key = `${line}:${did ? 'shipped in the turn' : 'not in the turn'}`;
        shipOutcome.set(key, (shipOutcome.get(key) ?? 0) + 1);
      }
    }
    console.log(`${turns} prompts of 5+ min (${withSteps} with a task list), ${shipped} sessions with shipping commands`);
    console.log('expected to ship: ' + [...shipOutcome].map(([k, v]) => `${k}=${v}`).join(', '));
    console.log(table('prompt', promptSamples));
    console.log(table('agent', agentSamples));
    expect(turns).toBeGreaterThanOrEqual(0);
  }, 600_000);
});
