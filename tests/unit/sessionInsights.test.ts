import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionInsights } from '@core/sessionInsights';
import { MAIN, newAgent, newSession, toView, type AgentNode, type LogEntry, type SessionView } from '@core/state';
import { SessionWatcher } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MIN = 60_000;

function agent(id: string, kind: AgentNode['kind'], over: Partial<AgentNode> = {}): AgentNode {
  return { ...newAgent(id, kind, NOW - 10 * MIN, kind === 'main' ? null : MAIN), ...over };
}

function viewWith(list: AgentNode[], extra: Partial<SessionView> = {}, log: LogEntry[] = []): SessionView {
  const v = toView(newSession('s1'));
  v.agents = Object.fromEntries(list.map((a) => [a.id, a]));
  v.log = log;
  return { ...v, ...extra };
}

const EMPTY_CONTEXT = { pct: null, growthPerMin: null, minutesToCompact: null };

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-insights-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('sessionInsights: empty and partial views', () => {
  it('returns zeros, empty arrays and nulls for an empty session', () => {
    const r = sessionInsights(toView(newSession('empty')), NOW);
    expect(r.toolsPerMin).toEqual(new Array(30).fill(0));
    expect(r.topTools).toEqual([]);
    expect(r.recentFiles).toEqual([]);
    expect(r.recentErrors).toEqual([]);
    expect(r.burn).toEqual({ tokensPerMin: 0, toolsPerMin: 0, costPerHour: null });
    expect(r.context).toEqual(EMPTY_CONTEXT);
    expect(r.goalMix).toEqual([]);
    expect(r.agents).toEqual({ running: 0, waiting: 0, done: 0, error: 0, total: 0 });
    expect(r.uptimeMs).toBe(0);
    expect(r.busyShare).toBeNull();
  });

  it('does not throw on missing fields', () => {
    const v = { ...toView(newSession('x')), agents: undefined, log: undefined } as unknown as SessionView;
    expect(() => sessionInsights(v, NOW)).not.toThrow();
    expect(sessionInsights(v, NOW).agents.total).toBe(0);
  });
});

describe('sessionInsights: fixture transcript', () => {
  it('summarises a folded session', async () => {
    const { mainFile } = writeFixture(home);
    const w = new SessionWatcher(SID, mainFile);
    await w.poll();
    const view = w.state;
    const last = Math.max(...Object.values(view.agents).map((a) => a.lastActivity));
    const now = last + MIN;
    const r = sessionInsights(view, now);

    expect(r.toolsPerMin).toHaveLength(30);
    // every tool start in the fixture is recent enough to fall in the 30-minute series
    const total = Object.values(view.agents).reduce((n, a) => n + a.activity.length, 0);
    expect(r.toolsPerMin.reduce((n, c) => n + c, 0)).toBe(total);

    // Bash runs twice in the fixture (main and a2)
    const bash = r.topTools.find((t) => t.name === 'Bash');
    expect(bash?.count).toBe(view.log.filter((l) => l.kind === 'tool' && l.text.startsWith('Bash')).length);
    expect(r.topTools.length).toBeLessThanOrEqual(6);

    expect(r.agents.total).toBe(Object.values(view.agents).filter((a) => a.kind === 'agent').length);
    expect(r.agents.running + r.agents.done + r.agents.error + r.agents.waiting).toBeLessThanOrEqual(r.agents.total);
    expect(r.uptimeMs).toBe(now - view.startedAt!);
    expect(r.busyShare).toBeGreaterThan(0);
    expect(r.busyShare).toBeLessThanOrEqual(1);

    // main used 1000 input tokens per message on claude-opus-5-5: context is known
    expect(r.context.pct).not.toBeNull();
    expect(r.burn.costPerHour).not.toBeNull();
    expect(r.recentFiles.length).toBeGreaterThan(0);
  });
});

describe('sessionInsights: minute bucketing', () => {
  it('puts tool starts into the minute they fall in, oldest first', () => {
    const acts = [
      NOW, // age 0, current minute -> index 29
      NOW - 59_999, // age 0
      NOW - MIN, // age 1 exactly -> index 28
      NOW - 29 * MIN - 1, // age 29 -> index 0
      NOW - 30 * MIN, // age 30, outside the series
      NOW + 5_000, // clock skew: counts as age 0
    ];
    const v = viewWith([agent('a1', 'agent', { activity: acts })]);
    const r = sessionInsights(v, NOW);
    expect(r.toolsPerMin[29]).toBe(3);
    expect(r.toolsPerMin[28]).toBe(1);
    expect(r.toolsPerMin[0]).toBe(1);
    expect(r.toolsPerMin.reduce((n, c) => n + c, 0)).toBe(5);
  });

  it('sums all agents into the same buckets and sizes the burn rate on the last 10 minutes', () => {
    const v = viewWith([
      agent('a1', 'agent', { activity: [NOW - 9 * MIN, NOW - 10 * MIN] }), // age 9 counted, age 10 not
      agent('a2', 'agent', { activity: [NOW - 9 * MIN + 1, NOW - 2 * MIN] }),
    ]);
    const r = sessionInsights(v, NOW);
    expect(r.toolsPerMin[20]).toBe(1); // age 9 (a1)
    expect(r.toolsPerMin[21]).toBe(1); // age 8 (a2, 1 ms short of 9 minutes)
    expect(r.toolsPerMin[27]).toBe(1); // age 2 (a2)
    expect(r.toolsPerMin[19]).toBe(1); // age 10 (a1): in the 30-minute series, outside the burn window
    expect(r.toolsPerMin.reduce((n, c) => n + c, 0)).toBe(4);
    expect(r.burn.toolsPerMin).toBeCloseTo(3 / 10, 10);
  });
});

describe('sessionInsights: recent files', () => {
  it('dedupes by path, orders newest first and takes ts from the matching call', () => {
    const a1 = agent('a1', 'agent', {
      files: ['/p/one.ts', '/p/two.ts', '/p/three.ts'],
      lastActivity: NOW - 2 * MIN,
      recent: [
        { id: 'r1', name: 'Read', summary: 'three.ts', ts: NOW - 30_000, ok: true },
        { id: 'r2', name: 'Read', summary: 'two.ts', ts: NOW - 90_000, ok: true },
      ],
    });
    const a2 = agent('a2', 'agent', {
      files: ['/p/one.ts'],
      lastActivity: NOW - 10_000,
      recent: [{ id: 'r3', name: 'Edit', summary: 'one.ts', ts: NOW - 10_000, ok: true }],
    });
    const r = sessionInsights(viewWith([a1, a2]), NOW);
    expect(r.recentFiles.map((f) => f.path)).toEqual(['/p/one.ts', '/p/three.ts', '/p/two.ts']);
    expect(r.recentFiles[0]).toEqual({ path: '/p/one.ts', agentId: 'a2', ts: NOW - 10_000 });
    expect(r.recentFiles[1].ts).toBe(NOW - 30_000);
  });

  it('gives null ts when no recent call matches, and caps at 8', () => {
    const files = Array.from({ length: 12 }, (_, i) => `/x/f${i}.ts`);
    const a = agent('a1', 'agent', { files, lastActivity: NOW - MIN });
    const r = sessionInsights(viewWith([a]), NOW);
    expect(r.recentFiles).toHaveLength(8);
    expect(new Set(r.recentFiles.map((f) => f.path)).size).toBe(8);
    expect(r.recentFiles[0].path).toBe('/x/f11.ts'); // most recent last in the list
    expect(r.recentFiles.every((f) => f.ts === null)).toBe(true);
  });
});

describe('sessionInsights: recent errors', () => {
  it('keeps the newest 5 failures, newest first', () => {
    const log: LogEntry[] = [];
    for (let i = 0; i < 8; i++) log.push({ seq: i + 1, ts: NOW + i * 1000, agentId: 'a1', kind: 'tool-error', text: `err ${i}` });
    log.push({ seq: 20, ts: NOW + 500, agentId: 'a2', kind: 'tool', text: 'Bash  ok' });
    log.push({ seq: 21, ts: NOW + 9000, agentId: MAIN, kind: 'attention', text: 'boom', attn: 'error' });
    log.push({ seq: 22, ts: NOW + 9500, agentId: MAIN, kind: 'attention', text: 'approve?', attn: 'permission' });
    const r = sessionInsights(viewWith([agent(MAIN, 'main')], {}, log), NOW);
    expect(r.recentErrors).toHaveLength(5);
    expect(r.recentErrors.map((e) => e.text)).toEqual(['boom', 'err 7', 'err 6', 'err 5', 'err 4']);
    expect(r.recentErrors[0]).toEqual({ ts: NOW + 9000, agentId: MAIN, text: 'boom' });
  });
});

describe('sessionInsights: goal grouping and counts', () => {
  it('groups subagents by goal with counts by state, leaving out main and workflows', () => {
    const list = [
      agent(MAIN, 'main', { status: 'running' }),
      agent('e1', 'agent', { agentType: 'Explore', status: 'running' }),
      agent('e2', 'agent', { agentType: 'Explore', status: 'done' }),
      agent('p1', 'agent', { agentType: 'Plan', status: 'error' }),
      agent('b1', 'agent', { agentType: 'general-purpose', description: 'implement the cache', status: 'running' }),
      agent('b2', 'agent', { agentType: 'general-purpose', description: 'implement the cache', status: 'waiting' }),
      agent('wf:1', 'workflow', { status: 'running' }),
    ];
    const r = sessionInsights(viewWith(list), NOW);
    expect(r.goalMix).toEqual([
      // ties on size sort by goal name
      { goal: 'build', running: 2, done: 0, error: 0 },
      { goal: 'search', running: 1, done: 1, error: 0 },
      { goal: 'plan', running: 0, done: 0, error: 1 },
    ]);
    expect(r.agents).toEqual({ running: 2, waiting: 1, done: 1, error: 1, total: 5 });
  });
});

describe('sessionInsights: burn and context', () => {
  it('estimates tokens and cost in the last 10 minutes from each agent window', () => {
    // 20 minutes of activity, half of it inside the burn window; 600k input tokens at opus-5.5 ($4/M in)
    const a = agent('a1', 'agent', {
      startedAt: NOW - 20 * MIN,
      status: 'running',
      model: 'claude-opus-5-5',
      tokens: { in: 600_000, out: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const r = sessionInsights(viewWith([a]), NOW);
    expect(r.burn.tokensPerMin).toBeCloseTo(300_000 / 10, 6);
    // total estimated cost 2.4, half of it in the window: 1.2 per 10 min = 7.2 per hour
    expect(r.burn.costPerHour).toBeCloseTo(7.2, 6);
  });

  it('scales a reported session cost by the recent share and nulls the rate without priced tokens', () => {
    const a = agent('a1', 'agent', {
      startedAt: NOW - 20 * MIN,
      status: 'running',
      model: 'claude-opus-5-5',
      tokens: { in: 600_000, out: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(sessionInsights(viewWith([a], { costUSD: 10 }), NOW).burn.costPerHour).toBeCloseTo(30, 6);
    const local = { ...a, model: 'qwen2.5-coder:32b' };
    const r = sessionInsights(viewWith([local]), NOW);
    expect(r.burn.costPerHour).toBeNull();
    expect(r.burn.tokensPerMin).toBeCloseTo(30_000, 6);
  });

  it('forecasts compaction from the context growth since the first activity', () => {
    const main = agent(MAIN, 'main', {
      startedAt: NOW - 10 * MIN,
      model: 'claude-opus-5-5',
      contextTokens: 100_000,
      contextPeak: 100_000,
      contextAt: NOW,
    });
    const r = sessionInsights(viewWith([main]), NOW);
    // 200k window (guessed), 50% full; 100k tokens in 10 minutes = 10k per minute; 0.97*200k - 100k = 94k left
    expect(r.context.pct).toBe(50);
    expect(r.context.growthPerMin).toBeCloseTo(10_000, 6);
    expect(r.context.minutesToCompact).toBeCloseTo(9.4, 6);
  });

  it('gives no growth rate after compaction, and no context for unknown windows', () => {
    const compacted = agent(MAIN, 'main', {
      startedAt: NOW - 10 * MIN,
      model: 'claude-opus-5-5',
      contextTokens: 40_000,
      contextPeak: 150_000,
      contextAt: NOW,
    });
    const r = sessionInsights(viewWith([compacted]), NOW);
    expect(r.context.pct).toBe(20);
    expect(r.context.growthPerMin).toBeNull();
    expect(r.context.minutesToCompact).toBeNull();

    const local = agent(MAIN, 'main', { startedAt: NOW - 10 * MIN, model: 'qwen2.5-coder:32b', contextTokens: 5000, contextAt: NOW });
    expect(sessionInsights(viewWith([local]), NOW).context).toEqual(EMPTY_CONTEXT);
  });
});

describe('sessionInsights: uptime and busy share', () => {
  it('measures the union of agent busy spans against uptime', () => {
    const list = [
      agent('a1', 'agent', { startedAt: NOW - 120_000, endedAt: NOW - 100_000, status: 'done' }), // [-120, -100]
      agent('a2', 'agent', { startedAt: NOW - 110_000, endedAt: NOW - 90_000, status: 'done' }), // [-110, -90], overlaps a1
      agent('a3', 'agent', { startedAt: NOW - 60_000, status: 'running' }), // [-60, now]
    ];
    const r = sessionInsights(viewWith(list, { startedAt: NOW - 120_000 }), NOW);
    expect(r.uptimeMs).toBe(120_000);
    // union: [-120, -90] (30 s) plus [-60, 0] (60 s) = 90 s of 120 s
    expect(r.busyShare).toBeCloseTo(90 / 120, 6);
  });
});

describe('sessionInsights: scale', () => {
  it('finishes a 300-agent, 2000-line view in under 50 ms', () => {
    const list: AgentNode[] = [agent(MAIN, 'main', { startedAt: NOW - 60 * MIN, model: 'claude-opus-5-5', contextTokens: 50_000, contextPeak: 50_000, contextAt: NOW })];
    const types = ['Explore', 'Plan', 'general-purpose', 'code-reviewer'];
    const descs = ['find the api', 'implement the cache', 'run the tests', 'review the diff'];
    for (let i = 0; i < 300; i++) {
      const startedAt = NOW - (60 - (i % 50)) * MIN;
      const activity = Array.from({ length: 120 }, (_, k) => NOW - (k * 20_000 + (i % 7) * 1000));
      const files = Array.from({ length: 30 }, (_, k) => `/src/f${(i + k) % 200}.ts`);
      const recent = Array.from({ length: 10 }, (_, k) => ({ id: `r${k}`, name: 'Read', summary: `f${(i + k) % 200}.ts`, ts: NOW - k * 1000, ok: true }));
      list.push(
        agent(`s${i}`, 'agent', {
          agentType: types[i % types.length],
          description: descs[i % descs.length],
          status: i % 5 === 0 ? 'running' : i % 11 === 0 ? 'error' : 'done',
          startedAt,
          endedAt: i % 5 === 0 ? null : NOW - (i % 13) * MIN,
          model: 'claude-haiku-5-5',
          tokens: { in: 50_000, out: 5_000, cacheRead: 0, cacheWrite: 0 },
          activity,
          files,
          recent,
        }),
      );
    }
    const log: LogEntry[] = Array.from({ length: 2000 }, (_, i) => ({
      seq: i + 1,
      ts: NOW - (2000 - i) * 1000,
      agentId: `s${i % 300}`,
      kind: i % 10 === 0 ? 'tool-error' : 'tool',
      text: `Read  f${i % 200}.ts`,
    }));
    const v = viewWith(list, { startedAt: NOW - 60 * MIN }, log);

    sessionInsights(v, NOW); // warm up
    const t0 = performance.now();
    const r = sessionInsights(v, NOW);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(r.agents.total).toBe(300);
    expect(r.recentErrors).toHaveLength(5);
    expect(r.recentFiles).toHaveLength(8);
  });
});
