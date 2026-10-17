// Integration: two PeerService instances in one process over localhost. A sharer with a fixture session, and a viewer that pairs,
// streams the session's view, sees an appended transcript line arrive, and sees the sharer go offline and come back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboxItem } from '@core/inbox';
import { remoteId } from '@core/remote';
import { toView, type SessionSummary, type SessionView } from '@core/state';
import { emptyUsage, type UsageView } from '@core/usage';
import { PeerService, type ShareSource } from '../../src/main/peer/service';
import { SessionWatcher } from '../../src/main/watcher';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const until = async (what: string, fn: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A ShareSource over one fixture session, polled like the SessionManager does. */
class FixtureSource implements ShareSource {
  w: SessionWatcher;
  ver = 0;
  retained = new Map<string, number>();
  private timer: NodeJS.Timeout;
  usageView: UsageView = {
    ...emptyUsage(),
    fiveHour: { pct: 42, resetsAt: Date.now() + 3_600_000, at: Date.now(), source: 'statusline' },
    // anything beyond the UsageView fields must never be sent
    ...({ oauthToken: 'sk-ant-oat-SECRET' } as object),
  };
  inboxItems: InboxItem[] = [];
  constructor(
    mainFile: string,
    private summary: SessionSummary,
  ) {
    this.w = new SessionWatcher(SID, mainFile);
    this.timer = setInterval(() => {
      void this.w.poll().then((changed) => {
        if (changed) this.ver++;
      });
    }, 50);
  }
  stop() {
    clearInterval(this.timer);
  }
  summaries() {
    return [{ ...this.summary, mtime: Date.now() }];
  }
  view(id: string): SessionView | null {
    return id === SID && this.w.primed ? toView(this.w.state) : null;
  }
  version() {
    return this.ver;
  }
  retain(id: string) {
    this.retained.set(id, (this.retained.get(id) ?? 0) + 1);
  }
  release(id: string) {
    this.retained.set(id, (this.retained.get(id) ?? 0) - 1);
  }
  overview() {
    const v = this.view(SID);
    return v ? [v] : [];
  }
  overviewVersion() {
    return this.ver;
  }
  inbox() {
    return this.inboxItems;
  }
  usage() {
    return this.usageView;
  }
}

const emptySource: ShareSource = {
  summaries: () => [],
  view: () => null,
  version: () => 0,
  retain: () => {},
  release: () => {},
  overview: () => [],
  overviewVersion: () => 0,
  inbox: () => [],
  usage: () => emptyUsage(),
};

const fast = { bindHost: '127.0.0.1', discovery: false, scryptN: 1024, pairMinIntervalMs: 0, heartbeatMs: 400, pushMs: 40, retryMs: 100 };

describe('peer link over localhost', () => {
  let dir: string;
  let mainFile: string;
  let src: FixtureSource;
  let sharer: PeerService;
  let viewer: PeerService;
  let nsId: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-peer-'));
    const home = path.join(dir, 'home');
    ({ mainFile } = writeFixture(home));
    src = new FixtureSource(mainFile, {
      id: SID,
      file: mainFile,
      projectDir: PROJECT,
      project: 'app',
      cwd: 'C:\\demo\\app',
      title: 'Retry + docs',
      mtime: Date.now(),
      size: fs.statSync(mainFile).size,
      live: true,
      entrypoint: 'cli',
    });
    src.inboxItems = [
      {
        id: `${SID}:permission:main:1`,
        sessionId: SID,
        sessionTitle: 'Retry + docs',
        kind: 'permission',
        severity: 'critical',
        title: 'Permission needed',
        detail: 'Bash: npm test',
        firstSeen: 1,
        lastSeen: 1,
        count: 1,
        agentId: 'main',
        agentName: 'main',
        resolved: false,
        resolvedAt: null,
      },
    ];
    sharer = new PeerService({ storeFile: path.join(dir, 'mac', 'peers.json'), name: 'Test Mac', source: src, port: 0, ...fast });
    viewer = new PeerService({ storeFile: path.join(dir, 'pc', 'peers.json'), name: 'Test PC', source: emptySource, port: 0, ...fast });
    sharer.start();
    viewer.start();
    nsId = remoteId(sharer.me.deviceId, SID);
  });

  afterAll(async () => {
    src?.stop();
    await viewer?.stop();
    await sharer?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has no listener until sharing is turned on', async () => {
    expect(sharer.status().listening).toBe(false);
    expect(sharer.status().code).toBeNull();
    await sharer.setSharing(true);
    const st = sharer.status();
    expect(st.listening).toBe(true);
    expect(st.port).toBeGreaterThan(0);
    expect(st.code?.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('refuses a wrong code, then pairs with the right one', async () => {
    const port = sharer.status().port;
    const bad = await viewer.pair('127.0.0.1', port, 'ZZZZ-ZZZZ');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Wrong pairing code');
    expect(sharer.status().failuresLeft).toBe(4);
    expect(viewer.status().devices).toEqual([]);

    const r = await viewer.pair('127.0.0.1', port, sharer.status().code!.code);
    expect(r).toEqual({ ok: true, name: 'Test Mac' });
    expect(sharer.status().codeState).toBe('used');
    expect(sharer.status().devices.map((d) => [d.role, d.name])).toEqual([['viewer', 'Test PC']]);
    await until('the viewer link to come online', () => viewer.status().devices[0]?.state === 'online');
    await until('the sharer to see the viewer', () => sharer.status().devices[0]?.online === true);
  });

  it('receives the session list namespaced, plus inbox and usage meters only', async () => {
    await until('remote summaries', () => viewer.summaries().length === 1);
    const [s] = viewer.summaries();
    expect(s).toMatchObject({ id: nsId, machine: 'Test Mac', title: 'Retry + docs', live: true, file: '' });
    await until('remote inbox', () => viewer.remoteInbox()[0]?.items.length === 1);
    expect(viewer.remoteInbox()[0]).toMatchObject({ machine: 'Test Mac', deviceId: sharer.me.deviceId });
    await until('remote usage', () => viewer.remoteUsage().length === 1);
    const u = viewer.remoteUsage()[0];
    expect(u.fiveHour?.pct).toBe(42);
    expect(JSON.stringify(u)).not.toContain('SECRET');
  });

  it('streams a subscribed view and its live updates', async () => {
    expect(viewer.view(nsId)).toBeNull();
    viewer.setSelected(nsId);
    await until('the remote view', () => !!viewer.view(nsId));
    const v = viewer.view(nsId)!;
    expect(v.id).toBe(nsId);
    expect(v.machine).toBe('Test Mac');
    expect(Object.keys(v.agents).sort()).toEqual(expect.arrayContaining(['main', 'a1', 'a2', 'a3']));
    expect(src.retained.get(SID)).toBe(1);

    const before = v.eventCount;
    fs.appendFileSync(
      mainFile,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        sessionId: SID,
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg_peer',
          model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', id: 'toolu_peer', name: 'Bash', input: { command: 'echo over-the-link', description: 'peer link test' } }],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }) + '\n',
    );
    await until('the appended line to arrive', () => (viewer.view(nsId)?.eventCount ?? 0) > before);
    const after = viewer.view(nsId)!;
    expect(after.agents.main.currentTool?.name).toBe('Bash');
    expect(after.agents.a1).toBe(viewer.view(nsId)!.agents.a1); // decoded with identity kept for untouched agents
  });

  it('streams the overview only while wanted', async () => {
    expect(viewer.overview()).toEqual([]);
    viewer.setOverviewWanted(true);
    await until('the remote overview', () => viewer.overview().length === 1);
    expect(viewer.overview()[0]).toMatchObject({ id: nsId, machine: 'Test Mac' });
    viewer.setOverviewWanted(false);
    expect(viewer.overview()).toEqual([]);
  });

  it('marks the sharer offline when it stops, and reconnects when it is back', async () => {
    await sharer.setSharing(false);
    await until('the viewer to notice', () => viewer.status().devices[0]?.state !== 'online');
    const dev = viewer.status().devices[0];
    expect(dev.offlineSince).toBeGreaterThan(0);
    const [s] = viewer.summaries();
    expect(s).toMatchObject({ id: nsId, live: false });
    expect(s.offlineSince).toBe(dev.offlineSince);
    expect(viewer.remoteInbox()).toEqual([]);
    expect(src.retained.get(SID)).toBe(0); // the sharer released the session

    await sharer.setSharing(true);
    await until('the link to come back', () => viewer.status().devices[0]?.state === 'online', 10_000);
    await until('the view to stream again', () => (viewer.view(nsId)?.eventCount ?? 0) > 0);
    expect(viewer.summaries()[0].live).toBe(true);
  });

  it('un-pairing on the sharer revokes the viewer', async () => {
    const key = sharer.status().devices[0].key;
    sharer.unpair(key);
    await until('the viewer to be revoked', () => viewer.status().devices[0]?.state === 'revoked');
    expect(sharer.status().devices).toEqual([]);
  });
});
