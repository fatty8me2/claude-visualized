// A busy, live session for judging the graph visuals: one Opus main agent with 48 direct children (9 running, 39 finished, so they
// wrap into rows and fold into a chip), one nested tree (a running subagent with 3 children of its own) and one workflow group with 6
// agents. The step helpers below append transcript lines and subagent files the way Claude Code does, with "now"-relative timestamps
// so the session counts as live. Used by tests/e2e/showcase.test.ts (SHOWCASE=1).
import fs from 'node:fs';
import path from 'node:path';

export const SHOW_SID = '22222222-2222-4222-8222-222222222222';
export const SHOW_PROJECT = 'C--showcase-app';
export const SHOW_TITLE = 'Showcase: 48 agents';
export const SHOW_CWD = 'C:\\showcase\\app';
export const WF_RUN = 'wf_show';
const WF_TASK = 'wtask_show';

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

interface Node {
  id: string; // 'main' or the agentId
  file: string; // the transcript this node writes to
  model: string;
  parentId: string | null;
  spawnToolUse?: string; // the Agent tool_use in the parent that launched this node
  openTool?: string; // the last tool_use started here, closed by the next step
  desc: string;
  workflow?: boolean;
  done?: boolean;
}

export interface Showcase {
  home: string;
  sid: string;
  mainFile: string;
  subDir: string;
  wfDir: string;
  journal: string;
  nodes: Map<string, Node>;
  /** timestamp offset in ms from now, advanced by `step` on every line (bulk history is written in the past) */
  at: number;
  step: number;
}

const iso = (sh: Showcase) => {
  const t = new Date(Date.now() + sh.at).toISOString();
  sh.at += sh.step;
  return t;
};
let counter = 0;
const uid = (p: string) => `${p}_${(++counter).toString(36)}`;
const usage = { input_tokens: 800, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function emit(sh: Showcase, node: Node, obj: Record<string, unknown>) {
  const common = { sessionId: sh.sid, cwd: SHOW_CWD, version: '2.1.295', entrypoint: 'cli', gitBranch: 'main', userType: 'external', timestamp: iso(sh) };
  const who = node.id === 'main' ? { isSidechain: false, permissionMode: 'default' } : { isSidechain: true, agentId: node.id };
  fs.appendFileSync(node.file, JSON.stringify({ ...common, ...who, ...obj }) + '\n');
}

function assistant(sh: Showcase, node: Node, block: unknown, stop: string | null = null) {
  emit(sh, node, {
    type: 'assistant',
    message: { id: uid('msg'), model: node.model, role: 'assistant', content: [block], stop_reason: stop, usage },
  });
}

/** an assistant tool_use in `node`'s transcript; returns the tool_use id */
function toolUse(sh: Showcase, node: Node, name: string, input: unknown): string {
  const id = uid('toolu');
  assistant(sh, node, { type: 'tool_use', id, name, input });
  return id;
}

function toolResult(sh: Showcase, node: Node, toolUseId: string, ok: boolean, content: string, extra: Record<string, unknown> = {}) {
  emit(sh, node, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: !ok }] },
    ...extra,
  });
}

/** closes the node's open tool call (if any) */
function closeOpen(sh: Showcase, node: Node, ok = true) {
  if (!node.openTool) return;
  toolResult(sh, node, node.openTool, ok, ok ? 'ok' : 'exit 1: 3 failing');
  node.openTool = undefined;
}

function register(sh: Showcase, node: Node) {
  sh.nodes.set(node.id, node);
  return node;
}

/** the subagent's first activity: a prompt, then a tool call that stays open until the next step */
function begin(sh: Showcase, node: Node, desc: string) {
  emit(sh, node, { type: 'user', message: { role: 'user', content: desc } });
  node.openTool = toolUse(sh, node, 'Grep', { pattern: desc.split(' ')[0], path: 'src' });
}

// ---------- setup ----------

export function writeShowcase(home: string): Showcase {
  const pdir = path.join(home, 'projects', SHOW_PROJECT);
  const sdir = path.join(pdir, SHOW_SID);
  const subDir = path.join(sdir, 'subagents');
  const wfDir = path.join(subDir, 'workflows', WF_RUN);
  fs.mkdirSync(wfDir, { recursive: true });
  const sh: Showcase = {
    home,
    sid: SHOW_SID,
    mainFile: path.join(pdir, `${SHOW_SID}.jsonl`),
    subDir,
    wfDir,
    journal: path.join(wfDir, 'journal.jsonl'),
    nodes: new Map(),
    at: -70_000,
    step: 150,
  };
  fs.writeFileSync(sh.mainFile, '');
  fs.writeFileSync(sh.journal, '{"type":"launched"}\n');
  const main = register(sh, { id: 'main', file: sh.mainFile, model: OPUS, parentId: null, desc: 'main' });

  emit(sh, main, { type: 'user', message: { role: 'user', content: 'Review the repo with a wide fan-out and report back.' } });
  emit(sh, main, { type: 'custom-title', customTitle: SHOW_TITLE, sessionId: SHOW_SID });
  assistant(sh, main, { type: 'text', text: 'Fanning out across the repo.' });

  // 39 finished top-level agents (spawned and finished in the past)
  const VERBS = ['read', 'grep', 'trace', 'map', 'diff', 'check', 'scan'];
  const NOUNS = [
    'api client',
    'retry policy',
    'config loader',
    'hook receiver',
    'session tail',
    'plan parser',
    'usage meter',
    'graph layout',
    'fixtures',
    'docs index',
    'workflow journal',
    'cost ledger',
    'tests',
  ];
  for (let i = 0; i < 39; i++) {
    const desc = `${VERBS[i % 7]} ${NOUNS[(i * 3) % 13]}`;
    spawn(sh, 'main', { id: `f${i + 1}`, desc, model: i % 4 === 0 ? SONNET : HAIKU, type: i % 3 === 0 ? 'Explore' : 'general-purpose' });
    finish(sh, `f${i + 1}`);
  }

  // 9 running top-level agents, one of them (n1) the root of the nested tree
  const running: [string, string, string, string?][] = [
    ['r1', 'W1: review api client retry', HAIKU, 'Explore'],
    ['r2', 'W2: review graph layout', SONNET],
    ['r3', 'W3: review hook receiver', HAIKU],
    ['r4', 'W4: review session tail', SONNET],
    ['r5', 'search repo', HAIKU, 'Explore'],
    ['r6', 'run tests', SONNET],
    ['r7', 'W5: review docs', HAIKU],
    ['r8', 'check types', HAIKU],
  ];
  for (const [id, desc, model, type] of running) {
    spawn(sh, 'main', { id, desc, model, type });
    touch(sh, id);
  }
  spawn(sh, 'main', { id: 'n1', desc: 'explore retry tree', model: SONNET, type: 'Explore' });
  touch(sh, 'n1');
  // the nested tree: n1 launches three children of its own (n1a finished)
  spawn(sh, 'n1', { id: 'n1a', desc: 'read retry config', model: HAIKU, type: 'Explore' });
  finish(sh, 'n1a');
  spawn(sh, 'n1', { id: 'n1b', desc: 'grep backoff', model: HAIKU, type: 'Explore' });
  touch(sh, 'n1b');
  spawn(sh, 'n1', { id: 'n1c', desc: 'map client tests', model: HAIKU });
  touch(sh, 'n1c');

  // one workflow group with 6 agents: x1 and x2 finished, the rest running
  const tool = toolUse(sh, main, 'Workflow', { script: "export const meta = { name: 'review', description: 'showcase' }" });
  toolResult(sh, main, tool, true, 'started', {
    toolUseResult: {
      status: 'async_launched',
      taskId: WF_TASK,
      taskType: 'local_workflow',
      workflowName: 'review',
      runId: WF_RUN,
      summary: 'Review the showcase',
    },
  });
  for (let i = 1; i <= 6; i++) {
    wfSpawn(sh, `x${i}`, `review:x${i}`, i <= 2 ? 'Read' : 'Review');
    if (i <= 2) wfFinish(sh, `x${i}`);
  }

  // back to live time for everything after the bulk history
  sh.at = 0;
  sh.step = 0;
  fs.appendFileSync(sh.mainFile, JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SHOW_SID, timestamp: iso(sh) }) + '\n');
  return sh;
}

// ---------- step helpers (used live by the scenario) ----------

/** spawns a top-level or nested subagent: the Agent tool_use in the parent, the meta file, and the child's first activity */
export function spawn(sh: Showcase, parentId: string, o: { id: string; desc: string; model: string; type?: string; background?: boolean }) {
  const parent = sh.nodes.get(parentId);
  if (!parent) throw new Error(`no agent ${parentId}`);
  const toolUseId = toolUse(sh, parent, 'Agent', {
    description: o.desc,
    subagent_type: o.type ?? 'general-purpose',
    prompt: o.desc,
    ...(o.background ? { run_in_background: true } : {}),
  });
  fs.writeFileSync(
    path.join(sh.subDir, `agent-${o.id}.meta.json`),
    JSON.stringify({
      agentType: o.type ?? 'general-purpose',
      description: o.desc,
      toolUseId,
      requestShape: o.background ? 'background' : 'foreground',
    }),
  );
  const node = register(sh, {
    id: o.id,
    file: path.join(sh.subDir, `agent-${o.id}.jsonl`),
    model: o.model,
    parentId,
    spawnToolUse: toolUseId,
    desc: o.desc,
  });
  begin(sh, node, o.desc);
}

/** a workflow child: a meta file with its phase, a journal "started" line, and its first activity */
export function wfSpawn(sh: Showcase, id: string, desc: string, phase: string) {
  fs.writeFileSync(
    path.join(sh.wfDir, `agent-${id}.meta.json`),
    JSON.stringify({ agentType: 'workflow-subagent', description: desc, workflowPhase: phase, requestShape: 'foreground' }),
  );
  fs.appendFileSync(sh.journal, JSON.stringify({ type: 'started', agentId: id }) + '\n');
  const node = register(sh, {
    id,
    file: path.join(sh.wfDir, `agent-${id}.jsonl`),
    model: SONNET,
    parentId: 'wf',
    desc,
    workflow: true,
  });
  begin(sh, node, desc);
}

/** a workflow child finishes: its journal result line */
export function wfFinish(sh: Showcase, id: string) {
  const node = sh.nodes.get(id);
  if (!node) throw new Error(`no workflow agent ${id}`);
  closeOpen(sh, node);
  node.done = true;
  fs.appendFileSync(sh.journal, JSON.stringify({ type: 'result', agentId: id }) + '\n');
}

/** starts a new tool call on an agent (closing the previous one): the "tool calls flowing" pulse */
export function step(sh: Showcase, id: string, name = 'Read', input: unknown = { file_path: 'src/api.ts' }) {
  const node = sh.nodes.get(id);
  if (!node) throw new Error(`no agent ${id}`);
  closeOpen(sh, node);
  node.openTool = toolUse(sh, node, name, input);
}

/** the same as touching the agent: a fresh tool call so its last activity is recent */
export function touch(sh: Showcase, id: string) {
  step(sh, id, 'Grep', { pattern: 'retry', path: 'src' });
}

/** several agents at once, the way a busy session looks */
export function pulse(sh: Showcase, ids: string[]) {
  for (const id of ids) step(sh, id, 'Bash', { command: 'npm test', description: 'Run the suite' });
}

/** a subagent finishes: its end_turn text, and the Agent tool_result (status completed) in its parent */
export function finish(sh: Showcase, id: string) {
  const node = sh.nodes.get(id);
  if (!node) throw new Error(`no agent ${id}`);
  if (node.workflow) return wfFinish(sh, id);
  closeOpen(sh, node);
  node.done = true;
  assistant(sh, node, { type: 'text', text: `Done: ${node.desc}.` }, 'end_turn');
  const parent = sh.nodes.get(node.parentId!)!;
  toolResult(sh, parent, node.spawnToolUse!, true, 'Finished', {
    toolUseResult: { status: 'completed', agentId: id, resolvedModel: node.model, description: node.desc },
  });
}

/** a subagent errors: a failing tool call in its own transcript, then an Agent tool_result that is_error in the parent */
export function fail(sh: Showcase, id: string) {
  const node = sh.nodes.get(id);
  if (!node) throw new Error(`no agent ${id}`);
  closeOpen(sh, node, false);
  const parent = sh.nodes.get(node.parentId!)!;
  toolResult(sh, parent, node.spawnToolUse!, false, 'Agent failed: the review hit a rate limit', {
    toolUseResult: { status: 'failed', agentId: id, resolvedModel: node.model },
  });
}

/** finishes every workflow child still running, then the workflow task's completion notice */
export function finishWorkflow(sh: Showcase) {
  for (const n of [...sh.nodes.values()]) if (n.workflow && !n.done) wfFinish(sh, n.id);
  const notif = `<task-notification>\n<task-id>${WF_TASK}</task-id>\n<status>completed</status>\n<summary>Workflow "review" finished</summary>\n</task-notification>`;
  const main = sh.nodes.get('main')!;
  fs.appendFileSync(
    sh.mainFile,
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(sh), sessionId: sh.sid, content: notif }) + '\n',
  );
  emit(sh, main, { type: 'user', message: { role: 'user', content: notif } });
}

/** a main-agent tool call (used to clear the waiting state with real activity) */
export function mainStep(sh: Showcase, name: string, input: unknown) {
  const main = sh.nodes.get('main')!;
  closeOpen(sh, main);
  main.openTool = toolUse(sh, main, name, input);
}

/** a PermissionRequest hook POST to the running app (the hook receiver works in the live app, not only from the transcript) */
export async function permissionRequest(port: number, sid = SHOW_SID) {
  const r = await fetch(`http://127.0.0.1:${port}/hook?src=claude-visualized`, {
    method: 'POST',
    body: JSON.stringify({ session_id: sid, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
  });
  return r.ok;
}
