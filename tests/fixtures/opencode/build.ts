// Sanitized fake OpenCode data, mirroring the real formats (no real paths, names or content):
//  - the SQLite database of OpenCode 1.x (<data>/opencode.db: session / message / part / todo tables, JSON in `data`)
//  - the older JSON files (<data>/storage/{session/<project>,message/<session>,part/<message>,todo}/*.json)
// The scenario: a main session on a local Qwen model (LM Studio) that reads a file, writes a todo list, hands work to an
// "explore" subagent (a child session started by the task tool), and is running a bash command when the data ends.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAIN = 'ses_demo_main_0001';
export const CHILD = 'ses_demo_child_0002';
export const OC_PROJECT = '/srv/demo-app';
export const OC_MODEL = { providerID: 'lmstudio', modelID: 'qwen3-27b-q6_k' };
export const OC_TITLE = 'Add retry to the API client';

const SCHEMA = `
create table project (id text primary key, worktree text not null, time_created integer not null, time_updated integer not null);
create table session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null, title text not null,
  version text not null, agent text, model text, cost real default 0 not null, tokens_input integer default 0 not null,
  time_created integer not null, time_updated integer not null, time_archived integer);
create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
create table todo (session_id text not null, content text not null, status text not null, priority text not null, position integer not null,
  time_created integer not null, time_updated integer not null, primary key (session_id, position));
`;

export function openDb(dir: string): DatabaseSync {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'opencode.db');
  const fresh = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  if (fresh) db.exec(SCHEMA);
  return db;
}

export function putSession(db: DatabaseSync, s: { id: string; parent?: string; title: string; agent?: string; created: number; updated: number }) {
  db.prepare(
    'insert or replace into session (id, project_id, parent_id, slug, directory, title, version, agent, model, time_created, time_updated) values (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    s.id,
    'prj_demo',
    s.parent ?? null,
    s.id.slice(-4),
    OC_PROJECT,
    s.title,
    '1.18.31',
    s.agent ?? 'build',
    JSON.stringify({ id: OC_MODEL.modelID, providerID: OC_MODEL.providerID, variant: 'default' }),
    s.created,
    s.updated,
  );
}
export function putMessage(db: DatabaseSync, id: string, session: string, t: number, data: Record<string, unknown>) {
  db.prepare('insert or replace into message values (?,?,?,?,?)').run(id, session, t, t, JSON.stringify(data));
}
export function putPart(db: DatabaseSync, id: string, message: string, session: string, t: number, data: Record<string, unknown>) {
  db.prepare('insert or replace into part values (?,?,?,?,?,?)').run(id, message, session, t, t, JSON.stringify(data));
}
export function touchSession(db: DatabaseSync, id: string, t: number) {
  db.prepare('update session set time_updated = ? where id = ?').run(t, id);
}

const tokens = (input: number, output: number, read = 0) => ({ total: input + output + read, input, output, reasoning: 0, cache: { write: 0, read } });

/** A tool part as OpenCode writes it. */
export const toolPart = (
  tool: string,
  status: 'running' | 'completed' | 'error',
  input: Record<string, unknown>,
  start: number,
  end?: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'tool',
  tool,
  callID: `call_${tool}_${start}`,
  state:
    status === 'running'
      ? { status, input, time: { start } }
      : status === 'error'
        ? { status, input, error: 'file not found', time: { start, end } }
        : { status, input, output: 'ok', title: tool, metadata: { truncated: false, ...extra }, time: { start, end } },
  unknownFutureField: { anything: [1, 2, 3] },
});

/** Everything up to (not including) the running bash call. `t0` is the base time; returns the db. */
export function seedDb(dir: string, t0: number = Date.now() - 60_000): DatabaseSync {
  const db = openDb(dir);
  const T = (s: number) => t0 + s * 1000;
  putSession(db, { id: MAIN, title: OC_TITLE, created: T(0), updated: T(20) });
  putSession(db, { id: CHILD, parent: MAIN, title: 'Find the HTTP client (@explore subagent)', agent: 'explore', created: T(8), updated: T(18) });
  // main: prompt, then an assistant message that reads, plans and delegates
  putMessage(db, 'msg_001', MAIN, T(1), { role: 'user', time: { created: T(1) }, agent: 'build', model: { ...OC_MODEL, variant: 'default' } });
  putPart(db, 'prt_001', 'msg_001', MAIN, T(1), {
    type: 'text',
    text: 'Add retry with backoff to the API client and update the docs.',
    time: { start: T(1), end: T(1) },
  });
  putMessage(db, 'msg_002', MAIN, T(2), {
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    parentID: 'msg_001',
    ...OC_MODEL,
    path: { cwd: OC_PROJECT, root: '/' },
    cost: 0,
    tokens: tokens(1200, 90, 400),
    time: { created: T(2), completed: T(12) },
    finish: 'tool-calls',
  });
  putPart(db, 'prt_002', 'msg_002', MAIN, T(2), { type: 'step-start' });
  putPart(db, 'prt_003', 'msg_002', MAIN, T(3), {
    type: 'text',
    text: 'I will start by reading the client, then plan the change.',
    time: { start: T(3), end: T(4) },
  });
  putPart(db, 'prt_004', 'msg_002', MAIN, T(4), toolPart('read', 'completed', { filePath: `${OC_PROJECT}/src/client.ts` }, T(4), T(5)));
  putPart(
    db,
    'prt_005',
    'msg_002',
    MAIN,
    T(6),
    toolPart(
      'todowrite',
      'completed',
      {
        todos: [
          { content: 'Read the client', status: 'completed', priority: 'high' },
          { content: 'Add retry with backoff', status: 'in_progress', priority: 'high' },
          { content: 'Update the docs', status: 'pending', priority: 'medium' },
        ],
      },
      T(6),
      T(7),
    ),
  );
  putPart(
    db,
    'prt_006',
    'msg_002',
    MAIN,
    T(8),
    toolPart(
      'task',
      'completed',
      { description: 'Find the HTTP client', prompt: 'Locate the HTTP client module and list its public functions.', subagent_type: 'explore' },
      T(8),
      T(19),
      { sessionId: CHILD, parentSessionId: MAIN },
    ),
  );
  putPart(db, 'prt_007', 'msg_002', MAIN, T(12), { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: tokens(1200, 90, 400) });
  db.prepare('insert or replace into todo values (?,?,?,?,?,?,?)').run(MAIN, 'Read the client', 'completed', 'high', 0, T(6), T(6));
  db.prepare('insert or replace into todo values (?,?,?,?,?,?,?)').run(MAIN, 'Add retry with backoff', 'in_progress', 'high', 1, T(6), T(6));
  db.prepare('insert or replace into todo values (?,?,?,?,?,?,?)').run(MAIN, 'Update the docs', 'pending', 'medium', 2, T(6), T(6));
  // child (subagent) session
  putMessage(db, 'msg_c01', CHILD, T(9), { role: 'user', time: { created: T(9) }, agent: 'explore', model: OC_MODEL });
  putPart(db, 'prt_c01', 'msg_c01', CHILD, T(9), {
    type: 'text',
    text: 'Locate the HTTP client module and list its public functions.',
    time: { start: T(9), end: T(9) },
  });
  putMessage(db, 'msg_c02', CHILD, T(10), {
    role: 'assistant',
    mode: 'explore',
    agent: 'explore',
    parentID: 'msg_c01',
    ...OC_MODEL,
    cost: 0,
    tokens: tokens(800, 60),
    time: { created: T(10), completed: T(18) },
    finish: 'stop',
  });
  putPart(
    db,
    'prt_c02',
    'msg_c02',
    CHILD,
    T(10),
    toolPart('grep', 'completed', { pattern: 'fetch\\(', path: `${OC_PROJECT}/src` }, T(10), T(11), { matches: 4 }),
  );
  putPart(db, 'prt_c03', 'msg_c02', CHILD, T(17), {
    type: 'text',
    text: 'The client lives in src/client.ts and exports request() and get().',
    time: { start: T(17), end: T(18) },
  });
  putPart(db, 'prt_c04', 'msg_c02', CHILD, T(18), { type: 'step-finish', reason: 'stop', cost: 0, tokens: tokens(800, 60) });
  // main continues: a second assistant message, tool still running
  putMessage(db, 'msg_003', MAIN, T(20), {
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    parentID: 'msg_001',
    ...OC_MODEL,
    cost: 0,
    tokens: tokens(0, 0),
    time: { created: T(20) },
  });
  return db;
}

/** The running bash call that ends the scenario (written separately so tests can make it appear live). */
export function addRunningBash(db: DatabaseSync, t: number, id = 'prt_008', command = 'npm test') {
  putPart(db, id, 'msg_003', MAIN, t, toolPart('bash', 'running', { command, description: 'Run the tests' }, t));
  touchSession(db, MAIN, t);
}
export function finishBash(db: DatabaseSync, t: number, id = 'prt_008', command = 'npm test') {
  putPart(db, id, 'msg_003', MAIN, t - 1000, toolPart('bash', 'completed', { command, description: 'Run the tests' }, t - 1000, t, { exit: 0 }));
  touchSession(db, MAIN, t);
}

/** The same scenario in the older JSON-file layout. */
export function writeLegacyStorage(dir: string, t0: number = Date.now() - 60_000) {
  const T = (s: number) => t0 + s * 1000;
  const root = path.join(dir, 'storage');
  const put = (rel: string, o: unknown) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(o));
  };
  const sess = (id: string, parentID: string | undefined, title: string, c: number, u: number) =>
    put(`session/prj_demo/${id}.json`, {
      id,
      version: '0.15.0',
      projectID: 'prj_demo',
      directory: OC_PROJECT,
      parentID,
      title,
      time: { created: c, updated: u },
    });
  sess(MAIN, undefined, OC_TITLE, T(0), T(20));
  sess(CHILD, MAIN, 'Find the HTTP client (@explore subagent)', T(8), T(18));
  put(`message/${MAIN}/msg_001.json`, { id: 'msg_001', sessionID: MAIN, role: 'user', time: { created: T(1) } });
  put(`part/msg_001/prt_001.json`, { id: 'prt_001', messageID: 'msg_001', sessionID: MAIN, type: 'text', text: 'Add retry with backoff to the API client.' });
  put(`message/${MAIN}/msg_002.json`, {
    id: 'msg_002',
    sessionID: MAIN,
    role: 'assistant',
    ...OC_MODEL,
    cost: 0,
    tokens: tokens(1200, 90, 400),
    time: { created: T(2), completed: T(12) },
    finish: 'tool-calls',
  });
  put(`part/msg_002/prt_004.json`, {
    id: 'prt_004',
    messageID: 'msg_002',
    sessionID: MAIN,
    ...toolPart('read', 'completed', { filePath: `${OC_PROJECT}/src/client.ts` }, T(4), T(5)),
  });
  put(`part/msg_002/prt_006.json`, {
    id: 'prt_006',
    messageID: 'msg_002',
    sessionID: MAIN,
    ...toolPart('task', 'running', { description: 'Find the HTTP client', subagent_type: 'explore' }, T(8)),
    state: {
      status: 'running',
      input: { description: 'Find the HTTP client', subagent_type: 'explore' },
      metadata: { sessionId: CHILD },
      time: { start: T(8) },
    },
  });
  put(`part/msg_002/prt_007.json`, { id: 'prt_007', messageID: 'msg_002', sessionID: MAIN, type: 'step-finish', cost: 0, tokens: tokens(1200, 90, 400) });
  put(`message/${CHILD}/msg_c01.json`, { id: 'msg_c01', sessionID: CHILD, role: 'user', time: { created: T(9) } });
  put(`part/msg_c01/prt_c01.json`, { id: 'prt_c01', messageID: 'msg_c01', sessionID: CHILD, type: 'text', text: 'Locate the HTTP client module.' });
  put(`message/${CHILD}/msg_c02.json`, {
    id: 'msg_c02',
    sessionID: CHILD,
    role: 'assistant',
    ...OC_MODEL,
    tokens: tokens(800, 60),
    time: { created: T(10), completed: T(18) },
    finish: 'stop',
  });
  put(`part/msg_c02/prt_c02.json`, {
    id: 'prt_c02',
    messageID: 'msg_c02',
    sessionID: CHILD,
    ...toolPart('grep', 'running', { pattern: 'fetch', path: OC_PROJECT }, T(10)),
  });
  put(`todo/${MAIN}.json`, [{ id: '1', content: 'Add retry', status: 'in_progress', priority: 'high' }]);
}
