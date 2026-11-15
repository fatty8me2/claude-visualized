import { describe, expect, it } from 'vitest';
import {
  classifyRel,
  parseListLine,
  parseSshTarget,
  planFetch,
  REMOTE_SCRIPT,
  safeRel,
  sshArgs,
  sshErrorText,
  type LocalFile,
  type RemoteFile,
} from '../../src/core/sshRemote';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const files = (list: [string, number, number][]): Map<string, RemoteFile> =>
  new Map(list.map(([rel, ageMin, size]) => [rel, { rel, mtime: NOW - ageMin * MIN, size }]));

describe('ssh target', () => {
  it('accepts user@host, bare hosts and a port', () => {
    expect(parseSshTarget(' me@my-mac ')).toEqual({ ok: true, target: 'me@my-mac' });
    expect(parseSshTarget('100.64.0.7', 2222)).toEqual({ ok: true, target: '100.64.0.7', port: 2222 });
    expect(parseSshTarget('devbox', 22)).toEqual({ ok: true, target: 'devbox' });
  });
  it('refuses anything ssh or a shell could read as more than a host', () => {
    for (const bad of ['', '-oProxyCommand=calc', 'me@-host', 'a b', 'me@host;rm', 'me@host$(x)', "me@ho'st", 'me@@host', '-l', 'x'.repeat(300)])
      expect(parseSshTarget(bad).ok, bad).toBe(false);
    expect(parseSshTarget('host', 70000).ok).toBe(false);
  });
  it('never lets ssh prompt, and runs only sh', () => {
    const a = sshArgs({ target: 'me@my-mac', port: 2222 });
    expect(a).toContain('BatchMode=yes');
    expect(a.slice(-4)).toEqual(['-p', '2222', 'me@my-mac', 'sh']);
  });
});

describe('remote listing', () => {
  it('parses stat lines and drops unsafe paths', () => {
    expect(parseListLine('1800000000 42 ./proj-a/abc.jsonl')).toEqual({ rel: 'proj-a/abc.jsonl', mtime: 1_800_000_000_000, size: 42 });
    for (const bad of [
      '1 2 ./../x.jsonl',
      '1 2 ./a/../../b.jsonl',
      '1 2 ./a/b c.jsonl',
      "1 2 ./a/b'.jsonl",
      '1 2 /etc/passwd',
      'CVEND 5',
      '1 2 ./top.jsonl',
      '1 2 ./a/.hidden',
    ])
      expect(parseListLine(bad), bad).toBeNull();
    expect(safeRel('a/b/subagents/workflows/run1/journal.jsonl')).toBe(true);
  });
  it('knows which file belongs to which session', () => {
    expect(classifyRel('p/s1.jsonl')).toEqual({ session: 's1', main: true, mode: 'append' });
    expect(classifyRel('p/s1/subagents/agent-a.jsonl')).toEqual({ session: 's1', main: false, mode: 'append' });
    expect(classifyRel('p/s1/subagents/agent-a.meta.json')?.mode).toBe('replace');
    expect(classifyRel('p/s1/custom-title.json')?.mode).toBe('replace');
    expect(classifyRel('p/s1/other.json')).toBeNull();
    expect(classifyRel('p/notes.json')).toBeNull();
  });
  it('the script has unix line endings and only reads', () => {
    expect(REMOTE_SCRIPT).not.toMatch(/\r/);
    expect(REMOTE_SCRIPT).not.toMatch(/\brm\b|\bmv\b|\bcp\b|>>|\bcurl\b|\bwget\b|\beval\b/);
  });
});

describe('fetch plan', () => {
  const none = () => undefined;
  it('copies live sessions whole, side files before the main transcript', () => {
    const remote = files([
      ['p/live.jsonl', 1, 1000],
      ['p/live/subagents/agent-a.jsonl', 2, 500],
      ['p/live/subagents/agent-a.meta.json', 2, 50],
      ['p/old.jsonl', 600, 9000],
      ['p/old/subagents/agent-b.jsonl', 600, 700],
      ['p/old/custom-title.json', 600, 30],
    ]);
    const plan = planFetch(remote, none, { now: NOW });
    expect(plan.tasks.map((t) => t.rel)).toEqual([
      'p/live/subagents/agent-a.jsonl',
      'p/live/subagents/agent-a.meta.json',
      'p/live.jsonl',
      'p/old/custom-title.json',
      'p/old.jsonl',
    ]);
    expect(plan.pendingBytes).toBe(1000 + 500 + 50 + 30 + 9000);
    expect(plan.settled).toEqual([]);
  });
  it('a pinned session gets its side files too, and settles when nothing is missing', () => {
    const remote = files([
      ['p/old.jsonl', 600, 9000],
      ['p/old/subagents/agent-b.jsonl', 600, 700],
    ]);
    const local = new Map<string, LocalFile>([['p/old.jsonl', { size: 9000, mtime: 0 }]]);
    const plan = planFetch(remote, (r) => local.get(r), { now: NOW, pinned: new Set(['old']) });
    expect(plan.tasks.map((t) => t.rel)).toEqual(['p/old/subagents/agent-b.jsonl']);
    local.set('p/old/subagents/agent-b.jsonl', { size: 700, mtime: 0 });
    const done = planFetch(remote, (r) => local.get(r), { now: NOW, pinned: new Set(['old']) });
    expect(done.tasks).toEqual([]);
    expect(done.settled).toEqual(['old']);
  });
  it('continues a transcript from where the copy ends and restarts one that shrank', () => {
    const remote = files([
      ['p/a.jsonl', 1, 1000],
      ['p/b.jsonl', 1, 100],
    ]);
    const local = new Map<string, LocalFile>([
      ['p/a.jsonl', { size: 400, mtime: 0 }],
      ['p/b.jsonl', { size: 900, mtime: 0 }],
    ]);
    const plan = planFetch(remote, (r) => local.get(r), { now: NOW });
    expect(plan.tasks.find((t) => t.rel === 'p/a.jsonl')).toMatchObject({ offset: 400, restart: false });
    expect(plan.tasks.find((t) => t.rel === 'p/b.jsonl')).toMatchObject({ offset: 0, restart: true });
  });
  it('lists only the most recent sessions beyond the live ones and skips sessions without a main transcript', () => {
    const remote = files([
      ['p/s1.jsonl', 100, 10],
      ['p/s2.jsonl', 200, 10],
      ['p/s3.jsonl', 300, 10],
      ['p/orphan/subagents/agent-x.jsonl', 1, 10],
    ]);
    expect(planFetch(remote, none, { now: NOW, recent: 2 }).tasks.map((t) => t.rel)).toEqual(['p/s1.jsonl', 'p/s2.jsonl']);
  });
});

describe('ssh errors', () => {
  it('turns stderr into something to act on', () => {
    expect(sshErrorText('me@my-mac: Permission denied (publickey,password).', 'me@my-mac')).toMatch(/SSH key/);
    expect(sshErrorText('Host key verification failed.', 'me@my-mac')).toMatch(/ssh me@my-mac/);
    expect(sshErrorText('ssh: connect to host my-mac port 22: Connection timed out', 'me@my-mac')).toMatch(/Remote Login/);
    expect(sshErrorText('', 'me@my-mac')).toBe('The SSH connection closed.');
  });
});
