import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseSigrokSr } from "./sigrokSrParser";
import { decodeUartChunk, decodeI2C, decodeSPI } from "./laDecoders";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "test-fixtures", "sigrok");

async function loadFixture(name: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(FIXTURE_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("sigrok-dumps fixtures", () => {
  it("decodes hello_world UART capture", async () => {
    const cap = await parseSigrokSr(await loadFixture("hello_world_8n1_9600.sr"));
    expect(cap.sampleRate).toBe(625_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const rows = decodeUartChunk(cap.samples, cap.sampleRate, 9600, 0);
    const text = rows.map(r => String.fromCharCode(r.byte)).join("");
    expect(text.startsWith("Hello World!\r\n")).toBe(true);
  });

  it("loads i2c-sht21 capture", async () => {
    const cap = await parseSigrokSr(await loadFixture("i2c-sht21-100khz-read-serial-hold.sr"));
    expect(cap.sampleRate).toBe(8_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const frames = decodeI2C(cap.samples, cap.sampleRate, 6, 7); // SCL=probe7, SDA=probe8 => ch 6,7
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some(f => f.type === "start")).toBe(true);
  });

  it("decodes spi-count-lsb capture without CS", async () => {
    const cap = await parseSigrokSr(await loadFixture("spi-count-lsb.sr"));
    expect(cap.sampleRate).toBe(400_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    // MOSI on ch0, MISO on ch1 (all low), SCK on ch2, no CS line.
    const frames = decodeSPI(cap.samples, cap.sampleRate, 0, 1, 2, -1, 0, 8, true);
    expect(frames.length).toBeGreaterThan(0);
  });
});
