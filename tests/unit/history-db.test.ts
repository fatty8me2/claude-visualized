import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldEvents } from '../../src/core/reducer';
import { normalizeLine } from '../../src/core/normalize';
import { dayKey } from '../../src/core/history';
import { HistoryDb } from '../../src/main/historyDb';
import { runIndex } from '../../src/main/historyIndex';
import { SID, writeFixture } from '../fixtures/build';
import { SID2, secondLines, writeSecondFixture } from '../fixtures/history';

let tmp: string;
let home: string;
let db: HistoryDb;
const NOW = Date.parse('2026-10-03T12:00:00Z');

const index = () => runIndex(db, { projectsDir: path.join(home, 'projects') });
const mainFile = () => path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-hist-'));
  home = path.join(tmp, 'home');
  writeFixture(home);
  writeSecondFixture(home);
  db = new HistoryDb(path.join(tmp, 'history.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** what the live reducer says a session's token totals are */
function reducerTotals(sid: string, files: { file: string; agentId: string | null }[]) {
  const events = files.flatMap((f) =>
    fs
      .readFileSync(f.file, 'utf8')
      .split('\n')
      .flatMap((l) => normalizeLine(l, { sessionId: sid, agentId: f.agentId })),
  );
  return foldEvents(sid, events).totals;
}

describe('history database', () => {
  it('uses node:sqlite with FTS5', () => {
    expect(db.hasFts()).toBe(true);
    expect(db.sqliteVersion()).toMatch(/^3\./);
  });

  it('indexes both sessions and their agents', async () => {
    const r = await index();
    expect(r.scanned).toBe(2);
    expect(r.indexed).toBe(2);
    expect(db.counts().sessions).toBe(2);
    const s = db.db.prepare('select * from sessions where id = ?').get(SID) as any;
    expect(s.title).toBe('Retry + docs');
    expect(s.project).toBe('app');
    expect(s.entrypoint).toBe('cli');
    expect(s.cost_usd).toBe(1.25);
    expect(s.agent_count).toBe(5); // a1 a2 a3 w1 w2
    const agents = db.db.prepare('select agent_id, type, goal, model, tool_count from agents where session_id = ? order by agent_id').all(SID) as any[];
    expect(agents.map((a) => a.agent_id)).toEqual(['a1', 'a2', 'a3', 'main', 'w1', 'w2']);
    expect(agents.find((a) => a.agent_id === 'a1')).toMatchObject({ type: 'Explore', goal: 'search', model: 'claude-haiku-5-5', tool_count: 2 });
    expect(agents.find((a) => a.agent_id === 'a2')).toMatchObject({ type: 'general-purpose', goal: 'test' });
    const s2 = db.db.prepare('select * from sessions where id = ?').get(SID2) as any;
    expect(s2).toMatchObject({ title: 'Flaky login test', project: 'other', cost_usd: 0.5, agent_count: 0 });
    expect(s2.models.split('\n').sort()).toEqual(['claude-sonnet-5-5', 'qwen2.5-coder:32b']);
  });

  it('token totals match the live reducer (messages counted once by id)', async () => {
    await index();
    const sub = path.join(home, 'projects', 'C--demo-app', SID, 'subagents');
    const wf = path.join(sub, 'workflows', 'wf_x');
    const live = reducerTotals(SID, [
      { file: mainFile(), agentId: null },
      ...['a1', 'a2', 'a3'].map((id) => ({ file: path.join(sub, `agent-${id}.jsonl`), agentId: id })),
      ...['w1', 'w2'].map((id) => ({ file: path.join(wf, `agent-${id}.jsonl`), agentId: id })),
    ]);
    const t = db.db.prepare('select sum(tin) i, sum(tout) o, sum(cache_read) r, sum(cache_write) w from usage_msgs where session_id = ?').get(SID) as any;
    expect({ in: t.i, out: t.o, cacheRead: t.r, cacheWrite: t.w }).toEqual(live);
    const a = db.db.prepare("select tokens_in i, tokens_out o from agents where session_id = ? and agent_id = 'a1'").get(SID) as any;
    expect(a).toEqual({ i: 500 + 600 + 700, o: 20 + 20 + 30 });
    const s2 = db.db.prepare('select sum(tin) i, count(*) n from usage_msgs where session_id = ?').get(SID2) as any;
    expect(s2).toEqual({ i: 2000 + 2000 + 5000, n: 3 }); // o_1 appears on two lines
  });

  it('rolls up per local day, project and model, with the local model apart', async () => {
    await index();
    const days = db.db
      .prepare('select distinct day from usage_daily order by day')
      .all()
      .map((r: any) => r.day);
    expect(days).toEqual([...new Set([dayKey(Date.parse('2026-09-28T09:15:01Z')), dayKey(Date.parse('2026-10-01T10:00:01Z'))])].sort());
    expect(days.length).toBe(2);
    const sum = db.summary({ range: 'all', groupBy: 'day' }, NOW);
    expect(sum.groups.map((g) => g.key)).toContain(days[0]);
    const first = sum.groups.find((g) => g.key === days[0])!;
    expect(first.byFamily.local).toBe(5300);
    expect(first.byFamily.sonnet).toBe(2000 + 100 + 2000 + 100);
    expect(sum.byProject.map((p) => p.key).sort()).toEqual(['app', 'other']);
    expect(sum.byModel.find((m) => m.key === 'qwen2.5-coder:32b')!.label).toMatch(/^Qwen/);
  });

  it('summarises KPIs, tools, goals and the heatmap', async () => {
    await index();
    const s = db.summary({ range: 'all', groupBy: 'week' }, NOW);
    expect(s.kpis.sessions).toBe(2);
    expect(s.kpis.costUsd).toBeCloseTo(1.75);
    expect(s.kpis.costSessions).toBe(2);
    expect(s.kpis.agents).toBe(5);
    expect(s.kpis.activeDays).toBe(2);
    expect(s.kpis.tokens.messages).toBe(db.db.prepare('select count(*) n from usage_msgs').get()!.n);
    expect(s.tools.find((t) => t.tool === 'Bash')!.count).toBe(3); // main npm test, a2 npm test, other login spec
    expect(s.goals.reduce((n, g) => n + g.count, 0)).toBe(7); // 6 agents of the first session + the other session's main
    expect(s.heat.flat().reduce((a, b) => a + b, 0)).toBe(s.kpis.tokens.messages);
    // a 7 day range ending 2026-10-03 still has the newest session but not the one from 09-28
    const week = db.summary({ range: '7d', groupBy: 'day' }, NOW);
    expect(week.kpis.sessions).toBe(2);
    const short = db.summary({ range: '7d', groupBy: 'day' }, Date.parse('2026-10-20T12:00:00Z'));
    expect(short.kpis.sessions).toBe(0);
    expect(short.groups).toHaveLength(7);
  });

  it('finds text in prompts, assistant text and tool summaries', async () => {
    await index();
    const r = db.search({ q: 'retry' });
    expect(r.empty).toBe(false);
    expect(r.hits.length).toBeGreaterThan(2);
    const kinds = new Set(r.hits.map((h) => h.kind));
    expect(kinds.has('prompt')).toBe(true);
    expect(kinds.has('tool')).toBe(true); // Grep /retry/ in a1
    const top = r.hits.find((h) => h.sessionId === SID)!;
    expect(top.title).toBe('Retry + docs');
    expect(top.project).toBe('app');
    expect(top.snippet.some((p) => p.hit && /retry/i.test(p.text))).toBe(true);
    expect(r.hits.some((h) => h.agent === 'search repo')).toBe(true);

    expect(db.search({ q: 'flaky log' }).hits.map((h) => h.sessionId)).toEqual([SID2]); // prefix match on the last term
    expect(db.search({ q: 'retry', project: 'other' }).hits).toHaveLength(0);
    expect(db.search({ q: 'timeout', project: 'other' }).hits.length).toBeGreaterThan(0);
    expect(db.search({ q: 'retry', limit: 1 }).hits).toHaveLength(1);
  });

  it('never throws on hostile queries', async () => {
    await index();
    for (const q of ['"', '(', 'a AND', 'NEAR(', '*', '-x', 'a OR b OR', "'; drop table docs; --", 'x:y', '\u0001\u0002']) {
      expect(() => db.search({ q })).not.toThrow();
    }
    expect(db.search({ q: '"' }).empty).toBe(true);
    expect(db.counts().docs).toBeGreaterThan(0);
  });

  it('only reads new bytes on a re-run and picks up appended lines', async () => {
    const first = await index();
    expect(first.bytesRead).toBeGreaterThan(1000);
    const again = await index();
    expect(again.indexed).toBe(0);
    expect(again.bytesRead).toBe(0);

    const before = db.summary({ range: 'all', groupBy: 'day' }, NOW).kpis.tokens;
    const add = JSON.stringify({
      type: 'assistant',
      sessionId: SID,
      timestamp: '2026-10-01T10:05:00.000Z',
      message: {
        id: 'msg_new',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'brand new zebra remark' }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    });
    fs.appendFileSync(mainFile(), add + '\n');
    const inc = await index();
    expect(inc.indexed).toBe(1);
    expect(inc.reset).toBe(0);
    expect(inc.bytesRead).toBe(Buffer.byteLength(add) + 1);
    const after = db.summary({ range: 'all', groupBy: 'day' }, NOW).kpis.tokens;
    expect(after.tokensIn - before.tokensIn).toBe(7);
    expect(after.tokensOut - before.tokensOut).toBe(3);
    expect(after.messages - before.messages).toBe(1);
    expect(db.search({ q: 'zebra' }).hits).toHaveLength(1);
  });

  it('waits for the end of a half-written last line', async () => {
    const half =
      '{"type":"assistant","sessionId":"x","timestamp":"2026-10-01T10:06:00.000Z","message":{"id":"msg_half","model":"claude-opus-5-5","content":[{"type":"text","text":"half';
    fs.appendFileSync(mainFile(), half);
    await index();
    expect(db.search({ q: 'half' }).hits).toHaveLength(0);
    fs.appendFileSync(mainFile(), ' written"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n');
    await index();
    expect(db.search({ q: 'written' }).hits).toHaveLength(1);
  });

  it('re-indexes a truncated or rewritten file from scratch without double counting', async () => {
    await index();
    const total = () => (db.db.prepare('select sum(tin) n from usage_msgs where session_id = ?').get(SID) as any).n;
    const baseline = total();
    // rewrite in place with different, shorter content
    const lines = fs.readFileSync(mainFile(), 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(mainFile(), lines.slice(0, 6).join('\n') + '\n');
    const r = await index();
    expect(r.reset).toBe(1);
    expect(total()).toBeLessThan(baseline);
    // a rewrite that keeps the length but changes bytes is caught by the signatures too
    const text = fs.readFileSync(mainFile(), 'utf8');
    const same = text.replace('Add retry', 'Add RETRY');
    expect(same.length).toBe(text.length);
    fs.writeFileSync(mainFile(), same);
    fs.utimesSync(mainFile(), new Date(), new Date(Date.now() + 5000));
    expect((await index()).reset).toBe(1);
    expect(db.search({ q: 'RETRY' }).hits.length).toBeGreaterThan(0);
    // and back to the full content: no leftovers from either version
    fs.writeFileSync(mainFile(), lines.join('\n') + '\n');
    expect((await index()).reset).toBe(1);
    expect(total()).toBe(baseline);
  });

  it('forgets sessions whose transcript was deleted', async () => {
    await index();
    fs.rmSync(path.join(home, 'projects', 'C--demo-other'), { recursive: true });
    const r = await index();
    expect(r.pruned).toBe(1);
    expect(db.counts().sessions).toBe(1);
    expect(db.db.prepare('select count(*) n from usage_msgs where session_id = ?').get(SID2)).toEqual({ n: 0 });
    expect(db.summary({ range: 'all', groupBy: 'day' }, NOW).byProject.map((p) => p.key)).toEqual(['app']);
  });

  it('survives reopening and can be rebuilt from nothing', async () => {
    await index();
    const file = db.file;
    db.close();
    db = new HistoryDb(file);
    expect(db.counts().sessions).toBe(2);
    expect((await index()).indexed).toBe(0);
    db.close();
    fs.rmSync(file);
    db = new HistoryDb(file);
    expect(db.counts().sessions).toBe(0);
    expect((await index()).indexed).toBe(2);
    expect(db.search({ q: 'login' }).hits.length).toBeGreaterThan(0);
  });

  it('an unreadable session does not stop the others', async () => {
    fs.mkdirSync(path.join(home, 'projects', 'C--broken', 'bad.jsonl'), { recursive: true }); // a directory named like a transcript
    const r = await index();
    expect(db.counts().sessions).toBe(2);
    expect(r.scanned).toBeGreaterThanOrEqual(2);
  });

  it('keeps the second fixture content stable for the e2e', () => {
    expect(secondLines().join('\n')).toContain('Fix the flaky login test');
  });
});
