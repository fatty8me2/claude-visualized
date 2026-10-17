// A framed peer connection: plaintext JSON frames during the handshake, AES-GCM frames after `secure()`.
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { CipherState } from './crypto';
import { encodeFrame, FrameDecoder, MAX_FRAME, MAX_PREAUTH_FRAME } from './frame';

export type Json = Record<string, unknown>;

/** What the handshake needs from a connection (an in-memory pair in tests, a PeerSocket for real). */
export interface HandshakeChannel {
  sendJson(o: Json): void;
  recvJson(timeoutMs?: number): Promise<Json>;
}

export interface SessionKeys {
  send: Buffer;
  recv: Buffer;
}

/** drop a peer that does not read what we send */
const MAX_BUFFERED = 32 * 1024 * 1024;

/**
 * Events: 'close' (reason: string) once. After secure(), every authentic frame is handed to the message callback; any frame that fails to
 * decrypt (tampered, replayed, reordered) closes the connection.
 */
export class PeerSocket extends EventEmitter implements HandshakeChannel {
  private dec = new FrameDecoder(MAX_PREAUTH_FRAME);
  private queue: Buffer[] = [];
  private waiter: { resolve: (o: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private tx: CipherState | null = null;
  private rx: CipherState | null = null;
  private onMessage: ((m: Json) => void) | null = null;
  closed = false;
  closeReason = '';
  lastRecv = Date.now();

  constructor(readonly sock: net.Socket) {
    super();
    sock.setNoDelay(true);
    sock.on('data', (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = this.dec.push(chunk);
      } catch (e) {
        this.close((e as Error).message);
        return;
      }
      for (const f of frames) {
        if (this.closed) return;
        this.onFrame(f);
      }
    });
    sock.on('error', (e) => this.close(e.message));
    sock.on('close', () => this.close('connection closed'));
  }

  get remoteAddress(): string {
    return this.sock.remoteAddress ?? '?';
  }

  private onFrame(f: Buffer) {
    this.lastRecv = Date.now();
    if (!this.rx || !this.onMessage) {
      this.queue.push(f);
      this.deliver();
      return;
    }
    let msg: Json;
    try {
      msg = JSON.parse(this.rx.open(f).toString('utf8')) as Json;
    } catch {
      // a handshake error sent in the clear (e.g. our signature was refused) explains the failure; it is never acted on
      let code = '';
      try {
        const o = JSON.parse(f.toString('utf8')) as Json;
        if (o?.t === 'error' && typeof o.code === 'string') code = o.code.slice(0, 40);
      } catch {
        /* ciphertext */
      }
      this.close(code ? `error:${code}` : 'message failed authentication');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.close('bad message');
    try {
      this.onMessage(msg);
    } catch (e) {
      // a malformed message must never take the app down: drop the link instead
      this.close(`bad message: ${(e as Error).message}`);
    }
  }

  private deliver() {
    if (!this.waiter || !this.queue.length) return;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    const f = this.queue.shift()!;
    try {
      const o = JSON.parse(f.toString('utf8')) as Json;
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('bad handshake message');
      w.resolve(o);
    } catch (e) {
      w.reject(e as Error);
    }
  }

  recvJson(timeoutMs = 10_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error(this.closeReason || 'closed'));
    if (this.waiter) return Promise.reject(new Error('already waiting'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('handshake timed out'));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.deliver();
    });
  }

  sendJson(o: Json) {
    if (this.closed) return;
    let buf: Buffer = Buffer.from(JSON.stringify(o), 'utf8');
    if (this.tx) buf = this.tx.seal(buf);
    this.sock.write(encodeFrame(buf));
    if (this.sock.writableLength > MAX_BUFFERED) this.close('peer is not reading');
  }

  /** Switch to the encrypted channel; frames that already arrived are decrypted and delivered too. */
  secure(keys: SessionKeys, onMessage: (m: Json) => void) {
    this.tx = new CipherState(keys.send);
    this.rx = new CipherState(keys.recv);
    this.dec.max = MAX_FRAME;
    this.onMessage = onMessage;
    const q = this.queue;
    this.queue = [];
    for (const f of q) if (!this.closed) this.onFrame(f);
  }

  get isSecure(): boolean {
    return !!this.rx;
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error(reason));
      this.waiter = null;
    }
    this.sock.destroy();
    this.emit('close', reason);
  }

  /** send then close once flushed (errors before closing a handshake) */
  end(o: Json) {
    if (this.closed) return;
    this.sendJson(o);
    this.sock.end();
    setTimeout(() => this.close('ended'), 500).unref();
  }
}
