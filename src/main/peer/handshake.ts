// Pairing (code) and authentication (device keys) handshakes, independent of the transport. Protocol: docs/PEER-LINK.md.
import {
  deviceIdOf,
  ecdh,
  hkdf,
  hmac,
  newEphemeral,
  open,
  random,
  safeEqual,
  scryptKey,
  seal,
  sha256,
  sign,
  verify,
  type Identity,
  type PairingCodes,
} from './crypto';
import type { HandshakeChannel, Json, SessionKeys } from './link';

export const PROTOCOL = 1;

/** A paired device as stored and exchanged: no private parts. */
export interface PeerIdentity {
  deviceId: string;
  name: string;
  pub: string;
}

export type HandshakeErrorCode =
  'no-code' | 'expired' | 'locked' | 'busy' | 'bad-code' | 'unknown-device' | 'bad-signature' | 'server-auth' | 'protocol' | 'version';

const MESSAGES: Record<HandshakeErrorCode, string> = {
  'no-code': 'The other computer has no pairing code right now. Turn sharing on there and use the code it shows.',
  expired: 'That pairing code has expired. Generate a new one on the other computer.',
  locked: 'Too many wrong codes. Generate a new code on the other computer.',
  busy: 'Too many attempts; wait a second and try again.',
  'bad-code': 'Wrong pairing code.',
  'unknown-device': 'The other computer does not know this device (it was un-paired there). Pair again.',
  'bad-signature': 'The device key did not verify.',
  'server-auth': 'The other computer could not prove it knows the code; this may not be the computer you meant.',
  protocol: 'Unexpected message from the other computer.',
  version: 'The other computer runs an incompatible version of Claude Visualized.',
};

export class HandshakeError extends Error {
  constructor(
    readonly code: HandshakeErrorCode,
    detail?: string,
  ) {
    super(detail ?? MESSAGES[code]);
  }
}

const b64 = (b: Buffer) => b.toString('base64');

function buf(o: Json, key: string, len?: number): Buffer {
  const v = o[key];
  if (typeof v !== 'string' || v.length > 4096) throw new HandshakeError('protocol', `missing ${key}`);
  const b = Buffer.from(v, 'base64');
  if (len !== undefined && b.length !== len) throw new HandshakeError('protocol', `bad ${key}`);
  return b;
}

function str(o: Json, key: string, max = 200): string {
  const v = o[key];
  if (typeof v !== 'string' || !v || v.length > max) throw new HandshakeError('protocol', `missing ${key}`);
  return v;
}

async function expect(ch: HandshakeChannel, t: string): Promise<Json> {
  const m = await ch.recvJson();
  if (m.t === 'error') {
    const code = typeof m.code === 'string' && m.code in MESSAGES ? (m.code as HandshakeErrorCode) : 'protocol';
    throw new HandshakeError(code);
  }
  if (m.t !== t) throw new HandshakeError('protocol', `expected ${t}, got ${String(m.t)}`);
  return m;
}

function parseIdentity(raw: Buffer): PeerIdentity {
  let o: Json;
  try {
    o = JSON.parse(raw.toString('utf8')) as Json;
  } catch {
    throw new HandshakeError('protocol', 'bad identity');
  }
  const id: PeerIdentity = { deviceId: str(o, 'deviceId', 64), name: str(o, 'name', 100), pub: str(o, 'pub', 200) };
  // the id must be the hash of the key, so nobody can claim another device's id
  if (deviceIdOf(id.pub) !== id.deviceId) throw new HandshakeError('protocol', 'device id does not match its key');
  return id;
}

const publicPart = (me: Identity): PeerIdentity => ({ deviceId: me.deviceId, name: me.name, pub: me.pub });

async function pairKeys(code: string, salt: Buffer, scryptN?: number) {
  const k = await scryptKey(code, salt, scryptN);
  return { auth: hkdf(k, salt, 'cvis1 pair auth'), box: hkdf(k, salt, 'cvis1 pair box') };
}

/** transcript hash of an auth handshake: both ids, both nonces, both ephemeral keys */
function transcript(clientId: string, serverId: string, nc: Buffer, ns: Buffer, ec: Buffer, es: Buffer): Buffer {
  return sha256('cvis1 auth', clientId, serverId, nc, ns, ec, es);
}

function sessionKeys(shared: Buffer, th: Buffer, side: 'client' | 'server'): SessionKeys {
  const c2s = hkdf(shared, th, 'cvis1 c2s');
  const s2c = hkdf(shared, th, 'cvis1 s2c');
  return side === 'client' ? { send: c2s, recv: s2c } : { send: s2c, recv: c2s };
}

// ---------------- server (sharer) ----------------

export interface ServerContext {
  me: Identity;
  codes: PairingCodes;
  /** a paired viewer by device id */
  viewer(deviceId: string): PeerIdentity | null;
  onPaired(peer: PeerIdentity): void;
  /** a failed pairing attempt, for the UI */
  onPairFailure?(reason: HandshakeErrorCode): void;
  now?: () => number;
  scryptN?: number;
}

export type ServerResult = { kind: 'paired'; peer: PeerIdentity } | { kind: 'auth'; peer: PeerIdentity; keys: SessionKeys };

/** Run the sharer's side. Errors are sent to the client before the HandshakeError is thrown; the caller closes the connection. */
export async function serverHandshake(ch: HandshakeChannel, ctx: ServerContext): Promise<ServerResult> {
  const now = ctx.now ?? Date.now;
  const fail = (code: HandshakeErrorCode): never => {
    ch.sendJson({ t: 'error', code });
    throw new HandshakeError(code);
  };
  const hello = await ch.recvJson();
  if (hello.t !== 'hello') return fail('protocol');
  if (hello.v !== PROTOCOL) return fail('version');

  if (hello.mode === 'pair') {
    const attempt = ctx.codes.begin(now());
    if (!attempt.ok) {
      ctx.onPairFailure?.(attempt.reason);
      return fail(attempt.reason);
    }
    const salt = random(16);
    const ns = random(32);
    ch.sendJson({ t: 'pair-salt', salt: b64(salt), ns: b64(ns) });
    const keysP = pairKeys(attempt.code, salt, ctx.scryptN);
    const proof = await expect(ch, 'pair-proof');
    const keys = await keysP;
    const nc = buf(proof, 'nc', 32);
    const mac = buf(proof, 'mac', 32);
    if (!safeEqual(mac, hmac(keys.auth, 'client', ns, nc))) {
      ctx.codes.fail();
      ctx.onPairFailure?.('bad-code');
      return fail('bad-code');
    }
    let peer: PeerIdentity;
    try {
      peer = parseIdentity(open(keys.box, str(proof, 'box', 4096), Buffer.concat([Buffer.from('c2s'), ns, nc])));
    } catch {
      return fail('protocol');
    }
    ctx.codes.consume();
    ctx.onPaired(peer);
    ch.sendJson({
      t: 'pair-ok',
      mac: b64(hmac(keys.auth, 'server', ns, nc)),
      box: seal(keys.box, Buffer.from(JSON.stringify(publicPart(ctx.me))), Buffer.concat([Buffer.from('s2c'), ns, nc])),
    });
    return { kind: 'paired', peer };
  }

  if (hello.mode === 'auth') {
    const clientId = str(hello, 'deviceId', 64);
    const nc = buf(hello, 'nc', 32);
    const ec = buf(hello, 'eph');
    const peer = ctx.viewer(clientId);
    if (!peer) return fail('unknown-device');
    const eph = newEphemeral();
    let shared: Buffer;
    try {
      shared = ecdh(eph, ec);
    } catch {
      return fail('protocol');
    }
    const ns = random(32);
    const th = transcript(clientId, ctx.me.deviceId, nc, ns, ec, eph.pub);
    ch.sendJson({
      t: 'auth-chal',
      deviceId: ctx.me.deviceId,
      ns: b64(ns),
      eph: b64(eph.pub),
      sig: b64(sign(ctx.me.priv, Buffer.concat([Buffer.from('server'), th]))),
    });
    const resp = await expect(ch, 'auth-resp');
    if (!verify(peer.pub, Buffer.concat([Buffer.from('client'), th]), buf(resp, 'sig'))) return fail('bad-signature');
    return { kind: 'auth', peer, keys: sessionKeys(shared, th, 'server') };
  }
  return fail('protocol');
}

// ---------------- client (viewer) ----------------

/** Pair with a sharer using its code; returns the sharer's identity to store. */
export async function clientPair(ch: HandshakeChannel, me: Identity, code: string, scryptN?: number): Promise<PeerIdentity> {
  ch.sendJson({ t: 'hello', v: PROTOCOL, mode: 'pair' });
  const salted = await expect(ch, 'pair-salt');
  const salt = buf(salted, 'salt', 16);
  const ns = buf(salted, 'ns', 32);
  const keys = await pairKeys(code, salt, scryptN);
  const nc = random(32);
  ch.sendJson({
    t: 'pair-proof',
    nc: b64(nc),
    mac: b64(hmac(keys.auth, 'client', ns, nc)),
    box: seal(keys.box, Buffer.from(JSON.stringify(publicPart(me))), Buffer.concat([Buffer.from('c2s'), ns, nc])),
  });
  const ok = await expect(ch, 'pair-ok');
  if (!safeEqual(buf(ok, 'mac', 32), hmac(keys.auth, 'server', ns, nc))) throw new HandshakeError('server-auth');
  try {
    return parseIdentity(open(keys.box, str(ok, 'box', 4096), Buffer.concat([Buffer.from('s2c'), ns, nc])));
  } catch {
    throw new HandshakeError('server-auth');
  }
}

/** Authenticate to a paired sharer with device keys; returns the session keys of the encrypted channel. */
export async function clientAuth(ch: HandshakeChannel, me: Identity, host: PeerIdentity): Promise<SessionKeys> {
  const eph = newEphemeral();
  const nc = random(32);
  ch.sendJson({ t: 'hello', v: PROTOCOL, mode: 'auth', deviceId: me.deviceId, nc: b64(nc), eph: b64(eph.pub) });
  const chal = await expect(ch, 'auth-chal');
  if (chal.deviceId !== host.deviceId) throw new HandshakeError('bad-signature', 'A different computer answered at that address.');
  const ns = buf(chal, 'ns', 32);
  const es = buf(chal, 'eph');
  const th = transcript(me.deviceId, host.deviceId, nc, ns, eph.pub, es);
  if (!verify(host.pub, Buffer.concat([Buffer.from('server'), th]), buf(chal, 'sig'))) throw new HandshakeError('bad-signature');
  let shared: Buffer;
  try {
    shared = ecdh(eph, es);
  } catch {
    throw new HandshakeError('protocol', 'bad ephemeral key');
  }
  ch.sendJson({ t: 'auth-resp', sig: b64(sign(me.priv, Buffer.concat([Buffer.from('client'), th]))) });
  return sessionKeys(shared, th, 'client');
}
