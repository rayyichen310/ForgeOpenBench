import { describe, it, expect } from "vitest";
import { LaStreamWriter, type LaChunkSink } from "./laStreamWriter";

interface FlushRecord {
  chunkIdx: number;
  raw: Uint8Array;
  startSample: number;
}

function makeSink() {
  const flushes: FlushRecord[] = [];
  const sink: LaChunkSink = {
    flushChunk: async (chunkIdx, raw, startSample) => {
      flushes.push({ chunkIdx, raw: new Uint8Array(raw), startSample });
    },
  };
  return { sink, flushes };
}

describe("LaStreamWriter", () => {
  it("flushes exactly one whole chunk each time staging fills", async () => {
    const { sink, flushes } = makeSink();
    const w = new LaStreamWriter(sink, 1, 10);
    for (let i = 0; i < 4; i++) {
      await w.write(new Uint8Array(8).fill(i)); // 32 bytes in 8-byte writes
    }
    expect(flushes.length).toBe(3); // 10 + 10 + 10, 2 staged
    expect(flushes.map(f => f.chunkIdx)).toEqual([0, 1, 2]);
    expect(flushes.map(f => f.startSample)).toEqual([0, 10, 20]);
    expect(flushes.every(f => f.raw.length === 10)).toBe(true);
    expect(w.stagedSamples).toBe(2);
    expect(w.totalSamples).toBe(32);
  });

  it("each byte is flushed exactly once and in order", async () => {
    const { sink, flushes } = makeSink();
    const w = new LaStreamWriter(sink, 1, 10);
    const input = new Uint8Array(25).map((_, i) => i);
    await w.write(input.subarray(0, 7));
    await w.write(input.subarray(7, 19));
    await w.write(input.subarray(19));
    await w.flush();
    const all = new Uint8Array(25);
    let off = 0;
    for (const f of flushes) {
      all.set(f.raw, off);
      off += f.raw.length;
    }
    expect(off).toBe(25);
    expect(Array.from(all)).toEqual(Array.from(input));
  });

  it("flush persists the partial tail; empty flush is a no-op", async () => {
    const { sink, flushes } = makeSink();
    const w = new LaStreamWriter(sink, 1, 10);
    await w.flush();
    expect(flushes.length).toBe(0);
    await w.write(new Uint8Array([1, 2, 3]));
    await w.flush();
    expect(flushes.length).toBe(1);
    expect(Array.from(flushes[0].raw)).toEqual([1, 2, 3]);
    expect(w.stagedSamples).toBe(0);
  });

  it("16-bit: flush only persists whole samples, remainder stays staged", async () => {
    const { sink, flushes } = makeSink();
    const w = new LaStreamWriter(sink, 2, 10); // staging = 20 bytes
    await w.write(new Uint8Array([1, 2, 3, 4, 5])); // 2.5 samples
    await w.flush();
    expect(flushes.length).toBe(1);
    expect(Array.from(flushes[0].raw)).toEqual([1, 2, 3, 4]); // 2 whole samples
    expect(w.stagedSamples).toBe(0);
    // Remainder byte 5 completes a sample with the next write
    await w.write(new Uint8Array([6]));
    await w.flush();
    expect(Array.from(flushes[1].raw)).toEqual([5, 6]);
    expect(w.totalSamples).toBe(3);
  });

  it("stagedTail exposes only whole staged samples", async () => {
    const { sink } = makeSink();
    const w = new LaStreamWriter(sink, 2, 10);
    await w.write(new Uint8Array([1, 2, 3])); // 1.5 samples
    expect(w.stagedSamples).toBe(1);
    expect(Array.from(w.stagedTail())).toEqual([1, 2]);
  });

  it("backfill resumes an aligned partial chunk", async () => {
    const { sink, flushes } = makeSink();
    const w = new LaStreamWriter(sink, 1, 10, { chunkCount: 1, totalSamples: 10 });
    w.backfill(new Uint8Array([90, 91, 92])); // partial chunk 1 reloaded
    expect(w.totalSamples).toBe(13);
    await w.write(new Uint8Array([93, 94, 95, 96, 97, 98, 99])); // fills chunk 1
    expect(flushes.length).toBe(1);
    expect(flushes[0].chunkIdx).toBe(1);
    expect(flushes[0].startSample).toBe(10);
    expect(Array.from(flushes[0].raw)).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });

  it("invokes onChunkFlushed hook per flushed chunk", async () => {
    const { sink } = makeSink();
    const w = new LaStreamWriter(sink, 1, 10);
    const hooked: number[] = [];
    w.onChunkFlushed = (chunkIdx) => hooked.push(chunkIdx);
    await w.write(new Uint8Array(25));
    await w.flush();
    expect(hooked).toEqual([0, 1, 2]);
  });

  it("a single write larger than several chunks flushes them all", async () => {
    const { sink, flushes } = makeSink();
    const w = new LaStreamWriter(sink, 1, 10);
    await w.write(new Uint8Array(35).map((_, i) => i));
    expect(flushes.length).toBe(3);
    expect(w.stagedSamples).toBe(5);
    expect(Array.from(w.stagedTail())).toEqual([30, 31, 32, 33, 34]);
  });
});
