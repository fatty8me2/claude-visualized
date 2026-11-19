// Keeps a local copy of one SSH remote's recent Claude Code transcripts (see core/sshRemote.ts for what is copied and in which order).
// The copy has the same layout as ~/.claude/projects, so a SessionManager can follow it like local sessions.
// A file that is not here yet is downloaded as <name>.part and renamed when complete, so nothing downstream sees half a backlog.
// Kiln's events file (local-model hand-offs, see main/kiln.ts) is copied too, to <dir>/kiln/events.jsonl, with its rotation.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { noPosixShell, planFetch, sshErrorText, type FetchTask, type LocalFile, type RemoteFile, type RemoteShell, type SshHostState } from '@core/sshRemote';
import { SshConn, type SpawnSpec } from './conn';

export interface MirrorOptions {
  /** this host's mirror folder; transcripts go under <dir>/projects */
  dir: string;
  /** how to start the connection for a remote running that shell */
  spec: (shell: RemoteShell) => SpawnSpec;
  /** the shell found on an earlier connection ('sh' is tried first) */
  shell?: RemoteShell;
  target: string;
  /** time between listings of recently changed files (default 1.5 s) */
  quickMs?: number;
  /** time between full listings (default 60 s) */
  fullMs?: number;
  /** most bytes copied per request (default 2 MB), so live sessions are never stuck behind a big backlog */
  chunk?: number;
  /** first reconnect delay (default 2 s, doubling to 60 s) */
  retryMs?: number;
}

const MAX_RETRY_MS = 60_000;
const SYNCING_BYTES = 256 * 1024;
const PART = '.part';

interface Local extends LocalFile {
  part: boolean;
}

/** Events: 'status' (state, error, progress or hostname changed), 'settled' (a live or pinned session is fully copied), 'shell' (the remote is Windows). */
export class HostMirror extends EventEmitter {
  readonly projectsDir: string;
  /** the local copy of the other computer's Kiln events file (it exists once Kiln has written something there) */
  readonly kilnFile: string;
  state: SshHostState = 'connecting';
  error: string | null = null;
  offlineSince: number | null = null;
  pendingBytes = 0;
  hostname = '';
  /** 'sh' until the other computer turns out to be Windows */
  shell: RemoteShell;
  /** sessions whose every file should be copied although they are not live (the selected one) */
  pinned = new Set<string>();
  /** live and pinned sessions that were fully copied at least once */
  readonly settled = new Set<string>();
  /** copy Kiln's events file too (Settings: "Show Kiln runs") */
  copyKiln = true;
  private remote = new Map<string, RemoteFile>();
  private local = new Map<string, Local>();
  private conn: SshConn | null = null;
  private stopped = true;
  private wake: (() => void) | null = null;
  private clockOffset = 0;
  /** bytes of Kiln's events file copied so far */
  private kilnSize = 0;
  private kilnDue = 0;

  constructor(private opts: MirrorOptions) {
    super();
    this.projectsDir = path.join(opts.dir, 'projects');
    this.kilnFile = path.join(opts.dir, 'kiln', 'events.jsonl');
    this.shell = opts.shell ?? 'sh';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }

  stop() {
    this.stopped = true;
    this.conn?.close();
    this.wake?.();
  }

  /** Copy a newly pinned session without waiting for the next listing. */
  poke() {
    this.wake?.();
  }

  private file(rel: string): string {
    return path.join(this.projectsDir, ...rel.split('/'));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private set(state: SshHostState, error: string | null = null) {
    const changed = state !== this.state || error !== this.error;
    if (state === 'offline' && this.offlineSince === null) this.offlineSince = Date.now();
    if (state === 'online' || state === 'syncing') this.offlineSince = null;
    this.state = state;
    this.error = error;
    if (changed) this.emit('status');
  }

  private async run() {
    await this.scanLocal();
    let retry = this.opts.retryMs ?? 2000;
    while (!this.stopped) {
      const conn = new SshConn(this.opts.spec(this.shell));
      this.conn = conn;
      let error: string;
      let started = false;
      try {
        const hostname = await conn.start();
        started = true;
        if (hostname && hostname !== this.hostname) {
          this.hostname = hostname;
          this.emit('status');
        }
        retry = this.opts.retryMs ?? 2000;
        await this.session(conn);
        error = '';
      } catch (e) {
        error = (e as Error).message;
      }
      conn.close();
      this.conn = null;
      if (this.stopped) break;
      // a Windows computer answers "'sh' is not recognized": talk to its PowerShell instead, from now on
      if (!started && this.shell === 'sh' && noPosixShell(error)) {
        this.shell = 'powershell';
        this.emit('shell', this.shell);
        continue;
      }
      this.pendingBytes = 0;
      this.set('offline', sshErrorText(error, this.opts.target));
      await this.sleep(Math.round(retry * (0.8 + Math.random() * 0.4)));
      retry = Math.min(MAX_RETRY_MS, retry * 2);
      if (!this.stopped && this.state === 'offline') this.emit('status');
    }
  }

  /** One connection's life: list, plan, copy a chunk, repeat. Throws when the connection fails. */
  private async session(conn: SshConn) {
    const quickMs = this.opts.quickMs ?? 1500;
    const fullMs = this.opts.fullMs ?? 60_000;
    let lastFull = 0;
    let lastQuick = 0;
    while (!this.stopped) {
      const now = Date.now();
      if (!lastFull || now - lastFull >= fullMs) {
        const r = await conn.list('full');
        lastFull = lastQuick = Date.now();
        this.clockOffset = r.now - lastFull;
        this.remote = new Map(r.files.map((f) => [f.rel, f]));
        if (r.files.length) await this.prune();
      } else if (now - lastQuick >= quickMs) {
        const r = await conn.list('quick');
        lastQuick = Date.now();
        this.clockOffset = r.now - lastQuick;
        for (const f of r.files) this.remote.set(f.rel, f);
      }
      if (this.copyKiln && Date.now() >= this.kilnDue) await this.syncKiln(conn, quickMs, fullMs);
      const plan = planFetch(this.remote, (rel) => this.local.get(rel), { now: Date.now() + this.clockOffset, pinned: this.pinned });
      for (const id of plan.settled) {
        if (this.settled.has(id)) continue;
        this.settled.add(id);
        this.emit('settled', id);
      }
      const state = plan.pendingBytes > SYNCING_BYTES ? 'syncing' : 'online';
      const progress = plan.pendingBytes !== this.pendingBytes;
      this.pendingBytes = plan.pendingBytes;
      if (state !== this.state || this.error) this.set(state);
      else if (progress && state === 'syncing') this.emit('status');
      if (plan.tasks.length) {
        if ((await this.fetch(conn, plan.tasks[0])) === 'relist') lastFull = 0;
      } else await this.sleep(Math.max(50, quickMs - (Date.now() - lastQuick)));
    }
  }

  private async fetch(conn: SshConn, t: FetchTask): Promise<'ok' | 'relist'> {
    const file = this.file(t.rel);
    if (t.restart) await this.drop(t.rel);
    const r = await conn.read(t.rel, t.offset, t.mode === 'replace' ? Math.max(1, t.size) + 65_536 : (this.opts.chunk ?? 2 * 1024 * 1024));
    if (r === 'missing' || r === 'shrunk') {
      // gone or rewritten on the other side: forget it and let the next full listing decide
      await this.drop(t.rel);
      this.remote.delete(t.rel);
      return 'relist';
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const when = new Date(t.mtime);
    if (t.mode === 'replace') {
      const tmp = file + PART;
      await fs.writeFile(tmp, r.data);
      await fs.utimes(tmp, when, when);
      await fs.rename(tmp, file);
      this.local.set(t.rel, { size: r.data.length, mtime: t.mtime, part: false });
      this.remote.set(t.rel, { rel: t.rel, mtime: t.mtime, size: r.data.length });
      return 'ok';
    }
    const l = this.local.get(t.rel);
    let part = l ? l.part : true;
    const size = t.offset + r.data.length;
    await fs.appendFile(part ? file + PART : file, r.data);
    await fs.utimes(part ? file + PART : file, when, when);
    if (part && size >= r.size) {
      await fs.rename(file + PART, file);
      part = false;
    }
    this.local.set(t.rel, { size, mtime: t.mtime, part });
    // the file may have grown since it was listed
    if (r.size !== t.size) this.remote.set(t.rel, { rel: t.rel, mtime: t.mtime, size: Math.max(r.size, size) });
    return 'ok';
  }

  /**
   * Copy the next piece of Kiln's events file. Kiln only appends, except when it rotates the file at 5 MB (events.jsonl ->
   * events.jsonl.1): then the local copy is rotated the same way and the rest of the old file is read from the remote .1, so
   * KilnSource sees what it would see on the other computer.
   */
  private async syncKiln(conn: SshConn, quickMs: number, fullMs: number) {
    const chunk = this.opts.chunk ?? 2 * 1024 * 1024;
    const r = await conn.readKiln(false, this.kilnSize, chunk);
    if (r === 'missing') {
      // no Kiln on the other computer (or nothing written yet): look again now and then
      this.kilnDue = Date.now() + fullMs;
      return;
    }
    await fs.mkdir(path.dirname(this.kilnFile), { recursive: true });
    if (r === 'shrunk') {
      const old = this.kilnSize;
      await fs.rm(this.kilnFile + '.1', { force: true });
      await fs.rename(this.kilnFile, this.kilnFile + '.1').catch(() => {});
      this.kilnSize = 0;
      for (let off = old; ; ) {
        const rest = await conn.readKiln(true, off, chunk);
        if (typeof rest === 'string' || !rest.data.length) break;
        await fs.appendFile(this.kilnFile + '.1', rest.data);
        off += rest.data.length;
        if (off >= rest.size) break;
      }
      this.kilnDue = 0;
      return;
    }
    if (r.data.length) {
      await fs.appendFile(this.kilnFile, r.data);
      this.kilnSize += r.data.length;
    }
    // a backlog is read chunk after chunk; after that, as often as the quick listing
    this.kilnDue = this.kilnSize < r.size ? 0 : Date.now() + quickMs;
  }

  private async drop(rel: string) {
    this.local.delete(rel);
    const file = this.file(rel);
    await fs.rm(file, { force: true });
    await fs.rm(file + PART, { force: true });
  }

  /** Local copies of files the other computer no longer lists (deleted there, or older than the listing window). */
  private async prune() {
    for (const rel of [...this.local.keys()]) if (!this.remote.has(rel)) await this.drop(rel);
  }

  /** What is already here from an earlier run. */
  private async scanLocal() {
    this.local.clear();
    const visit = async (dir: string, rel: string, depth: number) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (depth < 6) await visit(p, r, depth + 1);
          continue;
        }
        try {
          const st = await fs.stat(p);
          const part = r.endsWith(PART);
          const key = part ? r.slice(0, -PART.length) : r;
          if (part && this.local.has(key)) continue;
          this.local.set(key, { size: st.size, mtime: Math.round(st.mtimeMs), part });
        } catch {
          /* vanished */
        }
      }
    };
    await visit(this.projectsDir, '', 0);
    try {
      this.kilnSize = (await fs.stat(this.kilnFile)).size;
    } catch {
      this.kilnSize = 0;
    }
  }
}
