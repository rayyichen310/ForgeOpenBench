import type { LaCapture } from "./laDecoders";
import { parseSigrokSr } from "./sigrokSrParser";

export type LaFileFormat = "fob-csv" | "fob-json" | "sigrok-sr" | "unknown";

export { parseSigrokSr };

export function detectLaFormat(name: string, contentType?: string): LaFileFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "fob-csv";
  if (lower.endsWith(".json")) return "fob-json";
  if (lower.endsWith(".sr")) return "sigrok-sr";
  if (lower.endsWith(".zip") && contentType?.includes("/zip")) return "sigrok-sr";
  return "unknown";
}

export function parseLaCsv(text: string): LaCapture {
  const allLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const meta = allLines.find((l) => l.startsWith("# format:"));
  if (meta?.includes("transition-only")) return parseTransitionCsv(allLines, meta);

  const lines = allLines.filter((l) => !l.startsWith("#"));
  if (lines.length < 2) throw new Error("CSV has no data rows");

  const header = lines[0].split(",").map((c) => c.trim());
  if (header[0].toLowerCase() !== "time") throw new Error("CSV header must start with 'time'");
  const channelLabels = header.slice(1);
  const width = channelLabels.length;
  if (width < 1 || width > 16) throw new Error(`Unsupported channel count: ${width}`);

  const samples = new Uint8Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < width + 1) throw new Error(`Row ${i} has too few columns`);
    let byte = 0;
    for (let ch = 0; ch < width; ch++) {
      const val = cols[ch + 1].trim();
      if (val === "1") byte |= 1 << ch;
      else if (val !== "0") throw new Error(`Row ${i} channel ${ch} is not 0/1: ${val}`);
    }
    samples[i - 1] = byte;
  }

  let sampleRate = 12_000_000;
  if (lines.length >= 3) {
    const t0 = Number(colsAt(lines[1], 0));
    const t1 = Number(colsAt(lines[2], 0));
    if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 > t0) {
      sampleRate = Math.round(1 / (t1 - t0));
    }
  }

  return {
    sampleRate,
    width: width <= 8 ? 8 : 16,
    samples,
    source: "fob-csv",
    importedAt: new Date().toISOString(),
    channelLabels,
  };
}

function parseTransitionCsv(lines: string[], meta: string): LaCapture {
  const params = Object.fromEntries(
    meta
      .replace(/^# format:\s*/, "")
      .split(",")
      .map((p) => p.trim().split(":") as [string, string])
  );
  const totalSamples = Number(params.samples);
  const sampleRate = Number(params.sampleRate);
  const width = Number(params.width) === 16 ? 16 : 8;
  if (!Number.isFinite(totalSamples) || totalSamples <= 0) throw new Error("Missing transition CSV sample count");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Missing transition CSV sample rate");

  const labelToChannel = new Map<string, number>();
  const dataLines = lines.filter((l) => !l.startsWith("#") && l.toLowerCase() !== "time,channel,value");
  const samples = new Uint8Array(totalSamples);
  let current = 0;
  let lastSample = 0;
  for (const line of dataLines) {
    const cols = line.split(",");
    if (cols.length < 3) continue;
    const time = Number(cols[0]);
    const label = cols[1].trim();
    const value = Number(cols[2].trim());
    if (Number.isNaN(time) || Number.isNaN(value) || (value !== 0 && value !== 1)) continue;
    let ch = labelToChannel.get(label);
    if (ch === undefined) {
      ch = labelToChannel.size;
      labelToChannel.set(label, ch);
    }
    const sampleIdx = Math.round(time * sampleRate);
    if (sampleIdx > lastSample) {
      for (let s = lastSample; s < sampleIdx && s < totalSamples; s++) samples[s] = current;
      lastSample = sampleIdx;
    }
    if (value) current |= 1 << ch;
    else current &= ~(1 << ch);
  }
  for (let s = lastSample; s < totalSamples; s++) samples[s] = current;

  const channelLabels = Array.from(labelToChannel.keys());
  return {
    sampleRate,
    width: width <= 8 ? 8 : 16,
    samples,
    source: "fob-csv",
    importedAt: new Date().toISOString(),
    channelLabels,
  };
}

export function parseLaJson(text: string): LaCapture {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON");
  const obj = parsed as Record<string, unknown>;
  const sampleRate = Number(obj.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Invalid sampleRate");
  const width = obj.width === 8 ? 8 : 16;
  const samplesB64 = typeof obj.samples === "string" ? obj.samples : "";
  const samples = base64ToBytes(samplesB64);
  const channelLabels = Array.isArray(obj.channelLabels)
    ? obj.channelLabels.map((l) => String(l))
    : undefined;
  return {
    sampleRate,
    width,
    samples,
    source: typeof obj.source === "string" ? obj.source : "fob-json",
    importedAt: typeof obj.importedAt === "string" ? obj.importedAt : new Date().toISOString(),
    channelLabels,
  };
}

function colsAt(line: string, index: number): string {
  return line.split(",")[index]?.trim() ?? "";
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = typeof atob === "undefined"
    ? Buffer.from(b64, "base64").toString("binary")
    : atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
