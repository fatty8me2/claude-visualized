// Peer link handshake and channel crypto (docs/PEER-LINK.md), driven over an in-memory channel pair.
import { describe, expect, it } from 'vitest';
import { CipherState, CODE_TTL_MS, deviceIdOf, newIdentity, normalizeCode, PairingCodes, random, type Identity } from '../../src/main/peer/crypto';
import { clientAuth, clientPair, HandshakeError, serverHandshake, type PeerIdentity, type ServerContext } from '../../src/main/peer/handshake';
import type { HandshakeChannel, Json } from '../../src/main/peer/link';

/** two connected in-memory channels; every message is JSON round-tripped and recorded */
function channelPair(): { a: HandshakeChannel; b: HandshakeChannel; aSent: Json[]; bSent: Json[] } {
  const mk = (sent: Json[]) => {
    const q: Json[] = [];
    let waiter: ((o: Json) => void) | null = null;
    const ch = {
      push(o: Json) {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(o);
        } else q.push(o);
      },
      recvJson: (ms = 2000) =>
        new Promise<Json>((resolve, reject) => {
          const o = q.shift();
          if (o) return resolve(o);
          const t = setTimeout(() => reject(new Error('timeout')), ms);
          waiter = (v) => {
            clearTimeout(t);
            resolve(v);
          };
        }),
      sendJson: (_o: Json) => {},
      sent,
    };
    return ch;
  };
  const aSent: Json[] = [];
  const bSent: Json[] = [];
  const a = mk(aSent);
  const b = mk(bSent);
  a.sendJson = (o) => {
    const c = JSON.parse(JSON.stringify(o)) as Json;
    aSent.push(c);
    b.push(c);
  };
  b.sendJson = (o) => {
    const c = JSON.parse(JSON.stringify(o)) as Json;
    bSent.push(c);
    a.push(c);
  };
  return { a, b, aSent, bSent };
}

const N = 1024; // small scrypt cost keeps the tests fast; the app uses 2^14
const ident = (name: string): Identity => {
  const i = newIdentity(name);
  return { deviceId: i.deviceId, name, pub: i.pub, priv: i.priv };
};
const pub = (i: Identity): PeerIdentity => ({ deviceId: i.deviceId, name: i.name, pub: i.pub });

function server(me: Identity, codes: PairingCodes, viewers: Map<string, PeerIdentity>) {
  const paired: PeerIdentity[] = [];
  const ctx: ServerContext = {
    me,
    codes,
    viewer: (id) => viewers.get(id) ?? null,
    onPaired: (p) => {
      paired.push(p);
      viewers.set(p.deviceId, p);
    },
    scryptN: N,
  };
  return { ctx, paired };
}

const settle = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );

describe('pairing codes', () => {
  it('are 8 Crockford base32 characters and normalize typing variants', () => {
    const c = new PairingCodes();
    const code = c.generate(0);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(normalizeCode('7kq4-m2xd')).toBe('7KQ4M2XD');
    expect(normalizeCode(' 7KQ4 M2XD ')).toBe('7KQ4M2XD');
    expect(normalizeCode('O1IL')).toBe('0111');
  });

  it('expire after 10 minutes', () => {
    const c = new PairingCodes({ minIntervalMs: 0 });
    c.generate(1000);
    expect(c.begin(1000 + CODE_TTL_MS - 1).ok).toBe(true);
    expect(c.begin(1000 + CODE_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(c.current(1000 + CODE_TTL_MS).code).toBeNull();
  });

  it('lock after 5 failures, and rate-limit attempts', () => {
    const c = new PairingCodes({ minIntervalMs: 1000 });
    c.generate(0);
    for (let i = 0; i < 5; i++) {
      expect(c.begin(i * 1000).ok).toBe(true);
      c.fail();
    }
    expect(c.begin(10_000)).toEqual({ ok: false, reason: 'locked' });
    const d = new PairingCodes({ minIntervalMs: 1000 });
    d.generate(0);
    expect(d.begin(5000).ok).toBe(true);
    expect(d.begin(5500)).toEqual({ ok: false, reason: 'busy' });
  });
});

describe('pairing handshake', () => {
  it('pairs with the right code and exchanges identities', async () => {
    const s = ident('Mac');
    const c = ident('PC');
    const codes = new PairingCodes({ minIntervalMs: 0 });
    const code = codes.generate(Date.now());
    const { a, b } = channelPair();
    const srv = server(s, codes, new Map());
    const [sr, host] = await Promise.all([serverHandshake(a, srv.ctx), clientPair(b, c, code.toLowerCase().replace(/^(.{4})/, '$1-'), N)]);
    expect(sr.kind).toBe('paired');
    expect(srv.paired).toEqual([pub(c)]);
    expect(host).toEqual(pub(s));
    // single use
    expect(codes.current(Date.now()).state).toBe('used');
    expect(codes.begin(Date.now())).toEqual({ ok: false, reason: 'no-code' });
  });

  it('fails a wrong code without revealing anything, and locks after 5 tries', async () => {
    const s = ident('Mac');
    const c = ident('PC');
    const codes = new PairingCodes({ minIntervalMs: 0 });
    const code = codes.generate(Date.now());
    const wrong = code.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'));
    for (let i = 0; i < 5; i++) {
      const { a, b, aSent } = channelPair();
      const srv = server(s, codes, new Map());
      const [sr, cr] = await Promise.all([settle(serverHandshake(a, srv.ctx)), settle(clientPair(b, c, wrong, N))]);
      expect(sr.ok).toBe(false);
      expect(cr.ok).toBe(false);
      expect(!cr.ok && (cr.e as HandshakeError).code).toBe('bad-code');
      expect(srv.paired).toEqual([]);
      // the server sent its salt and a bare error: no MAC, no identity, no key material
      expect(aSent.map((m) => m.t)).toEqual(['pair-salt', 'error']);
      expect(Object.keys(aSent[1]).sort()).toEqual(['code', 't']);
      expect(JSON.stringify(aSent)).not.toContain(s.pub);
    }
    // now even the right code is refused
    const { a, b } = channelPair();
    const [, cr] = await Promise.all([settle(serverHandshake(a, server(s, codes, new Map()).ctx)), settle(clientPair(b, c, code, N))]);
    expect(!cr.ok && (cr.e as HandshakeError).code).toBe('locked');
  });

  it('refuses an expired code', async () => {
    let now = 0;
    const codes = new PairingCodes({ minIntervalMs: 0 });
    const code = codes.generate(now);
    now = CODE_TTL_MS + 1;
    const { a, b } = channelPair();
    const srv = server(ident('Mac'), codes, new Map());
    srv.ctx.now = () => now;
    const [, cr] = await Promise.all([settle(serverHandshake(a, srv.ctx)), settle(clientPair(b, ident('PC'), code, N))]);
    expect(!cr.ok && (cr.e as HandshakeError).code).toBe('expired');
  });

  it('rejects a fake sharer that does not know the code', async () => {
    const { a, b } = channelPair();
    const c = ident('PC');
    const fake = (async () => {
      await a.recvJson();
      a.sendJson({ t: 'pair-salt', salt: random(16).toString('base64'), ns: random(32).toString('base64') });
      await a.recvJson();
      a.sendJson({ t: 'pair-ok', mac: random(32).toString('base64'), box: random(80).toString('base64') });
    })();
    const [, cr] = await Promise.all([fake, settle(clientPair(b, c, 'ABCD-EFGH', N))]);
    expect(!cr.ok && (cr.e as HandshakeError).code).toBe('server-auth');
  });
});

describe('device-key authentication', () => {
  async function paired() {
    const s = ident('Mac');
    const c = ident('PC');
    const viewers = new Map<string, PeerIdentity>([[c.deviceId, pub(c)]]);
    return { s, c, viewers, codes: new PairingCodes() };
  }

  it('authenticates both sides and derives matching per-direction keys', async () => {
    const { s, c, viewers, codes } = await paired();
    const { a, b } = channelPair();
    const [sr, ck] = await Promise.all([serverHandshake(a, server(s, codes, viewers).ctx), clientAuth(b, c, pub(s))]);
    expect(sr.kind).toBe('auth');
    if (sr.kind !== 'auth') return;
    expect(sr.peer.deviceId).toBe(c.deviceId);
    expect(ck.send.equals(sr.keys.recv)).toBe(true);
    expect(ck.recv.equals(sr.keys.send)).toBe(true);
    expect(ck.send.equals(ck.recv)).toBe(false);
  });

  it('refuses an unknown device and an impostor using a paired id', async () => {
    const { s, c, codes } = await paired();
    {
      const { a, b } = channelPair();
      const [, cr] = await Promise.all([settle(serverHandshake(a, server(s, codes, new Map()).ctx)), settle(clientAuth(b, c, pub(s)))]);
      expect(!cr.ok && (cr.e as HandshakeError).code).toBe('unknown-device');
    }
    {
      // the impostor claims c's id but holds another key
      const viewers = new Map<string, PeerIdentity>([[c.deviceId, pub(c)]]);
      const other = ident('Evil');
      const impostor: Identity = { ...other, deviceId: c.deviceId };
      const { a, b } = channelPair();
      const [sr] = await Promise.all([settle(serverHandshake(a, server(s, codes, viewers).ctx)), settle(clientAuth(b, impostor, pub(s)))]);
      expect(!sr.ok && (sr.e as HandshakeError).code).toBe('bad-signature');
    }
  });

  it('rejects a sharer that is not the paired one', async () => {
    const { s, c, viewers, codes } = await paired();
    const other = ident('Other Mac');
    const { a, b } = channelPair();
    // the client expects s but `other` answers (with its own, valid key)
    const [, cr] = await Promise.all([settle(serverHandshake(a, server(other, codes, viewers).ctx)), settle(clientAuth(b, c, pub(s)))]);
    expect(cr.ok).toBe(false);
  });

  it('binds device ids to their keys', () => {
    const i = newIdentity('x');
    expect(deviceIdOf(i.pub)).toBe(i.deviceId);
    expect(i.deviceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('encrypted channel', () => {
  const key = random(32);

  it('round-trips in order', () => {
    const tx = new CipherState(key);
    const rx = new CipherState(key);
    for (const m of ['one', 'two', 'three']) expect(rx.open(tx.seal(Buffer.from(m))).toString()).toBe(m);
  });

  it('rejects a replayed frame', () => {
    const tx = new CipherState(key);
    const rx = new CipherState(key);
    const f1 = tx.seal(Buffer.from('sub a'));
    expect(rx.open(f1).toString()).toBe('sub a');
    expect(() => rx.open(f1)).toThrow();
  });

  it('rejects reordered and dropped frames', () => {
    const tx = new CipherState(key);
    const rx = new CipherState(key);
    tx.seal(Buffer.from('first'));
    const f2 = tx.seal(Buffer.from('second'));
    expect(() => rx.open(f2)).toThrow();
  });

  it('rejects tampered ciphertext and tags', () => {
    const tx = new CipherState(key);
    const f = tx.seal(Buffer.from('{"t":"sessions","items":[]}'));
    for (const i of [0, 5, f.length - 1]) {
      const bad = Buffer.from(f);
      bad[i] ^= 1;
      expect(() => new CipherState(key).open(bad)).toThrow();
    }
    expect(() => new CipherState(random(32)).open(f)).toThrow();
    expect(new CipherState(key).open(f).toString()).toContain('sessions');
  });
});
