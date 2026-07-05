/**
 * Simple run-length encoder for logic-analyzer sample buffers.
 *
 * Format:
 * - bps=1: [value, count...]
 * - bps=2: [lo, hi, count...]
 * Count is variable-length: <=127 stored as one byte, otherwise four bytes
 * with high bit set on the first byte.
 * Falls back to raw storage when RLE would be larger.
 */

export type RleFormat = "rle" | "raw";

export function rleEncode(
  samples: Uint8Array,
  bps: 1 | 2
): { data: Uint8Array; format: RleFormat } {
  return bps === 2 ? rleEncode16(samples) : rleEncode8(samples);
}

export function rleDecode(
  data: Uint8Array,
  bps: 1 | 2,
  format: RleFormat,
  byteLength: number
): Uint8Array {
  if (format !== "rle" || byteLength === 0) return data;
  return bps === 2 ? rleDecode16(data, byteLength) : rleDecode8(data, byteLength);
}

function rleEncode8(samples: Uint8Array): { data: Uint8Array; format: RleFormat } {
  if (samples.length === 0) return { data: new Uint8Array(0), format: "raw" };
  const runs: number[] = [];
  let current = samples[0];
  let count = 1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] === current && count < 0x7fffffff) {
      count++;
    } else {
      writeRun8(runs, current, count);
      current = samples[i];
      count = 1;
    }
  }
  writeRun8(runs, current, count);
  const data = new Uint8Array(runs);
  return data.length < samples.length
    ? { data, format: "rle" }
    : { data: new Uint8Array(samples), format: "raw" };
}

function rleEncode16(samples: Uint8Array): { data: Uint8Array; format: RleFormat } {
  if (samples.length === 0) return { data: new Uint8Array(0), format: "raw" };
  if (samples.length % 2 !== 0) {
    throw new Error("16-bit RLE requires even-length buffer");
  }
  const runs: number[] = [];
  let currentLo = samples[0];
  let currentHi = samples[1];
  let count = 1;
  for (let i = 2; i < samples.length; i += 2) {
    const lo = samples[i];
    const hi = samples[i + 1];
    if (lo === currentLo && hi === currentHi && count < 0x7fffffff) {
      count++;
    } else {
      writeRun16(runs, currentLo, currentHi, count);
      currentLo = lo;
      currentHi = hi;
      count = 1;
    }
  }
  writeRun16(runs, currentLo, currentHi, count);
  const data = new Uint8Array(runs);
  return data.length < samples.length
    ? { data, format: "rle" }
    : { data: new Uint8Array(samples), format: "raw" };
}

function writeRun8(out: number[], value: number, count: number) {
  out.push(value);
  writeCount(out, count);
}

function writeRun16(out: number[], lo: number, hi: number, count: number) {
  out.push(lo, hi);
  writeCount(out, count);
}

function writeCount(out: number[], count: number) {
  if (count <= 127) {
    out.push(count);
  } else {
    out.push(0x80 | (count & 0x7f));
    out.push((count >> 7) & 0xff);
    out.push((count >> 15) & 0xff);
    out.push((count >> 23) & 0xff);
  }
}

function readCount(data: Uint8Array, index: number): { value: number; nextIndex: number } {
  const b = data[index];
  if ((b & 0x80) === 0) {
    return { value: b, nextIndex: index + 1 };
  }
  const lo = b & 0x7f;
  const mid1 = data[index + 1];
  const mid2 = data[index + 2];
  const hi = data[index + 3];
  const value = lo | (mid1 << 7) | (mid2 << 15) | (hi << 23);
  return { value, nextIndex: index + 4 };
}

function rleDecode8(data: Uint8Array, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let i = 0;
  let o = 0;
  while (i < data.length) {
    const value = data[i++];
    const count = readCount(data, i);
    i = count.nextIndex;
    out.fill(value, o, o + count.value);
    o += count.value;
  }
  return out;
}

function rleDecode16(data: Uint8Array, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let i = 0;
  let o = 0;
  while (i < data.length) {
    const lo = data[i++];
    const hi = data[i++];
    const count = readCount(data, i);
    i = count.nextIndex;
    const runBytes = count.value * 2;
    out[o] = lo;
    out[o + 1] = hi;
    let copied = 2;
    while (copied < runBytes) {
      const toCopy = Math.min(copied, runBytes - copied);
      out.copyWithin(o + copied, o, o + toCopy);
      copied += toCopy;
    }
    o += runBytes;
  }
  return out;
}
