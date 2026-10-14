import fs from 'node:fs/promises';

/** structured-clone friendly read position, so a worker can hand a file over to the main thread */
export interface TailSnapshot {
  offset: number;
  mtimeMs: number;
  partial: Uint8Array;
}

/**
 * Incremental line reader for an append-only file. Polling + byte offsets is more reliable
 * on Windows than fs.watch. A file that shrinks is reported as truncated so callers can rebuild.
 */
export class FileTail {
  offset = 0;
  mtimeMs = 0;
  /** bytes of an incomplete trailing line, kept as bytes so multi-byte chars are never split */
  private partial: Buffer = Buffer.alloc(0);

  constructor(readonly file: string) {}

  /** Returns complete new lines, 'truncated' if the file shrank, or null if it doesn't exist. */
  async read(): Promise<string[] | 'truncated' | null> {
    let st;
    try {
      st = await fs.stat(this.file);
    } catch {
      return null;
    }
    this.mtimeMs = st.mtimeMs;
    if (st.size < this.offset) return 'truncated';
    if (st.size === this.offset) return [];
    const fh = await fs.open(this.file, 'r');
    let chunk: Buffer;
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.offset);
      this.offset += bytesRead;
      chunk = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    const data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    const nl = data.lastIndexOf(0x0a);
    if (nl === -1) {
      this.partial = Buffer.from(data);
      return [];
    }
    this.partial = Buffer.from(data.subarray(nl + 1));
    return data.subarray(0, nl).toString('utf8').split('\n');
  }

  snapshot(): TailSnapshot {
    return { offset: this.offset, mtimeMs: this.mtimeMs, partial: new Uint8Array(this.partial) };
  }

  restore(s: TailSnapshot) {
    this.offset = s.offset;
    this.mtimeMs = s.mtimeMs;
    this.partial = Buffer.from(s.partial);
  }

  reset() {
    this.offset = 0;
    this.partial = Buffer.alloc(0);
  }
}
