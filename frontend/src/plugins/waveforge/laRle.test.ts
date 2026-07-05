import { describe, it, expect } from "vitest";
import { rleEncode, rleDecode } from "./laRle";

describe("laRle", () => {
  it("round-trips an 8-bit idle buffer", () => {
    const samples = new Uint8Array(100_000).fill(0x21);
    const { data, format } = rleEncode(samples, 1);
    expect(format).toBe("rle");
    expect(data.length).toBeLessThan(20);
    const decoded = rleDecode(data, 1, format, samples.length);
    expect(decoded.length).toBe(samples.length);
    expect(decoded[0]).toBe(0x21);
    expect(decoded[samples.length - 1]).toBe(0x21);
  });

  it("round-trips a 16-bit idle buffer", () => {
    const samples = new Uint8Array(200_000);
    for (let i = 0; i < samples.length; i += 2) {
      samples[i] = 0x34;
      samples[i + 1] = 0x12;
    }
    const { data, format } = rleEncode(samples, 2);
    expect(format).toBe("rle");
    expect(data.length).toBeLessThan(20);
    const decoded = rleDecode(data, 2, format, samples.length);
    expect(decoded.length).toBe(samples.length);
    expect(decoded[0]).toBe(0x34);
    expect(decoded[1]).toBe(0x12);
    expect(decoded[decoded.length - 2]).toBe(0x34);
    expect(decoded[decoded.length - 1]).toBe(0x12);
  });

  it("falls back to raw for high-entropy data", () => {
    const samples = new Uint8Array(1000);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 256;
    const { data, format } = rleEncode(samples, 1);
    expect(format).toBe("raw");
    expect(data.length).toBe(samples.length);
    const decoded = rleDecode(data, 1, format, samples.length);
    expect(decoded).toEqual(samples);
  });

  it("round-trips mixed 8-bit runs", () => {
    const samples = new Uint8Array([0, 0, 0, 1, 1, 2, 2, 2, 2, 3]);
    const { data, format } = rleEncode(samples, 1);
    expect(format).toBe("rle");
    const decoded = rleDecode(data, 1, format, samples.length);
    expect(decoded).toEqual(samples);
  });

  it("round-trips a long run that needs multi-byte count", () => {
    const samples = new Uint8Array(200).fill(0xab);
    const { data, format } = rleEncode(samples, 1);
    expect(format).toBe("rle");
    const decoded = rleDecode(data, 1, format, samples.length);
    expect(decoded).toEqual(samples);
  });

  it("returns raw for empty buffer", () => {
    const { data, format } = rleEncode(new Uint8Array(0), 1);
    expect(format).toBe("raw");
    expect(data.length).toBe(0);
  });
});
