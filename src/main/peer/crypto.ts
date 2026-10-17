// Crypto building blocks of the peer link, all from node:crypto (see docs/PEER-LINK.md for the design):
// pairing codes, scrypt + HKDF key derivation, HMAC, Ed25519 identities, X25519 ECDH and the AES-256-GCM channel with counter nonces.
import crypto, { type KeyObject } from 'node:crypto';

// ---- pairing codes ----

/** Crockford base32: no I, L, O, U, so codes read aloud and typed by hand survive */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LEN = 8; // 8 x 5 bits = 40 bits
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_FAILURES = 5;

export function newPairingCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/** "7kq4-m2xd", "7KQ4 M2XD", "7KQ4M2XD" -> "7KQ4M2XD"; Crockford's look-alikes are folded (O->0, I/L->1). */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export type CodeState = 'none' | 'active' | 'expired' | 'locked' | 'used';

/**
 * The sharer's current pairing code: valid for 10 minutes, single use, at most one attempt per `minIntervalMs`, burned after MAX_FAILURES wrong
 * attempts (a new one must then be generated on the sharer).
 */
export class PairingCodes {
  private code: string | null = null;
  private expiresAt = 0;
  private failures = 0;
  private state: CodeState = 'none';
  private lastAttempt = -Infinity;

  constructor(
    private opts: { ttlMs?: number; maxFailures?: number; minIntervalMs?: number } = {},
    private gen: () => string = newPairingCode,
  ) {}

  generate(now: number): string {
    this.code = this.gen();
    this.expiresAt = now + (this.opts.ttlMs ?? CODE_TTL_MS);
    this.failures = 0;
    this.state = 'active';
    return this.code;
  }

  clear() {
    this.code = null;
    this.state = 'none';
  }

  current(now: number): { state: CodeState; code: string | null; expiresAt: number; failuresLeft: number } {
    if (this.state === 'active' && now >= this.expiresAt) {
      this.state = 'expired';
      this.code = null;
    }
    const max = this.opts.maxFailures ?? MAX_FAILURES;
    return { state: this.state, code: this.state === 'active' ? this.code : null, expiresAt: this.expiresAt, failuresLeft: Math.max(0, max - this.failures) };
  }

  /** Start an attempt: the code to check against, or why there is none. */
  begin(now: number): { ok: true; code: string } | { ok: false; reason: 'no-code' | 'expired' | 'locked' | 'busy' } {
    const cur = this.current(now);
    if (cur.state === 'locked') return { ok: false, reason: 'locked' };
    if (cur.state === 'expired') return { ok: false, reason: 'expired' };
    if (cur.state !== 'active' || !cur.code) return { ok: false, reason: 'no-code' };
    if (now - this.lastAttempt < (this.opts.minIntervalMs ?? 1000)) return { ok: false, reason: 'busy' };
    this.lastAttempt = now;
    return { ok: true, code: cur.code };
  }

  fail() {
    this.failures++;
    if (this.failures >= (this.opts.maxFailures ?? MAX_FAILURES)) {
      this.state = 'locked';
      this.code = null;
    }
  }

  consume() {
    this.state = 'used';
    this.code = null;
  }
}

// ---- key derivation and MACs ----

export const SCRYPT_N = 1 << 14;

export function scryptKey(code: string, salt: Buffer, N = SCRYPT_N): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(normalizeCode(code), salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32));
}

export function hmac(key: Buffer, ...parts: (Buffer | string)[]): Buffer {
  const h = crypto.createHmac('sha256', key);
  for (const p of lenPrefixed(parts)) h.update(p);
  return h.digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Unambiguous concatenation: every part prefixed with its length. */
function lenPrefixed(parts: (Buffer | string)[]): Buffer[] {
  const out: Buffer[] = [];
  for (const p of parts) {
    const b = typeof p === 'string' ? Buffer.from(p, 'utf8') : p;
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length, 0);
    out.push(n, b);
  }
  return out;
}

export function sha256(...parts: (Buffer | string)[]): Buffer {
  const h = crypto.createHash('sha256');
  for (const p of lenPrefixed(parts)) h.update(p);
  return h.digest();
}

export const random = (n: number): Buffer => crypto.randomBytes(n);

// ---- one-shot boxes (identity exchange during pairing) ----

export function seal(key: Buffer, plain: Buffer, aad: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

export function open(key: Buffer, box: string, aad: Buffer): Buffer {
  const raw = Buffer.from(box, 'base64');
  if (raw.length < 28) throw new Error('box too short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
}

// ---- identities ----

export interface Identity {
  deviceId: string;
  name: string;
  /** Ed25519 public key, SPKI DER, base64 */
  pub: string;
  priv: KeyObject;
}

/** A device id is bound to its key: the first 16 bytes of SHA-256 of the public key, hex. */
export function deviceIdOf(pubB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 32);
}

export function newIdentity(name: string): Identity & { privDer: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { deviceId: deviceIdOf(pub), name, pub, priv: privateKey, privDer: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

export function loadPrivateKey(der: string): KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });
}

export function publicKeyOf(pubB64: string): KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
}

export function sign(priv: KeyObject, data: Buffer): Buffer {
  return crypto.sign(null, data, priv);
}

export function verify(pubB64: string, data: Buffer, sig: Buffer): boolean {
  try {
    return crypto.verify(null, data, publicKeyOf(pubB64), sig);
  } catch {
    return false;
  }
}

// ---- ephemeral ECDH ----

export interface Ephemeral {
  pub: Buffer;
  priv: KeyObject;
}

export function newEphemeral(): Ephemeral {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }), priv: privateKey };
}

export function ecdh(mine: Ephemeral, theirs: Buffer): Buffer {
  const pub = crypto.createPublicKey({ key: theirs, format: 'der', type: 'spki' });
  if (pub.asymmetricKeyType !== 'x25519') throw new Error('not an X25519 key');
  return crypto.diffieHellman({ privateKey: mine.priv, publicKey: pub });
}

// ---- the encrypted channel ----

/**
 * One direction of the channel: AES-256-GCM with a 96-bit nonce made of a 64-bit message counter. Each direction has its own key, so nonces never
 * repeat under a key. The receiver only accepts the next counter value: a replayed, reordered, dropped or modified frame fails to open.
 */
export class CipherState {
  private n = 0n;
  constructor(private key: Buffer) {
    if (key.length !== 32) throw new Error('key must be 32 bytes');
  }

  private nonce(): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.n, 4);
    return iv;
  }

  seal(plain: Buffer): Buffer {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, this.nonce());
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    this.n++;
    return ct;
  }

  /** Throws when the frame is not the next authentic one; the caller must then drop the connection. */
  open(frame: Buffer): Buffer {
    if (frame.length < 16) throw new Error('frame too short');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, this.nonce());
    d.setAAD(AAD);
    d.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()]);
    this.n++;
    return plain;
  }
}

const AAD = Buffer.from('cvis1 frame', 'utf8');
