// SSH remotes (docs/SSH-REMOTES.md): computers watched without the app installed on them. This computer logs in over SSH with the
// user's own key, lists the other computer's Claude Code transcripts and copies what is new into a local mirror folder, which the
// normal session pipeline then follows. Read-only: the only remote commands are the listing and byte-range reads below.
// Pure: no Electron, no Node APIs.

export interface SshHostConfig {
  /** stable id, used as the device id of its sessions (remote:<id>:<sessionId>) */
  id: string;
  /** what is handed to ssh: user@host, or a host / alias from the user's ssh config */
  target: string;
  port?: number;
  /** name shown in the app; the other computer's hostname when empty */
  label?: string;
  /** the other computer's own hostname, learned on the first connection */
  hostname?: string;
  /** what runs on the other side: 'sh' (macOS, Linux; tried first) or 'powershell' (Windows), learned on the first connection */
  shell?: RemoteShell;
}

export type RemoteShell = 'sh' | 'powershell';

export type SshHostState = 'connecting' | 'syncing' | 'online' | 'offline';

/** One SSH remote, pushed on the 'ssh' channel. */
export interface SshHostView {
  id: string;
  target: string;
  port: number | null;
  name: string;
  state: SshHostState;
  error: string | null;
  offlineSince: number | null;
  /** bytes still to copy (only while syncing) */
  pendingBytes: number;
  sessions: number;
}

export interface SshAddResult {
  ok: boolean;
  error?: string;
}

const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Accepts user@host or a bare host/alias. Anything that could be read as an ssh option or carry shell syntax is refused. */
export function parseSshTarget(input: string, port?: number | null): { ok: true; target: string; port?: number } | { ok: false; error: string } {
  const target = input.trim();
  if (!target) return { ok: false, error: 'Enter the other computer as user@host.' };
  if (target.length > 255 || !TARGET_RE.test(target)) return { ok: false, error: 'Use the form user@host (letters, digits, dots and dashes).' };
  if (port === undefined || port === null || port === 22) return { ok: true, target };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'The port must be between 1 and 65535.' };
  return { ok: true, target, port };
}

export function sshArgs(h: Pick<SshHostConfig, 'target' | 'port'>, shell: RemoteShell = 'sh'): string[] {
  return [
    '-T',
    // never prompt: a password or an unknown host key fails with a message instead of hanging
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...(h.port ? ['-p', String(h.port)] : []),
    h.target,
    ...(shell === 'powershell' ? ['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'] : ['sh']),
  ];
}

export const FULL_DAYS = 14;
export const QUICK_MINUTES = 3;

/**
 * Sent to the remote `sh` on stdin. Defines the two read-only requests and reports ready.
 *  cv_list <find test> <value>  -> "<mtime s> <size> ./<path>" per transcript file, then "CVEND <remote epoch s>"
 *  cv_read <path> <offset> <max> -> "CVD <n> <size>" followed by exactly n bytes; n is -1 for a missing file, -2 for one that shrank
 *  cv_kread <0|1> <offset> <max> -> the same for Kiln's events file (1: its rotation, events.jsonl.1), found the way Kiln finds it
 * Works with GNU and BSD (macOS) tools.
 */
export const REMOTE_SCRIPT =
  [
    'cv_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"',
    "if stat -c %Y / >/dev/null 2>&1; then cv_sf=-c; cv_fm='%Y %s %n'; else cv_sf=-f; cv_fm='%m %z %N'; fi",
    'cv_list() {',
    '  if [ -d "$cv_root" ]; then',
    '    ( cd "$cv_root" && find . -type f \\( -name \'*.jsonl\' -o -name \'*.json\' \\) "$1" "$2" -exec stat "$cv_sf" "$cv_fm" {} + ) 2>/dev/null',
    '  fi',
    '  echo "CVEND $(date +%s)"',
    '}',
    // Kiln's events file (kiln/events.py events_path): KILN_EVENTS_PATH, else $XDG_CONFIG_HOME/kiln, else ~/.config/kiln
    'cv_kf="${KILN_EVENTS_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/kiln/events.jsonl}"',
    'case "$cv_kf" in "~/"*) cv_kf="$HOME/${cv_kf#??}";; esac',
    'cv_read() { cv_rd "$cv_root/$1" "$2" "$3"; }',
    'cv_kread() { if [ "$1" = 1 ]; then cv_rd "$cv_kf.1" "$2" "$3"; else cv_rd "$cv_kf" "$2" "$3"; fi; }',
    'cv_rd() {',
    '  cv_s=$(wc -c < "$1" 2>/dev/null) || cv_s=',
    '  cv_s=$(echo $cv_s)',
    '  case "$cv_s" in',
    "    ''|*[!0-9]*) echo 'CVD -1 0'; return;;",
    '  esac',
    '  cv_n=$((cv_s - $2))',
    '  if [ "$cv_n" -lt 0 ]; then echo "CVD -2 $cv_s"; return; fi',
    '  if [ "$cv_n" -gt "$3" ]; then cv_n=$3; fi',
    '  echo "CVD $cv_n $cv_s"',
    // padded with zero bytes so exactly n bytes always follow, even if the file shrinks between the two commands
    '  if [ "$cv_n" -gt 0 ]; then { tail -c "+$(($2 + 1))" "$1" 2>/dev/null; head -c "$cv_n" /dev/zero; } | head -c "$cv_n"; fi',
    '}',
    'echo "CVREADY $(hostname 2>/dev/null || uname -n)"',
  ].join('\n') + '\n';

/**
 * The same two requests for a Windows remote, sent to `powershell -Command -` on stdin (Windows PowerShell 5.1 or newer).
 * Every statement is one line: in this mode PowerShell runs a line as soon as it is complete. Output goes through the raw stdout
 * stream, so file bytes arrive untouched.
 *  cv_list <minutes>              -> as above, for files changed in the last <minutes>
 *  cv_read <path> <offset> <max>  -> as above
 *  cv_kread <0|1> <offset> <max>  -> as above
 */
export const REMOTE_SCRIPT_PS =
  [
    "$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'",
    '$cv_o = [Console]::OpenStandardOutput()',
    "$cv_root = if ($env:CLAUDE_CONFIG_DIR) { Join-Path $env:CLAUDE_CONFIG_DIR 'projects' } else { Join-Path $env:USERPROFILE '.claude\\projects' }",
    '$cv_epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)',
    'function cv_w([string]$s) { $b = [Text.Encoding]::UTF8.GetBytes($s + "`n"); $cv_o.Write($b, 0, $b.Length); $cv_o.Flush() }',
    "function cv_list([double]$minutes) { $sb = New-Object Text.StringBuilder; $now = [DateTime]::UtcNow; if ([IO.Directory]::Exists($cv_root)) { $full = [IO.Path]::GetFullPath($cv_root).TrimEnd([char]92); $cut = $now.AddMinutes(-$minutes); try { foreach ($p in [IO.Directory]::EnumerateFiles($full, '*.json*', [IO.SearchOption]::AllDirectories)) { try { $f = New-Object IO.FileInfo $p; if (($f.Extension -eq '.jsonl' -or $f.Extension -eq '.json') -and $f.LastWriteTimeUtc -gt $cut) { [void]$sb.Append([int64]($f.LastWriteTimeUtc - $cv_epoch).TotalSeconds).Append(' ').Append($f.Length).Append(' ./').Append($p.Substring($full.Length + 1).Replace([char]92, [char]47)).Append(\"`n\") } } catch { } } } catch { } }; [void]$sb.Append('CVEND ').Append([int64]($now - $cv_epoch).TotalSeconds); cv_w $sb.ToString() }",
    // Kiln's events file, found the way Kiln finds it (KILN_EVENTS_PATH, XDG_CONFIG_HOME, ~/.config)
    "$cv_kf = if ($env:KILN_EVENTS_PATH) { $env:KILN_EVENTS_PATH -replace '^~(?=[\\\\/]|$)', $HOME } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'kiln/events.jsonl' } else { Join-Path $HOME '.config/kiln/events.jsonl' }",
    'function cv_read([string]$rel, [int64]$off, [int64]$max) { cv_rd (Join-Path $cv_root $rel) $off $max }',
    'function cv_kread([int]$which, [int64]$off, [int64]$max) { if ($which -eq 1) { cv_rd ($cv_kf + ".1") $off $max } else { cv_rd $cv_kf $off $max } }',
    // the transcript stays writable (and deletable) by Claude Code while it is read
    'function cv_rd([string]$path, [int64]$off, [int64]$max) { $fs = $null; try { $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)) } catch { cv_w \'CVD -1 0\'; return }; try { $s = $fs.Length; $n = $s - $off; if ($n -lt 0) { cv_w "CVD -2 $s"; return }; if ($n -gt $max) { $n = $max }; $buf = New-Object byte[] $n; $fs.Position = $off; $got = 0; while ($got -lt $n) { $r = $fs.Read($buf, $got, $n - $got); if ($r -le 0) { break }; $got += $r }; cv_w "CVD $n $s"; if ($n -gt 0) { $cv_o.Write($buf, 0, $n); $cv_o.Flush() } } finally { $fs.Close() } }',
    'cv_w ("CVREADY " + $env:COMPUTERNAME)',
  ].join('\n') + '\n';

export const remoteScript = (shell: RemoteShell): string => (shell === 'powershell' ? REMOTE_SCRIPT_PS : REMOTE_SCRIPT);

/** 'full': every transcript file touched in the last FULL_DAYS days; 'quick': only the last few minutes. */
export function listCommand(shell: RemoteShell, kind: 'full' | 'quick'): string {
  if (shell === 'powershell') return `cv_list ${kind === 'full' ? FULL_DAYS * 24 * 60 : QUICK_MINUTES}`;
  return kind === 'full' ? `cv_list -mtime -${FULL_DAYS}` : `cv_list -mmin -${QUICK_MINUTES}`;
}

/** True when stderr says the remote login shell does not know `sh`: a Windows computer (cmd or PowerShell). */
export const noPosixShell = (stderr: string): boolean => /is not recognized|command not found|sh: not found/i.test(stderr);

export interface RemoteFile {
  /** path under the remote projects folder, '/'-separated */
  rel: string;
  /** epoch ms */
  mtime: number;
  size: number;
}

const SEG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A listed path is only used when every part is a plain name: it becomes a local file name and a shell argument. */
export function safeRel(rel: string): boolean {
  if (rel.length > 400) return false;
  const parts = rel.split('/');
  return parts.length >= 2 && parts.length <= 6 && parts.every((p) => SEG_RE.test(p));
}

/** One line of cv_list output; null for anything that is not a usable file line. */
export function parseListLine(line: string): RemoteFile | null {
  const m = /^(\d{1,12}) (\d{1,15}) \.\/(.+)$/.exec(line);
  if (!m || !safeRel(m[3])) return null;
  return { rel: m[3], mtime: Number(m[1]) * 1000, size: Number(m[2]) };
}

export interface RelInfo {
  session: string;
  /** the session's main transcript (<project>/<id>.jsonl) */
  main: boolean;
  /** 'append': a transcript that only grows; 'replace': a small JSON file rewritten as a whole */
  mode: 'append' | 'replace';
}

const SMALL_JSON_MAX = 1_000_000;

export function classifyRel(rel: string): RelInfo | null {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (parts.length === 2) return name.endsWith('.jsonl') ? { session: name.slice(0, -6), main: true, mode: 'append' } : null;
  if (name.endsWith('.jsonl')) return { session: parts[1], main: false, mode: 'append' };
  if (name === 'custom-title.json' || name.endsWith('.meta.json')) return { session: parts[1], main: false, mode: 'replace' };
  return null;
}

export interface LocalFile {
  size: number;
  mtime: number;
}

export interface FetchTask {
  rel: string;
  session: string;
  mode: 'append' | 'replace';
  /** where to continue from; 0 with `restart` when the local copy must be thrown away first */
  offset: number;
  restart: boolean;
  size: number;
  mtime: number;
}

export interface FetchPlan {
  /** in the order to fetch: live sessions, then pinned ones, then the most recent; inside a session the main transcript comes last */
  tasks: FetchTask[];
  /** live and pinned sessions whose every file is up to date */
  settled: string[];
  pendingBytes: number;
}

export const SSH_LIVE_MS = 15 * 60_000;
/** not-live sessions whose main transcript is mirrored, so they show in the session list */
export const SSH_RECENT = 30;

/**
 * What to copy next. Live and pinned (selected) sessions get all their files; the most recent other sessions only their main
 * transcript and title, which is what the session list needs.
 */
export function planFetch(
  remote: ReadonlyMap<string, RemoteFile>,
  local: (rel: string) => LocalFile | undefined,
  opts: { now: number; pinned?: ReadonlySet<string>; recent?: number; liveMs?: number },
): FetchPlan {
  interface Group {
    id: string;
    activity: number;
    main: RemoteFile | null;
    side: { f: RemoteFile; info: RelInfo }[];
  }
  const groups = new Map<string, Group>();
  for (const f of remote.values()) {
    const info = classifyRel(f.rel);
    if (!info) continue;
    if (info.mode === 'replace' && f.size > SMALL_JSON_MAX) continue;
    let g = groups.get(info.session);
    if (!g) groups.set(info.session, (g = { id: info.session, activity: 0, main: null, side: [] }));
    g.activity = Math.max(g.activity, f.mtime);
    if (info.main) g.main = f;
    else g.side.push({ f, info });
  }
  const sorted = [...groups.values()].filter((g) => g.main).sort((a, b) => b.activity - a.activity);
  const liveMs = opts.liveMs ?? SSH_LIVE_MS;
  const tiers: Group[][] = [[], [], []];
  let recentLeft = opts.recent ?? SSH_RECENT;
  for (const g of sorted) {
    if (opts.now - g.activity < liveMs) tiers[0].push(g);
    else if (opts.pinned?.has(g.id)) tiers[1].push(g);
    else if (recentLeft-- > 0) tiers[2].push(g);
  }
  const tasks: FetchTask[] = [];
  const settled: string[] = [];
  let pendingBytes = 0;
  const need = (f: RemoteFile, session: string, mode: 'append' | 'replace'): boolean => {
    const l = local(f.rel);
    let offset = 0;
    let restart = false;
    if (mode === 'append') {
      if (l && l.size === f.size) return false;
      if (l && l.size < f.size) offset = l.size;
      else restart = !!l;
    } else {
      if (l && l.size === f.size && Math.abs(l.mtime - f.mtime) < 1000) return false;
      restart = !!l;
    }
    tasks.push({ rel: f.rel, session, mode, offset, restart, size: f.size, mtime: f.mtime });
    pendingBytes += f.size - offset;
    return true;
  };
  tiers.forEach((tier, t) => {
    for (const g of tier) {
      let any = false;
      for (const s of g.side) {
        // recent sessions: only the title beside the main transcript
        if (t === 2 && !s.f.rel.endsWith('/custom-title.json')) continue;
        any = need(s.f, g.id, s.info.mode) || any;
      }
      any = need(g.main!, g.id, 'append') || any;
      if (!any && t < 2) settled.push(g.id);
    }
  });
  return { tasks, settled, pendingBytes };
}

/** What ssh printed on stderr, as something a person can act on. */
export function sshErrorText(stderr: string, target: string): string {
  const s = stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s))
    return `The identity of ${target} changed since the last connection. Check it, then fix the entry in your known_hosts file.`;
  if (/Host key verification failed/i.test(s))
    return `This computer has not connected to ${target} before. Run "ssh ${target}" once in a terminal and accept its key.`;
  if (/Permission denied/i.test(s)) return `${target} refused the login. Set up an SSH key for it: this app never asks for or stores a password.`;
  if (/Could not resolve hostname/i.test(s)) return `Could not find ${target}.`;
  if (/timed out|Connection refused|No route to host|Network is unreachable/i.test(s))
    return `Could not reach ${target}. Is it on, and is Remote Login (SSH) enabled there?`;
  if (noPosixShell(s)) return `${target} has neither a POSIX shell nor PowerShell to read its transcripts with.`;
  const last = s.split(/\r?\n/).filter(Boolean).pop();
  return last ? last.slice(0, 200) : 'The SSH connection closed.';
}
