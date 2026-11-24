// Google Antigravity CLI (agy) transcripts for tests: the step log agy 1.5.16 writes to
// ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl, as Kiln's own tailer reads it
// (Kiln tests/fixtures/agy/transcript.jsonl, copied below with its folder renamed). Sanitized: no real paths, names or content.
import fs from 'node:fs';
import path from 'node:path';

export const AGY_MODEL = 'gemini-4-neon-high';

/**
 * The name the lead's transcript gives Kiln's delegate_task. agy namespaces a plugin's MCP server as <plugin>_<server>
 * ("kiln-harness_harness", Kiln launch.ts) and its tools as mcp_<server>_<tool>: an inference, the app accepts other spellings too.
 */
export const AGY_DELEGATE = 'mcp_kiln-harness_harness_delegate_task';

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** agy's local-time stamps in a result step's header */
const local = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const enc = (v: string) => JSON.stringify(v);

export const agyUser = (i: number, at: number, request: string) =>
  JSON.stringify({
    step_index: i,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: iso(at),
    content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${local(at)}.\n</ADDITIONAL_METADATA>`,
  });

export const agyResponse = (
  i: number,
  at: number,
  o: { content?: string; calls?: [name: string, args: Record<string, unknown>][]; in?: number; cacheRead?: number; out?: number; model?: string } = {},
) =>
  JSON.stringify({
    step_index: i,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: iso(at),
    model: o.model ?? AGY_MODEL,
    input_tokens: o.in ?? 2400,
    cache_read_tokens: o.cacheRead ?? 8000,
    output_tokens: o.out ?? 120,
    thinking: 'Planning the next step.\n',
    ...(o.content ? { content: o.content } : {}),
    ...(o.calls?.length ? { tool_calls: o.calls.map(([name, args]) => ({ name, args })) } : {}),
  });

export const agyResult = (i: number, at: number, output: string, done = at, status = 'DONE') =>
  JSON.stringify({
    step_index: i,
    source: 'MODEL',
    type: 'GENERIC',
    status,
    created_at: iso(at),
    content: `Created At: ${local(at)}\nCompleted At: ${local(done)}\n${output}`,
  });

/** agy passes most string arguments JSON-encoded: "\"ls -la\"" */
export const agyArgs = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? enc(v) : v]));
export const agySteps = (steps: [title: string, status: 'pending' | 'in_progress' | 'done'][]) => ({
  steps: JSON.stringify(steps.map(([title, status]) => ({ status, title }))),
});

/** Kiln's agy fixture (a real agy 1.5.16 run: update_steps, run_command, read_file), in /Users/demo/code/notes. */
export const KILN_AGY_TRANSCRIPT = [
  '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-11-24T19:15:51Z","content":"<USER_REQUEST>\\nTrack two steps with update_steps: (1) list the files here with a shell command, (2) read a.txt. Do both, mark the steps done, then reply \\"done\\".\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nThe current local time is: 2026-11-24T13:15:51-06:00.\\n</ADDITIONAL_METADATA>\\n<USER_SETTINGS_CHANGE>\\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (High). No need to comment on this change if the user doesn\'t ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\\n</USER_SETTINGS_CHANGE>"}',
  '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-24T19:15:51Z","model":"gemini-4-neon-high","input_tokens":9735,"cache_read_tokens":0,"output_tokens":357,"thinking":"Calling the update function for the first step, aiming to list files using a command. This fulfills the first part of the request.\\n\\n\\n","tool_calls":[{"name":"update_steps","args":{"steps":"[{\\"status\\":\\"in_progress\\",\\"title\\":\\"List workspace files\\"},{\\"status\\":\\"pending\\",\\"title\\":\\"Read a.txt\\"}]"}},{"name":"run_command","args":{"CommandLine":"\\"ls -la\\"","WaitMsBeforeAsync":"5000","toolSummary":"\\"List workspace files\\""}}]}',
  '{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-24T19:15:56Z","content":"Created At: 2026-11-24T13:15:56-06:00\\nCompleted At: 2026-11-24T13:15:57-06:00\\nCreated At: 2026-11-24T13:15:56-06:00\\nCompleted At: 2026-11-24T13:15:56-06:00\\nOK"}',
  '{"step_index":3,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-24T19:15:56Z","content":"Created At: 2026-11-24T13:15:56-06:00\\nCompleted At: 2026-11-24T13:15:57-06:00\\nCreated At: 2026-11-24T13:15:56-06:00\\nCompleted At: 2026-11-24T13:15:57-06:00\\nCommand exited with code 0.\\n\\nCommand output:\\ntotal 8\\r\\ndrwxr-xr-x@  4 me  wheel  128 Nov 24 13:15 .\\r\\n-rw-r--r--@  1 me  wheel    6 Nov 24 13:15 a.txt\\r\\n"}',
  '{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-24T19:15:57Z","model":"gemini-4-neon-high","input_tokens":2716,"cache_read_tokens":7678,"output_tokens":242,"content":"Listed the workspace files and found `a.txt`. Reading `a.txt` next.","tool_calls":[{"name":"update_steps","args":{"steps":"[{\\"status\\":\\"done\\",\\"title\\":\\"List workspace files\\"},{\\"status\\":\\"in_progress\\",\\"title\\":\\"Read a.txt\\"}]"}},{"name":"read_file","args":{"Path":"\\"/Users/demo/code/notes/a.txt\\""}}]}',
  '{"step_index":5,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-24T19:16:01Z","content":"Created At: 2026-11-24T13:16:01-06:00\\nCompleted At: 2026-11-24T13:16:02-06:00\\nCreated At: 2026-11-24T13:16:01-06:00\\nCompleted At: 2026-11-24T13:16:02-06:00\\nOK"}',
  '{"step_index":6,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-24T19:16:02Z","content":"Created At: 2026-11-24T13:16:02-06:00\\nCompleted At: 2026-11-24T13:16:02-06:00\\nCreated At: 2026-11-24T13:16:02-06:00\\nCompleted At: 2026-11-24T13:16:02-06:00\\nShowing lines 1-1 of 1\\n1: hello"}',
  '{"step_index":7,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-24T19:16:02Z","model":"gemini-4-neon-high","input_tokens":2462,"cache_read_tokens":8345,"output_tokens":82,"tool_calls":[{"name":"update_steps","args":{"steps":"[{\\"status\\":\\"done\\",\\"title\\":\\"List workspace files\\"},{\\"status\\":\\"done\\",\\"title\\":\\"Read a.txt\\"}]"}}]}',
  '{"step_index":8,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-24T19:16:06Z","content":"Created At: 2026-11-24T13:16:06-06:00\\nCompleted At: 2026-11-24T13:16:06-06:00\\nCreated At: 2026-11-24T13:16:06-06:00\\nCompleted At: 2026-11-24T13:16:06-06:00\\nOK"}',
  '{"step_index":9,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-24T19:16:06Z","model":"gemini-4-neon-high","input_tokens":2212,"cache_read_tokens":8758,"output_tokens":10,"content":"done"}',
];

/** Where agy writes a conversation's transcript under a data folder (CLAUDE_VIS_AGY_DIR points the app at it in tests). */
export function agyTranscriptFile(dataDir: string, conversationId: string): string {
  return path.join(dataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

export function writeAgyTranscript(dataDir: string, conversationId: string, lines: string[]): string {
  const f = agyTranscriptFile(dataDir, conversationId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

/** The lead_sessions table of Kiln's harness.db (schema.ts v1 + migrations 003 and 005) and one Antigravity lead row. */
export const LEAD_SESSIONS_SQL = `CREATE TABLE lead_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (kind, native_session_id)
);
ALTER TABLE lead_sessions ADD COLUMN transcript_path TEXT;
ALTER TABLE lead_sessions ADD COLUMN status TEXT;
ALTER TABLE lead_sessions ADD COLUMN status_at INTEGER;
ALTER TABLE lead_sessions ADD COLUMN launch_id TEXT;`;
