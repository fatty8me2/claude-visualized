// Indexing of shell-call durations (cmd_runs) for the running-command countdown (src/core/cmdEta.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryDb } from '../../src/main/historyDb';
import { runIndex } from '../../src/main/historyIndex';

const SID = '55555555-5555-4555-8555-555555555555';
const T0 = Date.parse('2026-11-10T10:00:00Z');
const S = 1000;

let tmp: string;
let projects: string;
let file: string;
let db: HistoryDb;

const base = (t: number) => ({ sessionId: SID, cwd: 'C:\\work\\shop', version: '2.1.300', timestamp: new Date(T0 + t).toISOString() });
const call = (t: number, id: string, input: Record<string, unknown>, name = 'Bash') => ({
  type: 'assistant',
  message: { id: `m_${id}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  ...base(t),
});
const result = (t: number, id: string, extra: Record<string, unknown> = {}, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Exit code 1' : 'ok', is_error: isError }] },
  toolUseResult: { stdout: 'x', stderr: '', interrupted: false, isImage: false },
  ...base(t),
  ...extra,
});
const write = (lines: unknown[], append = false) =>
  (append ? fs.appendFileSync : fs.writeFileSync)(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const rows = () =>
  db.db.prepare('select tool_use_id id, key, ms, ok from cmd_runs order by ts').all() as { id: string; key: string; ms: number | null; ok: number | null }[];
const index = () => runIndex(db, { projectsDir: projects });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-cmd-'));
  projects = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(projects, 'C--work-shop'), { recursive: true });
  file = path.join(projects, 'C--work-shop', `${SID}.jsonl`);
  db = new HistoryDb(path.join(tmp, 'history.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('shell-call durations in the history index', () => {
  it('times foreground shell calls and leaves out what says nothing about their length', async () => {
    write([
      { type: 'user', message: { role: 'user', content: 'run the tests' }, ...base(0) },
      call(1 * S, 't1', { command: 'cd /c/work/shop && npm run test:e2e 2>&1 | tail -20' }),
      result(201 * S, 't1'),
      call(202 * S, 't2', { command: 'npm test' }),
      result(232 * S, 't2', {}, true),
      call(233 * S, 't3', { command: 'npm run dev', run_in_background: true }),
      result(234 * S, 't3', { toolUseResult: { backgroundTaskId: 'b1' } }),
      call(235 * S, 't4', { command: 'npm run build' }),
      result(240 * S, 't4', { toolUseResult: { interrupted: true } }),
      call(241 * S, 't5', { command: 'npm run release' }),
      result(400 * S, 't5', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }),
      call(401 * S, 't6', { command: 'ls -la' }),
      result(402 * S, 't6'),
      call(403 * S, 't7', { command: 'gh run watch 42' }, 'PowerShell'),
      result(1000 * S, 't7', { toolUseResult: { backgroundTaskId: 'b2', timedOutAfterMs: 600000 } }),
    ]);
    await index();
    expect(rows()).toEqual([
      { id: 't1', key: 'npm run test:e2e', ms: 200 * S, ok: 1 },
      { id: 't2', key: 'npm test', ms: 30 * S, ok: 0 },
    ]);
  });

  it('completes a call whose result arrives after an earlier pass read its start', async () => {
    write([call(1 * S, 'p1', { command: 'npx vitest run' }, 'PowerShell'), call(2 * S, 'p2', { command: 'cargo build' })]);
    await index();
    expect(rows()).toEqual([
      { id: 'p1', key: 'npx vitest run', ms: null, ok: null },
      { id: 'p2', key: 'cargo build', ms: null, ok: null },
    ]);
    write([result(46 * S, 'p1'), result(50 * S, 'p2', { toolUseResult: { interrupted: true } })], true);
    await index();
    expect(rows()).toEqual([{ id: 'p1', key: 'npx vitest run', ms: 45 * S, ok: 1 }]);
    // a rebuild from scratch agrees
    db.dropSession(SID);
    db.db.exec('delete from files');
    await index();
    expect(rows()).toEqual([{ id: 'p1', key: 'npx vitest run', ms: 45 * S, ok: 1 }]);
  });

  it('feeds the command priors by key and project', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(call(i * 600 * S, `r${i}`, { command: 'npm run test:e2e' }), result(i * 600 * S + (180 + i * 10) * S, `r${i}`));
    }
    write(lines);
    await index();
    const p = db.cmdPriors(T0 + 86_400_000);
    expect(p.all['npm run test:e2e']).toEqual([180, 190, 200, 210, 220, 230].map((x) => x * S));
    expect(p.byProject.shop['npm run test:e2e']).toHaveLength(6);
  });
});
