import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layoutAgents, DEFAULT_LAYOUT } from '@core/layout';
import { normalizeHook } from '@core/normalize';
import { MAIN } from '@core/state';
import { SessionWatcher } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function load(opts = {}) {
  const { mainFile } = writeFixture(home, opts);
  const w = new SessionWatcher(SID, mainFile);
  await w.poll();
  return w;
}

describe('session folding from transcripts', () => {
  it('builds the agent tree with correct parents', async () => {
    const { state } = await load();
    const a = state.agents;
    expect(Object.keys(a).sort()).toEqual(['a1', 'a2', 'a3', 'main', 'w1', 'w2', 'wf:wf_x'].sort());
    expect(a.a1.parentId).toBe(MAIN);
    expect(a.a3.parentId).toBe('a1'); // nested via the Agent call inside a1's transcript
    expect(a.a3.depth).toBe(2);
    expect(a.a2.parentId).toBe(MAIN);
    expect(a['wf:wf_x'].parentId).toBe(MAIN);
    expect(a.w1.parentId).toBe('wf:wf_x');
    expect(a['wf:wf_x'].agentType).toBe('review');
    expect(a['wf:wf_x'].description).toBe('Review all the things');
  });

  it('derives statuses from results, notifications and journals', async () => {
    const { state } = await load();
    const a = state.agents;
    expect(a.a1.status).toBe('done'); // sync Agent tool_result status completed
    expect(a.a2.status).toBe('done'); // task-notification
    expect(a.a2.background).toBe(true);
    expect(a.a3.status).toBe('done');
    expect(a.w1.status).toBe('done'); // workflow journal result
    expect(a.w2.status).toBe('running');
    expect(a.main.status).toBe('idle'); // end_turn
  });

  it('takes models from transcripts and Agent results', async () => {
    const { state } = await load();
    expect(state.agents.main.model).toBe('claude-opus-5-5');
    expect(state.agents.main.effort).toBe('high');
    expect(state.agents.a1.model).toBe('claude-haiku-5-5');
    expect(state.agents.a2.model).toBe('claude-sonnet-5-5');
  });

  it('counts usage once per message id', async () => {
    const { state } = await load();
    // main: 6 messages (two of them span 2 lines each) at 1000 input tokens
    expect(state.agents.main.tokens.in).toBe(6000);
    expect(state.agents.a1.tokens.in).toBe(1800);
    expect(state.totals.in).toBe(6000 + 1800 + 100 + 200 + 50 + 50);
    expect(state.totals.out).toBe(6 * 50 + 70 + 5 + 10 + 5 + 5);
  });

  it('tracks mode, todos, title, cost, errors and unknown lines', async () => {
    const { state } = await load();
    expect(state.mode).toBe('plan');
    expect(state.todos).toEqual([{ id: '1', text: 'Map the repo', status: 'completed', owner: MAIN }]);
    expect(state.title).toBe('Retry + docs');
    expect(state.costUSD).toBe(1.25);
    expect(state.agents.main.errorCount).toBe(1);
    expect(state.warnings).toBe(1);
    expect(state.cwd).toBe('C:\\demo\\app');
    expect(state.entrypoint).toBe('cli');
    const kinds = state.log.map((l) => l.kind);
    expect(kinds).toContain('prompt');
    expect(kinds).toContain('mode');
    expect(kinds).toContain('tool-error');
    expect(state.log.find((l) => l.kind === 'tool' && l.agentId === MAIN && l.text.startsWith('Bash'))?.text).toBe('Bash  Run the test suite');
    // initial load interleaves files by time: a2's Bash (t+10s) precedes main's (t+53s)
    const order = state.log.filter((l) => l.kind === 'tool' && l.text.startsWith('Bash')).map((l) => l.agentId);
    expect(order).toEqual(['a2', MAIN]);
  });

  it('ignores a truncated final line until it completes', async () => {
    const w = await load({ truncatedTail: true });
    const before = w.state.eventCount;
    fs.appendFileSync(w.mainFile, 'ne"}}\n');
    await w.poll();
    expect(w.state.eventCount).toBeGreaterThan(before);
    expect(w.state.log.some((l) => l.kind === 'prompt' && l.text === 'half a line')).toBe(true);
  });

  it('picks up new subagents live', async () => {
    const w = await load();
    const sub = path.join(w.dir, 'subagents');
    fs.writeFileSync(path.join(sub, 'agent-a9.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'design it', toolUseId: 'toolu_A9' }));
    fs.writeFileSync(path.join(sub, 'agent-a9.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a9', sessionId: SID, timestamp: new Date().toISOString(), message: { id: 'm9', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_q', name: 'Glob', input: { pattern: '**/*.ts' } }] } }) + '\n');
    (w as unknown as { lastDirScan: number }).lastDirScan = 0;
    await w.poll();
    const a9 = w.state.agents.a9;
    expect(a9.agentType).toBe('Plan');
    expect(a9.status).toBe('running');
    expect(a9.currentTool?.name).toBe('Glob');
  });

  it('collects replay events sorted by time and folds to the same tree', async () => {
    const w = await load();
    const events = await w.collectAllEvents();
    for (let i = 1; i < events.length; i++) expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    const { foldEvents } = await import('@core/reducer');
    const s = foldEvents(SID, events);
    expect(Object.keys(s.agents).sort()).toEqual(Object.keys(w.state.agents).sort());
    expect(s.agents.a3.parentId).toBe('a1');
  });
});

describe('hooks merged with transcripts', () => {
  it('counts a tool seen by both a hook and the transcript once', async () => {
    const w = await load();
    const before = w.state.agents.main.toolCount;
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_live', tool_input: { file_path: 'x.ts' }, permission_mode: 'acceptEdits' }, Date.now()));
    expect(w.state.agents.main.toolCount).toBe(before + 1);
    expect(w.state.agents.main.currentTool?.name).toBe('Edit');
    expect(w.state.mode).toBe('acceptEdits');
    fs.appendFileSync(
      w.mainFile,
      JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: new Date(Date.now() - 1000).toISOString(), message: { id: 'm_live', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_live', name: 'Edit', input: { file_path: 'x.ts' } }] } }) + '\n',
    );
    await w.poll();
    expect(w.state.agents.main.toolCount).toBe(before + 1);
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'toolu_live' }, Date.now()));
    expect(w.state.agents.main.currentTool).toBeNull();
  });

  it('hook subagent lifecycle and attention', async () => {
    const w = await load();
    const now = Date.now();
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: 'h1', agent_type: 'Explore' }, now));
    expect(w.state.agents.h1.status).toBe('running');
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'h1' }, now + 1000));
    expect(w.state.agents.h1.status).toBe('done');
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, now + 2000));
    expect(w.state.agents.main.status).toBe('waiting');
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, now + 3000));
    expect(w.state.agents.main.status).toBe('running');
  });
});

describe('graph layout', () => {
  it('places nodes without overlap and collapses finished crowds', async () => {
    const { state } = await load();
    const lay = layoutAgents(state.agents);
    for (const a of lay.nodes)
      for (const b of lay.nodes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    expect(lay.edges.length).toBe(lay.nodes.length - 1);

    // 10 finished children under main collapse into one chip
    const agents = { ...state.agents };
    for (let i = 0; i < 10; i++) agents[`z${i}`] = { ...state.agents.a2, id: `z${i}`, parentId: MAIN, status: 'done' };
    const lay2 = layoutAgents(agents, DEFAULT_LAYOUT);
    const chip = lay2.nodes.find((n) => n.collapsed);
    expect(chip?.collapsed?.count).toBeGreaterThanOrEqual(10);
  });

  it('never re-adds collapsed subtrees as orphans', async () => {
    const { state } = await load();
    const agents = { ...state.agents };
    // 8 finished workflows with 30 finished agents each, all under main
    for (let w = 0; w < 8; w++) {
      agents[`wf:${w}`] = { ...state.agents['wf:wf_x'], id: `wf:${w}`, parentId: MAIN, status: 'done' };
      for (let i = 0; i < 30; i++) agents[`w${w}_${i}`] = { ...state.agents.w1, id: `w${w}_${i}`, parentId: `wf:${w}`, status: 'done' };
    }
    const lay = layoutAgents(agents);
    const ids = lay.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith('w0_'))).toBe(false);
    expect(lay.width).toBeLessThan(5000);
    // expanding main shows the workflows, each still collapsing its own crowd
    const open = layoutAgents(agents, { ...DEFAULT_LAYOUT, expanded: new Set([MAIN]) });
    expect(open.nodes.filter((n) => n.id.startsWith('wf:')).length).toBeGreaterThanOrEqual(8);
    expect(open.nodes.some((n) => n.id.startsWith('w0_'))).toBe(false);
  });
});
