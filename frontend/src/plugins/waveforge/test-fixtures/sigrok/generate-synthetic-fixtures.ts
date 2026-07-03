import { writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateSwdFrame, generateJtagFrame, generateModbusFrame } from "../../laDecoders";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildZip(entries: { name: string; data: Uint8Array }[]): ArrayBuffer {
  const parts: Uint8Array[] = [];
  const cd: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lh = new DataView(localHeader.buffer);
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true); // stored
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0, true);
    lh.setUint32(14, 0, true); // crc32 placeholder
    lh.setUint32(18, e.data.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    parts.push(localHeader);
    parts.push(e.data);

    const cdEntry = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdEntry.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, 0, true);
    cdv.setUint32(20, e.data.length, true);
    cdv.setUint32(24, e.data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cdEntry.set(nameBytes, 46);
    cd.push(cdEntry);

    offset += localHeader.length + e.data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of cd) { parts.push(c); cdSize += c.length; }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdStart, true);
  eocdView.setUint16(20, 0, true);
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

function makeSigrokMetadata(opts: { sampleRate: number; numProbes?: number; probeLabels?: (string | undefined)[] }): Uint8Array {
  const lines = [
    "[sigrok]",
    "version=2",
    "[sac]",
    `samplerate=${opts.sampleRate}`,
    `numprobes=${opts.numProbes ?? 8}`,
    "capturefile=logic-1",
    "unitsize=1",
  ];
  if (opts.probeLabels) {
    for (let i = 0; i < opts.probeLabels.length; i++) {
      const label = opts.probeLabels[i];
      if (label !== undefined && label !== "") lines.push(`probe${i + 1}=${label}`);
    }
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

function writeSr(name: string, sampleRate: number, samples: Uint8Array, probeLabels: (string | undefined)[]) {
  const zip = buildZip([
    { name: "metadata", data: makeSigrokMetadata({ sampleRate, probeLabels }) },
    { name: "logic-1", data: samples },
  ]);
  return writeFile(join(__dirname, name), new Uint8Array(zip));
}

async function main() {
  await writeSr(
    "swd-reset-read.sr",
    1_000_000,
    generateSwdFrame(1_000_000, 1, 0, [{ apnDp: 0, read: true, addr: 0, data: 0x12345678 }]),
    ["SWCLK", "SWDIO"]
  );
  await writeSr(
    "jtag-ir-dr.sr",
    1_000_000,
    generateJtagFrame(1_000_000, 0, 1, 2, 3, [
      { register: "IR", tdi: 0x5, tdo: 0, bits: 4 },
      { register: "DR", tdi: 0x1234, tdo: 0x4321, bits: 16 },
    ]),
    ["TCK", "TMS", "TDI", "TDO"]
  );
  await writeSr(
    "modbus-read-holding.sr",
    1_000_000,
    generateModbusFrame(1_000_000, 2, 9600, 1, 0x03, [0x00, 0x00, 0x00, 0x0A], "even"),
    ["", "", "RS485"]
  );
  console.log("Synthetic sigrok fixtures generated.");
}

main().catch(e => { console.error(e); process.exit(1); });
