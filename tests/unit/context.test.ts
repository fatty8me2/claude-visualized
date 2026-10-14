import { describe, expect, it } from 'vitest';
import { contextInfo, contextLevel, contextWindow } from '@core/context';
import type { AgentEvent } from '@core/events';
import { foldEvents } from '@core/reducer';
import { MAIN } from '@core/state';

const usage = (ts: number, msgId: string, input: number, agentId: string | null = null): AgentEvent => ({
  k: 'usage',
  ts,
  src: 'transcript',
  ref: { sessionId: 's', agentId },
  msgId,
  usage: { in: 5, out: 100, cacheRead: input - 5 - 1000, cacheWrite: 1000 },
});

describe('context tokens in the reducer', () => {
  it('tracks the latest message, not a sum', () => {
    const s = foldEvents('s', [usage(1000, 'a', 50_000), usage(2000, 'b', 60_000), usage(3000, 'c', 70_000)]);
    expect(s.agents[MAIN].contextTokens).toBe(70_000);
    expect(s.agents[MAIN].contextAt).toBe(3000);
  });

  it('counts a message once even when its lines repeat the usage', () => {
    const s = foldEvents('s', [usage(1000, 'a', 50_000), usage(1001, 'a', 50_000)]);
    expect(s.agents[MAIN].contextTokens).toBe(50_000);
  });

  it('drops after compaction', () => {
    const s = foldEvents('s', [
      usage(1000, 'a', 180_000),
      { k: 'compact', ts: 2000, src: 'transcript', ref: { sessionId: 's', agentId: null } },
      usage(3000, 'b', 20_000),
    ]);
    expect(s.agents[MAIN].contextTokens).toBe(20_000);
    expect(s.agents[MAIN].contextPeak).toBe(180_000);
  });

  it('ignores an out-of-order older message', () => {
    const s = foldEvents('s', [usage(3000, 'b', 20_000), usage(1000, 'a', 180_000)]);
    expect(s.agents[MAIN].contextTokens).toBe(20_000);
  });

  it('keeps agents separate', () => {
    const s = foldEvents('s', [usage(1000, 'a', 90_000), usage(1500, 'x', 30_000, 'sub1'), usage(2000, 'y', 40_000, 'sub2')]);
    expect(s.agents[MAIN].contextTokens).toBe(90_000);
    expect(s.agents.sub1.contextTokens).toBe(30_000);
    expect(s.agents.sub2.contextTokens).toBe(40_000);
  });
});

describe('contextWindow', () => {
  it('uses 1M when the model string says so', () => {
    expect(contextWindow('opus[1m]')).toEqual({ size: 1_000_000, estimated: false });
    expect(contextWindow('claude-opus-5-5[1m]')).toEqual({ size: 1_000_000, estimated: false });
  });
  it('infers 1M when usage has exceeded 200k', () => {
    expect(contextWindow('claude-opus-5-5', 300_000)).toEqual({ size: 1_000_000, estimated: true });
  });
  it('defaults to an estimated 200k', () => {
    expect(contextWindow('claude-opus-5-5', 100_000)).toEqual({ size: 200_000, estimated: true });
    expect(contextWindow(null)).toEqual({ size: 200_000, estimated: true });
  });
  it('computes percentage and level thresholds', () => {
    expect(contextLevel(0.69)).toBe('ok');
    expect(contextLevel(0.7)).toBe('warn');
    expect(contextLevel(0.9)).toBe('hot');
    const c = contextInfo({ model: 'claude-opus-5-5', contextTokens: 457_000, contextPeak: 457_000 });
    expect(c).toMatchObject({ size: 1_000_000, pct: 46, level: 'ok', estimated: true });
    expect(contextInfo({ model: null, contextTokens: 0, contextPeak: 0 })).toBeNull();
  });
});
