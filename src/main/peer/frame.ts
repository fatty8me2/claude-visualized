// Length-prefixed framing for the peer link: 4-byte big-endian payload length, then the payload.

/** largest frame before authentication (handshake messages are small) */
export const MAX_PREAUTH_FRAME = 64 * 1024;
/** largest frame after authentication (a full SessionView of a very large session) */
export const MAX_FRAME = 16 * 1024 * 1024;

export class FrameError extends Error {}

export function encodeFrame(payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

/** Splits a byte stream into frames. Throws FrameError (and stays broken) when a frame is larger than `max`. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private broken = false;

  constructor(public max = MAX_PREAUTH_FRAME) {}

  push(chunk: Buffer): Buffer[] {
    if (this.broken) throw new FrameError('stream already failed');
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.max) {
        this.broken = true;
        throw new FrameError(`frame of ${len} bytes exceeds ${this.max}`);
      }
      if (this.buf.length < 4 + len) break;
      out.push(Buffer.from(this.buf.subarray(4, 4 + len)));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }

  /** bytes received but not yet a whole frame */
  get pending(): number {
    return this.buf.length;
  }
}
