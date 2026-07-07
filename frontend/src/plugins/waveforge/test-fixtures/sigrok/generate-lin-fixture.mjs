#!/usr/bin/env node
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function generateLinFrame(sampleRate, channel, baud, id, data, checksumMode) {
  const spb = Math.max(1, Math.floor(sampleRate / baud));
  const samples = [];
  const pushBit = (val) => { for (let i = 0; i < spb; i++) samples.push(val ? (1 << channel) : 0); };
  pushBit(1); // idle
  for (let b = 0; b < 13; b++) pushBit(0); // break: 13 bit periods dominant
  pushBit(1); // break delimiter
  for (let b = 0; b < 8; b++) pushBit((0x55 >> b) & 1);
  const p0 = ((id >> 0) ^ (id >> 1) ^ (id >> 2) ^ (id >> 4)) & 1;
  const p1 = ((id >> 1) ^ (id >> 3) ^ (id >> 4) ^ (id >> 5)) & 1;
  const pid = (id & 0x3f) | (p0 << 6) | (p1 << 7);
  for (let b = 0; b < 8; b++) pushBit((pid >> b) & 1);
  const dataLen = id <= 1 ? 2 : id <= 3 ? 4 : id <= 7 ? 4 : 8;
  for (let i = 0; i < dataLen; i++) {
    const byte = data[i] ?? 0;
    for (let b = 0; b < 8; b++) pushBit((byte >> b) & 1);
  }
  let cksum = checksumMode === "enhanced" ? pid : 0;
  for (let i = 0; i < dataLen; i++) { cksum += data[i] ?? 0; if (cksum > 0xff) cksum = (cksum & 0xff) + 1; }
  cksum = (~cksum) & 0xff;
  for (let b = 0; b < 8; b++) pushBit((cksum >> b) & 1);
  pushBit(1);
  return new Uint8Array(samples);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    local.set(nameBytes, 30);
    localParts.push(local, Buffer.from(data));
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0, 4); central.writeUInt16LE(0, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42); central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const RATE = 1_000_000, BAUD = 19200, CH = 0;
const f1 = generateLinFrame(RATE, CH, BAUD, 0x00, [0x42, 0x84], "classic");
const f2 = generateLinFrame(RATE, CH, BAUD, 0x02, [0x01, 0x02, 0x03, 0x04], "classic");
const combined = new Uint8Array(f1.length + f2.length);
combined.set(f1, 0); combined.set(f2, f1.length);
const metadata = `[sigrok]\nversion=2\nsamplerate=${RATE}\nunitsize=1\ncapturefile=logic-1\ntotal probes=1\nprobe1=LIN\n`;
const zip = buildZip([
  { name: "metadata", data: new TextEncoder().encode(metadata) },
  { name: "logic-1", data: combined },
]);
const outPath = join(__dirname, "lin_synthetic_2frames.sr");
writeFileSync(outPath, zip);
console.log(`Wrote ${outPath} (${zip.length} bytes, ${combined.length} samples)`);
