// Pure merge logic for adding/removing our http hooks in ~/.claude/settings.json.
// Everything we don't own (including unknown fields) is round-tripped untouched.

type Json = Record<string, any>;

export const MARKER = 'claude-visualized';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostModelSwitch',
  'SessionEnd',
] as const;

/** file name of our status-line forwarder; also how we recognize our statusLine entry */
export const STATUSLINE_FILE = 'claude-visualized-statusline.mjs';

export function isOurStatusLine(sl: unknown): boolean {
  return !!sl && typeof sl === 'object' && typeof (sl as Json).command === 'string' && (sl as Json).command.includes(STATUSLINE_FILE);
}

export type StatusLineState = 'ours' | 'other' | 'none';

export function statusLineState(settings: Json): StatusLineState {
  const sl = settings?.statusLine;
  if (!sl) return 'none';
  return isOurStatusLine(sl) ? 'ours' : 'other';
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hook?src=${MARKER}`;
}

export function isOurHook(h: unknown): boolean {
  return !!h && typeof h === 'object' && (h as Json).type === 'http' && typeof (h as Json).url === 'string' && (h as Json).url.includes(MARKER);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Remove our hooks; drop groups/events/hooks object only if we emptied them. */
export function uninstallHooks(settings: Json): Json {
  const out = clone(settings ?? {});
  if (isOurStatusLine(out.statusLine)) delete out.statusLine;
  const hooks = out.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept: Json[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const remaining = g.hooks.filter((h: unknown) => !isOurHook(h));
      if (remaining.length === g.hooks.length) kept.push(g);
      else if (remaining.length > 0) kept.push({ ...g, hooks: remaining });
    }
    if (kept.length > 0) hooks[ev] = kept;
    else if (groups.length > 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

/**
 * Adds our hooks, and our status line (the only source of live 5-hour / weekly usage) when
 * `statusLineCommand` is given and the user has no status line of their own.
 */
export function installHooks(settings: Json, port: number, statusLineCommand?: string): Json {
  const out = uninstallHooks(settings);
  if (statusLineCommand && !out.statusLine) out.statusLine = { type: 'command', command: statusLineCommand, padding: 0 };
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    groups.push({ hooks: [{ type: 'http', url: hookUrl(port), timeout: 2 }] });
    out.hooks[ev] = groups;
  }
  return out;
}

export type HookInstallState = 'installed' | 'partial' | 'none' | 'other-port';

export function hookStatus(settings: Json, port: number): HookInstallState {
  const hooks = settings?.hooks ?? {};
  let ours = 0;
  let right = 0;
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const found = groups.flatMap((g: Json) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter(isOurHook);
    if (found.length) ours++;
    if (found.some((h: Json) => h.url === hookUrl(port))) right++;
  }
  if (ours === 0) return 'none';
  if (right === HOOK_EVENTS.length) return 'installed';
  if (right === 0) return 'other-port';
  return 'partial';
}
