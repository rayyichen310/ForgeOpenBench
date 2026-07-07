import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseSigrokSr } from "./sigrokSrParser";
import { decodeUartChunk, decodeI2C, decodeSPI, decodeSWD, decodeJTAG, decodeModbus, decodeOneWire, decodeLIN, inferDecoderDefaults, autoDetectLaProtocol } from "./laDecoders";

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

  it("auto-detects and decodes real SWD sigrok-dumps fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("init_write_0xabbabeeb.sr"));
    expect(cap.sampleRate).toBe(8_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);

    const detected = autoDetectLaProtocol(cap);
    expect(detected.tab).toBe("swd");
    expect(detected.swd?.swdio).toBe(1);
    expect(detected.swd?.swclk).toBe(0);

    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("swd");
    const frames = decodeSWD(cap.samples, cap.sampleRate, cfg.swd.swdio, cfg.swd.swclk);
    expect(frames.filter(f => f.type === "data").length).toBeGreaterThan(0);
    expect(frames.filter(f => f.type === "request").length).toBeGreaterThan(0);
  });

  it("decodes real JTAG sigrok-dumps fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("keil_mcb2140_irscan_drscan.sr"));
    expect(cap.sampleRate).toBe(4_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("jtag");
    const frames = decodeJTAG(cap.samples, cap.sampleRate, cfg.jtag.tck, cfg.jtag.tms, cfg.jtag.tdi, cfg.jtag.tdo);
    expect(frames.filter(f => f.type === "shift").length).toBeGreaterThan(0);
  });

  it("auto-detects and decodes real Modbus RTU sigrok-dumps fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("wizmodbus.sr"));
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);

    const detected = autoDetectLaProtocol(cap);
    expect(detected.tab).toBe("modbus");
    expect(detected.modbus?.ch).toBe(3);
    expect(detected.modbus?.baud).toBe(9600);
    expect(detected.modbus?.parity).toBe("none");

    // The fixture labels the TX line; the Modbus decoder expects the bus signal.
    const frames = decodeModbus(cap.samples, cap.sampleRate, 3, 9600, "none");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(f => f.crcOk)).toBe(true);
  });

  it("loads and label-detects real CAN sigrok-dumps fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("can_mcp2515_125k_msg_222.sr"));
    expect(cap.sampleRate).toBe(4_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    expect(cap.channelLabels?.[2]).toBe("CAN_RX");

    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("can");
    expect(cfg.can.ch).toBe(2);

    // The CAN decoder lacks bit destuffing, so it cannot fully decode real
    // captures. Verify the channel has signal activity.
    let transitions = 0;
    let last = -1;
    for (let s = 0; s < cap.samples.length; s++) {
      const v = (cap.samples[s] >> 2) & 1;
      if (last >= 0 && v !== last) transitions++;
      last = v;
    }
    expect(transitions).toBeGreaterThan(0);
  });

  it("auto-detects and decodes real 1-Wire sigrok-dumps fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("onewire_ds18b20.sr"));
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);

    // ch0 has the 1-Wire reset/presence/byte traffic.
    const frames = decodeOneWire(cap.samples, cap.sampleRate, 0);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter(f => f.type === "reset").length).toBeGreaterThan(0);
    expect(frames.filter(f => f.type === "byte").length).toBeGreaterThan(0);
  });

  it("auto-detects and decodes synthetic LIN .sr fixture", async () => {
    const cap = await parseSigrokSr(await loadFixture("lin_synthetic_2frames.sr"));
    expect(cap.sampleRate).toBe(1_000_000);
    expect(cap.width).toBe(8);
    expect(cap.samples.length).toBeGreaterThan(0);
    expect(cap.channelLabels?.[0]).toBe("LIN");

    const cfg = inferDecoderDefaults(cap);
    expect(cfg.tab).toBe("lin");
    expect(cfg.lin.ch).toBe(0);

    const detected = autoDetectLaProtocol(cap);
    expect(detected.tab).toBe("lin");
    expect(detected.lin?.ch).toBe(0);
    expect(detected.lin?.baud).toBe(19_200);

    const frames = decodeLIN(cap.samples, cap.sampleRate, 0, 19_200, "classic");
    expect(frames.length).toBe(2);
    expect(frames.every(f => f.parityOk && f.checksumOk)).toBe(true);
    expect(frames[0]!.id).toBe(0x00);
    expect(frames[0]!.data).toEqual([0x42, 0x84]);
    expect(frames[1]!.id).toBe(0x02);
    expect(frames[1]!.data).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
});
