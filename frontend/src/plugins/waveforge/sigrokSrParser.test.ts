import { describe, it, expect } from "vitest";
import { unzipAll, parseSigrokSr, streamSigrokSr } from "./sigrokSrParser";

function buildZip(entries: { name: string; data: Uint8Array }[]): ArrayBuffer {
  const parts: Uint8Array[] = [];
  const cd: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lh = new DataView(localHeader.buffer);
    lh.setUint32(0, 0x04034b50, true); // local sig
    lh.setUint16(4, 20, true); // version
    lh.setUint16(6, 0, true); // flags
    lh.setUint16(8, 0, true); // stored
    lh.setUint16(10, 0, true); // time
    lh.setUint16(12, 0, true); // date
    lh.setUint32(14, 0, true); // crc32 placeholder
    lh.setUint32(18, e.data.length, true); // compressed size
    lh.setUint32(22, e.data.length, true); // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    parts.push(localHeader);
    parts.push(e.data);

    const cdEntry = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdEntry.buffer);
    cdv.setUint32(0, 0x02014b50, true); // CD sig
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // stored
    cdv.setUint16(12, 0, true); // time
    cdv.setUint16(14, 0, true); // date
    cdv.setUint32(16, 0, true); // crc32
    cdv.setUint32(20, e.data.length, true); // compressed size
    cdv.setUint32(24, e.data.length, true); // uncompressed size
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra len
    cdv.setUint16(32, 0, true); // comment len
    cdv.setUint16(34, 0, true); // disk start
    cdv.setUint16(36, 0, true); // int attrs
    cdv.setUint32(38, 0, true); // ext attrs
    cdv.setUint32(42, offset, true); // local header offset
    cdEntry.set(nameBytes, 46);
    cd.push(cdEntry);

    offset += localHeader.length + e.data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of cd) { parts.push(c); cdSize += c.length; }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD sig
  eocdView.setUint16(4, 0, true); // disk
  eocdView.setUint16(6, 0, true); // disk with CD
  eocdView.setUint16(8, entries.length, true); // entries on disk
  eocdView.setUint16(10, entries.length, true); // total entries
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdStart, true);
  eocdView.setUint16(20, 0, true); // comment len
  parts.push(eocd);

  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out.buffer;
}

describe("unzipAll", () => {
  it("extracts a stored-method ZIP", async () => {
    const zip = buildZip([
      { name: "metadata", data: new TextEncoder().encode("[sigrok]\nversion=2\n") },
      { name: "logic-1", data: new Uint8Array([0x01, 0x02, 0x03]) },
    ]);
    const entries = await unzipAll(zip);
    expect(entries.map(e => e.name)).toContain("metadata");
    expect(entries.map(e => e.name)).toContain("logic-1");
  });
});

describe("parseSigrokSr", () => {
  it("parses a minimal 8-bit stored .sr", async () => {
    const metadata = `[sigrok]
version=2
[samplerate]
samplerate=1000000
[Device 1]
capturefile=logic-1
unitsize=1
total samples=4
`;
    const zip = buildZip([
      { name: "metadata", data: new TextEncoder().encode(metadata) },
      { name: "logic-1", data: new Uint8Array([0b00000001, 0b00000010, 0b00000011, 0b00000100]) },
    ]);
    const cap = await parseSigrokSr(zip);
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("parses a minimal 16-bit stored .sr", async () => {
    const metadata = `[sigrok]
version=2
[samplerate]
samplerate=24000000
[Device 1]
capturefile=logic-1
unitsize=2
total samples=2
`;
    const zip = buildZip([
      { name: "metadata", data: new TextEncoder().encode(metadata) },
      { name: "logic-1", data: new Uint8Array([0x01, 0x02, 0x03, 0x04]) },
    ]);
    const cap = await parseSigrokSr(zip);
    expect(cap.sampleRate).toBe(24_000_000);
    expect(cap.width).toBe(16);
    expect(cap.samples).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });

  it("parses samplerate with kHz/MHz suffix", async () => {
    const metadata = `[sigrok]
samplerate=625 kHz
unitsize=1
capturefile=logic-1
`;
    const zip = buildZip([
      { name: "metadata", data: new TextEncoder().encode(metadata) },
      { name: "logic-1", data: new Uint8Array([0xff]) },
    ]);
    const cap = await parseSigrokSr(zip);
    expect(cap.sampleRate).toBe(625_000);
  });

  it("concatenates chunked logic-1 files", async () => {
    const metadata = `[sigrok]
samplerate=1000000
unitsize=1
capturefile=logic-1
`;
    const zip = buildZip([
      { name: "metadata", data: new TextEncoder().encode(metadata) },
      { name: "logic-1", data: new Uint8Array([0x01, 0x02]) },
      { name: "logic-1-1", data: new Uint8Array([0x03, 0x04]) },
      { name: "logic-1-2", data: new Uint8Array([0x05]) },
    ]);
    const cap = await parseSigrokSr(zip);
    expect(cap.samples).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]));
  });

  it("streamSigrokSr yields each logic chunk separately", async () => {
    const metadata = `[sigrok]
samplerate=1000000
unitsize=1
capturefile=logic-1
`;
    const zip = buildZip([
      { name: "metadata", data: new TextEncoder().encode(metadata) },
      { name: "logic-1", data: new Uint8Array([0x01, 0x02]) },
      { name: "logic-1-1", data: new Uint8Array([0x03, 0x04]) },
      { name: "logic-1-2", data: new Uint8Array([0x05]) },
    ]);
    const { meta, chunks } = await streamSigrokSr(zip);
    expect(meta.sampleRate).toBe(1_000_000);
    expect(meta.width).toBe(8);
    const parts: Uint8Array[] = [];
    for await (const c of chunks) parts.push(c);
    expect(parts.length).toBe(3);
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    expect(all).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]));
  });
});
