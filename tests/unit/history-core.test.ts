import { describe, expect, it } from 'vitest';
import {
  addDays,
  aggregateUsage,
  buildFtsQuery,
  buildHeatmap,
  dayKey,
  dayStartMs,
  extractDelta,
  fillTimeGroups,
  formatUsd,
  hourOf,
  niceTicks,
  parseSnippet,
  rangeFromDay,
  skipLine,
  sumRows,
  titleFromPrompt,
  weekStart,
  weekdayIndex,
  type UsageRow,
} from '../../src/core/history';

const row = (o: Partial<UsageRow>): UsageRow => ({
  day: '2026-10-01',
  project: 'app',
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  family: 'opus',
  tokensIn: 100,
  tokensOut: 10,
  cacheRead: 1000,
  cacheWrite: 50,
  messages: 1,
  ...o,
});

describe('date bucketing (local timezone, weeks start Monday)', () => {
  it('uses the local calendar day, not UTC', () => {
    // 23:30 and 00:30 local are different days whatever the machine timezone is
    expect(dayKey(new Date(2026, 9, 5, 23, 30).getTime())).toBe('2026-10-05');
    expect(dayKey(new Date(2026, 9, 6, 0, 30).getTime())).toBe('2026-10-06');
    expect(hourOf(new Date(2026, 9, 6, 0, 30).getTime())).toBe(0);
    expect(hourOf(new Date(2026, 9, 6, 23, 59).getTime())).toBe(23);
  });

  it('weeks start on Monday', () => {
    expect(weekdayIndex('2026-10-05')).toBe(0); // Monday
    expect(weekdayIndex('2026-10-11')).toBe(6); // Sunday
    expect(weekStart('2026-10-11')).toBe('2026-10-05');
    expect(weekStart('2026-10-05')).toBe('2026-10-05');
    expect(weekStart('2026-10-14')).toBe('2026-10-12');
    expect(weekStart('2026-01-01')).toBe('2025-12-29');
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // DST changes in the US that week: still exactly one calendar day
  });

  it('range starts at local midnight N-1 days before today', () => {
    const now = new Date(2026, 9, 14, 15, 0).getTime();
    expect(rangeFromDay('7d', now)).toBe('2026-10-08');
    expect(rangeFromDay('30d', now)).toBe('2026-09-15');
    expect(rangeFromDay('all', now)).toBeNull();
    expect(dayStartMs('2026-10-08')).toBe(new Date(2026, 9, 8).getTime());
  });
});

describe('usage aggregation', () => {
  const rows = [
    row({ day: '2026-10-05', project: 'a', model: 'claude-opus-5-5', family: 'opus' }),
    row({ day: '2026-10-07', project: 'a', model: 'claude-sonnet-5-5', family: 'sonnet', tokensIn: 300 }),
    row({ day: '2026-10-11', project: 'b', model: 'qwen2.5-coder:32b', provider: 'local', family: 'local', tokensIn: 50, tokensOut: 5 }),
    row({ day: '2026-10-12', project: 'b', model: 'claude-opus-5-5', family: 'opus' }),
  ];

  it('sums input, output and cache separately', () => {
    const t = sumRows(rows);
    expect(t.tokensIn).toBe(100 + 300 + 50 + 100);
    expect(t.tokensOut).toBe(10 + 10 + 5 + 10);
    expect(t.cacheRead).toBe(4000);
    expect(t.messages).toBe(4);
  });

  it('groups by week, Sunday and Monday in different weeks', () => {
    const g = aggregateUsage(rows, 'week');
    expect(g.map((x) => x.key)).toEqual(['2026-10-05', '2026-10-12']);
    expect(g[0].messages).toBe(3); // Mon 5, Wed 7, Sun 11
    expect(g[1].messages).toBe(1);
  });

  it('splits a group by model family and keeps local models apart', () => {
    const [w1] = aggregateUsage(rows, 'week');
    expect(Object.keys(w1.byFamily).sort()).toEqual(['local', 'opus', 'sonnet']);
    expect(w1.byFamily.local).toBe(55);
    expect(w1.byFamilyAll.local).toBe(55 + 1000 + 50);
  });

  it('orders project and model groups biggest first and labels models', () => {
    const p = aggregateUsage(rows, 'project');
    expect(p.map((x) => x.key)).toEqual(['a', 'b']);
    const m = aggregateUsage(rows, 'model');
    expect(m.map((x) => x.key)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'qwen2.5-coder:32b']);
    expect(m.find((x) => x.key === 'claude-sonnet-5-5')!.label).toBe('Sonnet 5.5');
  });

  it('fills gaps so a time axis is continuous', () => {
    const days = fillTimeGroups(aggregateUsage(rows, 'day'), 'day', '2026-10-04', '2026-10-13');
    expect(days).toHaveLength(10);
    expect(days[0].key).toBe('2026-10-04');
    expect(days[0].messages).toBe(0);
    expect(days[1].messages).toBe(1);
    const weeks = fillTimeGroups(aggregateUsage(rows, 'week'), 'week', '2026-09-23', '2026-10-13');
    expect(weeks.map((x) => x.key)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
  });

  it('builds a Monday-first weekday x hour grid', () => {
    const grid = buildHeatmap([
      { day: '2026-10-05', hour: 9, messages: 4 },
      { day: '2026-10-12', hour: 9, messages: 2 },
      { day: '2026-10-11', hour: 23, messages: 7 },
    ]);
    expect(grid).toHaveLength(7);
    expect(grid[0][9]).toBe(6);
    expect(grid[6][23]).toBe(7);
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(13);
  });
});

describe('full-text query building', () => {
  it('turns words into AND-ed prefix terms', () => {
    expect(buildFtsQuery('retry')).toBe('"retry"*');
    expect(buildFtsQuery('  retry   backoff ')).toBe('"retry"* AND "backoff"*');
  });

  it('keeps quoted text as a phrase', () => {
    expect(buildFtsQuery('"flaky login" test')).toBe('"flaky login" AND "test"*');
  });

  it('neutralises FTS operators and punctuation', () => {
    expect(buildFtsQuery('NOT retry OR (a:b) *')).toBe('"NOT"* AND "retry"* AND "OR"* AND "a b"*');
    expect(buildFtsQuery('src/api.ts')).toBe('"src api ts"*');
    expect(buildFtsQuery('say "hi')).toBe('"say"* AND "hi"*');
    expect(buildFtsQuery("it's")).toBe('"it s"*');
  });

  it('returns null when nothing searchable is left', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('()*"" -- ^')).toBeNull();
  });

  it('keeps non-latin words', () => {
    expect(buildFtsQuery('café 日本語')).toBe('"café"* AND "日本語"*');
  });

  it('caps the number of terms', () => {
    const q = buildFtsQuery(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '))!;
    expect(q.split(' AND ')).toHaveLength(12);
  });

  it('splits snippets into plain and highlighted parts', () => {
    expect(parseSnippet('add \u0001retry\u0002 with backoff')).toEqual([
      { text: 'add ', hit: false },
      { text: 'retry', hit: true },
      { text: ' with backoff', hit: false },
    ]);
    expect(parseSnippet('')).toEqual([]);
    expect(parseSnippet('\u0001a\u0002\u0001b\u0002')).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: true },
    ]);
  });
});

describe('chart helpers', () => {
  it('picks round axis ticks that cover the max', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    for (const max of [1, 7, 97, 1234, 56_000, 3_400_000]) {
      const t = niceTicks(max);
      expect(t[0]).toBe(0);
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(max);
      expect(t.length).toBeGreaterThanOrEqual(2);
      expect(t.length).toBeLessThanOrEqual(7);
      const step = t[1] - t[0];
      t.forEach((v, i) => expect(v).toBeCloseTo(i * step));
    }
    expect(niceTicks(100)).toEqual([0, 50, 100]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  });

  it('formats dollars', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(1234.5)).toBe('$1,235');
  });
});

describe('extracting facts from transcript lines', () => {
  const line = (o: unknown) => JSON.stringify(o);
  const base = { sessionId: 's1', cwd: 'C:\\x\\proj', timestamp: '2026-10-01T10:00:00.000Z' };

  it('dedupes usage by message id and takes the last line of a message', () => {
    const msg = (out: number, block: unknown) =>
      line({ type: 'assistant', ...base, message: { id: 'm1', model: 'claude-opus-5-5', content: [block], usage: { input_tokens: 10, output_tokens: out } } });
    const d = extractDelta('s1', null, [
      msg(5, { type: 'text', text: 'hello there' }),
      msg(40, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }),
    ]);
    const main = d.agents.get('main')!;
    expect(main.usage.size).toBe(1);
    expect(main.usage.get('m1')!.tout).toBe(40);
    expect(main.usage.get('m1')!.model).toBe('claude-opus-5-5');
    expect(main.toolCount).toBe(1);
    expect(d.cwd).toBe('C:\\x\\proj');
  });

  it('indexes prompts, whole assistant text blocks and tool summaries', () => {
    const long = 'x'.repeat(900) + ' tail-marker';
    const d = extractDelta('s1', null, [
      line({ type: 'user', ...base, message: { role: 'user', content: 'Please add retry <system-reminder>noise</system-reminder>' } }),
      line({ type: 'assistant', ...base, message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: long }] } }),
      line({
        type: 'assistant',
        ...base,
        message: { id: 'm3', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'retry', path: 'src' } }] },
      }),
    ]);
    const docs = d.agents.get('main')!.docs;
    expect(docs.find((x) => x.kind === 'prompt')!.text).toBe('Please add retry');
    expect(docs.find((x) => x.kind === 'assistant')!.text).toContain('tail-marker'); // beyond the 400 char preview
    expect(docs.find((x) => x.kind === 'tool')!.text).toContain('/retry/');
  });

  it('attributes subagent lines to the file agent and counts tools per local day', () => {
    const ts = new Date(2026, 9, 5, 12, 0).getTime();
    const d = extractDelta('s1', 'a7', [
      line({
        type: 'assistant',
        isSidechain: true,
        agentId: 'a7',
        sessionId: 's1',
        timestamp: new Date(ts).toISOString(),
        message: { id: 'q', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'u', name: 'Read', input: { file_path: 'a.ts' } }] },
      }),
    ]);
    expect([...d.agents.keys()]).toEqual(['a7']);
    expect([...d.agents.get('a7')!.toolDays.entries()]).toEqual([[`2026-10-05\tRead`, 1]]);
  });

  it('skips tool results and file snapshots without parsing them', () => {
    expect(skipLine('{"type":"user","message":{"content":[{"tool_use_id":"x","type":"tool_result","content":"..."}]}}')).toBe(true);
    expect(skipLine('{"type":"file-history-snapshot","snapshot":{}}')).toBe(true);
    expect(skipLine('{"type":"user","message":{"content":"hello"}}')).toBe(false);
    // a prompt that merely talks about tool_result is escaped in JSON and must stay indexed
    expect(skipLine(JSON.stringify({ type: 'user', message: { content: 'what is "type":"tool_result"?' } }))).toBe(false);
  });

  it('records titles with the custom one winning, and the reported cost', () => {
    const d = extractDelta('s1', null, [
      line({ type: 'ai-title', aiTitle: 'AI name', sessionId: 's1' }),
      line({ type: 'custom-title', customTitle: 'My name', sessionId: 's1' }),
      line({ type: 'ai-title', aiTitle: 'Later AI name', sessionId: 's1' }),
      line({ type: 'cost-state', totalCostUSD: 2.5, modelUsage: {}, sessionId: 's1' }),
    ]);
    expect(d.title).toEqual({ title: 'My name', rank: 3 });
    expect(d.costUsd).toBe(2.5);
  });

  it('derives a title from the first prompt, not from system text', () => {
    expect(titleFromPrompt('  Add   retry\nto the client ')).toBe('Add retry to the client');
    expect(titleFromPrompt('<local-command-stdout>x</local-command-stdout>')).toBeNull();
    expect(titleFromPrompt(null)).toBeNull();
  });
});
