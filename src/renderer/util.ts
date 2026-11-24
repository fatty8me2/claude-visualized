import { modelFamily } from '@core/summarize';
import type { AgentNode } from '@core/state';
import { quietAfterMs } from '@core/work';

export type DisplayStatus = 'running' | 'quiet' | 'waiting' | 'idle' | 'done' | 'error';

/** "running" with no tool in flight and nothing written for a while is shown as quiet, not busy. */
export function displayStatus(a: AgentNode, now: number): DisplayStatus {
  if (a.status !== 'running') return a.status;
  if (a.currentTool) return 'running';
  return now - a.lastActivity > quietAfterMs(a.kind) ? 'quiet' : 'running';
}

/** the status word shown next to its icon (see StatusText in components/cardParts.tsx) */
export const STATUS_WORD: Record<DisplayStatus, string> = {
  running: 'running',
  quiet: 'quiet',
  waiting: 'needs you',
  idle: 'idle',
  done: 'done',
  error: 'failed',
};

/** Sessions the Claude desktop app cannot open: another tool wrote them (OpenCode, Google Antigravity). */
export function opensInClaude(entrypointOrSource: string | null | undefined): boolean {
  return entrypointOrSource !== 'opencode' && entrypointOrSource !== 'antigravity';
}

export function famClass(model: string | null | undefined): string {
  return `fam-${modelFamily(model)}`;
}

export function clock(ts: number): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function agentName(a: AgentNode | undefined): string {
  if (!a) return '?';
  if (a.kind === 'main') return 'main';
  if (a.agentType === 'kiln') return 'Kiln';
  if (a.agentType === 'kiln-worker') return 'Kiln worker';
  if (a.agentType === 'kiln-helper') return 'Kiln helper';
  return a.agentType || 'agent';
}
