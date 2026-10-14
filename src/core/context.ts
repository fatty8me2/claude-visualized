import { classifyModel } from './models';

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
const ONE_M = /\[1m\]|(?:^|[-_\s])1m(?:$|[-_\s\]])/i;

/** model family word from an id or alias, e.g. "claude-opus-5-5" or "opus[1m]" -> "opus" */
function family(m: string): string | null {
  return /(opus|sonnet|haiku|fable)/i.exec(m)?.[1]?.toLowerCase() ?? null;
}

/**
 * `settingsModel` is the user's Claude Code default (settings.json "model", e.g. "opus[1m]");
 * when it asks for the 1M window, agents of that model family run with it.
 */
export function contextWindow(model: string | null | undefined, peakTokens = 0, settingsModel?: string | null): ContextWindow {
  if (model && ONE_M.test(model)) return { size: WINDOW_1M, estimated: false };
  if (model && settingsModel && ONE_M.test(settingsModel) && family(model) !== null && family(model) === family(settingsModel)) {
    return { size: WINDOW_1M, estimated: false };
  }
  if (peakTokens > WINDOW_STD) return { size: WINDOW_1M, estimated: true };
  return { size: WINDOW_STD, estimated: true };
}

export type ContextLevel = 'ok' | 'warn' | 'hot';

export interface ContextInfo {
  tokens: number;
  /** 0 when the window is unknown (a non-Claude model no running server has reported on) */
  size: number;
  estimated: boolean;
  /** false: show the token count only, no percentage */
  windowKnown: boolean;
  /** 0..1+ (0 when unknown) */
  fraction: number;
  pct: number;
  level: ContextLevel;
}

export function contextLevel(fraction: number): ContextLevel {
  return fraction >= 0.9 ? 'hot' : fraction >= 0.7 ? 'warn' : 'ok';
}

/** A context length a running local server reported for a model. */
export interface LocalWindow {
  size: number;
  /** true when it is the model's maximum rather than the loaded (runtime) context */
  estimated: boolean;
}

/**
 * null when no usage has been seen for the agent yet. Claude models use the inferred 200k/1M window;
 * local and other non-Claude models only get a percentage when `localWindow` (reported by a running
 * server) is given, otherwise just the token count.
 */
export function contextInfo(
  a: { model: string | null; contextTokens: number; contextPeak: number },
  settingsModel?: string | null,
  localWindow?: LocalWindow | null,
): ContextInfo | null {
  if (!a.contextTokens) return null;
  if (a.model && classifyModel(a.model).provider !== 'anthropic') {
    if (!localWindow || !localWindow.size) {
      return { tokens: a.contextTokens, size: 0, estimated: false, windowKnown: false, fraction: 0, pct: 0, level: 'ok' };
    }
    const fraction = a.contextTokens / localWindow.size;
    return { tokens: a.contextTokens, size: localWindow.size, estimated: localWindow.estimated, windowKnown: true, fraction, pct: Math.round(fraction * 100), level: contextLevel(fraction) };
  }
  const w = contextWindow(a.model, Math.max(a.contextPeak, a.contextTokens), settingsModel);
  const fraction = a.contextTokens / w.size;
  return { tokens: a.contextTokens, size: w.size, estimated: w.estimated, windowKnown: true, fraction, pct: Math.round(fraction * 100), level: contextLevel(fraction) };
}
