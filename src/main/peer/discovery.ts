// LAN discovery: while sharing, a small UDP broadcast beacon says "a Claude Visualized share is here" (name, port, a device-id hash; no session
// data). Viewers listen only while the Devices page is open. mDNS would need a dependency or a hand-written DNS codec; a beacon is enough here.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

export const DISCOVERY_PORT = 47831;
const BEACON_MS = 3000;
const FORGET_MS = 10_000;
const APP = 'claude-visualized';

export interface Beacon {
  name: string;
  port: number;
  /** short hash of the device id: enough to tell machines apart and to match a paired one */
  id: string;
}

export interface Discovered extends Beacon {
  host: string;
  seenAt: number;
}

/** IPv4 broadcast addresses of this machine's interfaces, plus the limited broadcast address. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

export function parseBeacon(raw: Buffer): Beacon | null {
  if (raw.length > 512) return null;
  try {
    const o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (o.app !== APP || o.v !== 1) return null;
    const { name, port, id } = o;
    if (typeof name !== 'string' || !name || name.length > 100) return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof id !== 'string' || !/^[0-9a-f]{8,32}$/.test(id)) return null;
    return { name, port, id };
  } catch {
    return null;
  }
}

/** Events: 'change' when the list of discovered hosts changes. */
export class Discovery extends EventEmitter {
  private beaconSock: dgram.Socket | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private listenSock: dgram.Socket | null = null;
  private found = new Map<string, Discovered>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    private port = DISCOVERY_PORT,
    private ownId: () => string,
  ) {
    super();
  }

  startBeacon(info: () => Beacon) {
    if (this.beaconSock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => this.stopBeacon());
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        return;
      }
      const send = () => {
        const msg = Buffer.from(JSON.stringify({ app: APP, v: 1, ...info() }));
        for (const addr of broadcastAddresses()) sock.send(msg, this.port, addr, () => {});
      };
      send();
      this.beaconTimer = setInterval(send, BEACON_MS);
    });
    this.beaconSock = sock;
  }

  stopBeacon() {
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    try {
      this.beaconSock?.close();
    } catch {
      /* already closed */
    }
    this.beaconSock = null;
  }

  get listening(): boolean {
    return !!this.listenSock;
  }

  startListening() {
    if (this.listenSock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => this.stopListening());
    sock.on('message', (raw, rinfo) => {
      const b = parseBeacon(raw);
      if (!b || b.id === this.ownId()) return;
      const key = `${rinfo.address}:${b.port}`;
      const had = this.found.get(key);
      this.found.set(key, { ...b, host: rinfo.address, seenAt: Date.now() });
      if (!had || had.name !== b.name || had.id !== b.id) this.emit('change');
    });
    sock.bind(this.port);
    this.listenSock = sock;
    this.sweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, d] of this.found) {
        if (now - d.seenAt > FORGET_MS) {
          this.found.delete(k);
          changed = true;
        }
      }
      if (changed) this.emit('change');
    }, 2000);
  }

  stopListening() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    try {
      this.listenSock?.close();
    } catch {
      /* already closed */
    }
    this.listenSock = null;
    if (this.found.size) {
      this.found.clear();
      this.emit('change');
    }
  }

  hosts(): Discovered[] {
    return [...this.found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  stop() {
    this.stopBeacon();
    this.stopListening();
  }
}
