// Context-window sizing. Transcripts do not record the window size (no "[1m]" in model ids or
// requestedModel, no context keys), so it is inferred.

export const WINDOW_STD = 200_000;
export const WINDOW_1M = 1_000_000;

export interface ContextWindow {
  size: number;
  /** true when the size is a guess rather than read from the model string */
  estimated: boolean;
}

/**
 * 1M if the model string says so; otherwise 1M if the agent has ever been observed past the
 * standard window (it could not have fit otherwise); otherwise the standard 200k, as a guess.
 */
export function contextWindow(model: string | null | undefined, peakTokens = 0): ContextWindow {
  if (model && /\[1m\]|(?:^|[-_\s])1m(?:$|[-_\s\]])/i.test(model)) return { size: WINDOW_1M, estimated: false };
  if (peakTokens > WINDOW_STD) return { size: WINDOW_1M, estimated: true };
  return { size: WINDOW_STD, estimated: true };
}

export type ContextLevel = 'ok' | 'warn' | 'hot';

export interface ContextInfo {
  tokens: number;
  size: number;
  estimated: boolean;
  /** 0..1+ */
  fraction: number;
  pct: number;
  level: ContextLevel;
}

export function contextLevel(fraction: number): ContextLevel {
  return fraction >= 0.9 ? 'hot' : fraction >= 0.7 ? 'warn' : 'ok';
}

/** null when no usage has been seen for the agent yet. */
export function contextInfo(a: { model: string | null; contextTokens: number; contextPeak: number }): ContextInfo | null {
  if (!a.contextTokens) return null;
  const w = contextWindow(a.model, Math.max(a.contextPeak, a.contextTokens));
  const fraction = a.contextTokens / w.size;
  return { tokens: a.contextTokens, size: w.size, estimated: w.estimated, fraction, pct: Math.round(fraction * 100), level: contextLevel(fraction) };
}
