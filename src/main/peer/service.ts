// PeerService: both roles of the peer link (docs/PEER-LINK.md).
//  - sharer (server): listens only while sharing is on, pairs with a one-time code, then streams this machine's own sessions, subscribed
//    views, overview, inbox and usage to authenticated viewers. Inbound messages are limited to sub/unsub/overview/ping: it never acts on anything.
//  - viewer (client): keeps a link to every paired host, decodes what they stream and exposes it (namespaced) to the SessionManager.
// No Electron imports: the integration test runs two of these in one process.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { DiscoveredHostView, PairResult, PeerDeviceView, PeersView } from '@core/api';
import type { InboxItem } from '@core/inbox';
import { mergeSummaries, namespaceView, parseRemoteId, remoteId, shareableSummaries, type RemoteHostData, type RemoteInbox } from '@core/remote';
import type { SessionSummary, SessionView } from '@core/state';
import { OverviewDecoder, OverviewEncoder, ViewDecoder, ViewEncoder, type OverviewMsg, type ViewMsg } from '@core/sync';
import type { UsageView } from '@core/usage';
import { formatCode, PairingCodes, type CodeState } from './crypto';
import { Discovery, DISCOVERY_PORT } from './discovery';
import { clientAuth, clientPair, HandshakeError, serverHandshake, type PeerIdentity } from './handshake';
import { PeerSocket, type Json, type SessionKeys } from './link';
import { deviceKey, PeerStore, type PairedDevice } from './store';

export const DEFAULT_PEER_PORT = 47830;

/** What the sharer reads from this machine. Everything returned must be local (never data received from other peers). */
export interface ShareSource {
  summaries(): SessionSummary[];
  view(id: string): SessionView | null;
  /** changes whenever the session's view may have changed */
  version(id: string): number;
  /** keep a session followed while a viewer is subscribed to it */
  retain(id: string): void;
  release(id: string): void;
  overview(): SessionView[];
  overviewVersion(): number;
  inbox(): InboxItem[];
  usage(): UsageView;
}

export interface PeerServiceOptions {
  storeFile: string;
  name: string;
  source: ShareSource;
  port?: number;
  /** interface to listen on while sharing; all interfaces by default */
  bindHost?: string;
  discovery?: boolean;
  discoveryPort?: number;
  scryptN?: number;
  /** minimum time between pairing attempts (default 1 s) */
  pairMinIntervalMs?: number;
  /** ping interval; a link silent for 3x this is dropped (default 10 s) */
  heartbeatMs?: number;
  /** push cadence to viewers (default 250 ms) */
  pushMs?: number;
  /** first reconnect delay (default 1 s, doubling to 30 s) */
  retryMs?: number;
}

const MAX_PENDING = 8;
const HANDSHAKE_MS = 10_000;
const MAX_SUBS = 16;
const MAX_RETRY_MS = 30_000;
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;

interface ViewerConn {
  peer: PeerIdentity;
  sock: PeerSocket;
  subs: Map<string, { enc: ViewEncoder; version: number }>;
  overviewOn: boolean;
  ovEnc: OverviewEncoder;
  ovVersion: number;
  sent: { sessions: string; inbox: string; usage: string };
  lastSlow: number;
  lastPing: number;
}

interface HostLink {
  dev: PairedDevice;
  sock: PeerSocket | null;
  state: PeerDeviceView['state'];
  error: string | null;
  offlineSince: number | null;
  summaries: SessionSummary[];
  inbox: InboxItem[];
  usage: UsageView | null;
  /** remote session id -> decoder, for the sessions this side wants (the selected one) */
  views: Map<string, ViewDecoder>;
  ovDec: OverviewDecoder;
  ovViews: SessionView[];
  retryMs: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  lastPing: number;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** enough of a SessionView for the UI not to trip over it */
const isViewShape = (v: SessionView): boolean => typeof v.id === 'string' && isObj(v.agents) && Array.isArray(v.log) && isObj(v.totals);

/**
 * Events: 'status' (PeersView), and for the viewer side 'sessions', 'view' (namespaced session id), 'overview', 'inbox', 'usage'.
 */
export class PeerService extends EventEmitter {
  readonly store: PeerStore;
  private codes: PairingCodes;
  private server: net.Server | null = null;
  private listening = false;
  private serverError: string | null = null;
  private sharing = false;
  private port: number;
  private pending = new Set<PeerSocket>();
  private conns = new Map<string, ViewerConn>();
  private links = new Map<string, HostLink>();
  private discovery: Discovery | null;
  private tick: NodeJS.Timeout | null = null;
  private selected: { deviceId: string; id: string } | null = null;
  private overviewWanted = false;
  private lastCodeState: CodeState = 'none';
  private lastPairFailure: { reason: string; at: number } | null = null;

  constructor(private opts: PeerServiceOptions) {
    super();
    this.store = new PeerStore(opts.storeFile, opts.name);
    this.port = opts.port ?? DEFAULT_PEER_PORT;
    this.codes = new PairingCodes({ minIntervalMs: opts.pairMinIntervalMs });
    this.discovery = opts.discovery === false ? null : new Discovery(opts.discoveryPort ?? DISCOVERY_PORT, () => this.beaconId);
    this.discovery?.on('change', () => this.emitStatus());
  }

  private get beaconId(): string {
    return this.store.me.deviceId.slice(0, 16);
  }

  get me() {
    return this.store.me;
  }

  /** Start the viewer links to every paired host and the housekeeping timer. Sharing is started separately (setSharing). */
  start() {
    if (this.tick) return;
    this.tick = setInterval(() => this.onTick(), this.opts.pushMs ?? 250);
    for (const d of this.store.list()) if (d.role === 'host') this.ensureLink(d);
  }

  async stop() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    for (const l of this.links.values()) this.dropLink(l);
    this.links.clear();
    this.discovery?.stop();
    await this.setSharing(false);
  }

  // ======================= status =======================

  status(): PeersView {
    const now = Date.now();
    const code = this.codes.current(now);
    const devices: PeerDeviceView[] = this.store.list().map((d) => {
      const base = { key: deviceKey(d), deviceId: d.deviceId, name: d.name, role: d.role, pairedAt: d.pairedAt, lastSeen: d.lastSeen };
      if (d.role === 'host') {
        const l = this.links.get(d.deviceId);
        return {
          ...base,
          host: d.host,
          port: d.port,
          online: l?.state === 'online',
          state: l?.state ?? 'offline',
          error: l?.error ?? null,
          offlineSince: l?.offlineSince ?? null,
        };
      }
      const online = this.conns.has(d.deviceId);
      return { ...base, online, state: online ? 'online' : 'offline', error: null, offlineSince: null };
    });
    const hostIds = new Set(
      this.store
        .list()
        .filter((d) => d.role === 'host')
        .map((d) => d.deviceId.slice(0, 16)),
    );
    const discovered: DiscoveredHostView[] = (this.discovery?.hosts() ?? []).map((h) => ({ ...h, paired: hostIds.has(h.id) }));
    return {
      self: { deviceId: this.me.deviceId, name: this.me.name },
      sharing: this.sharing,
      listening: this.listening,
      port: this.port,
      error: this.serverError,
      code: code.code ? { code: formatCode(code.code), expiresAt: code.expiresAt } : null,
      codeState: code.state,
      failuresLeft: code.failuresLeft,
      lastPairFailure: this.lastPairFailure,
      discovering: !!this.discovery?.listening,
      discovered,
      devices,
    };
  }

  private emitStatus() {
    this.emit('status', this.status());
  }

  // ======================= sharer (server) =======================

  get isSharing(): boolean {
    return this.sharing;
  }

  /** Start or stop sharing. Resolves once listening (or failed to); while off there is no listener at all. */
  setSharing(on: boolean): Promise<void> {
    if (!on) {
      this.sharing = false;
      this.listening = false;
      this.serverError = null;
      const srv = this.server;
      this.server = null;
      for (const s of this.pending) s.close('sharing stopped');
      for (const c of this.conns.values()) c.sock.close('sharing stopped');
      this.codes.clear();
      this.discovery?.stopBeacon();
      this.emitStatus();
      return new Promise((resolve) => (srv ? srv.close(() => resolve()) : resolve()));
    }
    if (this.server) return Promise.resolve();
    this.sharing = true;
    this.serverError = null;
    const srv = net.createServer((raw) => this.onConnection(raw));
    this.server = srv;
    if (this.codes.current(Date.now()).state !== 'active') this.codes.generate(Date.now());
    return new Promise((resolve) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        if (this.server !== srv) return resolve();
        this.server = null;
        this.listening = false;
        this.serverError = err.code === 'EADDRINUSE' ? `port ${this.port} is in use` : err.message;
        this.discovery?.stopBeacon();
        this.emitStatus();
        resolve();
      });
      srv.listen(this.port, this.opts.bindHost, () => {
        if (this.server !== srv) return resolve();
        this.listening = true;
        const addr = srv.address();
        if (addr && typeof addr === 'object') this.port = addr.port; // port 0 (tests): the one picked
        this.discovery?.startBeacon(() => ({ name: this.me.name, port: this.port, id: this.beaconId }));
        this.emitStatus();
        resolve();
      });
    });
  }

  async setPort(port: number) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === this.port) return;
    this.port = port;
    if (this.sharing) {
      await this.setSharing(false);
      await this.setSharing(true);
    } else this.emitStatus();
  }

  newCode() {
    this.codes.generate(Date.now());
    this.lastPairFailure = null;
    this.emitStatus();
  }

  private onConnection(raw: net.Socket) {
    if (!this.sharing || this.pending.size >= MAX_PENDING) {
      raw.destroy();
      return;
    }
    const sock = new PeerSocket(raw);
    this.pending.add(sock);
    sock.on('close', () => this.pending.delete(sock));
    const timer = setTimeout(() => sock.close('handshake timed out'), HANDSHAKE_MS);
    serverHandshake(sock, {
      me: this.me,
      codes: this.codes,
      viewer: (id) => this.store.get('viewer', id),
      onPaired: (peer) => {
        this.store.upsert({ ...peer, role: 'viewer', pairedAt: Date.now(), lastSeen: Date.now() });
      },
      onPairFailure: (reason) => {
        this.lastPairFailure = { reason, at: Date.now() };
        this.emitStatus();
      },
      scryptN: this.opts.scryptN,
    }).then(
      (res) => {
        clearTimeout(timer);
        this.pending.delete(sock);
        if (res.kind === 'paired') {
          this.lastPairFailure = null;
          this.emitStatus();
          sock.sock.end();
          setTimeout(() => sock.close('paired'), 1000).unref();
          return;
        }
        this.attachViewer(sock, res.peer, res.keys);
      },
      () => {
        clearTimeout(timer);
        sock.sock.end();
        setTimeout(() => sock.close('handshake failed'), 500).unref();
      },
    );
  }

  private attachViewer(sock: PeerSocket, peer: PeerIdentity, keys: SessionKeys) {
    if (sock.closed || !this.sharing) return sock.close('closed');
    this.conns.get(peer.deviceId)?.sock.close('replaced by a new connection');
    const c: ViewerConn = {
      peer,
      sock,
      subs: new Map(),
      overviewOn: false,
      ovEnc: new OverviewEncoder(),
      ovVersion: -1,
      sent: { sessions: '', inbox: '', usage: '' },
      lastSlow: 0,
      lastPing: Date.now(),
    };
    this.conns.set(peer.deviceId, c);
    sock.on('close', () => {
      for (const id of c.subs.keys()) this.opts.source.release(id);
      c.subs.clear();
      if (this.conns.get(peer.deviceId) === c) this.conns.delete(peer.deviceId);
      this.emitStatus();
    });
    sock.secure(keys, (m) => this.onViewerMessage(c, m));
    sock.sendJson({ t: 'welcome', deviceId: this.me.deviceId, name: this.me.name });
    this.store.touch('viewer', peer.deviceId, Date.now());
    this.pushViewer(c, true);
    this.emitStatus();
  }

  /** The only inbound messages a sharer accepts. Anything else is ignored: the link is read-only. */
  private onViewerMessage(c: ViewerConn, m: Json) {
    const src = this.opts.source;
    switch (m.t) {
      case 'sub': {
        const id = m.id;
        if (typeof id !== 'string' || !SID_RE.test(id)) return;
        const sub = c.subs.get(id);
        if (sub) {
          // a viewer that lost step asks again: start over with a full view
          sub.enc = new ViewEncoder();
          sub.version = -1;
        } else {
          // only sessions this side shares (live and recent ones) can be streamed
          if (c.subs.size >= MAX_SUBS || !shareableSummaries(src.summaries()).some((s) => s.id === id)) return;
          src.retain(id);
          c.subs.set(id, { enc: new ViewEncoder(), version: -1 });
        }
        this.pushViewer(c, false);
        return;
      }
      case 'unsub': {
        const id = m.id;
        if (typeof id !== 'string' || !c.subs.has(id)) return;
        c.subs.delete(id);
        src.release(id);
        return;
      }
      case 'overview':
        c.overviewOn = m.on === true;
        c.ovEnc = new OverviewEncoder();
        c.ovVersion = -1;
        return;
      default:
        return; // 'ping' and anything unknown: nothing to do
    }
  }

  private pushViewer(c: ViewerConn, force: boolean) {
    if (c.sock.closed) return;
    const src = this.opts.source;
    const now = Date.now();
    if (force || now - c.lastSlow >= 1000) {
      c.lastSlow = now;
      const sessions = shareableSummaries(src.summaries());
      const sj = JSON.stringify(sessions);
      if (sj !== c.sent.sessions) {
        c.sent.sessions = sj;
        c.sock.sendJson({ t: 'sessions', items: sessions });
      }
      const inbox = src.inbox().filter((i) => !i.machine);
      const ij = JSON.stringify(inbox);
      if (ij !== c.sent.inbox) {
        c.sent.inbox = ij;
        c.sock.sendJson({ t: 'inbox', items: inbox });
      }
      // only the computed meters: never tokens or raw API responses
      const u = src.usage();
      const usage: UsageView = { fiveHour: u.fiveHour, sevenDay: u.sevenDay, spend: u.spend, statuslineAt: u.statuslineAt, models: u.models, api: u.api };
      const uj = JSON.stringify(usage);
      if (uj !== c.sent.usage) {
        c.sent.usage = uj;
        c.sock.sendJson({ t: 'usage', usage });
      }
    }
    for (const [id, sub] of c.subs) {
      const v = src.version(id);
      if (v === sub.version) continue;
      const view = src.view(id);
      if (!view) continue;
      sub.version = v;
      c.sock.sendJson({ t: 'view', id, msg: sub.enc.encode(view) });
    }
    if (c.overviewOn) {
      const ov = src.overviewVersion();
      if (ov !== c.ovVersion) {
        c.ovVersion = ov;
        c.sock.sendJson({ t: 'overview', msg: c.ovEnc.encode(src.overview()) });
      }
    }
  }

  // ======================= viewer (client) =======================

  /** Pair with a sharer at host:port using the code it shows. */
  async pair(host: string, port: number, code: string, retryBusy = true): Promise<PairResult> {
    host = host.trim();
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Enter a host and a port.' };
    const r = await this.pairOnce(host, port, code);
    // the sharer allows one attempt per second: a quick retype after a typo just waits
    if (r === 'busy' && retryBusy) {
      await new Promise((res) => setTimeout(res, 1100));
      return this.pair(host, port, code, false);
    }
    return r === 'busy' ? { ok: false, error: new HandshakeError('busy').message } : r;
  }

  private async pairOnce(host: string, port: number, code: string): Promise<PairResult | 'busy'> {
    let sock: PeerSocket;
    try {
      sock = await this.connect(host, port);
    } catch (e) {
      return { ok: false, error: `Could not connect to ${host}:${port}: ${(e as Error).message}` };
    }
    let peer: PeerIdentity;
    try {
      peer = await clientPair(sock, this.me, code, this.opts.scryptN);
    } catch (e) {
      if (e instanceof HandshakeError && e.code === 'busy') return 'busy';
      return { ok: false, error: e instanceof HandshakeError ? e.message : `Pairing failed: ${(e as Error).message}` };
    } finally {
      sock.close('pairing done');
    }
    if (peer.deviceId === this.me.deviceId) return { ok: false, error: 'That is this computer.' };
    const dev: PairedDevice = { ...peer, role: 'host', host, port, pairedAt: Date.now(), lastSeen: Date.now() };
    this.store.upsert(dev);
    const old = this.links.get(dev.deviceId);
    if (old) {
      this.dropLink(old);
      this.links.delete(dev.deviceId);
    }
    if (this.tick) this.ensureLink(dev);
    this.emitStatus();
    return { ok: true, name: peer.name };
  }

  /** Forget a paired device: its key is never accepted again, and its link (either direction) is closed. */
  unpair(key: string) {
    const d = this.store.remove(key);
    if (!d) return;
    if (d.role === 'host') {
      const l = this.links.get(d.deviceId);
      if (l) {
        this.dropLink(l);
        this.links.delete(d.deviceId);
      }
      if (this.selected?.deviceId === d.deviceId) this.selected = null;
      this.emitRemoteAll();
    } else {
      const c = this.conns.get(d.deviceId);
      if (c) {
        c.sock.sendJson({ t: 'revoked' });
        c.sock.sock.end();
        setTimeout(() => c.sock.close('un-paired'), 300).unref();
      }
    }
    this.emitStatus();
  }

  setDiscovering(on: boolean) {
    if (!this.discovery) return;
    if (on) this.discovery.startListening();
    else this.discovery.stopListening();
    this.emitStatus();
  }

  private connect(host: string, port: number): Promise<PeerSocket> {
    return new Promise((resolve, reject) => {
      const raw = net.connect({ host, port });
      const t = setTimeout(() => {
        raw.destroy();
        reject(new Error('timed out'));
      }, HANDSHAKE_MS);
      raw.once('connect', () => {
        clearTimeout(t);
        raw.removeAllListeners('error');
        resolve(new PeerSocket(raw));
      });
      raw.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  private ensureLink(dev: PairedDevice) {
    if (this.links.has(dev.deviceId)) return;
    const l: HostLink = {
      dev,
      sock: null,
      state: 'connecting',
      error: null,
      offlineSince: null,
      summaries: [],
      inbox: [],
      usage: null,
      views: new Map(),
      ovDec: new OverviewDecoder(),
      ovViews: [],
      retryMs: this.opts.retryMs ?? 1000,
      timer: null,
      stopped: false,
      lastPing: 0,
    };
    if (this.selected?.deviceId === dev.deviceId) l.views.set(this.selected.id, new ViewDecoder());
    this.links.set(dev.deviceId, l);
    void this.connectLink(l);
  }

  private dropLink(l: HostLink) {
    l.stopped = true;
    if (l.timer) clearTimeout(l.timer);
    l.timer = null;
    l.sock?.close('link closed');
    l.sock = null;
  }

  private async connectLink(l: HostLink) {
    if (l.stopped) return;
    l.timer = null;
    if (l.state !== 'online') l.state = 'connecting';
    this.emitStatus();
    let sock: PeerSocket;
    try {
      sock = await this.connect(l.dev.host ?? '', l.dev.port ?? DEFAULT_PEER_PORT);
    } catch (e) {
      return this.linkFailed(l, (e as Error).message);
    }
    if (l.stopped) return sock.close('stopped');
    let keys: SessionKeys;
    try {
      keys = await clientAuth(sock, this.me, l.dev);
    } catch (e) {
      sock.close('auth failed');
      if (e instanceof HandshakeError && e.code === 'unknown-device') return this.revoked(l);
      return this.linkFailed(l, (e as Error).message);
    }
    if (l.stopped) return sock.close('stopped');
    l.sock = sock;
    l.lastPing = Date.now();
    sock.on('close', (reason: string) => {
      if (l.sock !== sock) return;
      l.sock = null;
      if (reason === 'error:unknown-device' || reason === 'error:bad-signature') return this.revoked(l);
      this.linkFailed(l, reason);
    });
    sock.secure(keys, (m) => this.onHostMessage(l, sock, m));
    // what this side wants is re-requested on every connection
    for (const id of l.views.keys()) {
      l.views.set(id, new ViewDecoder());
      sock.sendJson({ t: 'sub', id });
    }
    if (this.overviewWanted) sock.sendJson({ t: 'overview', on: true });
  }

  private linkFailed(l: HostLink, error: string) {
    if (l.stopped) return;
    const wasOnline = l.state === 'online';
    l.state = 'offline';
    l.error = error;
    if (wasOnline || l.offlineSince === null) l.offlineSince = Date.now();
    // stale state of a host we can no longer see: views, overview and inbox go; summaries stay (shown offline)
    l.ovDec = new OverviewDecoder();
    l.ovViews = [];
    l.inbox = [];
    for (const id of l.views.keys()) l.views.set(id, new ViewDecoder());
    this.emitRemoteAll();
    this.emitStatus();
    const jitter = 0.8 + Math.random() * 0.4;
    l.timer = setTimeout(() => void this.connectLink(l), Math.round(l.retryMs * jitter));
    l.retryMs = Math.min(MAX_RETRY_MS, l.retryMs * 2);
  }

  private revoked(l: HostLink) {
    this.linkFailed(l, 'This computer was un-paired on the other side.');
    if (l.timer) clearTimeout(l.timer);
    l.timer = null;
    l.state = 'revoked';
    l.stopped = true;
    this.emitStatus();
  }

  private onHostMessage(l: HostLink, sock: PeerSocket, m: Json) {
    switch (m.t) {
      case 'welcome': {
        l.state = 'online';
        l.error = null;
        l.offlineSince = null;
        l.retryMs = this.opts.retryMs ?? 1000;
        if (typeof m.name === 'string' && m.name && m.name.length <= 100 && m.name !== l.dev.name) {
          l.dev = { ...l.dev, name: m.name };
          this.store.upsert(l.dev);
        }
        this.store.touch('host', l.dev.deviceId, Date.now());
        this.emitStatus();
        this.emit('sessions');
        return;
      }
      case 'sessions':
        if (!Array.isArray(m.items)) return;
        l.summaries = (m.items as SessionSummary[]).filter((s) => isObj(s) && typeof s.id === 'string' && SID_RE.test(s.id));
        this.emit('sessions');
        return;
      case 'inbox':
        if (!Array.isArray(m.items)) return;
        l.inbox = (m.items as InboxItem[]).filter(
          (i) =>
            isObj(i) &&
            typeof i.id === 'string' &&
            (typeof i.sessionId === 'string' || i.sessionId === null) &&
            typeof i.title === 'string' &&
            typeof i.detail === 'string' &&
            typeof i.lastSeen === 'number',
        );
        this.emit('inbox');
        return;
      case 'usage':
        if (!isObj(m.usage)) return;
        l.usage = m.usage as unknown as UsageView;
        this.emit('usage');
        return;
      case 'view': {
        const id = m.id;
        if (typeof id !== 'string' || !isObj(m.msg)) return;
        const dec = l.views.get(id);
        if (!dec) return;
        const v = dec.apply(m.msg as unknown as ViewMsg);
        if (v === undefined || (v !== null && !isViewShape(v))) {
          l.views.set(id, new ViewDecoder());
          sock.sendJson({ t: 'sub', id }); // out of step: ask for a full view again
          return;
        }
        this.emit('view', remoteId(l.dev.deviceId, id));
        return;
      }
      case 'overview': {
        if (!isObj(m.msg) || !Array.isArray(m.msg.items) || !this.overviewWanted) return;
        const vs = l.ovDec.apply(m.msg as unknown as OverviewMsg);
        if (vs === undefined || vs.some((v) => !isViewShape(v))) {
          l.ovDec = new OverviewDecoder();
          sock.sendJson({ t: 'overview', on: true });
          return;
        }
        l.ovViews = vs;
        this.emit('overview');
        return;
      }
      case 'revoked':
        sock.close('revoked');
        this.revoked(l);
        return;
      default:
        return;
    }
  }

  private emitRemoteAll() {
    this.emit('sessions');
    this.emit('inbox');
    this.emit('usage');
    this.emit('overview');
    if (this.selected) this.emit('view', remoteId(this.selected.deviceId, this.selected.id));
  }

  // ---- what the SessionManager / inbox / usage read (RemoteSource) ----

  private hostData(): RemoteHostData[] {
    const out: RemoteHostData[] = [];
    for (const l of this.links.values()) {
      out.push({
        deviceId: l.dev.deviceId,
        machine: l.dev.name,
        offlineSince: l.state === 'online' ? null : (l.offlineSince ?? Date.now()),
        summaries: l.summaries,
      });
    }
    return out;
  }

  /** every host's sessions, namespaced (remote:<deviceId>:<sessionId>) with a machine name */
  summaries(): SessionSummary[] {
    return mergeSummaries([], this.hostData());
  }

  view(nsId: string): SessionView | null {
    const p = parseRemoteId(nsId);
    if (!p) return null;
    const l = this.links.get(p.deviceId);
    const v = l?.views.get(p.id)?.view;
    return l && v ? namespaceView(v, l.dev.deviceId, l.dev.name) : null;
  }

  overview(): SessionView[] {
    const out: SessionView[] = [];
    for (const l of this.links.values()) if (l.state === 'online') for (const v of l.ovViews) out.push(namespaceView(v, l.dev.deviceId, l.dev.name));
    return out;
  }

  /** Stream this remote session's view (unsubscribing the previous one); null or a local id stops streaming. */
  setSelected(nsId: string | null) {
    const p = nsId ? parseRemoteId(nsId) : null;
    const prev = this.selected;
    if (prev && p && prev.deviceId === p.deviceId && prev.id === p.id) return;
    if (prev) {
      const l = this.links.get(prev.deviceId);
      if (l?.views.delete(prev.id)) l.sock?.sendJson({ t: 'unsub', id: prev.id });
    }
    this.selected = p;
    if (!p) return;
    const l = this.links.get(p.deviceId);
    if (!l) return;
    l.views.set(p.id, new ViewDecoder());
    l.sock?.sendJson({ t: 'sub', id: p.id });
  }

  setOverviewWanted(on: boolean) {
    if (on === this.overviewWanted) return;
    this.overviewWanted = on;
    for (const l of this.links.values()) {
      l.ovDec = new OverviewDecoder();
      l.ovViews = [];
      l.sock?.sendJson({ t: 'overview', on });
    }
  }

  remoteInbox(): RemoteInbox[] {
    const out: RemoteInbox[] = [];
    for (const l of this.links.values()) if (l.state === 'online') out.push({ deviceId: l.dev.deviceId, machine: l.dev.name, items: l.inbox });
    return out;
  }

  remoteUsage(): UsageView[] {
    const out: UsageView[] = [];
    for (const l of this.links.values()) if (l.usage) out.push(l.usage);
    return out;
  }

  /** name of the machine a remote session id belongs to */
  machineOf(nsId: string): string | null {
    const p = parseRemoteId(nsId);
    if (!p) return null;
    return this.links.get(p.deviceId)?.dev.name ?? this.store.get('host', p.deviceId)?.name ?? 'another computer';
  }

  // ======================= housekeeping =======================

  private onTick() {
    const now = Date.now();
    const hb = this.opts.heartbeatMs ?? 10_000;
    for (const c of this.conns.values()) {
      this.pushViewer(c, false);
      if (now - c.lastPing >= hb) {
        c.lastPing = now;
        c.sock.sendJson({ t: 'ping' });
      }
      if (now - c.sock.lastRecv > hb * 3) c.sock.close('no heartbeat');
    }
    for (const l of this.links.values()) {
      const s = l.sock;
      if (!s || s.closed) continue;
      if (now - l.lastPing >= hb) {
        l.lastPing = now;
        s.sendJson({ t: 'ping' });
      }
      if (now - s.lastRecv > hb * 3) s.close('no heartbeat');
    }
    const cs = this.codes.current(now).state;
    if (cs !== this.lastCodeState) {
      this.lastCodeState = cs;
      this.emitStatus();
    }
  }
}
