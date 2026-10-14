import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply } from '@core/reducer';
import { newSession, toView, type SessionView } from '@core/state';
import { LocalViewStream, OverviewDecoder, OverviewEncoder, ViewDecoder, ViewEncoder } from '@core/sync';
import { SessionWatcher } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';
import { LARGE_SID, writeLargeSession } from '../fixtures/large';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sync-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ipc = <T>(m: T): T => structuredClone(m);

/** the decoded view must equal the live one (the log may differ only in how far back it is trimmed) */
function expectSame(decoded: SessionView, live: SessionView) {
  expect(Object.keys(decoded.agents).sort()).toEqual(Object.keys(live.agents).sort());
  for (const k of Object.keys(live.agents)) expect(JSON.stringify(decoded.agents[k]), k).toBe(JSON.stringify(live.agents[k]));
  const n = Math.min(decoded.log.length, live.log.length);
  expect(decoded.log.slice(-n)).toEqual(live.log.slice(-n));
  const { agents: _a, log: _l, ...m1 } = decoded;
  const { agents: _a2, log: _l2, ...m2 } = live;
  expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
}

async function eventsOf(mainFile: string, sid: string) {
  return new SessionWatcher(sid, mainFile).collectAllEvents();
}

describe('incremental view transport', () => {
  it('reproduces the live view exactly after every chunk of events (fixture session)', async () => {
    const { mainFile } = writeFixture(home);
    const events = await eventsOf(mainFile, SID);
    expect(events.length).toBeGreaterThan(20);
    for (const chunk of [1, 3, 7]) {
      const s = newSession(SID);
      const enc = new ViewEncoder();
      const dec = new ViewDecoder();
      for (let i = 0; i < events.length; i++) {
        apply(s, events[i]);
        if ((i + 1) % chunk) continue;
        const v = dec.apply(ipc(enc.encode(toView(s))));
        expect(v).toBeTruthy();
        expectSame(v!, toView(s));
      }
    }
  });

  it('keeps object identity for agents and the log that did not change', async () => {
    const { mainFile } = writeFixture(home);
    const events = await eventsOf(mainFile, SID);
    const s = newSession(SID);
    const enc = new ViewEncoder();
    const dec = new ViewDecoder();
    for (const e of events.slice(0, events.length - 1)) apply(s, e);
    const v1 = dec.apply(ipc(enc.encode(toView(s))))!;
    const idle = ipc(enc.encode(toView(s)));
    expect(idle.t).toBe('delta');
    expect(dec.apply(idle)).toBeTruthy();
    apply(s, events[events.length - 1]);
    const v2 = dec.apply(ipc(enc.encode(toView(s))))!;
    const keys = Object.keys(v2.agents);
    expect(keys.filter((k) => v2.agents[k] === v1.agents[k]).length).toBeGreaterThan(0);
  });

  it('sends a full view for a new session, after a reset and after the state was rebuilt', async () => {
    const { mainFile } = writeFixture(home);
    const events = await eventsOf(mainFile, SID);
    const s = newSession(SID);
    for (const e of events) apply(s, e);
    const enc = new ViewEncoder();
    expect(enc.encode(toView(s)).t).toBe('full');
    expect(enc.encode(toView(s)).t).toBe('delta');
    enc.reset();
    expect(enc.encode(toView(s)).t).toBe('full');
    const rebuilt = newSession(SID);
    for (const e of events.slice(0, 5)) apply(rebuilt, e);
    expect(enc.encode(toView(rebuilt)).t).toBe('full'); // fewer events than before: the file was truncated and re-read
    expect(enc.encode({ ...toView(rebuilt), id: 'other' }).t).toBe('full');
    expect(enc.encode(null).t).toBe('none');
  });

  it('asks for a resync when a message is missed', async () => {
    const { mainFile } = writeFixture(home);
    const events = await eventsOf(mainFile, SID);
    const s = newSession(SID);
    const enc = new ViewEncoder();
    const dec = new ViewDecoder();
    for (const e of events.slice(0, 10)) apply(s, e);
    dec.apply(ipc(enc.encode(toView(s))));
    for (const e of events.slice(10, 15)) apply(s, e);
    enc.encode(toView(s)); // lost on the way
    for (const e of events.slice(15, 20)) apply(s, e);
    expect(dec.apply(ipc(enc.encode(toView(s))))).toBeUndefined();
    // a fresh decoder (new window) cannot apply a delta either
    expect(new ViewDecoder().apply(ipc(enc.encode(toView(s))))).toBeUndefined();
    // after a snapshot the encoder starts over with a full view
    enc.reset();
    expect(dec.apply(ipc(enc.encode(toView(s))))).toBeTruthy();
  });

  it('local stream (replay) is isolated from later reducer mutations', async () => {
    const { mainFile } = writeFixture(home);
    const events = await eventsOf(mainFile, SID);
    const s = newSession(SID);
    const stream = new LocalViewStream();
    let prev: SessionView | null = null;
    for (const e of events) {
      apply(s, e);
      const v = stream.next(toView(s));
      expectSame(v, toView(s));
      prev = v;
    }
    const frozen = JSON.stringify(prev);
    s.agents.main.toolCount += 99; // live mutation after the fact
    expect(JSON.stringify(prev)).toBe(frozen);
  });

  it('overview: per-session streams, sessions come and go', async () => {
    const { mainFile } = writeFixture(home);
    const events = await eventsOf(mainFile, SID);
    const s = newSession(SID);
    const t = newSession('second');
    const enc = new OverviewEncoder();
    const dec = new OverviewDecoder();
    let n = 0;
    for (const e of events) {
      apply(s, e);
      if (n++ % 2 === 0) apply(t, e);
      const live = [toView(s), ...(n % 5 === 0 ? [] : [toView(t)])];
      const out = dec.apply(ipc(enc.encode(live)))!;
      expect(out.length).toBe(live.length);
      out.forEach((v, i) => expectSame(v, live[i]));
    }
  });

  it('large session: a typical live push is a small fraction of the full view', async () => {
    const big = writeLargeSession(home, { agents: 120, toolCalls: 6000, running: 20 });
    const w = new SessionWatcher(LARGE_SID, big.mainFile);
    await w.poll();
    const enc = new ViewEncoder();
    const dec = new ViewDecoder();
    const full = enc.encode(toView(w.state));
    dec.apply(ipc(full));
    const fullBytes = JSON.stringify(full).length;
    big.append(30);
    await w.poll();
    const d = enc.encode(toView(w.state));
    expect(d.t).toBe('delta');
    expectSame(dec.apply(ipc(d))!, toView(w.state));
    expect(JSON.stringify(d).length).toBeLessThan(fullBytes / 4);
  });
});
