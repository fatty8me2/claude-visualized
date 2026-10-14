import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeDeepLink } from '../../src/main/desktopSessions';
import { SessionIndexer } from '../../src/main/indexer';
import { SID, writeFixture } from '../fixtures/build';

let home: string;
let desk: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-idx-'));
  desk = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-desk-'));
  process.env.CLAUDE_VIS_HOME = home;
  process.env.CLAUDE_VIS_DESKTOP_DIR = desk;
});
afterEach(() => {
  delete process.env.CLAUDE_VIS_HOME;
  delete process.env.CLAUDE_VIS_DESKTOP_DIR;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(desk, { recursive: true, force: true });
});

/** subagent files written just now would count as activity; make them old */
function ageTree(dir: string) {
  const old = new Date('2026-10-01T10:05:00Z');
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) fs.utimesSync(path.join(e.parentPath, e.name), old, old);
}

describe('session index', () => {
  it('does not call a session live just because its file was touched', async () => {
    const { mainFile, sessionDir } = writeFixture(home);
    ageTree(sessionDir);
    // the desktop app appends untimestamped bookkeeping to old transcripts, bumping mtime
    fs.appendFileSync(mainFile, JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SID }) + '\n' + JSON.stringify({ type: 'atis-latch', atis: '', sessionId: SID }) + '\n');
    const [s] = await new SessionIndexer().scan();
    expect(s.id).toBe(SID);
    expect(s.live).toBe(false);
    expect(s.mtime).toBeLessThan(Date.parse('2026-10-02T00:00:00Z')); // last real activity, not the touch
  });

  it('is live when a new timestamped line arrives', async () => {
    const { mainFile } = writeFixture(home);
    fs.appendFileSync(mainFile, JSON.stringify({ type: 'user', sessionId: SID, timestamp: new Date().toISOString(), message: { content: 'go on' } }) + '\n');
    const [s] = await new SessionIndexer().scan();
    expect(s.live).toBe(true);
  });

  it('maps transcripts to desktop sessions for deep links, with archive state', async () => {
    writeFixture(home);
    const d = path.join(desk, 'acct', 'org');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'local_abc-123.json'), JSON.stringify({ sessionId: 'local_abc-123', cliSessionId: SID, title: 'Desktop title', isArchived: true, lastActivityAt: Date.now() }));
    const idx = new SessionIndexer();
    const [s] = await idx.scan();
    expect(s.desktopId).toBe('local_abc-123');
    expect(s.archived).toBe(true);
    expect(s.title).toBe('Desktop title');
    expect(s.live).toBe(true); // desktop lastActivityAt is real activity
    expect(claudeDeepLink(SID, idx.desktop.byCliId.get(SID))).toBe('claude://code/continue?session=local_abc-123');
    expect(claudeDeepLink('cli-only', undefined)).toBe('claude://resume?session=cli-only');
  });
});
