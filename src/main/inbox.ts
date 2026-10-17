import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { deriveInbox, noticeItem, snapshotOf, type InboxItem, type InboxSnapshot } from '@core/inbox';
import { mergeInbox, type RemoteInbox } from '@core/remote';
import type { UsageView } from '@core/usage';
import type { NotifyRequest, SessionManager } from './manager';

const THROTTLE_MS = 250;
const TICK_MS = 30_000;
const DISMISSED_KEEP_MS = 30 * 24 * 3_600_000;

/**
 * Owns the inbox: derives it from the manager's watched sessions (see core/inbox.ts), remembers dismissals in userData
 * and emits 'inbox' (InboxSnapshot) whenever the visible result changes.
 */
export class InboxService extends EventEmitter {
  /** derived from this machine's sessions */
  private items: InboxItem[] = [];
  /** plus other computers' items (peer link), what the UI shows */
  private merged: InboxItem[] = [];
  private remote: RemoteInbox[] = [];
  private dismissed = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private lastSig = '';

  constructor(
    private manager: SessionManager,
    private getUsage: () => UsageView,
    private file: string,
  ) {
    super();
    this.load();
  }

  start() {
    this.manager.on('changed', () => this.schedule());
    this.manager.on('sessions', () => this.schedule());
    this.tick = setInterval(() => this.recompute(), TICK_MS);
    this.recompute();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.tick) clearInterval(this.tick);
  }

  snapshot(): InboxSnapshot {
    return snapshotOf(this.merged);
  }

  get count(): number {
    return this.merged.filter((i) => !i.resolved).length;
  }

  /** This machine's own items (what the peer link shares). */
  localItems(): InboxItem[] {
    return this.items;
  }

  /** Other computers' items, labelled by machine. Dismissing one only hides it here. */
  setRemote(remote: RemoteInbox[]) {
    this.remote = remote;
    this.schedule();
  }

  /** Coalesce bursts of changes into one derivation. */
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recompute();
    }, THROTTLE_MS);
  }

  recompute(now = Date.now()) {
    const dismissed = new Set(this.dismissed.keys());
    this.items = deriveInbox(this.items, this.manager.watchedViews(), this.getUsage(), now, dismissed);
    this.merged = this.remote.length ? mergeInbox(this.items, this.remote, dismissed) : this.items;
    const snap = snapshotOf(this.merged);
    const sig = JSON.stringify(snap.items);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.emit('inbox', snap);
  }

  /** OS notifications that are not needs-you lines (agent finished/failed) also land in the inbox. */
  onNotify(n: NotifyRequest) {
    if (n.kind === 'agent') {
      this.items = [
        ...this.items,
        noticeItem({ sessionId: n.sessionId, sessionTitle: this.manager.titleOf(n.sessionId) ?? 'Claude session', title: n.title, body: n.body }, Date.now()),
      ];
      this.lastSig = '';
    }
    this.recompute();
  }

  dismiss(id: string) {
    this.dismissed.set(id, Date.now());
    this.save();
    this.recompute();
  }

  /** Dismiss every resolved item. */
  clearResolved() {
    for (const i of this.merged) if (i.resolved) this.dismissed.set(i.id, Date.now());
    this.save();
    this.recompute();
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, number>;
      const now = Date.now();
      for (const [id, t] of Object.entries(raw)) if (typeof t === 'number' && now - t < DISMISSED_KEEP_MS) this.dismissed.set(id, t);
    } catch {
      /* first run or unreadable: nothing dismissed */
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.dismissed)));
    } catch (e) {
      console.error('inbox dismissals save failed', e);
    }
  }
}
