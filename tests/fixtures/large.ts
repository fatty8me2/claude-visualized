// Synthetic LARGE session for performance work: hundreds of subagents, tens of thousands of
// tool calls, a full log ring buffer, plus a live-append mode that keeps writing like a running session.
import fs from 'node:fs';
import path from 'node:path';

export const LARGE_SID = '99999999-9999-4999-8999-999999999999';
export const LARGE_PROJECT = 'C--demo-large';

export interface LargeOpts {
  agents: number;
  /** tool calls (tool_use + tool_result pairs) across all agents, main included */
  toolCalls: number;
  /** how many agents are still running at the end of the backlog */
  running: number;
}

export const LARGE_DEFAULTS: LargeOpts = { agents: 300, toolCalls: 30_000, running: 40 };

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const TOOLS = ['Read', 'Grep', 'Bash', 'Edit', 'Glob', 'Write'] as const;
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 });

function toolInput(name: string, n: number): Record<string, unknown> {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return { file_path: `C:\\demo\\large\\src\\mod${n % 400}\\file${n % 97}.ts`, old_string: 'a', new_string: 'b', content: 'x' };
    case 'Grep':
      return { pattern: `needle${n % 50}`, path: 'src' };
    case 'Glob':
      return { pattern: `src/mod${n % 400}/**/*.ts` };
    default:
      return { command: `npm run task-${n % 40} -- --flag ${n}` };
  }
}

export interface LargeSession {
  home: string;
  mainFile: string;
  sessionDir: string;
  /** append `n` more tool calls spread over the running agents (and main), timestamped now */
  append(n: number): void;
  readonly runningIds: string[];
}

export function writeLargeSession(home: string, opts: Partial<LargeOpts> = {}): LargeSession {
  const o = { ...LARGE_DEFAULTS, ...opts };
  const pdir = path.join(home, 'projects', LARGE_PROJECT);
  const sdir = path.join(pdir, LARGE_SID);
  const sub = path.join(sdir, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const mainFile = path.join(pdir, `${LARGE_SID}.jsonl`);
  const end = Date.now();
  const start = end - 3 * 3600_000;
  const base = (ts: number) => ({
    sessionId: LARGE_SID,
    cwd: 'C:\\demo\\large',
    version: '2.1.295',
    entrypoint: 'cli',
    gitBranch: 'main',
    timestamp: new Date(ts).toISOString(),
  });

  let counter = 0;
  const callLines = (agentId: string | null, model: string, ts: number): string[] => {
    const n = ++counter;
    const name = TOOLS[n % TOOLS.length];
    const id = `toolu_${agentId ?? 'm'}_${n}`;
    const side = agentId ? { isSidechain: true, agentId } : { isSidechain: false };
    return [
      JSON.stringify({
        type: 'assistant',
        ...side,
        message: {
          id: `msg_${id}`,
          model,
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input: toolInput(name, n) }],
          usage: usage(1000 + (n % 500), 40),
        },
        ...base(ts),
      }),
      JSON.stringify({
        type: 'user',
        ...side,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: n % 53 === 0 }] },
        ...base(ts + 200),
      }),
    ];
  };

  const perAgent = Math.max(1, Math.floor((o.toolCalls * 0.97) / o.agents));
  const mainCalls = o.toolCalls - perAgent * o.agents;
  const mainLines: string[] = [
    JSON.stringify({ type: 'user', isSidechain: false, permissionMode: 'default', message: { role: 'user', content: 'Refactor everything' }, ...base(start) }),
  ];
  const runningIds: string[] = [];
  const agentFiles: { id: string; file: string; model: string }[] = [];

  for (let i = 0; i < o.agents; i++) {
    const id = `ag${String(i).padStart(4, '0')}`;
    const model = MODELS[i % MODELS.length];
    const spawnTs = start + Math.floor((i / o.agents) * (end - start - 600_000));
    const tuid = `toolu_spawn_${i}`;
    mainLines.push(
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          id: `msg_sp${i}`,
          model: 'claude-opus-5-5',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: tuid,
              name: 'Agent',
              input: { description: `task ${i}`, subagent_type: i % 2 ? 'Explore' : 'general-purpose', prompt: `do chunk ${i}` },
            },
          ],
          usage: usage(2000, 80),
        },
        ...base(spawnTs),
      }),
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description: `task ${i}`, resolvedModel: model },
        ...base(spawnTs + 100),
      }),
    );
    fs.writeFileSync(
      path.join(sub, `agent-${id}.meta.json`),
      JSON.stringify({
        agentType: i % 2 ? 'Explore' : 'general-purpose',
        description: `task ${i}`,
        toolUseId: tuid,
        spawnDepth: 1,
        requestShape: 'background',
      }),
    );
    const isRunning = i >= o.agents - o.running;
    if (isRunning) runningIds.push(id);
    const lines: string[] = [
      JSON.stringify({ type: 'user', isSidechain: true, agentId: id, message: { role: 'user', content: `do chunk ${i}` }, ...base(spawnTs + 150) }),
    ];
    const span = isRunning ? end - spawnTs - 5000 : Math.min(600_000, end - spawnTs - 1000);
    for (let k = 0; k < perAgent; k++) lines.push(...callLines(id, model, spawnTs + 200 + Math.floor((k / perAgent) * span)));
    if (!isRunning) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: id,
          message: {
            id: `msg_fin${i}`,
            model,
            role: 'assistant',
            content: [{ type: 'text', text: `Finished chunk ${i}` }],
            stop_reason: 'end_turn',
            usage: usage(900, 30),
          },
          ...base(spawnTs + 200 + span + 500),
        }),
      );
      // completion arrives as a task-notification in the main transcript
      mainLines.push(
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          message: {
            role: 'user',
            content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "task ${i}" finished</summary>\n</task-notification>`,
          },
          ...base(spawnTs + 200 + span + 600),
        }),
      );
    }
    const file = path.join(sub, `agent-${id}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    agentFiles.push({ id, file, model });
  }
  for (let k = 0; k < mainCalls; k++)
    mainLines.push(...callLines(null, 'claude-opus-5-5', start + 1000 + Math.floor((k / Math.max(1, mainCalls)) * (end - start - 2000))));
  mainLines.push(JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: LARGE_SID, timestamp: new Date().toISOString() }));
  fs.writeFileSync(mainFile, mainLines.join('\n') + '\n');

  const running = agentFiles.filter((a) => runningIds.includes(a.id));
  let cursor = 0;
  return {
    home,
    mainFile,
    sessionDir: sdir,
    runningIds,
    append(n: number) {
      const perFile = new Map<string, string[]>();
      for (let i = 0; i < n; i++) {
        const target = i % 10 === 0 || running.length === 0 ? null : running[cursor++ % running.length];
        const key = target ? target.file : mainFile;
        const arr = perFile.get(key) ?? [];
        arr.push(...callLines(target?.id ?? null, target?.model ?? 'claude-opus-5-5', Date.now()));
        perFile.set(key, arr);
      }
      for (const [f, ls] of perFile) fs.appendFileSync(f, ls.join('\n') + '\n');
    },
  };
}
