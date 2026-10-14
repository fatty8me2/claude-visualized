import { describe, expect, it } from 'vitest';
import { describeActivity, toolPhrase, type ActivityAgent } from '@core/activity';

const NOW = 1_000_000;
const agent = (o: Partial<ActivityAgent> = {}): ActivityAgent => ({
  kind: 'agent',
  status: 'running',
  currentTool: null,
  lastText: null,
  lastActivity: NOW - 2000,
  ...o,
});
const tool = (name: string, input: unknown, summary = '', ago = 12_000) => ({ name, summary, input, since: NOW - ago });

describe('toolPhrase', () => {
  it('turns tool calls into plain English', () => {
    expect(toolPhrase('Read', 'api.ts', { file_path: 'C:\\x\\src\\api.ts' })).toBe('reading api.ts');
    expect(toolPhrase('Grep', '/retry/', { pattern: 'retry' })).toBe("searching for 'retry'");
    expect(toolPhrase('Edit', 'auth.ts', { file_path: '/a/b/auth.ts' })).toBe('editing auth.ts');
    expect(toolPhrase('Write', '', { file_path: '/a/b/new.md' })).toBe('writing new.md');
    expect(toolPhrase('Bash', '', { command: 'npm test' })).toBe('running the tests (npm test)');
    expect(toolPhrase('Bash', '', { command: 'npx vitest run && echo ok' })).toBe('running the tests (npx vitest run)');
    expect(toolPhrase('Bash', '', { command: 'npm run build' })).toBe('building (npm run build)');
    expect(toolPhrase('Bash', '', { command: 'git status' })).toBe('running git status');
    expect(toolPhrase('WebFetch', '', { url: 'https://github.com/foo/bar' })).toBe('reading github.com/foo/bar');
    expect(toolPhrase('WebSearch', '', { query: 'electron tray' })).toBe("searching the web for 'electron tray'");
    expect(toolPhrase('Agent', 'Explore: find auth', { description: 'find auth', subagent_type: 'Explore' })).toBe('starting a subagent: find auth');
    expect(toolPhrase('TaskUpdate', '#1')).toBe('updating the checklist');
    expect(toolPhrase('TodoWrite', '')).toBe('updating the checklist');
    expect(toolPhrase('mcp__ccd_session__mark_chapter', '')).toBe('calling mark_chapter (ccd_session)');
    expect(toolPhrase('Mystery', 'x')).toBe('using Mystery · x');
  });
});

describe('describeActivity', () => {
  it('shows the current tool with how long it has run', () => {
    const r = describeActivity(agent({ currentTool: tool('Read', { file_path: 'a/api.ts' }) }), { now: NOW });
    expect(r.phrase).toBe('reading api.ts');
    expect(r.line).toBe('reading api.ts · 12s');
    expect(r.since).toBe(NOW - 12_000);
    expect(r.kind).toBe('tool');
  });

  it('waits on running children', () => {
    const waiting = describeActivity(agent({ currentTool: tool('Agent', { description: 'x' }) }), { now: NOW, runningChildren: 3 });
    expect(waiting.phrase).toBe('waiting on 3 subagents');
    expect(describeActivity(agent(), { now: NOW, runningChildren: 1 }).phrase).toBe('waiting on 1 subagent');
    // an Agent call whose child has not appeared yet is still just starting
    expect(describeActivity(agent({ currentTool: tool('Agent', { description: 'dig' }) }), { now: NOW, runningChildren: 0 }).phrase).toBe(
      'starting a subagent: dig',
    );
    // a normal tool wins over background children
    expect(describeActivity(agent({ currentTool: tool('Read', { file_path: 'q.ts' }) }), { now: NOW, runningChildren: 2 }).phrase).toBe('reading q.ts');
  });

  it('writing a reply right after text, thinking when quiet', () => {
    expect(describeActivity(agent({ lastText: 'hi', lastTextAt: NOW - 1500 }), { now: NOW }).phrase).toBe('writing a reply');
    const thinking = describeActivity(agent({ lastText: 'hi', lastTextAt: NOW - 30_000 }), { now: NOW });
    expect(thinking.phrase).toBe('thinking…');
    expect(thinking.kind).toBe('thinking');
    expect(describeActivity(agent({ lastActivity: NOW - 400_000 }), { now: NOW }).kind).toBe('quiet');
  });

  it('finished agents quote the first line of their last message', () => {
    const r = describeActivity(agent({ status: 'done', lastText: '\n## Found it in src/api.ts\nmore detail' }), { now: NOW });
    expect(r.phrase).toBe('finished: Found it in src/api.ts');
    expect(r.line).toBe(r.phrase);
    expect(describeActivity(agent({ status: 'error' }), { now: NOW }).phrase).toBe('failed');
    expect(describeActivity(agent({ status: 'idle', kind: 'main', lastText: 'All done: retry added.' }), { now: NOW }).phrase).toBe(
      'finished: All done: retry added.',
    );
    expect(describeActivity(agent({ status: 'idle', kind: 'main' }), { now: NOW }).phrase).toBe('waiting for your next prompt');
  });

  it('flags agents blocked on the user and summarises workflows', () => {
    expect(describeActivity(agent({ status: 'waiting' }), { now: NOW }).phrase).toBe('waiting on you');
    expect(describeActivity(agent({ kind: 'workflow' }), { now: NOW, runningChildren: 2, totalChildren: 5 }).phrase).toBe('2 of 5 agents running');
  });
});
