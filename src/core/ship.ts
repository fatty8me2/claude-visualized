// What a tool call does toward shipping, and task-list changes from the Claude desktop app's own task-list tool.
// Pure. normalize.ts calls these with the whole tool input, before it is clipped for the state.
//
// Shipping kinds (see ShipKind): a git commit (also `npm version`, which commits and tags), a git push, opening a pull
// request, a release that is not public yet (a release build/upload such as `npm run release`, electron-builder
// --publish, a draft GitHub release) and publishing one (`gh release edit --draft=false`, a non-draft `gh release
// create`, `npm publish` and the like): the moment update checks and installs can see it.

import type { ShipKind, TodoInput, TodoOp } from './events';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** heredoc / here-string bodies and quoted strings say what a command is about (a commit message), not what it runs */
function commandWords(cmd: string): string {
  return cmd
    .replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$|\))/g, ' ')
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'[^'\n]*'/g, "''");
}

/** `git`, optionally with -C <dir> / -c key=value / --git-dir / --work-tree before the subcommand */
const GIT = String.raw`\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:\s+|=)\S+)*\s+`;

const PATTERNS: [ShipKind, RegExp][] = [
  ['commit', new RegExp(GIT + String.raw`commit\b`)],
  [
    'commit',
    /\b(?:npm|pnpm|yarn)\s+version\s+(?:major|minor|patch|premajor|preminor|prepatch|prerelease|from-git|v?\d+\.\d+\.\d+\S*)(?![^\n]*--no-git-tag-version)/,
  ],
  ['push', new RegExp(GIT + String.raw`push\b(?![^\n]*(?:--dry-run|\s-n\b))`)],
  ['pr', /\bgh\s+pr\s+create\b/],
  ['release', /\belectron-builder\b[^\n]*--publish(?:\s+|=)(?:always|onTag|onTagOrDraft)\b/],
  ['release', /\b(?:npm|pnpm)\s+run\s+release(?::[\w-]+)?(?=\s|$)/],
  ['release', /\byarn\s+(?:run\s+)?release(?::[\w-]+)?(?=\s|$)/],
  ['release', /\bgh\s+release\s+create\b[^\n]*--draft\b(?!\s*=\s*false)/],
  ['release', /\bgh\s+release\s+upload\b/],
  ['publish', /\bgh\s+release\s+edit\b[^\n]*--draft(?:\s*=\s*|\s+)false\b/],
  ['publish', /\bgh\s+release\s+create\b(?![^\n]*--draft\b(?!\s*=\s*false))/],
  ['publish', /\b(?:npm|pnpm|yarn)\s+publish\b(?![^\n]*--dry-run)/],
  ['publish', /\b(?:cargo|poetry|vsce|ovsx)\s+publish\b(?![^\n]*--dry-run)/],
  ['publish', /\btwine\s+upload\b/],
  ['publish', /\bgoreleaser\s+release\b(?![^\n]*--snapshot)/],
];

const ORDER: ShipKind[] = ['commit', 'push', 'pr', 'release', 'publish'];

/** Shipping steps one shell command performs, in pipeline order (commit before push before release). Empty when none. */
export function shipKinds(command: string): ShipKind[] {
  if (!command || !/\b(git|gh|npm|pnpm|yarn|electron-builder|cargo|poetry|vsce|ovsx|twine|goreleaser)\b/.test(command)) return [];
  const words = commandWords(command);
  const found = new Set<ShipKind>();
  // one pipeline segment at a time, so a flag in one command never counts for another
  for (const seg of words.split(/&&|\|\||;|\r?\n|\|/)) {
    for (const [kind, re] of PATTERNS) if (re.test(seg)) found.add(kind);
  }
  return ORDER.filter((k) => found.has(k));
}

/** Shipping steps of a tool call: only shell calls ship anything. */
export function toolShipKinds(name: string, input: unknown): ShipKind[] {
  if (!SHELL_TOOLS.has(name)) return [];
  const cmd = obj(input).command;
  return typeof cmd === 'string' ? shipKinds(cmd) : [];
}

// ---------- the Claude desktop app's task list ----------

/** The Code tab's task list ("update_plan") and its turn wrap-up, which checks the list off. */
const DESKTOP_PLAN = 'mcp__ccd_turn__update_plan';
const DESKTOP_WRAP = 'mcp__ccd_turn__wrap_up';

function positions(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : typeof v === 'number' ? [v] : [];
  return arr.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 200);
}

/** The task-list change a desktop-app tool call makes, or null. */
export function desktopTodoOp(name: string, input: unknown): TodoOp | null {
  if (name === DESKTOP_WRAP) return { finish: true };
  if (name !== DESKTOP_PLAN) return null;
  const i = obj(input);
  if (Array.isArray(i.items)) {
    const replace: TodoInput[] = (i.items as unknown[])
      .slice(0, 50)
      .map(obj)
      .map((t, n) => ({
        id: `p${n + 1}`,
        text: typeof t.content === 'string' ? t.content.slice(0, 200) : '',
        status: typeof t.status === 'string' ? t.status : 'pending',
      }))
      .filter((t) => t.text.trim());
    return { replace };
  }
  const op: TodoOp = {};
  if (i.advance === true) op.advance = true;
  const done = positions(i.done);
  if (done.length) op.done = done;
  const start = positions(i.start)[0];
  if (start) op.start = start;
  return op.advance || op.done || op.start ? op : null;
}
