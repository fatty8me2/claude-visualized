// Pure logic added in the 0.4 polish round: price estimates, graph zoom math, sidebar grouping and failed-tool output.
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@core/events';
import { clampZoom, fitScale, nextCardMode, revealDelta, zoomAnchor, ZOOM } from '@core/graphZoom';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, layoutAgents } from '@core/layout';
import { errorText, normalizeHook, normalizeLine } from '@core/normalize';
import { estimateAgents, estimateCostUSD, estimateRows, formatUSD, parseClaudeVersion, priceFor } from '@core/pricing';
import { foldEvents } from '@core/reducer';
import { EMPTY_PREFS, groupKey, groupRecent, matchSession, toggleId } from '@core/sessionGroups';
import { HOOK_EVENTS } from '@core/hooksConfig';
import { newAgent, type SessionSummary } from '@core/state';

const M = 1_000_000;

describe('pricing', () => {
  it('parses Claude ids in every spelling and ignores non-Claude models', () => {
    expect(parseClaudeVersion('claude-opus-5-5')).toEqual({ family: 'opus', version: '5.5' });
    expect(parseClaudeVersion('claude-opus-5-5-20260401')).toEqual({ family: 'opus', version: '5.5' });
    expect(parseClaudeVersion('anthropic.claude-sonnet-4-6-v1:0')).toEqual({ family: 'sonnet', version: '4.6' });
    expect(parseClaudeVersion('claude-haiku-4-5@20251001')).toEqual({ family: 'haiku', version: '4.5' });
    expect(parseClaudeVersion('claude-opus-5')).toEqual({ family: 'opus', version: '5' });
    expect(parseClaudeVersion('qwen2.5-coder:32b')).toBeNull();
    expect(parseClaudeVersion('gpt-4o')).toBeNull();
    expect(parseClaudeVersion(null)).toBeNull();
  });

  it('defaults cache prices from the input price', () => {
    expect(priceFor('claude-opus-5')).toEqual({ in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(priceFor('claude-opus-5-5')).toEqual({ in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(priceFor('claude-opus-3-9')).toBeNull(); // unknown version: never guessed
  });

  it('estimates a usage record', () => {
    const t = { in: M, out: M, cacheRead: M, cacheWrite: M };
    expect(estimateCostUSD(t, 'claude-sonnet-5-5')).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6);
    expect(estimateCostUSD(t, 'llama3.1:8b')).toBeNull();
  });

  it('sums agents and lists the models it could not price (local models are free, not missing)', () => {
    const a = newAgent('main', 'main', 0, null);
    a.model = 'claude-opus-5-5';
    a.tokens = { in: M, out: 0, cacheRead: 0, cacheWrite: 0 };
    const b = newAgent('b', 'agent', 0, 'main');
    b.model = 'qwen2.5-coder:32b';
    b.tokens = { in: M, out: M, cacheRead: 0, cacheWrite: 0 };
    const c = newAgent('c', 'agent', 0, 'main');
    c.model = 'claude-opus-3-9';
    c.tokens = { in: 10, out: 0, cacheRead: 0, cacheWrite: 0 };
    const e = estimateAgents({ main: a, b, c });
    expect(e.usd).toBeCloseTo(4, 6);
    expect(e.unpriced).toEqual(['claude-opus-3-9']);
  });

  it('estimates history rows and skips empty model names', () => {
    const e = estimateRows([
      { model: 'claude-haiku-4-5', in: M, out: M, cacheRead: 0, cacheWrite: 0 },
      { model: '', in: M, out: M, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(e.usd).toBeCloseTo(6, 6);
  });

  it('formats dollars', () => {
    expect(formatUSD(1.234)).toBe('$1.23');
    expect(formatUSD(123.4)).toBe('$123');
    expect(formatUSD(1533.2)).toBe('$1,533');
  });
});

describe('graph zoom', () => {
  it('fits the width, clamped to the floor and to 1', () => {
    expect(fitScale({ w: 1000, h: 100 }, { w: 2000, h: 100 }, 0, false, 0.5)).toBe(1);
    expect(fitScale({ w: 1000, h: 100 }, { w: 600, h: 100 }, 0, false, 0.5)).toBeCloseTo(0.6);
    expect(fitScale({ w: 1000, h: 100 }, { w: 300, h: 100 }, 0, false, 0.5)).toBe(0.5);
    // fitting the height too
    expect(fitScale({ w: 100, h: 1000 }, { w: 1000, h: 500 }, 0, true, 0.1)).toBeCloseTo(0.5);
  });

  it('switches card variants with hysteresis, and respects the preference', () => {
    expect(nextCardMode('full', 0.79, 'auto')).toBe('compact');
    expect(nextCardMode('full', 0.85, 'auto')).toBe('full');
    expect(nextCardMode('compact', 0.85, 'auto')).toBe('compact');
    expect(nextCardMode('compact', 0.95, 'auto')).toBe('full');
    expect(nextCardMode('full', 1, 'on')).toBe('compact');
    expect(nextCardMode('compact', 0.3, 'off')).toBe('full');
  });

  it('keeps the point under the cursor in place', () => {
    const pad = 36;
    const prev = { scale: 1, scrollLeft: 200, scrollTop: 100 };
    const cursor = { x: 300, y: 150 };
    const next = zoomAnchor(prev, 1.5, cursor, pad);
    const before = (prev.scrollLeft + cursor.x - pad) / prev.scale;
    const after = (next.scrollLeft + cursor.x - pad) / 1.5;
    expect(after).toBeCloseTo(before, 6);
    expect(clampZoom(9)).toBe(ZOOM.max);
    expect(clampZoom(0.01)).toBe(ZOOM.min);
  });

  it('scrolls a card out from under the drawer', () => {
    const view = { left: 0, top: 0, right: 1000, bottom: 600 };
    expect(revealDelta({ left: 100, top: 100, right: 300, bottom: 200 }, view, 400)).toBeNull();
    expect(revealDelta({ left: 700, top: 100, right: 900, bottom: 200 }, view, 400)).toEqual({ dx: 316, dy: 0 });
    expect(revealDelta({ left: 100, top: 550, right: 300, bottom: 650 }, view, 0)).toEqual({ dx: 0, dy: 66 });
  });

  it('lays compact cards out smaller, with a smaller chip', () => {
    const agents: Record<string, ReturnType<typeof newAgent>> = { main: newAgent('main', 'main', 0, null) };
    for (let i = 0; i < 9; i++) {
      const a = newAgent(`a${i}`, 'agent', i, 'main');
      a.status = 'done';
      agents[a.id] = a;
    }
    agents.main.status = 'running';
    const full = layoutAgents(agents, DEFAULT_LAYOUT);
    const compact = layoutAgents(agents, COMPACT_LAYOUT);
    expect(compact.width).toBeLessThan(full.width);
    expect(compact.nodes.find((n) => n.collapsed)?.h).toBe(COMPACT_LAYOUT.chipH);
    expect(full.nodes.find((n) => n.collapsed)?.h).toBe(DEFAULT_LAYOUT.chipH);
  });
});

describe('sidebar grouping', () => {
  const s = (id: string, project: string, mtime: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    id,
    file: `/p/${id}.jsonl`,
    projectDir: project,
    project,
    cwd: `/home/me/${project}`,
    title: `title ${id}`,
    mtime,
    size: 1,
    live: false,
    entrypoint: 'cli',
    ...extra,
  });

  it('matches title, project, folder, branch, machine and id', () => {
    const x = s('abcdef123456', 'app', 1, { gitBranch: 'feature/retry', machine: 'Test Mac' });
    expect(matchSession(x, '')).toBe(true);
    expect(matchSession(x, 'TITLE')).toBe(true);
    expect(matchSession(x, 'home/me')).toBe(true);
    expect(matchSession(x, 'retry')).toBe(true);
    expect(matchSession(x, 'mac')).toBe(true);
    expect(matchSession(x, 'abcdef')).toBe(true);
    expect(matchSession(x, 'nope')).toBe(false);
  });

  it('groups by project, newest group first, and takes out pinned and hidden sessions', () => {
    const list = [s('a', 'app', 10), s('b', 'web', 30), s('c', 'app', 20), s('d', 'web', 5), s('e', 'cli', 1)];
    const g = groupRecent(list, { pinned: ['e'], hidden: ['d'], collapsed: [groupKey(list[0])] });
    expect(g.pinned.map((x) => x.id)).toEqual(['e']);
    expect(g.hidden.map((x) => x.id)).toEqual(['d']);
    expect(g.groups.map((x) => [x.project, x.sessions.map((y) => y.id), x.collapsed])).toEqual([
      ['web', ['b'], false],
      ['app', ['c', 'a'], true],
    ]);
  });

  it('caps what lands in groups and reports the rest', () => {
    const list = Array.from({ length: 10 }, (_, i) => s(`s${i}`, 'app', i));
    const g = groupRecent(list, EMPTY_PREFS, 4);
    expect(g.groups[0].sessions).toHaveLength(4);
    expect(g.overflow).toBe(6);
  });

  it('toggles ids with a FIFO cap', () => {
    expect(toggleId(['a'], 'a', 3)).toEqual([]);
    expect(toggleId(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('failed tool output', () => {
  it('reads a tool_result error from string or text blocks, without colour codes', () => {
    expect(errorText('boom')).toBe('boom');
    expect(errorText([{ type: 'text', text: 'line one' }, { type: 'image' }, { type: 'text', text: 'line two' }])).toBe('line one\nline two');
    expect(errorText(`${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m failure`)).toBe('red failure');
    expect(errorText('<tool_use_error>File does not exist.</tool_use_error>')).toBe('File does not exist.');
    expect(errorText('x'.repeat(1000))).toHaveLength(300);
    expect(errorText('')).toBeUndefined();
    expect(errorText(undefined)).toBeUndefined();
  });

  it('keeps the message for failed calls only (transcript)', () => {
    const line = (isError: boolean) =>
      JSON.stringify({
        type: 'user',
        sessionId: 's',
        timestamp: '2026-10-18T10:00:00Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: isError, content: 'exit code 1: ENOENT' }] },
      });
    const failed = normalizeLine(line(true), { sessionId: 's', agentId: null }).find((e) => e.k === 'tool.end') as Extract<AgentEvent, { k: 'tool.end' }>;
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe('exit code 1: ENOENT');
    const ok = normalizeLine(line(false), { sessionId: 's', agentId: null }).find((e) => e.k === 'tool.end') as Extract<AgentEvent, { k: 'tool.end' }>;
    expect(ok.error).toBeUndefined();
  });

  it('keeps the message from a PostToolUseFailure hook', () => {
    const evs = normalizeHook({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_use_id: 't1', tool_name: 'Bash', error: 'denied' }, 1);
    const e = evs.find((x) => x.k === 'tool.end') as Extract<AgentEvent, { k: 'tool.end' }>;
    expect(e.error).toBe('denied');
  });

  it('stores it on the recent call and in the log line', () => {
    const ref = { sessionId: 's', agentId: 'ag' };
    const s = foldEvents('s', [
      { ts: 1, src: 'transcript', ref, k: 'tool.start', toolUseId: 't1', name: 'Bash', input: { command: 'npm test' } },
      { ts: 2, src: 'transcript', ref, k: 'tool.end', toolUseId: 't1', ok: false, error: 'exit code 1\nmore detail' },
    ] as AgentEvent[]);
    expect(s.agents.ag.recent[0].error).toBe('exit code 1\nmore detail');
    expect(s.log.find((l) => l.kind === 'tool-error')?.text).toBe('Bash failed: exit code 1');
  });

  it('subscribes to every hook event the normalizer understands', () => {
    expect(HOOK_EVENTS).toContain('StopFailure');
    expect(HOOK_EVENTS).toContain('PostModelSwitch');
  });
});
