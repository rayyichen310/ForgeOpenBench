import { describe, it, expect } from "vitest";
import { handleLaAcquireMode, detectEdge, type LaAcquireCtx, type LaTriggerConfig } from "./laAcquireModes";

function buildSignal(samples: number[], channel: number, width: 8 | 16 = 8): Uint8Array {
  const bps = width === 16 ? 2 : 1;
  const out = new Uint8Array(samples.length * bps);
  for (let i = 0; i < samples.length; i++) {
    const bit = samples[i] ? 1 : 0;
    if (width === 16 && channel >= 8) {
      out[i * bps + 1] |= bit << (channel - 8);
    } else {
      out[i * bps] |= bit << channel;
    }
  }
  return out;
}

function ctx(overrides: Partial<LaAcquireCtx> = {}): LaAcquireCtx {
  return {
    mode: "stopped",
    samples: new Uint8Array(0),
    width: 8,
    trigger: { enabled: false, channel: 0, edge: "rise" },
    totalSamples: 0,
    armedAtSample: 0,
    timeoutSamples: 1_000_000,
    ...overrides,
  };
}

const trigger: LaTriggerConfig = { enabled: true, channel: 3, edge: "rise" };

describe("detectEdge", () => {
  it("detects a rising edge on the configured channel", () => {
    const samples = buildSignal([0, 0, 0, 1, 1, 1], 3);
    expect(detectEdge(samples, 8, trigger)).toBe(true);
  });

  it("returns false when no edge occurs", () => {
    const samples = buildSignal([0, 0, 0, 0, 0], 3);
    expect(detectEdge(samples, 8, trigger)).toBe(false);
  });

  it("returns false when edge is on a different channel", () => {
    const samples = buildSignal([0, 0, 0, 1, 1, 1], 4);
    expect(detectEdge(samples, 8, trigger)).toBe(false);
  });

  it("detects falling edge", () => {
    const samples = buildSignal([1, 1, 1, 0, 0, 0], 3);
    expect(detectEdge(samples, 8, { enabled: true, channel: 3, edge: "fall" })).toBe(true);
  });

  it("detects both edges", () => {
    const rise = buildSignal([0, 0, 1, 1], 3);
    const fall = buildSignal([1, 1, 0, 0], 3);
    expect(detectEdge(rise, 8, { enabled: true, channel: 3, edge: "both" })).toBe(true);
    expect(detectEdge(fall, 8, { enabled: true, channel: 3, edge: "both" })).toBe(true);
  });

  it("returns false when trigger is disabled", () => {
    const samples = buildSignal([0, 0, 0, 1, 1, 1], 3);
    expect(detectEdge(samples, 8, { enabled: false, channel: 3, edge: "rise" })).toBe(false);
  });

  it("works in 16-bit mode", () => {
    const samples = buildSignal([0, 0, 0, 1, 1, 1], 10, 16);
    expect(detectEdge(samples, 16, { enabled: true, channel: 10, edge: "rise" })).toBe(true);
  });
});

describe("handleLaAcquireMode", () => {
  it("running mode renders and does not stop", () => {
    const result = handleLaAcquireMode(ctx({ mode: "running" }));
    expect(result.mode).toBe("running");
    expect(result.render).toBe(true);
    expect(result.stop).toBe(false);
  });

  it("stopped mode does nothing", () => {
    const result = handleLaAcquireMode(ctx({ mode: "stopped" }));
    expect(result.mode).toBe("stopped");
    expect(result.render).toBe(false);
    expect(result.stop).toBe(false);
  });

  it("single-held mode does nothing", () => {
    const result = handleLaAcquireMode(ctx({ mode: "single-held" }));
    expect(result.mode).toBe("single-held");
    expect(result.render).toBe(false);
    expect(result.stop).toBe(false);
  });

  it("single-armed transitions to single-held on rising edge", () => {
    const samples = buildSignal([0, 0, 0, 1, 1, 1], 3);
    const result = handleLaAcquireMode(ctx({ mode: "single-armed", samples, trigger, totalSamples: 6 }));
    expect(result.mode).toBe("single-held");
    expect(result.render).toBe(true);
    expect(result.stop).toBe(true);
    expect(result.triggered).toBe(true);
  });

  it("single-armed stays armed when no edge and no timeout", () => {
    const samples = buildSignal([0, 0, 0, 0, 0], 3);
    const result = handleLaAcquireMode(ctx({ mode: "single-armed", samples, trigger, totalSamples: 5, timeoutSamples: 100 }));
    expect(result.mode).toBe("single-armed");
    expect(result.render).toBe(false);
    expect(result.stop).toBe(false);
  });

  it("single-armed times out after timeoutSamples", () => {
    const samples = buildSignal([0, 0, 0, 0, 0], 3);
    const result = handleLaAcquireMode(ctx({ mode: "single-armed", samples, trigger, totalSamples: 1001, armedAtSample: 0, timeoutSamples: 1000 }));
    expect(result.mode).toBe("single-held");
    expect(result.render).toBe(true);
    expect(result.stop).toBe(true);
    expect(result.triggered).toBe(false);
  });
});
