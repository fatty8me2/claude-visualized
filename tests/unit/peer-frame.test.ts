import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameError, MAX_FRAME, MAX_PREAUTH_FRAME } from '../../src/main/peer/frame';

describe('peer framing', () => {
  it('prefixes the payload with its big-endian length', () => {
    const f = encodeFrame(Buffer.from('hello'));
    expect([...f.subarray(0, 4)]).toEqual([0, 0, 0, 5]);
    expect(f.subarray(4).toString()).toBe('hello');
  });

  it('reassembles frames split across chunks and several frames in one chunk', () => {
    const stream = Buffer.concat([encodeFrame(Buffer.from('a')), encodeFrame(Buffer.from('')), encodeFrame(Buffer.from('xyz'.repeat(1000)))]);
    const d = new FrameDecoder();
    const out: string[] = [];
    // byte-by-byte for the first frames, then the rest in one go
    for (let i = 0; i < 9; i++) out.push(...d.push(stream.subarray(i, i + 1)).map(String));
    out.push(...d.push(stream.subarray(9)).map(String));
    expect(out).toEqual(['a', '', 'xyz'.repeat(1000)]);
    expect(d.pending).toBe(0);
  });

  it('keeps a partial frame until the rest arrives', () => {
    const f = encodeFrame(Buffer.from('partial'));
    const d = new FrameDecoder();
    expect(d.push(f.subarray(0, 6))).toEqual([]);
    expect(d.pending).toBe(6);
    expect(d.push(f.subarray(6)).map(String)).toEqual(['partial']);
  });

  it('rejects oversized frames from the header alone, and stays failed', () => {
    const d = new FrameDecoder(MAX_PREAUTH_FRAME);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_PREAUTH_FRAME + 1, 0);
    expect(() => d.push(head)).toThrow(FrameError);
    expect(() => d.push(encodeFrame(Buffer.from('ok')))).toThrow(FrameError);
    // after authentication the limit is raised
    const big = new FrameDecoder(MAX_FRAME);
    expect(big.push(head)).toEqual([]);
  });
});
