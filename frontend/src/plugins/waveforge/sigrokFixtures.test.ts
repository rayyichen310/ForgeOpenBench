import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseSigrokSr } from "./sigrokSrParser";
import { decodeUartChunk, decodeI2C, decodeSPI, decodeSWD, decodeJTAG, decodeModbus, inferDecoderDefaults, autoDetectLaProtocol } from "./laDecoders";

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
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("uart");
    expect(cfg.uart.baud).toBe(9600);
    const rows = decodeUartChunk(cap.samples, cap.sampleRate, cfg.uart.baud, cfg.uart.ch);
    const text = rows.map(r => String.fromCharCode(r.byte)).join("");
    expect(text.startsWith("Hello World!\r\n")).toBe(true);
  });

  it("loads i2c-sht21 capture", async () => {
    const cap = await parseSigrokSr(await loadFixture("i2c-sht21-100khz-read-serial-hold.sr"));
    expect(cap.sampleRate).toBe(8_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("i2c");
    const frames = decodeI2C(cap.samples, cap.sampleRate, cfg.i2c.scl, cfg.i2c.sda);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some(f => f.type === "start")).toBe(true);
  });

  it("decodes spi-count-lsb capture without CS", async () => {
    const cap = await parseSigrokSr(await loadFixture("spi-count-lsb.sr"));
    expect(cap.sampleRate).toBe(400_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("spi");
    // Signal analysis: ch0 is the fastest toggler (clock), ch2 is MOSI.
    expect(cfg.spi.sck).toBe(0);
    expect(cfg.spi.mosi).toBe(2);
    // No CS line in this fixture.
    const frames = decodeSPI(cap.samples, cap.sampleRate, cfg.spi.mosi, cfg.spi.miso, cfg.spi.sck, -1, 0, 8, true);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("auto-detects UART, I2C, and SPI fixtures", async () => {
    const uartCap = await parseSigrokSr(await loadFixture("hello_world_8n1_9600.sr"));
    const uartResult = autoDetectLaProtocol(uartCap);
    expect(uartResult.tab).toBe("uart");
    expect(uartResult.uart?.ch).toBe(0);

    const i2cCap = await parseSigrokSr(await loadFixture("i2c-sht21-100khz-read-serial-hold.sr"));
    const i2cResult = autoDetectLaProtocol(i2cCap);
    expect(i2cResult.tab).toBe("i2c");
    expect(i2cResult.i2c?.scl).toBe(6);
    expect(i2cResult.i2c?.sda).toBe(7);

    const spiCap = await parseSigrokSr(await loadFixture("spi-count-lsb.sr"));
    const spiResult = autoDetectLaProtocol(spiCap);
    expect(spiResult.tab).toBe("spi");
    expect(spiResult.spi?.sck).toBe(0);
  });

  it("decodes synthetic SWD sigrok fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("swd-reset-read.sr"));
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("swd");
    const frames = decodeSWD(cap.samples, cap.sampleRate, cfg.swd.swdio, cfg.swd.swclk);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("decodes synthetic JTAG sigrok fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("jtag-ir-dr.sr"));
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("jtag");
    const frames = decodeJTAG(cap.samples, cap.sampleRate, cfg.jtag.tck, cfg.jtag.tms, cfg.jtag.tdi, cfg.jtag.tdo);
    expect(frames.filter(f => f.type === "shift").length).toBeGreaterThan(0);
  });

  it("decodes synthetic Modbus sigrok fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("modbus-read-holding.sr"));
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("modbus");
    const frames = decodeModbus(cap.samples, cap.sampleRate, cfg.modbus.ch, cfg.modbus.baud, cfg.modbus.parity);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].crcOk).toBe(true);
  });
});
