// SSH remotes (docs/SSH-REMOTES.md): computers watched without the app installed on them. Each remote has a HostMirror copying its
// transcripts into the app data folder and a passive SessionManager following that copy; this service presents them to the main
// SessionManager the same way the peer link presents paired computers (namespaced ids, a machine name, offline state).
// Read-only by construction: the only things sent to the other computer are file listings and byte-range reads.
// No Electron imports, so tests can run it against a local shell.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { deriveInbox, type InboxItem } from '@core/inbox';
import { mergeSummaries, namespaceView, parseRemoteId, remoteId, type RemoteHostData, type RemoteInbox } from '@core/remote';
import { parseSshTarget, sshArgs, type SshAddResult, type SshHostConfig, type SshHostView } from '@core/sshRemote';
import type { SessionSummary, SessionView } from '@core/state';
import { SessionManager, type NotifyRequest } from '../manager';
import type { BacklogLoader } from '../watcher';
import type { SpawnSpec } from './conn';
import { HostMirror, type MirrorOptions } from './mirror';

export interface SshServiceOptions {
  /** folder holding one mirror per remote */
  root: string;
  hosts: SshHostConfig[];
  /** persist the list after an add, a remove or a learned hostname */
  save: (hosts: SshHostConfig[]) => void;
  /** how to reach a remote (tests: a local shell) */
  spawn?: (h: SshHostConfig) => SpawnSpec;
  mirror?: Pick<MirrorOptions, 'quickMs' | 'fullMs' | 'chunk' | 'retryMs'>;
  tickMs?: number;
  /** tests: read backlogs on the calling thread */
  backlogLoader?: BacklogLoader;
}

interface Host {
  cfg: SshHostConfig;
  mirror: HostMirror;
  mgr: SessionManager;
  inbox: InboxItem[];
  inboxSig: string;
  /** the session the sub-manager keeps followed for the selected view */
  retained: string | null;
  viewReady: boolean;
  dirty: boolean;
  /** session count last reported in the status */
  count: number;
}

const ID_RE = /^ssh-[0-9a-f]{12}$/;

/** Windows ships OpenSSH in System32; prefer it so the user's ssh-agent service and ~/.ssh are the ones a terminal uses. */
export function sshCommand(): string {
  if (process.platform === 'win32') {
    const p = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'ssh';
}

export function sshHostId(target: string, port?: number): string {
  return `ssh-${createHash('sha256')
    .update(`${target.toLowerCase()}:${port ?? 22}`)
    .digest('hex')
    .slice(0, 12)}`;
}

/**
 * Events: 'status' (SshHostView[]), 'notify' (NotifyRequest), and the RemoteSource ones: 'sessions', 'view' (namespaced id), 'overview', 'inbox'.
 */
export class SshService extends EventEmitter {
  private hosts = new Map<string, Host>();
  private tick: NodeJS.Timeout | null = null;
  private selected: { deviceId: string; id: string } | null = null;
  private attention = true;
  private agentDone = false;

  constructor(private opts: SshServiceOptions) {
    super();
    for (const h of opts.hosts) if (h && typeof h.id === 'string' && ID_RE.test(h.id) && parseSshTarget(String(h.target), h.port).ok) this.attach(h);
  }

  start() {
    if (this.tick) return;
    this.tick = setInterval(() => this.onTick(), this.opts.tickMs ?? 300);
    for (const h of this.hosts.values()) this.run(h);
  }

  stop() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    for (const h of this.hosts.values()) {
      h.mirror.stop();
      h.mgr.stop();
    }
  }

  setNotify(attention: boolean, agentDone: boolean) {
    this.attention = attention;
    this.agentDone = agentDone;
    for (const h of this.hosts.values()) {
      h.mgr.notifyAttention = attention;
      h.mgr.notifyAgentDone = agentDone;
    }
  }

  // ======================= hosts =======================

  private name(h: Host): string {
    return h.cfg.label || h.mirror.hostname || h.cfg.hostname || h.cfg.target.split('@').pop() || h.cfg.target;
  }

  private attach(cfg: SshHostConfig): Host {
    const dir = path.join(this.opts.root, cfg.id);
    const spec = this.opts.spawn?.(cfg) ?? { command: sshCommand(), args: sshArgs(cfg) };
    const mirror = new HostMirror({ dir, spec, target: cfg.target, ...this.opts.mirror });
    const mgr = new SessionManager({ projectsRoot: mirror.projectsDir, passive: true, backlogLoader: this.opts.backlogLoader });
    mgr.followActive = false;
    mgr.notifyAttention = this.attention;
    mgr.notifyAgentDone = this.agentDone;
    const h: Host = { cfg, mirror, mgr, inbox: [], inboxSig: '[]', retained: null, viewReady: false, dirty: false, count: 0 };
    this.hosts.set(cfg.id, h);
    mirror.on('status', () => {
      this.emitStatus();
      this.emit('sessions');
      this.emit('overview');
      this.emit('inbox');
    });
    mgr.on('sessions', () => this.emit('sessions'));
    mgr.on('changed', () => (h.dirty = true));
    mgr.on('notify', (n: NotifyRequest) => {
      if (mirror.state === 'offline') return;
      this.emit('notify', { ...n, title: `${n.title} · ${this.name(h)}`, sessionId: remoteId(cfg.id, n.sessionId) } satisfies NotifyRequest);
    });
    return h;
  }

  private run(h: Host) {
    h.mirror.start();
    h.mgr.start();
  }

  add(target: string, port?: number | null, label?: string): SshAddResult {
    const p = parseSshTarget(target, port);
    if (!p.ok) return p;
    const id = sshHostId(p.target, p.port);
    if (this.hosts.has(id)) return { ok: false, error: 'That computer is already in the list.' };
    const cfg: SshHostConfig = { id, target: p.target, ...(p.port ? { port: p.port } : {}), ...(label?.trim() ? { label: label.trim().slice(0, 60) } : {}) };
    const h = this.attach(cfg);
    if (this.tick) this.run(h);
    this.save();
    this.emitStatus();
    return { ok: true };
  }

  /** Stop watching a remote and delete its local copy. */
  remove(id: string) {
    const h = this.hosts.get(id);
    if (!h) return;
    h.mirror.stop();
    h.mgr.stop();
    this.hosts.delete(id);
    if (this.selected?.deviceId === id) this.selected = null;
    if (ID_RE.test(id)) void fs.promises.rm(path.join(this.opts.root, id), { recursive: true, force: true }).catch(() => {});
    this.save();
    this.emitStatus();
    this.emit('sessions');
    this.emit('overview');
    this.emit('inbox');
  }

  private save() {
    this.opts.save([...this.hosts.values()].map((h) => h.cfg));
  }

  status(): SshHostView[] {
    return [...this.hosts.values()].map((h) => ({
      id: h.cfg.id,
      target: h.cfg.target,
      port: h.cfg.port ?? null,
      name: this.name(h),
      state: h.mirror.state,
      error: h.mirror.error,
      offlineSince: h.mirror.offlineSince,
      pendingBytes: h.mirror.pendingBytes,
      sessions: h.mgr.localSummaries().length,
    }));
  }

  private emitStatus() {
    this.emit('status', this.status());
  }

  // ======================= RemoteSource (what the main SessionManager reads) =======================

  private online(h: Host): boolean {
    return h.mirror.state === 'online' || h.mirror.state === 'syncing';
  }

  summaries(): SessionSummary[] {
    const data: RemoteHostData[] = [...this.hosts.values()].map((h) => ({
      deviceId: h.cfg.id,
      machine: this.name(h),
      offlineSince: this.online(h) ? null : (h.mirror.offlineSince ?? Date.now()),
      summaries: h.mgr.localSummaries(),
    }));
    return mergeSummaries([], data);
  }

  view(nsId: string): SessionView | null {
    const p = parseRemoteId(nsId);
    const h = p ? this.hosts.get(p.deviceId) : undefined;
    if (!p || !h || h.retained !== p.id) return null;
    const v = h.mgr.localView(p.id);
    return v ? namespaceView(v, h.cfg.id, this.name(h)) : null;
  }

  overview(): SessionView[] {
    const out: SessionView[] = [];
    for (const h of this.hosts.values()) if (this.online(h)) for (const v of h.mgr.localOverview()) out.push(namespaceView(v, h.cfg.id, this.name(h)));
    return out;
  }

  setSelected(nsId: string | null) {
    const p = nsId ? parseRemoteId(nsId) : null;
    this.selected = p && this.hosts.has(p.deviceId) ? p : null;
    for (const h of this.hosts.values()) {
      const want = this.selected?.deviceId === h.cfg.id ? this.selected.id : null;
      h.mirror.pinned = new Set(want ? [want] : []);
      if (want) h.mirror.poke();
    }
    this.syncRetained();
  }

  setOverviewWanted(_on: boolean) {
    /* live sessions are always followed: nothing to switch */
  }

  remoteInbox(): RemoteInbox[] {
    const out: RemoteInbox[] = [];
    for (const h of this.hosts.values()) if (this.online(h)) out.push({ deviceId: h.cfg.id, machine: this.name(h), items: h.inbox });
    return out;
  }

  /** name of the computer a remote session id belongs to; null when it is not one of ours */
  machineOf(nsId: string): string | null {
    const p = parseRemoteId(nsId);
    const h = p ? this.hosts.get(p.deviceId) : undefined;
    return h ? this.name(h) : null;
  }

  // ======================= housekeeping =======================

  /** The selected session is followed once all its files are here (or the remote is offline and what is here is all there is). */
  private syncRetained() {
    for (const h of this.hosts.values()) {
      const want = this.selected?.deviceId === h.cfg.id ? this.selected.id : null;
      if (h.retained && h.retained !== want) {
        h.mgr.release(h.retained);
        h.retained = null;
        h.viewReady = false;
      }
      if (want && !h.retained && (h.mirror.settled.has(want) || h.mirror.state === 'offline') && h.mgr.localSummaries().some((s) => s.id === want)) {
        h.mgr.retain(want);
        h.retained = want;
      }
    }
  }

  private onTick() {
    this.syncRetained();
    const now = Date.now();
    for (const h of this.hosts.values()) {
      if (h.mirror.hostname && !h.cfg.label && h.cfg.hostname !== h.mirror.hostname) {
        h.cfg = { ...h.cfg, hostname: h.mirror.hostname };
        this.save();
      }
      const count = h.mgr.localSummaries().length;
      if (count !== h.count) {
        h.count = count;
        this.emitStatus();
      }
      const ready = !!h.retained && h.mgr.localView(h.retained) !== null;
      if (ready !== h.viewReady) {
        h.viewReady = ready;
        h.dirty = true;
      }
      if (!h.dirty) continue;
      h.dirty = false;
      this.emit('overview');
      if (h.retained) this.emit('view', remoteId(h.cfg.id, h.retained));
      h.inbox = deriveInbox(h.inbox, h.mgr.watchedViews(), null, now);
      const sig = JSON.stringify(h.inbox);
      if (sig !== h.inboxSig) {
        h.inboxSig = sig;
        this.emit('inbox');
      }
    }
  }
}
