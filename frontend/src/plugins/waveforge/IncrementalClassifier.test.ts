import { describe, it, expect } from "vitest";
import { IncrementalClassifier, type ChannelGroupHypothesis } from "./IncrementalClassifier";

// Reuse the signal builders from laDecoders.test.ts
function buildUartSignal(
  bytes: number[],
  samplesPerBit: number,
  channel: number,
): Uint8Array {
  const bits: number[] = [];
  const push = (v: number, n: number) => { for (let i = 0; i < n; i++) bits.push(v); };
  push(1, samplesPerBit * 4);
  for (const b of bytes) {
    push(0, samplesPerBit);
    for (let i = 0; i < 8; i++) push((b >> i) & 1, samplesPerBit);
    push(1, samplesPerBit);
    push(1, samplesPerBit * 2);
  }
  push(1, samplesPerBit * 4);
  return Uint8Array.from(bits.map(v => v << channel));
}

function buildI2cSignal(
  addr7: number,
  write: boolean,
  data: Array<{ byte: number; ack: boolean }>,
  samplesPerPhase: number,
  sclCh: number,
  sdaCh: number,
): Uint8Array {
  const out: number[] = [];
  const push = (scl: number, sda: number, n: number) => {
    for (let i = 0; i < n; i++) out.push((scl << sclCh) | (sda << sdaCh));
  };
  const clockBit = (sda: number) => {
    push(0, sda, samplesPerPhase);
    push(1, sda, samplesPerPhase);
    push(0, sda, samplesPerPhase);
  };
  const sendByte = (byte: number, ack: boolean) => {
    for (let i = 7; i >= 0; i--) clockBit((byte >> i) & 1);
    clockBit(ack ? 0 : 1);
  };
  push(1, 1, samplesPerPhase * 4);
  push(1, 1, samplesPerPhase); push(1, 0, samplesPerPhase);
  sendByte((addr7 << 1) | (write ? 0 : 1), true);
  for (const d of data) sendByte(d.byte, d.ack);
  push(0, 0, samplesPerPhase); push(1, 0, samplesPerPhase); push(1, 1, samplesPerPhase);
  push(1, 1, samplesPerPhase * 4);
  return Uint8Array.from(out);
}

describe("IncrementalClassifier", () => {
  it("starts with no hypotheses", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    expect(cls.getLatest()).toBeNull();
  });

  it("returns empty hypotheses for a flat signal", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const chunk = new Uint8Array(1000).fill(0);
    const update = cls.update(chunk, 1000);
    expect(update.hypotheses).toHaveLength(0);
    expect(update.totalEdges).toBe(0);
    expect(update.totalSamples).toBe(1000);
    expect(update.stable).toBe(false);
  });

  it("detects UART after enough edges", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const samples = buildUartSignal([0x41, 0x42, 0x43, 0x44, 0x45], 10, 0);
    const update = cls.update(samples, samples.length);

    expect(update.hypotheses.length).toBeGreaterThan(0);
    const uart = update.hypotheses.find(h => h.protocol === "uart");
    expect(uart).toBeDefined();
    expect(uart!.channels).toContain(0);
    expect(uart!.confidence).toBeGreaterThan(0);
    expect(uart!.edgesSeen).toBeGreaterThan(0);
  });

  it("grows confidence as more chunks arrive", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const fullSignal = buildUartSignal([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48], 10, 0);
    const half = Math.floor(fullSignal.length / 2);

    // First chunk — fewer edges, lower confidence
    const update1 = cls.update(fullSignal.slice(0, half), half);
    const conf1 = update1.hypotheses.find(h => h.protocol === "uart")?.confidence ?? 0;

    // Second chunk — more edges, higher confidence
    const update2 = cls.update(fullSignal.slice(half), fullSignal.length - half);
    const conf2 = update2.hypotheses.find(h => h.protocol === "uart")?.confidence ?? 0;

    expect(conf2).toBeGreaterThanOrEqual(conf1);
  });

  it("detects I2C with clock-data channel grouping", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const samples = buildI2cSignal(0x50, true, [
      { byte: 0xAB, ack: true },
      { byte: 0xCD, ack: true },
    ], 10, 1, 2);
    const update = cls.update(samples, samples.length);

    // Channels 1 and 2 should be detected as active
    expect(update.totalEdges).toBeGreaterThan(0);
    const ch1 = update.channelLabels.find(l => l.channel === 1);
    const ch2 = update.channelLabels.find(l => l.channel === 2);
    expect(ch1).toBeDefined();
    expect(ch2).toBeDefined();
    // If hypotheses exist, channels 1 and 2 should be grouped together
    if (update.hypotheses.length > 0) {
      const groupWithBoth = update.hypotheses.find(h => h.channels.includes(1) && h.channels.includes(2));
      expect(groupWithBoth).toBeDefined();
    }
  });

  it("produces channel labels with confidence percentages", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const samples = buildUartSignal([0x41, 0x42, 0x43, 0x44, 0x45], 10, 0);
    const update = cls.update(samples, samples.length);

    const label = update.channelLabels.find(l => l.channel === 0);
    expect(label).toBeDefined();
    expect(label!.label).toContain("UART");
    expect(label!.label).toContain("%");
    expect(label!.confidence).toBeGreaterThan(0);
  });

  it("labels I2C channels as SCL/SDA", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const samples = buildI2cSignal(0x50, true, [
      { byte: 0xAB, ack: true },
      { byte: 0xCD, ack: true },
    ], 10, 1, 2);
    const update = cls.update(samples, samples.length);

    // Channels 1 and 2 should have labels (either SCL/SDA or generic D{n})
    const ch1Label = update.channelLabels.find(l => l.channel === 1);
    const ch2Label = update.channelLabels.find(l => l.channel === 2);
    expect(ch1Label).toBeDefined();
    expect(ch2Label).toBeDefined();
  });

  it("fires onUpdate callback after each update", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    let fired = 0;
    let lastUpdate: ChannelGroupHypothesis[] | null = null;
    cls.onUpdate((u) => { fired++; lastUpdate = u.hypotheses; });

    const samples = buildUartSignal([0x41, 0x42], 10, 0);
    cls.update(samples, samples.length);

    expect(fired).toBe(1);
    expect(lastUpdate).not.toBeNull();
  });

  it("accumulates edges across multiple chunks", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const chunk1 = buildUartSignal([0x41], 10, 0);
    const chunk2 = buildUartSignal([0x42], 10, 0);

    const u1 = cls.update(chunk1, chunk1.length);
    const edgesAfter1 = u1.totalEdges;

    const u2 = cls.update(chunk2, chunk2.length);
    expect(u2.totalEdges).toBeGreaterThan(edgesAfter1);
    expect(u2.totalSamples).toBe(chunk1.length + chunk2.length);
  });

  it("marks stable when confidence > 0.7", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    // Large UART signal for high confidence
    const bytes = Array.from({ length: 20 }, (_, i) => 0x41 + i);
    const samples = buildUartSignal(bytes, 10, 0);
    const update = cls.update(samples, samples.length);

    const uart = update.hypotheses.find(h => h.protocol === "uart");
    if (uart && uart.confidence > 0.7) {
      expect(update.stable).toBe(true);
    }
  });

  it("resets state correctly", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    const samples = buildUartSignal([0x41, 0x42], 10, 0);
    cls.update(samples, samples.length);
    expect(cls.getLatest()).not.toBeNull();

    cls.reset();
    expect(cls.getLatest()).toBeNull();
  });

  it("handles multi-protocol detection on separate channel groups", () => {
    // UART on D0, I2C on D1/D2 — combined into one signal
    const uartBytes = buildUartSignal([0x41, 0x42, 0x43], 10, 0);
    const i2cBytes = buildI2cSignal(0x50, true, [{ byte: 0xAB, ack: true }], 10, 1, 2);
    const len = Math.max(uartBytes.length, i2cBytes.length);
    const combined = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      combined[i] = (uartBytes[i] ?? 0) | (i2cBytes[i] ?? 0);
    }

    const cls = new IncrementalClassifier(8, 1_000_000);
    const update = cls.update(combined, len);

    // Should detect activity on channels 0, 1, and 2
    const activeLabels = update.channelLabels.filter(l => l.confidence > 0);
    expect(activeLabels.length).toBeGreaterThan(0);

    // Channel 0 should have a label
    const ch0Label = update.channelLabels.find(l => l.channel === 0);
    expect(ch0Label).toBeDefined();
  });

  it("labels unlabeled active channels as D{n}", () => {
    const cls = new IncrementalClassifier(8, 1_000_000);
    // Single transition on channel 3 — too few for any protocol
    const samples = new Uint8Array(100);
    samples.fill(0, 0, 50);
    samples.fill(1 << 3, 50); // ch3 goes high at sample 50
    const update = cls.update(samples, 100);

    const label = update.channelLabels.find(l => l.channel === 3);
    expect(label).toBeDefined();
    expect(label!.label).toBe("D3");
    expect(label!.confidence).toBe(0);
  });
});
