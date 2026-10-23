import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyUnifiedHeaders, emptyUsage } from '@core/usage';
import { PING_MODELS, pingBody, rejectedWaitMs, unifiedHeaders } from '@core/usagePing';
import { addPing, emptyPingStats, parsePingUsage, summarizePingStats } from '@core/pingStats';
import { DEFAULT_CONFIG, UsageScheduler } from '@core/usageScheduler';

const NOW = 1_790_000_000_000;
const H = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`anthropic-ratelimit-unified-${k}`, v]));

describe('applyUnifiedHeaders', () => {
  it('turns utilization fractions and epoch-second resets into exact ping readings', () => {
    const u = applyUnifiedHeaders(emptyUsage(), H({ '5h-utilization': '0.29', '5h-reset': '1792780800', '5h-status': 'allowed', '7d-utilization': '0.5', '7d-reset': '1793000000' }), NOW);
    expect(u.fiveHour).toEqual({ pct: 29, resetsAt: 1792780800_000, at: NOW, source: 'ping' });
    expect(u.sevenDay?.pct).toBe(50);
    expect(u.pingAt).toBe(NOW);
    expect(u.api?.state).toBe('ok');
  });
  it('ignores missing or garbled headers', () => {
    const base = emptyUsage();
    expect(applyUnifiedHeaders(base, {}, NOW)).toBe(base);
    expect(applyUnifiedHeaders(base, H({ '5h-utilization': 'abc', '5h-reset': 'x' }), NOW)).toBe(base);
    const u = applyUnifiedHeaders(base, H({ '5h-utilization': '1.7', '5h-reset': 'nope' }), NOW);
    expect(u.fiveHour).toMatchObject({ pct: 100, resetsAt: null });
    expect(u.sevenDay).toBeNull();
  });
  it('treats a rejected window as 100% with its reset, even without a utilization', () => {
    const u = applyUnifiedHeaders(emptyUsage(), H({ '5h-status': 'rejected', '5h-reset': '1792780800', '7d-utilization': '0.4' }), NOW);
    expect(u.fiveHour).toMatchObject({ pct: 100, resetsAt: 1792780800_000, source: 'ping' });
    expect(u.sevenDay?.pct).toBe(40);
  });
  it('keeps only the unified headers and waits for the reset (5 min at most)', () => {
    const src: Record<string, string> = { ...H({ '5h-utilization': '0.1', '5h-status': 'rejected', '5h-reset': String(NOW / 1000 + 120) }), authorization: 'x' };
    const h = unifiedHeaders((n) => src[n]);
    expect(Object.keys(h).every((k) => k.startsWith('anthropic-ratelimit-unified-'))).toBe(true);
    expect(rejectedWaitMs(h, NOW)).toBe(120_000);
    expect(rejectedWaitMs({}, NOW)).toBe(300_000);
  });
});

describe('ping scheduling', () => {
  const IV = 600_000;
  const cfg = { ...DEFAULT_CONFIG, activeMs: IV, idleMs: IV, minGapMs: IV, manualGapMs: IV, debounceMs: 1e12 };

  it('never pings without a session, pings when one starts, then at most every 10 minutes, and not for a burst', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let n = 0;
    let rl = false;
    const s: UsageScheduler = new UsageScheduler({ random: () => 0, canRun: () => s.status().active, poll: async () => (n++, rl ? { kind: 'rate-limited' } : { kind: 'ok' }) }, cfg);
    try {
      s.start();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(n).toBe(0); // app running, no session: nothing
      s.activity();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(n).toBe(1);
      for (let i = 0; i < 5; i++) {
        s.activity(); // a burst of activity changes nothing
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(n).toBe(1);
      for (let i = 0; i < 5; i++) {
        s.activity();
        await vi.advanceTimersByTimeAsync(61_000);
      }
      expect(n).toBe(2); // ~10 min after the first
      // the session goes quiet: no more pings
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(n).toBe(2);
      // a 429 without Retry-After is waited out
      rl = true;
      s.activity();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(n).toBe(3);
      expect(s.status().blockedUntil).toBeGreaterThan(Date.now() + 100_000);
    } finally {
      s.stop();
      vi.useRealTimers();
    }
  });
});

describe('the ping request (fake server)', () => {
  let server: http.Server;
  let home: string;
  const seen: { model: string; auth: string | undefined }[] = [];
  let missing = new Set<string>();
  let mode: 'ok' | '429' = 'ok';
  let fetchPing: typeof import('../../src/main/usagePing').fetchPing;
  const TOKEN = 'tok-SECRET-123';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const body = JSON.parse(b);
        seen.push({ model: body.model, auth: req.headers.authorization });
        if (missing.has(body.model)) return void res.writeHead(404).end('{}');
        const hdr = { 'anthropic-ratelimit-unified-5h-utilization': '0.29', 'anthropic-ratelimit-unified-5h-reset': '1792780800' };
        if (mode === '429') return void res.writeHead(429, { ...hdr, 'anthropic-ratelimit-unified-5h-status': 'rejected', 'retry-after': '0' }).end('{}');
        res.writeHead(200, hdr).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ping-'));
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 8 * 3600_000 } }));
    process.env.CLAUDE_VIS_HOME = home;
    process.env.CLAUDE_VIS_PING_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
    ({ fetchPing } = await import('../../src/main/usagePing'));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CLAUDE_VIS_PING_URL;
    delete process.env.CLAUDE_VIS_HOME;
  });

  it('the body model is always a Haiku id', () => {
    for (const m of PING_MODELS) expect(JSON.parse(pingBody(m)).model).toMatch(/haiku/i);
    expect(() => pingBody('claude-sonnet-5-5')).toThrow();
    expect(() => pingBody('claude-opus-5-5')).toThrow();
  });

  it('sends the login and returns the unified headers', async () => {
    const r = await fetchPing();
    expect(r.ok).toBe(true);
    expect(seen.at(-1)?.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen.at(-1)?.model).toBe('claude-haiku-5-5');
    if (r.ok) expect(applyUnifiedHeaders(emptyUsage(), r.headers, NOW).fiveHour?.pct).toBe(29);
  });

  it('a 429 that hit a limit still returns the headers, and its message holds no token', async () => {
    mode = '429';
    const r = await fetchPing();
    mode = 'ok';
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rateLimited).toBe(true);
      expect(r.headers?.['anthropic-ratelimit-unified-5h-status']).toBe('rejected');
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it('falls through Haiku ids on 404 and, when none exist, is unavailable without ever naming another model', async () => {
    seen.length = 0;
    missing = new Set(PING_MODELS);
    const r = await fetchPing();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unavailable).toBe(true);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    expect(seen.length).toBe(PING_MODELS.length);
    for (const s of seen) expect(s.model).toMatch(/haiku/i);
    missing = new Set();
  });

  it('errors from an unreachable server carry no token', async () => {
    process.env.CLAUDE_VIS_PING_URL = 'http://127.0.0.1:1/v1/messages';
    const r = await fetchPing();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('ping cost accumulation', () => {
  it('sums tokens and est. Haiku cost per day, 7 days and all time; reset is an empty state', () => {
    const u = parsePingUsage({ input_tokens: 35, output_tokens: 1, cache_read_input_tokens: 0 })!;
    expect(parsePingUsage('x')).toBeNull();
    expect(parsePingUsage({ input_tokens: -5, output_tokens: 'a' })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const day = 86_400_000;
    let s = emptyPingStats();
    s = addPing(s, u, 'claude-haiku-5-5', NOW - 10 * day);
    s = addPing(s, u, 'claude-haiku-5-5', NOW - 2 * day);
    s = addPing(s, u, 'claude-haiku-5-5-latest', NOW);
    s = addPing(s, null, null, NOW);
    const sum = summarizePingStats(s, NOW);
    expect(sum.all).toMatchObject({ n: 4, input: 105, output: 3 });
    expect(sum.week.n).toBe(3);
    expect(sum.today.n).toBe(2);
    expect(sum.all.costUsd).toBeCloseTo((3 * (35 * 0.1 + 1 * 0.5)) / 1e6, 10);
    expect(sum.lastAt).toBe(NOW);
    expect(summarizePingStats(emptyPingStats(), NOW).all.n).toBe(0);
  });
});
