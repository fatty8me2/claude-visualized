// Kiln events-file lines (kiln/events.py + kiln/runner.py) for tests: one delegated run, as Kiln's MCP server writes it.

export interface KilnRunSpec {
  id: string;
  task: string;
  cwd: string;
  /** unix seconds of task_started */
  start: number;
  pid?: number;
  model?: string;
  effort?: string;
  readonly?: boolean;
  /** [kiln tool, argument summary, ok] per step; each step takes 2 s (call) + 1 s (result) */
  steps?: [string, string, boolean][];
  /** text the model said after the steps */
  text?: string;
  /** omit to leave the run going */
  finish?: { ok: boolean; answer?: string; error?: string; files?: string[]; seconds?: number };
}

export function kilnRunLines(r: KilnRunSpec): string[] {
  const pid = r.pid ?? 4242;
  const base = { pid, task_id: r.id };
  const out: object[] = [];
  out.push({
    ts: r.start,
    kind: 'task_started',
    ...base,
    task: r.task,
    cwd: r.cwd,
    effort: r.effort ?? 'medium',
    readonly: !!r.readonly,
    profile: 'ollama',
    model: r.model ?? 'qwen3:30b',
    approval: r.readonly ? 'readonly' : 'auto',
  });
  let t = r.start;
  for (const [tool, arg, ok] of r.steps ?? []) {
    t += 2;
    out.push({ ts: t, kind: 'tool_call', ...base, tool, summary: `${tool} ${arg}`, args_preview: arg });
    t += 1;
    out.push({ ts: t, kind: 'tool_result', ...base, tool, ok, preview: ok ? 'fine' : 'Error: it broke' });
  }
  if (r.text) out.push({ ts: (t += 1), kind: 'model_text', ...base, text: r.text });
  if (r.finish) {
    const seconds = r.finish.seconds ?? t + 1 - r.start;
    out.push({
      ts: r.start + seconds,
      kind: 'task_finished',
      ...base,
      ok: r.finish.ok,
      answer: r.finish.answer ?? '',
      files_changed: r.finish.files ?? [],
      steps: (r.steps ?? []).length,
      prompt_tokens: 41000,
      completion_tokens: 3200,
      seconds,
      tokens_per_sec: 38.5,
      error: r.finish.error ?? null,
      model: r.model ?? 'qwen3:30b',
      diff_stat: r.finish.files?.length ? ` ${r.finish.files[0]} | 12 ++++++----\n 1 file changed` : null,
    });
  }
  return out.map((o) => JSON.stringify(o));
}

export const KILN_STATUS_LINE = (ts: number, reachable = true) =>
  JSON.stringify({ ts, kind: 'status_check', pid: 4243, profile: 'ollama', model: 'qwen3:30b', base_url: 'http://localhost:11434/v1', reachable, cwd: null, served_models: ['qwen3:30b'], detail: null });
