// One SSH connection to a remote `sh`, speaking the two read-only requests of core/sshRemote.ts (list, read a byte range).
// Requests run one at a time. No Electron imports: tests drive it with a local `sh` instead of ssh.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { listCommand, parseListLine, remoteScript, safeRel, type RemoteFile, type RemoteShell } from '@core/sshRemote';

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** what the command runs on the other side (default 'sh') */
  shell?: RemoteShell;
}

export interface ListResult {
  files: RemoteFile[];
  /** the remote clock, epoch ms */
  now: number;
}

export type ReadResult = { data: Buffer; size: number } | 'missing' | 'shrunk';

const REQUEST_MS = 45_000;
const READY_MS = 30_000;
const STDERR_KEEP = 4000;

type Waiter =
  | { kind: 'ready'; resolve: (hostname: string) => void; reject: (e: Error) => void }
  | { kind: 'list'; files: RemoteFile[]; resolve: (r: ListResult) => void; reject: (e: Error) => void }
  | { kind: 'read'; want: number; size: number; resolve: (r: ReadResult) => void; reject: (e: Error) => void };

/** Events: 'close' (stderr text, possibly empty). */
export class SshConn extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stderr = '';
  closed = false;

  constructor(private spec: SpawnSpec) {
    super();
  }

  /** Spawn, send the script and wait until the remote shell answers. Resolves with the remote hostname. */
  start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.spec.command, this.spec.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.spec.env ?? process.env });
      } catch (e) {
        this.closed = true;
        return reject(e as Error);
      }
      this.proc = proc;
      this.arm({ kind: 'ready', resolve, reject }, READY_MS);
      proc.on('error', (e: NodeJS.ErrnoException) => this.fail(e.code === 'ENOENT' ? 'The OpenSSH client (ssh) was not found on this computer.' : e.message));
      proc.on('close', () => this.fail(this.stderr));
      proc.stdout.on('data', (d: Buffer) => this.onData(d));
      proc.stderr.on('data', (d: Buffer) => {
        this.stderr = (this.stderr + d.toString('utf8')).slice(-STDERR_KEEP);
      });
      proc.stdin.on('error', () => {});
      proc.stdin.write(remoteScript(this.spec.shell ?? 'sh'));
    });
  }

  list(kind: 'full' | 'quick'): Promise<ListResult> {
    return this.request((resolve, reject) => ({ kind: 'list', files: [], resolve, reject }), listCommand(this.spec.shell ?? 'sh', kind));
  }

  read(rel: string, offset: number, max: number): Promise<ReadResult> {
    if (!safeRel(rel) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 1)
      return Promise.reject(new Error('bad read request'));
    return this.request((resolve, reject) => ({ kind: 'read', want: -1, size: 0, resolve, reject }), `cv_read '${rel}' ${offset} ${max}`);
  }

  close() {
    this.fail('closed');
  }

  private request<T>(make: (resolve: (v: T) => void, reject: (e: Error) => void) => Waiter, command: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed || !this.proc) return reject(new Error('not connected'));
      if (this.waiter) return reject(new Error('busy'));
      this.arm(make(resolve, reject), REQUEST_MS);
      this.proc.stdin.write(command + '\n');
      this.pump();
    });
  }

  private arm(w: Waiter, ms: number) {
    this.waiter = w;
    this.timer = setTimeout(() => this.fail('The other computer stopped answering.'), ms);
  }

  private settle(): Waiter | null {
    const w = this.waiter;
    this.waiter = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return w;
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const w = this.settle();
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.stdin.end();
      proc?.kill();
    } catch {
      /* already gone */
    }
    w?.reject(new Error(reason || 'The SSH connection closed.'));
    this.emit('close', reason);
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this.pump();
  }

  private takeLine(): string | null {
    const nl = this.buf.indexOf(0x0a);
    if (nl === -1) {
      // a line this long is not ours
      if (this.buf.length > 1_000_000) this.fail('unexpected output from the other computer');
      return null;
    }
    const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
    this.buf = this.buf.subarray(nl + 1);
    return line;
  }

  private pump() {
    for (;;) {
      const w = this.waiter;
      if (!w) {
        // nothing was asked: anything arriving now is noise
        this.buf = Buffer.alloc(0);
        return;
      }
      if (w.kind === 'read' && w.want >= 0) {
        if (this.buf.length < w.want) return;
        const data = Buffer.from(this.buf.subarray(0, w.want));
        this.buf = this.buf.subarray(w.want);
        this.settle();
        w.resolve({ data, size: w.size });
        continue;
      }
      const line = this.takeLine();
      if (line === null) return;
      if (w.kind === 'ready') {
        // a login script may print before our marker
        if (!line.startsWith('CVREADY')) continue;
        this.settle();
        w.resolve(line.slice(8).trim().slice(0, 100));
      } else if (w.kind === 'list') {
        if (line.startsWith('CVEND ')) {
          this.settle();
          w.resolve({ files: w.files, now: Number(line.slice(6)) * 1000 || Date.now() });
        } else {
          const f = parseListLine(line);
          if (f) w.files.push(f);
        }
      } else {
        const m = /^CVD (-?\d+) (\d+)$/.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n < 0) {
          this.settle();
          w.resolve(n === -1 ? 'missing' : 'shrunk');
        } else {
          w.want = n;
          w.size = Number(m[2]);
        }
      }
    }
  }
}
