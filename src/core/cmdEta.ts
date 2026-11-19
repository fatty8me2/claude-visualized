// When the shell command an agent is running right now should finish: a test suite, a build, `gh run watch`, a release.
//
// Every past Bash / PowerShell call is indexed with how long it took (src/main/historyDb.ts, table cmd_runs) under a
// normalized key: the program and its subcommand, without paths, quotes and most flags ("npm run test:e2e",
// "npx vitest run --config vitest.e2e.config.ts …", "gh run watch"). A running call is compared with past calls of the
// same key, in the same project when there are enough of them: how much longer those that outlasted this one's elapsed
// time went on (the same conditional reasoning as eta.ts). A call's own `timeout` caps the guess (it ends, or moves to
// the background, by then). Commands that usually take a few seconds get no countdown at all; one that has outlasted
// nearly every past run is "running long".
// Pure: a function of (input, now, priors).

import { quantile, remainingAfter } from './eta';
import { commandWords } from './ship';
import { isKilnDelegate, kilnEtaKey } from './kiln';

// ---------- the key ----------

/** shell tools whose calls are timed */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** the live state keeps the first 300 characters of a command (normalize.ts compactInput); the index keys the same prefix */
export const KEY_SOURCE_CAP = 300;
const KEY_MAX = 140;
const MAX_PARTS = 3;

/** programs that only move around, filter or print: never what a command is waiting on */
const TRIVIAL = new Set(
  (
    'cd pushd popd echo printf export set unset source . true false : exit return sleep tail head grep egrep rg sort uniq wc cat tee ls dir pwd ' +
    'sed awk cut tr xargs jq yq less more column basename dirname realpath readlink which where type command test [ [[ date clear cls mkdir rm rmdir ' +
    'cp mv touch chmod ln find stat file diff cmp nl rev fold od xxd base64 sha256sum md5sum shasum env printenv whoami hostname id kill ' +
    'get-content get-childitem get-item get-itemproperty get-location get-date get-command get-process get-help select-object select-string ' +
    'where-object foreach-object sort-object group-object measure-object format-table format-list format-wide out-string out-null out-file ' +
    'out-host write-output write-host write-error set-location push-location pop-location test-path new-item remove-item copy-item move-item ' +
    'rename-item set-content add-content clear-content convertto-json convertfrom-json join-path split-path resolve-path start-sleep stop-process ' +
    'get-filehash compare-object tee-object get-member set-variable get-variable ' +
    // shell syntax: a loop header or the end of a block runs nothing itself
    'for case esac done fi break continue function local declare read wait'
  ).split(' '),
);
/** prefixes that run the rest of the line */
const WRAPPERS = new Set(['sudo', 'time', 'nice', 'nohup', 'exec', 'call', 'builtin', 'stdbuf', 'unbuffer', 'caffeinate', 'winpty', 'cmd', 'cmd.exe']);
/** shell keywords before a command (`if npm test`, `until grep -q ...`, `do npm run build`) */
const KEYWORDS = new Set(['if', 'elif', 'then', 'else', 'while', 'until', 'do', '{', '}']);
/** flags whose next word is their value, not a subcommand */
const VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--prefix',
  '--cwd',
  '--dir',
  '-w',
  '--workspace',
  '--filter',
  '-F',
  '-R',
  '--repo',
  '--git-dir',
  '--work-tree',
  '--manifest-path',
  '-f',
  '--file',
  '-n',
  '--namespace',
  '--context',
  '--project-directory',
  '-t',
  '--tag',
  '-o',
  '--output',
  '-e',
  '-m',
  '--message',
  '--timeout',
  '-p',
  '--project',
]);
/** how many subcommand words are part of the key (default 1) */
const SUBS: Record<string, number> = {
  gh: 2,
  docker: 2,
  podman: 2,
  kubectl: 2,
  helm: 2,
  az: 2,
  gcloud: 2,
  aws: 2,
  pytest: 0,
  jest: 0,
  mocha: 0,
  tsc: 0,
  eslint: 0,
  prettier: 0,
  tox: 0,
  rspec: 0,
  phpunit: 0,
  sleep: 0,
};
/** tools whose --config file decides the workload (unit vs end-to-end tests) */
const CONFIG_TOOLS = new Set(['vitest', 'jest', 'playwright', 'mocha', 'cypress', 'karma', 'webpack', 'vite', 'rollup', 'electron-vite']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_ALIAS: Record<string, string> = {
  i: 'install',
  isntall: 'install',
  add: 'install',
  t: 'test',
  tst: 'test',
  'run-script': 'run',
  rum: 'run',
  urn: 'run',
  c: 'config',
};
/** `npx tool`, `pnpm exec tool`, `python -m tool`: the tool is what runs */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const RUNNER_SUBS: Record<string, Set<string>> = {
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['dlx', 'exec']),
  npm: new Set(['exec']),
  uv: new Set(['run']),
  poetry: new Set(['run']),
  pipenv: new Set(['run']),
  bundle: new Set(['exec']),
};
const SCRIPT_HOSTS = new Set(['python', 'node', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'deno', 'tsx', 'ts-node', 'pwsh', 'powershell']);

const isFlag = (t: string) => t.startsWith('-') && t.length > 1;
const isWord = (t: string) => /^[A-Za-z][\w:@+-]*$/.test(t);
const isPathy = (t: string) => t === '.' || t === '..' || /[\\/]/.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t);
const isRedirect = (t: string) => /^\d*(>>?|<|&>)/.test(t);
const baseName = (t: string) =>
  t
    .replace(/^['"]+|['"]+$/g, '')
    .split(/[\\/]/)
    .pop() ?? t;

/** quoted strings (also over several lines) and here-docs say what a command is about, not what it runs */
function bareWords(cmd: string): string {
  // the cut may end mid-word ("gr" of "grep"): drop that word
  let s = commandWords(cmd.length > KEY_SOURCE_CAP ? cmd.slice(0, KEY_SOURCE_CAP).replace(/\S*$/, '') : cmd);
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
  // a here-doc or quote the 300-character cut left open: drop the rest
  s = s.replace(/<<-?[\s\S]*$/, ' ');
  // a quote left open: everything after it (paired quotes are "" or '' by now)
  const open = s.search(/(?:^|[^"'])["'](?!["'])/);
  return open === -1 ? s : s.slice(0, open + 1);
}

function progName(tok: string): string {
  let p = baseName(tok).toLowerCase();
  p = p.replace(/\.(exe|cmd|bat|com)$/, '');
  if (/^python\d*(\.\d+)?$/.test(p) || p === 'py') p = 'python';
  return p;
}

/** The key of one pipeline segment, or null when it is trivial (cd, echo, tail, an assignment). */
function segmentKey(seg: string): string | null {
  let toks = seg
    .trim()
    .replace(/^[({\s]+/, '')
    .replace(/[)}\s]+$/, '')
    .split(/\s+/)
    .filter(Boolean);
  // drop redirections (and their targets)
  const kept: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isRedirect(t)) {
      if (/^\d*(>>?|<|&>)$/.test(t)) i++;
      continue;
    }
    kept.push(t);
  }
  toks = kept;
  // leading assignments, the call operator and wrappers
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === '&' || t === '!' || t === '--') continue;
    const p = t.toLowerCase();
    if (p === 'env' && /=/.test(toks[i + 1] ?? '')) continue;
    if (WRAPPERS.has(p) || KEYWORDS.has(p) || p === '/c' || p === '/s') continue;
    if (p === 'timeout' && /^\d+[smh]?$/.test(toks[i + 1] ?? '')) {
      i++;
      continue;
    }
    break;
  }
  if (i >= toks.length) return null;
  const first = toks[i];
  if (first.startsWith('$') || first === '""' || first === "''" || first.startsWith('#')) return null;
  let prog = progName(first);
  if (prog.length < 2 || !/^[a-z0-9_.@+-]+$/i.test(prog) || TRIVIAL.has(prog)) return null;
  let rest = toks.slice(i + 1);
  let prefix = '';

  // a runner: key the tool it runs
  const runnerTool = (from: string[]): { tool: string; rest: string[] } | null => {
    let j = 0;
    while (j < from.length && isFlag(from[j])) j += VALUE_FLAGS.has(from[j]) || from[j] === '-p' || from[j] === '--package' ? 2 : 1;
    if (j >= from.length) return null;
    const tool = progName(from[j].replace(/(.)@[^/]*$/, '$1'));
    return tool ? { tool, rest: from.slice(j + 1) } : null;
  };
  if (RUNNERS.has(prog)) {
    const r = runnerTool(rest);
    if (!r) return prog;
    prefix = `${prog} `;
    prog = r.tool;
    rest = r.rest;
  } else if (RUNNER_SUBS[prog]?.has(rest.find((t) => !isFlag(t)) ?? '')) {
    const k = rest.findIndex((t) => !isFlag(t));
    const r = runnerTool(rest.slice(k + 1));
    if (r) {
      prefix = `${prog} ${rest[k]} `;
      prog = r.tool;
      rest = r.rest;
    }
  } else if (prog === 'python' && rest[0] === '-m' && rest[1]) {
    prefix = 'python -m ';
    prog = progName(rest[1]);
    rest = rest.slice(2);
  }

  const parts: string[] = [prefix + prog];
  let config = '';
  let targeted = false;
  const positional: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t === '""' || t === "''") continue;
    if (t === '--') continue;
    if (isFlag(t)) {
      const eq = t.indexOf('=');
      const name = eq > 0 ? t.slice(0, eq) : t;
      const isConfig = name === '--config' || (name === '-c' && CONFIG_TOOLS.has(prog));
      const val = eq > 0 ? t.slice(eq + 1) : VALUE_FLAGS.has(name) || isConfig ? rest[++j] : undefined;
      if (isConfig && val && CONFIG_TOOLS.has(prog)) config = baseName(val);
      continue;
    }
    positional.push(t);
  }

  if (PACKAGE_MANAGERS.has(prog) && !prefix) {
    let sub = positional[0];
    if (sub) sub = NPM_ALIAS[sub] ?? sub;
    if (sub === 'run' || (prog === 'bun' && sub === 'run')) {
      const script = positional[1];
      if (script && isWord(script)) parts.push('run', script);
      else parts.push('run');
      targeted = positional.slice(2).some(isPathy);
    } else if (sub && isWord(sub)) {
      parts.push(sub);
      targeted = positional.slice(1).some(isPathy);
    }
  } else if (SCRIPT_HOSTS.has(prog) && !prefix) {
    // `node build.js`, `powershell -File x.ps1`; an inline script (`bash -c "..."`, quotes already gone) says nothing
    const k = rest.findIndex((t) => /^-file$/i.test(t));
    const script = k >= 0 ? rest[k + 1] : rest.find((t) => !isFlag(t) && isPathy(t) && t !== '""' && t !== "''");
    if (!script || !isPathy(script)) return null;
    parts.push(baseName(script));
  } else {
    const n = SUBS[prog] ?? 1;
    let k = 0;
    while (k < n && k < positional.length && isWord(positional[k])) parts.push(positional[k++]);
    targeted = positional.slice(k).some(isPathy);
  }
  if (config) parts.push('--config', config);
  return parts.join(' ') + (targeted ? ' …' : '');
}

const keyCache = new Map<string, string | null>();

/**
 * The normalized key of a shell command, or null when it runs nothing worth timing. Segments joined by && ; | and new
 * lines are keyed one by one and the non-trivial ones (up to three) joined: "npx electron-vite build && npx vitest run".
 * Cached: the cards ask on every clock tick.
 */
export function commandKey(command: string): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  const hit = keyCache.get(command);
  if (hit !== undefined) return hit;
  const keys: string[] = [];
  for (const seg of bareWords(command).split(/&&|\|\||;|\r?\n|\|/)) {
    const k = segmentKey(seg);
    if (!k || keys[keys.length - 1] === k) continue;
    keys.push(k);
    if (keys.length >= MAX_PARTS) break;
  }
  let key: string | null = keys.length ? keys.join(' && ') : null;
  if (key && key.length > KEY_MAX) key = key.slice(0, KEY_MAX - 1) + '…';
  if (keyCache.size >= 3000) keyCache.clear();
  keyCache.set(command, key);
  return key;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

export interface ShellCall {
  key: string;
  /** the call's own timeout in ms, when it set one */
  timeoutMs: number | null;
}

/** A timed shell call: its key and timeout. Null for other tools, background calls (they return at once) and trivial commands. */
export function shellCall(name: string, input: unknown): ShellCall | null {
  // a hand-off to Kiln's local model is timed like a command, from past runs at the same effort (main/kiln.ts adds them)
  if (isKilnDelegate(name)) {
    const k = obj(input);
    return { key: kilnEtaKey(typeof k.effort === 'string' ? k.effort : null, k.readonly === true), timeoutMs: null };
  }
  if (!SHELL_TOOLS.has(name)) return null;
  const i = obj(input);
  if (i.run_in_background === true) return null;
  const key = typeof i.command === 'string' ? commandKey(i.command) : null;
  if (!key) return null;
  const t = Number(i.timeout);
  return { key, timeoutMs: Number.isFinite(t) && t > 0 ? t : null };
}

/** The project a session belongs to, from its working folder (as the history index names it). */
export function cwdProject(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

// ---------- priors ----------

export interface CmdPriors {
  /** when they were computed; 0 = none yet */
  at: number;
  /** past durations (ms, ascending) by key, every project */
  all: Record<string, number[]>;
  /** the same per project */
  byProject: Record<string, Record<string, number[]>>;
}

export const NO_CMD_PRIORS: CmdPriors = { at: 0, all: {}, byProject: {} };

/** a key needs this many past runs to be used (per project, else overall) */
export const CMD_MIN_RUNS = 5;
/** newest runs kept per key */
const CMD_CAP = 80;
const CMD_MIN_MS = 200;
export const CMD_MAX_MS = 3 * 3_600_000;
/** keys whose runs nearly all take less than this are left out: nothing to count down */
const CMD_INSTANT_MS = 4_000;

export interface CmdRun {
  key: string;
  project: string;
  ms: number;
}

const asc = (a: number, b: number) => a - b;

/** Group past runs (newest first: each group keeps its newest runs). */
export function buildCmdPriors(runs: readonly CmdRun[], at: number): CmdPriors {
  const all = new Map<string, number[]>();
  const proj = new Map<string, Map<string, number[]>>();
  const add = (m: Map<string, number[]>, k: string, ms: number) => {
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    if (l.length < CMD_CAP) l.push(ms);
  };
  for (const r of runs) {
    if (!r.key || !(r.ms >= CMD_MIN_MS && r.ms <= CMD_MAX_MS)) continue;
    const ms = Math.round(r.ms);
    add(all, r.key, ms);
    if (r.project) {
      let m = proj.get(r.project);
      if (!m) proj.set(r.project, (m = new Map()));
      add(m, r.key, ms);
    }
  }
  const keep = (m: Map<string, number[]>): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    for (const [k, l] of m) {
      if (l.length < CMD_MIN_RUNS) continue;
      l.sort(asc);
      if (quantile(l, 0.9) < CMD_INSTANT_MS) continue;
      out[k] = l;
    }
    return out;
  };
  const byProject: Record<string, Record<string, number[]>> = {};
  for (const [p, m] of proj) {
    const g = keep(m);
    if (Object.keys(g).length) byProject[p] = g;
  }
  return { at, all: keep(all), byProject };
}

// ---------- one running call ----------

/** commands that usually finish within this get no countdown */
export const QUICK_MS = 12_000;
/** a quick command that has run this long is worth a "running long" */
const QUICK_SHOW_MS = 15_000;

export interface CmdEtaInput {
  name: string;
  input: unknown;
  /** when the call started */
  since: number;
  project?: string | null;
}

export interface CmdEta {
  key: string;
  since: number;
  elapsed: number;
  /** expected end (epoch ms) and a plausible range */
  at: number;
  low: number;
  high: number;
  remaining: number;
  /** time-based share done, for a bar */
  fraction: number;
  /** outlasted nearly every past run: the end is a guess */
  overdue: boolean;
  /** past runs compared with, and whether they are this project's */
  runs: number;
  scope: 'project' | 'all';
  /** middle half of the past runs (25th to 75th percentile), and their median, ms */
  typical: [number, number];
  median: number;
  /** the call's own timeout: it ends (or moves to the background) by then; null when it set none */
  timeoutAt: number | null;
}

/** past runs of a key: this project's when it has enough, else every project's */
export function cmdSamples(key: string, project: string | null | undefined, priors: CmdPriors): { dur: number[]; scope: 'project' | 'all' } | null {
  const p = project ? priors.byProject[project]?.[key] : undefined;
  if (p && p.length >= CMD_MIN_RUNS) return { dur: p, scope: 'project' };
  const a = priors.all[key];
  return a && a.length >= CMD_MIN_RUNS ? { dur: a, scope: 'all' } : null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Expected end of a running shell call, or null: not a timed shell call, nothing like it in the history, or a command
 * that usually takes seconds and has not overrun.
 */
export function cmdEta(c: CmdEtaInput, now: number, priors: CmdPriors): CmdEta | null {
  const call = shellCall(c.name, c.input);
  if (!call || !(c.since > 0)) return null;
  const s = cmdSamples(call.key, c.project, priors);
  if (!s) return null;
  const elapsed = Math.max(0, now - c.since);
  const { dur } = s;
  const typical: [number, number] = [quantile(dur, 0.25), quantile(dur, 0.75)];
  const median = quantile(dur, 0.5);
  const r = remainingAfter(dur, elapsed, [0.25, 0.5, 0.75], 2);
  const overdue = !r || r.left / dur.length < 0.05;
  if (typical[1] < QUICK_MS && !(overdue && elapsed >= QUICK_SHOW_MS)) return null;
  let remaining: number;
  let low: number;
  let high: number;
  if (!r || overdue) {
    // longer than (nearly) every past run: probably close, but that is a guess
    remaining = Math.max(20_000, elapsed * 0.25);
    low = Math.min(remaining, 10_000);
    high = Math.max(remaining * 2, elapsed * 0.6);
  } else {
    remaining = Math.max(r.q[1], 1000);
    low = Math.min(remaining, Math.max(0, r.q[0]));
    high = Math.max(remaining, r.q[2]);
  }
  const timeoutAt = call.timeoutMs ? c.since + call.timeoutMs : null;
  if (timeoutAt !== null && timeoutAt > now) {
    const cap = timeoutAt - now;
    remaining = Math.min(remaining, cap);
    high = Math.min(high, cap);
    low = Math.min(low, remaining);
  }
  return {
    key: call.key,
    since: c.since,
    elapsed,
    at: now + remaining,
    low: now + low,
    high: now + high,
    remaining,
    fraction: overdue ? 0.97 : clamp(elapsed / (elapsed + remaining), 0.02, 0.97),
    overdue,
    runs: dur.length,
    scope: s.scope,
    typical,
    median,
    timeoutAt: timeoutAt !== null && timeoutAt > now ? timeoutAt : null,
  };
}

/** What a finished call's result line says about its duration, from the transcript. */
export interface CmdResultInfo {
  /** the call failed (non-zero exit) */
  error: boolean;
  /** not a run to learn from: interrupted, moved to the background, or held for the user's permission */
  skip: boolean;
}

/** Read a tool_result line's fields that decide whether its duration counts (see historyIndex / extractDelta). */
export function cmdResultInfo(line: Obj, block: Obj): CmdResultInfo {
  const r = obj(line.toolUseResult);
  const perm = obj(line.permissionDecision);
  const src = typeof perm.source === 'string' ? perm.source : '';
  const text = typeof block.content === 'string' ? block.content : '';
  const skip =
    r.interrupted === true ||
    typeof r.backgroundTaskId === 'string' ||
    r.timedOutAfterMs != null ||
    src.startsWith('user') ||
    /^\[Request interrupted|doesn't want to proceed|was rejected/i.test(text);
  return { error: block.is_error === true, skip };
}
