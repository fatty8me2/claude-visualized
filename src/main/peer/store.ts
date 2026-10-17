// This device's identity and its paired devices, in userData/peers.json (mode 0600: it holds the private key).
import fs from 'node:fs';
import path from 'node:path';
import { loadPrivateKey, newIdentity, type Identity } from './crypto';
import type { PeerIdentity } from './handshake';

/** 'viewer': a device that may watch this one (we share with it). 'host': a device we watch (it shares with us). */
export type PeerRole = 'viewer' | 'host';

export interface PairedDevice extends PeerIdentity {
  role: PeerRole;
  /** hosts only: where to connect */
  host?: string;
  port?: number;
  pairedAt: number;
  lastSeen: number | null;
}

interface StoreFile {
  version: 1;
  identity: { deviceId: string; pub: string; priv: string };
  devices: PairedDevice[];
}

export const deviceKey = (d: { role: PeerRole; deviceId: string }) => `${d.role}:${d.deviceId}`;

export class PeerStore {
  readonly me: Identity;
  private devices: PairedDevice[] = [];
  private privDer: string;

  constructor(
    private file: string,
    name: string,
  ) {
    let data: StoreFile | null = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as StoreFile;
    } catch {
      /* first run */
    }
    if (data?.identity?.priv) {
      this.me = { deviceId: data.identity.deviceId, pub: data.identity.pub, priv: loadPrivateKey(data.identity.priv), name };
      this.privDer = data.identity.priv;
      this.devices = Array.isArray(data.devices) ? data.devices.filter((d) => d && typeof d.deviceId === 'string' && typeof d.pub === 'string') : [];
    } else {
      const id = newIdentity(name);
      this.me = { deviceId: id.deviceId, pub: id.pub, priv: id.priv, name };
      this.privDer = id.privDer;
      this.save();
    }
  }

  list(): readonly PairedDevice[] {
    return this.devices;
  }

  get(role: PeerRole, deviceId: string): PairedDevice | null {
    return this.devices.find((d) => d.role === role && d.deviceId === deviceId) ?? null;
  }

  upsert(d: PairedDevice) {
    this.devices = [...this.devices.filter((x) => deviceKey(x) !== deviceKey(d)), d];
    this.save();
  }

  touch(role: PeerRole, deviceId: string, at: number) {
    const d = this.get(role, deviceId);
    if (!d) return;
    d.lastSeen = at;
    this.save();
  }

  remove(key: string): PairedDevice | null {
    const d = this.devices.find((x) => deviceKey(x) === key) ?? null;
    if (d) {
      this.devices = this.devices.filter((x) => x !== d);
      this.save();
    }
    return d;
  }

  private save() {
    const data: StoreFile = { version: 1, identity: { deviceId: this.me.deviceId, pub: this.me.pub, priv: this.privDer }, devices: this.devices };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('peers.json save failed', e);
    }
  }
}
