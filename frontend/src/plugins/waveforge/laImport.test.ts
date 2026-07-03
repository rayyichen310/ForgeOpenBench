import { describe, it, expect } from "vitest";
import { parseLaCsv, parseLaJson, detectLaFormat } from "./laImport";
import { exportLaCsv, exportLaJson } from "./laExport";
import type { LaCapture } from "./laDecoders";

function makeUartCapture(): LaCapture {
  const sampleRate = 1_000_000;
  const baud = 115200;
  const spb = sampleRate / baud;
  const samples = new Uint8Array(3000);
  // UART 'A' (0x41) on channel 0: start 0, LSB first, stop 1
  const pushBit = (s: number, v: number) => {
    for (let i = 0; i < spb; i++) samples[Math.round(s * spb + i)] = v;
  };
  let bit = 0;
  pushBit(bit++, 0); // start
  for (let b = 0; b < 8; b++) pushBit(bit++, (0x41 >> b) & 1);
  pushBit(bit++, 1); // stop
  return {
    sampleRate,
    width: 8,
    samples,
    source: "test",
    importedAt: "2026-01-01T00:00:00Z",
  };
}

function csvToCapture(csv: string): LaCapture {
  return { ...parseLaCsv(csv), importedAt: "2026-01-01T00:00:00Z" };
}

function jsonToCapture(json: string): LaCapture {
  return { ...parseLaJson(json), importedAt: "2026-01-01T00:00:00Z" };
}

function capturesEqual(a: LaCapture, b: LaCapture): boolean {
  if (a.sampleRate !== b.sampleRate || a.width !== b.width || a.samples.length !== b.samples.length) return false;
  for (let i = 0; i < a.samples.length; i++) if (a.samples[i] !== b.samples[i]) return false;
  return true;
}

describe("detectLaFormat", () => {
  it("detects CSV and JSON and sr", () => {
    expect(detectLaFormat("capture.csv")).toBe("fob-csv");
    expect(detectLaFormat("capture.json")).toBe("fob-json");
    expect(detectLaFormat("capture.sr")).toBe("sigrok-sr");
    expect(detectLaFormat("capture.txt")).toBe("unknown");
  });
});

describe("parseLaCsv", () => {
  it("parses a minimal 2-channel CSV", () => {
    const csv = "time,D0,D1\n0,0,0\n1e-6,1,0\n2e-6,1,1\n3e-6,0,1";
    const cap = parseLaCsv(csv);
    expect(cap.width).toBe(8);
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.samples).toEqual(new Uint8Array([0, 1, 3, 2]));
  });

  it("throws on malformed rows", () => {
    expect(() => parseLaCsv("time,D0\n0")).toThrow();
    expect(() => parseLaCsv("foo,D0\n0,0")).toThrow();
  });
});

describe("exportLaCsv + parseLaCsv round-trip", () => {
  it("round-trips a small capture", () => {
    const cap = makeUartCapture();
    const csv = exportLaCsv(cap, "row");
    const parsed = csvToCapture(csv);
    expect(capturesEqual(cap, parsed)).toBe(true);
  });

  it("round-trips via transition-only CSV", () => {
    const cap = makeUartCapture();
    const csv = exportLaCsv(cap, "transition");
    const parsed = csvToCapture(csv);
    expect(capturesEqual(cap, parsed)).toBe(true);
  });
});

describe("exportLaJson + parseLaJson round-trip", () => {
  it("round-trips a capture with labels", () => {
    const cap: LaCapture = {
      sampleRate: 12_000_000,
      width: 16,
      samples: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      source: "test",
      importedAt: "2026-01-01T00:00:00Z",
      channelLabels: ["TX", "RX"],
    };
    const json = exportLaJson(cap);
    const parsed = jsonToCapture(json);
    expect(capturesEqual(cap, parsed)).toBe(true);
    expect(parsed.channelLabels).toEqual(["TX", "RX"]);
  });
});
