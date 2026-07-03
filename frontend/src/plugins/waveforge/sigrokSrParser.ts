import type { LaCapture } from "./laDecoders";

// Minimal in-browser ZIP parser for sigrok .sr files.
// Supports stored (uncompressed) and deflated entries using DecompressionStream.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export async function unzipAll(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len = buffer.byteLength;

  // Find End of Central Directory (EOCD)
  let eocdOffset = -1;
  for (let i = len - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP: EOCD not found");

  const cdEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    const sig = view.getUint32(p, true);
    if (sig !== 0x02014b50) throw new Error(`Invalid ZIP central directory signature at ${p}`);
    const compMethod = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = textDecoder(bytes, p + 46, nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // Read local file header to get actual data offset
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) throw new Error(`Invalid local file header for ${name}`);
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.slice(dataOffset, dataOffset + compSize);

    const data = compMethod === 0
      ? raw
      : await inflate(raw);

    if (data.length !== uncompSize) {
      // Some tools write streams with trailing data; trust actual length for stored, warn for deflated.
      console.warn(`sigrok .sr ${name}: expected ${uncompSize} bytes, got ${data.length}`);
    }
    entries.push({ name, data });
  }
  return entries;
}

function textDecoder(bytes: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function parseSigrokSr(buffer: ArrayBuffer): Promise<LaCapture> {
  const entries = await unzipAll(buffer);
  const metaEntry = entries.find(e => e.name === "metadata");
  const logicEntry = entries.find(e => e.name.startsWith("logic-1"));
  if (!metaEntry || !logicEntry) throw new Error(".sr file missing metadata or logic-1");

  const metaText = textDecoder(metaEntry.data, 0, metaEntry.data.length);
  const params = parseSigrokMetadata(metaText);
  const sampleRate = Number(params["samplerate"] ?? 0);
  const unitsize = Number(params["unitsize"] ?? 1);
  const totalSamples = Number(params["total samples"] ?? 0);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Invalid sigrok sample rate");
  if (![1, 2].includes(unitsize)) throw new Error(`Unsupported sigrok unitsize: ${unitsize}`);

  const samples = new Uint8Array(totalSamples * unitsize);
  samples.set(logicEntry.data.slice(0, samples.length));
  const width = unitsize === 2 ? 16 : 8;

  return {
    sampleRate,
    width,
    samples,
    source: "sigrok-sr",
    importedAt: new Date().toISOString(),
  };
}

function parseSigrokMetadata(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) params[trimmed.slice(0, idx).trim().toLowerCase()] = trimmed.slice(idx + 1).trim();
  }
  return params;
}
