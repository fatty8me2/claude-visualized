// Short human-readable one-liners for tool calls and model names.

import { classifyModel } from './models';

type Json = Record<string, any>;

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function firstLine(s: string, max = 90): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function host(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 40) : '');
  } catch {
    return url.slice(0, 60);
  }
}

/** Display name for a tool, dropping the mcp__server__ prefix. */
export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] ?? '';
    const tool = parts.slice(2).join('__');
    const shortServer = server.length > 20 ? server.slice(0, 8) : server.replace(/^claude[-_]/i, '');
    return `${shortServer}:${tool}`;
  }
  return name;
}

export function summarizeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Json;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(s(i.description) || s(i.command));
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return basename(s(i.file_path) || s(i.notebook_path));
    case 'Grep':
      return firstLine(`/${s(i.pattern)}/` + (i.path ? ` in ${basename(s(i.path))}` : ''));
    case 'Glob':
      return s(i.pattern);
    case 'WebFetch':
      return host(s(i.url));
    case 'WebSearch':
      return firstLine(s(i.query));
    case 'Agent':
    case 'Task':
      return firstLine(`${s(i.subagent_type) || 'agent'}: ${s(i.description)}`);
    case 'TaskCreate':
      return firstLine(s(i.subject));
    case 'TaskUpdate':
      return `#${s(i.taskId)} → ${s(i.status) || 'update'}`;
    case 'TodoWrite':
      return `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
    case 'Skill':
      return s(i.skill);
    case 'ToolSearch':
      return firstLine(s(i.query));
    case 'SendMessage':
      return firstLine(`→ ${s(i.to)}: ${s(i.message)}`);
    case 'Workflow':
      return firstLine(s(i.name) || /name:\s*'([^']+)'/.exec(s(i.script))?.[1] || 'workflow');
    case 'AskUserQuestion':
      return firstLine(Array.isArray(i.questions) ? s(i.questions[0]?.question) : '');
    case 'ExitPlanMode':
      return 'plan ready for approval';
    case 'Monitor':
      return firstLine(s(i.description) || s(i.command));
  }
  for (const v of Object.values(i)) if (typeof v === 'string' && v.trim()) return firstLine(v);
  return '';
}

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'local' | 'other';

/** Visual family: the Claude families, 'local' for any local model, else 'other'. */
export function modelFamily(model: string | null | undefined): ModelFamily {
  const c = classifyModel(model);
  if (c.provider === 'local') return 'local';
  if (c.provider === 'anthropic' && (c.family === 'opus' || c.family === 'sonnet' || c.family === 'haiku' || c.family === 'fable')) return c.family;
  return 'other';
}

/** "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", "qwen2.5-coder:32b" -> "Qwen2.5 Coder 32B" */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return '—';
  return classifyModel(model).label;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + 'k';
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function modeLabel(mode: string): { short: 'PLAN' | 'BUILD'; detail: string } {
  if (mode === 'plan') return { short: 'PLAN', detail: 'plan mode' };
  const detail: Record<string, string> = {
    default: 'asks before edits',
    acceptEdits: 'accept edits',
    auto: 'auto mode',
    bypassPermissions: 'bypass permissions',
    dontAsk: "don't ask",
  };
  return { short: 'BUILD', detail: detail[mode] ?? mode };
}
