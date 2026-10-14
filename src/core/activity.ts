// "What is it doing right now?" in plain English, from an agent's current state. Pure.

import { isTestCommand } from './goal';
import { formatDuration } from './summarize';

export interface ActivityAgent {
  kind: 'main' | 'agent' | 'workflow';
  status: 'running' | 'waiting' | 'idle' | 'done' | 'error';
  currentTool: { name: string; summary: string; since: number; input?: unknown } | null;
  lastText: string | null;
  lastTextAt?: number;
  lastActivity: number;
  endedAt?: number | null;
}

export interface ActivityContext {
  now: number;
  /** number of this agent's children that are still running */
  runningChildren?: number;
  /** workflow nodes: total children */
  totalChildren?: number;
}

export interface Activity {
  /** "reading api.ts" */
  phrase: string;
  /** when the current step began, null when there is no meaningful step */
  since: number | null;
  /** phrase + " · 12s" */
  line: string;
  kind: 'tool' | 'waiting-children' | 'reply' | 'thinking' | 'quiet' | 'finished' | 'idle' | 'blocked' | 'workflow';
}

const REPLY_WINDOW_MS = 6_000;
const QUIET_AFTER_MS = 120_000;

type Json = Record<string, any>;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function base(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname : '';
    return clip(u.host + path, 36);
  } catch {
    return clip(url, 36);
  }
}

export function firstLine(text: string | null | undefined, max = 90): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return clip(line.replace(/^[#>*\-\s]+/, ''), max);
}

function bashPhrase(i: Json, summary: string): string {
  const cmd = String(i.command ?? '').trim();
  const short = clip(cmd.split(/\s*(?:&&|;|\|)\s*/)[0] || cmd, 40);
  if (isTestCommand(cmd)) return `running the tests (${short})`;
  if (/^\s*git\b/.test(cmd)) return `running ${clip(cmd.split(/\s*(?:&&|;|\|)\s*/)[0], 40)}`;
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?(build|dev|start|compile)|\btsc\b|\bcargo build\b|\bgo build\b|\bmake\b|electron-vite|\bvite build\b/.test(cmd)) return `building (${short})`;
  if (/\b(npm|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|get|i)\b/.test(cmd)) return `installing dependencies (${short})`;
  if (/^\s*(rg|grep|find|fd|ls|dir|tree|Select-String|Get-ChildItem)\b/i.test(cmd)) return `searching the shell (${short})`;
  if (!cmd && summary) return `running ${clip(summary, 50)}`;
  const desc = typeof i.description === 'string' && i.description.trim() ? clip(i.description, 56) : '';
  return desc ? `running: ${desc}` : `running ${short}`;
}

/** The phrase for one in-flight tool call (no timing). */
export function toolPhrase(name: string, summary: string, input?: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Json;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
      return `reading ${base(s(i.file_path)) || summary || 'a file'}`;
    case 'Grep':
      return s(i.pattern) ? `searching for '${clip(s(i.pattern), 32)}'` : `searching ${summary}`;
    case 'Glob':
      return `finding files (${clip(s(i.pattern) || summary, 36)})`;
    case 'Edit':
    case 'MultiEdit':
      return `editing ${base(s(i.file_path)) || summary || 'a file'}`;
    case 'Write':
      return `writing ${base(s(i.file_path)) || summary || 'a file'}`;
    case 'NotebookEdit':
      return `editing ${base(s(i.notebook_path)) || summary || 'a notebook'}`;
    case 'Bash':
    case 'PowerShell':
      return bashPhrase(i, summary);
    case 'WebFetch':
      return `reading ${s(i.url) ? hostPath(s(i.url)) : summary || 'a web page'}`;
    case 'WebSearch':
      return `searching the web for '${clip(s(i.query) || summary, 40)}'`;
    case 'Agent':
    case 'Task': {
      const d = s(i.description) || summary.replace(/^[^:]*:\s*/, '');
      return d ? `starting a subagent: ${clip(d, 48)}` : 'starting a subagent';
    }
    case 'TaskCreate':
      return 'adding to the checklist';
    case 'TaskUpdate':
    case 'TodoWrite':
      return 'updating the checklist';
    case 'Skill':
      return `using the ${s(i.skill) || summary || 'a'} skill`;
    case 'ToolSearch':
      return 'looking up tools';
    case 'SendMessage':
      return `messaging ${s(i.to) || 'an agent'}`;
    case 'Workflow':
      return `starting a workflow${summary ? ': ' + clip(summary, 36) : ''}`;
    case 'AskUserQuestion':
      return 'asking you a question';
    case 'ExitPlanMode':
      return 'presenting the plan for approval';
    case 'Monitor':
      return `watching a background process${summary ? ' (' + clip(summary, 32) + ')' : ''}`;
    case 'TaskStop':
      return 'stopping a background task';
    case 'StructuredOutput':
      return 'writing its structured result';
    case 'SubagentHandback':
      return 'handing its report back';
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `calling ${parts.slice(2).join('__') || parts[1]} (${parts[1]})`;
  }
  return `using ${name}${summary ? ' · ' + clip(summary, 40) : ''}`;
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

export function describeActivity(a: ActivityAgent, ctx: ActivityContext): Activity {
  const { now } = ctx;
  const mk = (kind: Activity['kind'], phrase: string, since: number | null): Activity => ({
    kind,
    phrase,
    since,
    line: since != null && now - since >= 1000 ? `${phrase} · ${formatDuration(now - since)}` : phrase,
  });
  const kids = ctx.runningChildren ?? 0;

  if (a.kind === 'workflow') {
    const total = ctx.totalChildren ?? 0;
    if (a.status === 'done') return mk('finished', 'workflow finished', null);
    if (a.status === 'error') return mk('finished', 'workflow failed', null);
    return mk('workflow', total ? `${kids} of ${total} agents running` : 'starting up', null);
  }
  if (a.status === 'done' || a.status === 'error') {
    const msg = firstLine(a.lastText);
    const head = a.status === 'error' ? 'failed' : 'finished';
    return mk('finished', msg ? `${head}: ${msg}` : head, null);
  }
  if (a.status === 'waiting') return mk('blocked', 'waiting on you', a.endedAt ?? a.lastActivity);

  const t = a.currentTool;
  if (t) {
    if ((t.name === 'Agent' || t.name === 'Task') && kids > 0) return mk('waiting-children', `waiting on ${plural(kids, 'subagent')}`, t.since);
    return mk('tool', toolPhrase(t.name, t.summary, t.input), t.since);
  }
  if (kids > 0) return mk('waiting-children', `waiting on ${plural(kids, 'subagent')}`, null);
  if (a.status === 'idle') {
    const msg = firstLine(a.lastText);
    return mk('idle', msg ? `finished: ${msg}` : a.kind === 'main' ? 'waiting for your next prompt' : 'idle', null);
  }
  // running with nothing in flight
  if (a.lastTextAt && now - a.lastTextAt < REPLY_WINDOW_MS) return mk('reply', 'writing a reply', a.lastTextAt);
  if (now - a.lastActivity > QUIET_AFTER_MS) return mk('quiet', 'quiet', a.lastActivity);
  return mk('thinking', 'thinking…', a.lastActivity);
}
