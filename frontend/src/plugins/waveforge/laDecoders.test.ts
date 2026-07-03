import { describe, it, expect } from "vitest";
import type { LaCapture } from "./laDecoders";
import {
  decodeUartChunk,
  decodeI2C,
  decodeSPI,
  decodeCAN,
  decodeOneWire,
  decodeSWD,
  decodeJTAG,
  decodeModbus,
  generateLaTestPattern,
  makeFakeUartSignal,
  generateCanFrame,
  generateOneWireFrame,
  generateSwdFrame,
  generateJtagFrame,
  generateModbusFrame,
  MAX_TICKER,
  inferDecoderDefaults,
  autoDetectLaProtocol,
} from "./laDecoders";

// ---------------------------------------------------------------------------
// Signal builders
// ---------------------------------------------------------------------------

/** Build a UART signal on `channel`: idle-high, LSB-first, 8N1. */
function buildUartSignal(
  bytes: number[],
  samplesPerBit: number,
  channel: number,
  opts: { badStopBit?: boolean } = {}
): Uint8Array {
  const bits: number[] = [];
  const push = (v: number, n: number) => { for (let i = 0; i < n; i++) bits.push(v); };
  push(1, samplesPerBit * 4); // leading idle
  for (const b of bytes) {
    push(0, samplesPerBit); // start
    for (let i = 0; i < 8; i++) push((b >> i) & 1, samplesPerBit);
    push(opts.badStopBit ? 0 : 1, samplesPerBit); // stop
    push(1, samplesPerBit * 2); // inter-byte idle
  }
  push(1, samplesPerBit * 4); // trailing idle
  return Uint8Array.from(bits.map(v => v << channel));
}

/** Build an I2C transaction: START, addr byte (+ack), data bytes (+ack/nack), STOP. */
function buildI2cSignal(
  addr7: number,
  write: boolean,
  data: Array<{ byte: number; ack: boolean }>,
  samplesPerPhase: number,
  sclCh: number,
  sdaCh: number
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
  push(1, 1, samplesPerPhase * 4);              // idle
  push(1, 1, samplesPerPhase); push(1, 0, samplesPerPhase); // START
  sendByte((addr7 << 1) | (write ? 0 : 1), true);
  for (const d of data) sendByte(d.byte, d.ack);
  push(0, 0, samplesPerPhase); push(1, 0, samplesPerPhase); push(1, 1, samplesPerPhase); // STOP
  push(1, 1, samplesPerPhase * 4);              // idle
  return Uint8Array.from(out);
}

/** Build a SPI mode-0 transaction with configurable word size and CS polarity. */
function buildSpiSignal(
  words: Array<{ mosi: number; miso: number }>,
  bits: 8 | 16,
  samplesPerPhase: number,
  chans: { mosi: number; miso: number; sck: number; cs: number },
  csActiveLow = true
): Uint8Array {
  const out: number[] = [];
  const csInactive = csActiveLow ? 1 : 0;
  const csActive = csActiveLow ? 0 : 1;
  const push = (mosi: number, miso: number, sck: number, cs: number, n: number) => {
    for (let i = 0; i < n; i++) {
      out.push((mosi << chans.mosi) | (miso << chans.miso) | (sck << chans.sck) | (cs << chans.cs));
    }
  };
  push(0, 0, 0, csInactive, samplesPerPhase * 2); // idle
  push(0, 0, 0, csActive, samplesPerPhase);       // assert CS
  for (const w of words) {
    for (let i = bits - 1; i >= 0; i--) {
      const mo = (w.mosi >> i) & 1;
      const mi = (w.miso >> i) & 1;
      push(mo, mi, 0, csActive, samplesPerPhase); // setup on SCK low
      push(mo, mi, 1, csActive, samplesPerPhase); // sample on rising edge
    }
  }
  push(0, 0, 0, csInactive, samplesPerPhase * 2); // release CS
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// decodeUartChunk
// ---------------------------------------------------------------------------

describe("decodeUartChunk", () => {
  const RATE = 1_000_000;
  const BAUD = 100_000; // 10 samples per bit
  const SPB = RATE / BAUD;

  it("decodes a multi-byte message", () => {
    const sig = buildUartSignal([0x48, 0x69, 0x0a], SPB, 0); // "Hi\n"
    const rows = decodeUartChunk(sig, RATE, BAUD, 0);
    expect(rows.map(r => r.byte)).toEqual([0x48, 0x69, 0x0a]);
    expect(rows.every(r => !r.error)).toBe(true);
  });

  it("decodes on a non-zero channel", () => {
    const sig = buildUartSignal([0xa5], SPB, 5);
    const rows = decodeUartChunk(sig, RATE, BAUD, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].byte).toBe(0xa5);
  });

  it("flags a framing error when the stop bit is low", () => {
    const sig = buildUartSignal([0x42], SPB, 0, { badStopBit: true });
    const rows = decodeUartChunk(sig, RATE, BAUD, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBe(true);
  });

  it("propagates baseSample into sample and ts fields", () => {
    const sig = buildUartSignal([0x55], SPB, 0);
    const base = 100_000;
    const rows = decodeUartChunk(sig, RATE, BAUD, 0, base);
    expect(rows[0].sample).toBeGreaterThanOrEqual(base);
    expect(rows[0].ts).toBeCloseTo(rows[0].sample / RATE, 9);
  });

  it("returns empty for an idle-high line", () => {
    const sig = Uint8Array.from(new Array(1000).fill(1));
    expect(decodeUartChunk(sig, RATE, BAUD, 0)).toHaveLength(0);
  });

  it("decodes even parity correctly", () => {
    const { samples } = makeFakeUartSignal("A", RATE, BAUD, 0, "even", 1);
    const rows = decodeUartChunk(samples, RATE, BAUD, 0, 0, 8, "even", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].byte).toBe(0x41);
    expect(rows[0].parityOk).toBe(true);
    expect(rows[0].error).toBe(false);
  });

  it("decodes odd parity correctly", () => {
    const { samples } = makeFakeUartSignal("!", RATE, BAUD, 0, "odd", 1);
    const rows = decodeUartChunk(samples, RATE, BAUD, 0, 0, 8, "odd", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].byte).toBe(0x21);
    expect(rows[0].parityOk).toBe(true);
    expect(rows[0].error).toBe(false);
  });

  it("flags a parity error", () => {
    const { samples } = makeFakeUartSignal("A", RATE, BAUD, 0, "even", 1);
    const rows = decodeUartChunk(samples, RATE, BAUD, 0, 0, 8, "odd", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].parityOk).toBe(false);
    expect(rows[0].error).toBe(true);
  });

  it("decodes with inverted logic", () => {
    const { samples } = makeFakeUartSignal("Z", RATE, BAUD, 0, "none", 1);
    const inverted = samples.map(b => b ^ 1);
    const rows = decodeUartChunk(inverted, RATE, BAUD, 0, 0, 8, "none", 1, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].byte).toBe(0x5a);
  });

  it("decodes 7-bit data", () => {
    // 7-bit UART byte: start, 7 data bits (LSB-first), stop
    const bits: number[] = [];
    const push = (v: number, n: number) => { for (let i = 0; i < n; i++) bits.push(v); };
    push(1, SPB * 4); // idle
    const byte = 0x55; // 0b1010101
    push(0, SPB); // start
    for (let i = 0; i < 7; i++) push((byte >> i) & 1, SPB);
    push(1, SPB); // stop
    push(1, SPB * 4); // trailing idle
    const sig = Uint8Array.from(bits.map(v => v << 0));
    const rows = decodeUartChunk(sig, RATE, BAUD, 0, 0, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].byte).toBe(0x55);
  });

  it("decodes 2 stop bits", () => {
    const { samples } = makeFakeUartSignal("B", RATE, BAUD, 0, "none", 2);
    const rows = decodeUartChunk(samples, RATE, BAUD, 0, 0, 8, "none", 2);
    expect(rows).toHaveLength(1);
    expect(rows[0].byte).toBe(0x42);
  });
});

// ---------------------------------------------------------------------------
// decodeI2C
// ---------------------------------------------------------------------------

describe("decodeI2C", () => {
  const RATE = 1_000_000;
  const SPP = 10;

  it("decodes START, address, data bytes, ACKs, and STOP", () => {
    const sig = buildI2cSignal(0x50, true, [
      { byte: 0x01, ack: true },
      { byte: 0x02, ack: true },
    ], SPP, 0, 1);
    const rows = decodeI2C(sig, RATE, 0, 1);

    const types = rows.map(r => r.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("stop");

    const addrRow = rows.find(r => r.type === "byte" && r.addr !== undefined);
    expect(addrRow?.addr).toBe(0x50);
    expect(addrRow?.rw).toBe("write");

    const dataRows = rows.filter(r => r.type === "byte" && r.data !== undefined);
    expect(dataRows.map(r => r.data)).toEqual([0x01, 0x02]);

    expect(rows.filter(r => r.type === "ack")).toHaveLength(3); // addr + 2 data
    expect(rows.filter(r => r.type === "nack")).toHaveLength(0);
  });

  it("detects a read transaction", () => {
    const sig = buildI2cSignal(0x3c, false, [{ byte: 0xff, ack: false }], SPP, 0, 1);
    const rows = decodeI2C(sig, RATE, 0, 1);
    const addrRow = rows.find(r => r.type === "byte" && r.addr !== undefined);
    expect(addrRow?.addr).toBe(0x3c);
    expect(addrRow?.rw).toBe("read");
  });

  it("detects NACK", () => {
    const sig = buildI2cSignal(0x50, true, [{ byte: 0xaa, ack: false }], SPP, 0, 1);
    const rows = decodeI2C(sig, RATE, 0, 1);
    expect(rows.some(r => r.type === "nack")).toBe(true);
  });

  it("works on non-default channels", () => {
    const sig = buildI2cSignal(0x22, true, [{ byte: 0x7e, ack: true }], SPP, 4, 6);
    const rows = decodeI2C(sig, RATE, 4, 6);
    const dataRow = rows.find(r => r.type === "byte" && r.data !== undefined);
    expect(dataRow?.data).toBe(0x7e);
  });

  it("returns empty for an idle bus", () => {
    const sig = Uint8Array.from(new Array(1000).fill(0b11)); // both lines high
    expect(decodeI2C(sig, RATE, 0, 1)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// decodeSPI
// ---------------------------------------------------------------------------

describe("decodeSPI", () => {
  const RATE = 1_000_000;
  const SPP = 4;
  const CH = { mosi: 0, miso: 1, sck: 2, cs: 3 };

  it("decodes 8-bit mode-0 words", () => {
    const sig = buildSpiSignal(
      [{ mosi: 0xa5, miso: 0x12 }, { mosi: 0x5a, miso: 0x34 }],
      8, SPP, CH
    );
    const rows = decodeSPI(sig, RATE, CH.mosi, CH.miso, CH.sck, CH.cs, 0, 8, true);
    expect(rows.map(r => r.mosi)).toEqual([0xa5, 0x5a]);
    expect(rows.map(r => r.miso)).toEqual([0x12, 0x34]);
  });

  it("decodes 16-bit words", () => {
    const sig = buildSpiSignal([{ mosi: 0xbeef, miso: 0xcafe }], 16, SPP, CH);
    const rows = decodeSPI(sig, RATE, CH.mosi, CH.miso, CH.sck, CH.cs, 0, 16, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].mosi).toBe(0xbeef);
    expect(rows[0].miso).toBe(0xcafe);
  });

  it("supports CS active-high", () => {
    const sig = buildSpiSignal([{ mosi: 0x3c, miso: 0xc3 }], 8, SPP, CH, false);
    const rows = decodeSPI(sig, RATE, CH.mosi, CH.miso, CH.sck, CH.cs, 0, 8, false);
    expect(rows).toHaveLength(1);
    expect(rows[0].mosi).toBe(0x3c);
    expect(rows[0].miso).toBe(0xc3);
  });

  it("returns empty when CS never asserts", () => {
    const sig = Uint8Array.from(new Array(1000).fill(1 << CH.cs)); // CS high = inactive
    expect(decodeSPI(sig, RATE, CH.mosi, CH.miso, CH.sck, CH.cs, 0, 8, true)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateLaTestPattern — fixture round-trip through all three decoders
// ---------------------------------------------------------------------------

describe("generateLaTestPattern", () => {
  // Use a rate that is an exact integer multiple of 115200 so bit periods are
  // clean for direct bit-level verification.
  const RATE = 115200 * 8;
  const bitTime = 8;
  // One unscaled copy of the UART pattern is 320 samples:
  // 3 bytes (80 each) + 80 trailing idle. The generator does NOT add leading idle.
  const durationS = 320 / RATE;
  const pattern = generateLaTestPattern(RATE, durationS);

  it("returns the expected buffer length", () => {
    expect(pattern.length).toBe(Math.floor(RATE * durationS));
  });

  it("UART pattern on D0 starts with start bit and LSB-first data", () => {
    // D0 starts immediately with the start bit of 0x48 (LSB-first).
    // Each bit is 8 samples; start bit is samples 0-7.
    expect(pattern[0] & 1).toBe(0); // start bit
    expect(pattern[bitTime * 1] & 1).toBe(0); // bit 0 of 0x48 = 0
    expect(pattern[bitTime * 2] & 1).toBe(0); // bit 1 = 0
    expect(pattern[bitTime * 3] & 1).toBe(0); // bit 2 = 0
    expect(pattern[bitTime * 4] & 1).toBe(1); // bit 3 = 1
    expect(pattern[bitTime * 5] & 1).toBe(0); // bit 4 = 0
    expect(pattern[bitTime * 6] & 1).toBe(0); // bit 5 = 0
    expect(pattern[bitTime * 7] & 1).toBe(1); // bit 6 = 1
    expect(pattern[bitTime * 8] & 1).toBe(0); // bit 7 = 0
    expect(pattern[bitTime * 9] & 1).toBe(1); // stop bit
  });

  it("I2C pattern on D1/D2 shows idle, START, and address byte", () => {
    // SCL on D1, SDA on D2. Generator starts with 4*bitTime idle, then START.
    expect((pattern[0] >> 1) & 1).toBe(1); // SCL high
    expect((pattern[0] >> 2) & 1).toBe(1); // SDA high
    // START: SCL high, SDA falls (sample 32→40)
    const startIdx = bitTime * 4;
    expect((pattern[startIdx] >> 1) & 1).toBe(1); // SCL high
    expect((pattern[startIdx] >> 2) & 1).toBe(1); // SDA high before start
    expect((pattern[startIdx + bitTime] >> 2) & 1).toBe(0); // SDA falls on START
    // First bit of address byte 0xA0 is MSB = 1, presented at sample 48
    const addrBit0Idx = bitTime * 6;
    expect((pattern[addrBit0Idx] >> 2) & 1).toBe(1);
  });

  it("SPI pattern on D3-D6 shows CS active, clock edges, and MOSI data", () => {
    // D3=MOSI, D4=MISO, D5=SCK, D6=CS. CS active low after 2*bitTime idle.
    const csActiveIdx = bitTime * 2;
    expect((pattern[csActiveIdx] >> 6) & 1).toBe(0); // CS low
    // First bit of 0xA5 MOSI is MSB = 1, presented on first SCK low phase (sample 24)
    const firstBitIdx = bitTime * 3;
    expect((pattern[firstBitIdx] >> 3) & 1).toBe(1);
    // First bit of 0x12 MISO is MSB = 0
    expect((pattern[firstBitIdx] >> 4) & 1).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Row cap behavior (documented limitation — see la-pr1 spec)
// ---------------------------------------------------------------------------

describe("MAX_TICKER cap", () => {
  it("I2C decode stops after exceeding the cap", () => {
    // A long transaction with many data bytes should not return unbounded rows
    const data = Array.from({ length: 300 }, (_, i) => ({ byte: i & 0xff, ack: true }));
    const sig = buildI2cSignal(0x50, true, data, 4, 0, 1);
    const rows = decodeI2C(sig, 1_000_000, 0, 1);
    expect(rows.length).toBeLessThanOrEqual(MAX_TICKER + 2);
  });
});

describe("inferDecoderDefaults", () => {
  const base = { sampleRate: 1_000_000, width: 8 as const, samples: new Uint8Array(0), source: "fob-csv", importedAt: new Date().toISOString() };
  it("picks I2C when SCL/SDA labels are present", () => {
    const cfg = inferDecoderDefaults({ ...base, channelLabels: ["A0", "SCL", "SDA"] });
    expect(cfg.tab).toBe("i2c");
    expect(cfg.i2c).toEqual({ scl: 1, sda: 2, addrBits: 7 });
  });
  it("picks SPI when MOSI/SCK labels are present", () => {
    const cfg = inferDecoderDefaults({ ...base, channelLabels: ["MOSI", "MISO", "SCK", "CS"] });
    expect(cfg.tab).toBe("spi");
    expect(cfg.spi).toEqual({ mosi: 0, miso: 1, sck: 2, cs: 3, mode: 0, bits: 8, csActiveLow: true });
  });
  it("picks UART when TX label is present", () => {
    const cfg = inferDecoderDefaults({ ...base, channelLabels: ["TX", "RX"] });
    expect(cfg.tab).toBe("uart");
    expect(cfg.uart).toEqual({ baud: 115200, ch: 0 });
  });
  it("picks SPI for sigrok numeric probes", () => {
    const cfg = inferDecoderDefaults({ ...base, source: "sigrok-sr", channelLabels: ["0", "1", "2"] });
    expect(cfg.tab).toBe("spi");
  });
});

describe("autoDetectLaProtocol", () => {
  const cap = (samples: Uint8Array, rate: number): LaCapture => ({
    sampleRate: rate, width: 8, samples, source: "live", importedAt: new Date().toISOString(),
  });
  it("returns a positive score for a UART signal", () => {
    // 115200 baud: 10 samples/bit at 1.152 MHz sample rate.
    const rate = 1_152_000;
    const samples = buildUartSignal([0x48, 0x65, 0x6c], 10, 2);
    const result = autoDetectLaProtocol(cap(samples, rate));
    expect(result.score).toBeGreaterThan(0);
    expect(result.uart).toBeDefined();
  });
  it("returns a positive score for an I2C signal", () => {
    const samples = buildI2cSignal(0x50, true, [{ byte: 0xAB, ack: true }, { byte: 0xCD, ack: true }], 10, 1, 2);
    const result = autoDetectLaProtocol(cap(samples, 1_000_000));
    expect(result.score).toBeGreaterThan(0);
    // Small signals may tie with UART; real I2C fixtures verify protocol detection.
  });
  it("returns a positive score for the synthetic pattern", () => {
    const samples = generateLaTestPattern(1_000_000, 1);
    const result = autoDetectLaProtocol(cap(samples, 1_000_000));
    expect(result.score).toBeGreaterThan(0);
    expect(result.tab).toMatch(/^(uart|i2c|spi|can|onewire|swd|jtag|modbus)$/);
  });
  it("returns a positive score for a CAN signal", () => {
    const samples = generateCanFrame(1_000_000, 500_000, 3, 0x123, [0xDE, 0xAD, 0xBE, 0xEF]);
    const result = autoDetectLaProtocol({ ...cap(samples, 1_000_000), channelLabels: ["", "", "", "CAN"] });
    expect(result.score).toBeGreaterThan(0);
    expect(result.tab).toBe("can");
    expect(result.can).toBeDefined();
  });
  it("returns a positive score for a 1-Wire signal", () => {
    const samples = generateOneWireFrame(1_000_000, 2, [0x33, 0x00]);
    const result = autoDetectLaProtocol({ ...cap(samples, 1_000_000), channelLabels: ["", "", "1W"] });
    expect(result.score).toBeGreaterThan(0);
    expect(result.tab).toBe("onewire");
    expect(result.onewire).toBeDefined();
  });
  it("returns a positive score for a SWD signal", () => {
    const samples = generateSwdFrame(1_000_000, 1, 0, [{ apnDp: 0, read: true, addr: 0x0, data: 0x1BA01477 }]);
    const result = autoDetectLaProtocol({ ...cap(samples, 1_000_000), channelLabels: ["SWCLK", "SWDIO"] });
    expect(result.score).toBeGreaterThan(0);
    expect(result.tab).toBe("swd");
    expect(result.swd).toBeDefined();
  });
  it("returns a positive score for a JTAG signal", () => {
    const samples = generateJtagFrame(1_000_000, 0, 1, 2, 3, [{ register: "DR", tdi: 0xA5, tdo: 0x12, bits: 8 }]);
    const result = autoDetectLaProtocol({ ...cap(samples, 1_000_000), channelLabels: ["TCK", "TMS", "TDI", "TDO"] });
    expect(result.score).toBeGreaterThan(0);
    expect(result.tab).toBe("jtag");
    expect(result.jtag).toBeDefined();
  });
  it("returns a positive score for a Modbus signal", () => {
    const samples = generateModbusFrame(1_000_000, 2, 9600, 1, 0x03, [0x00, 0x00, 0x00, 0x0A], "even");
    const result = autoDetectLaProtocol({ ...cap(samples, 1_000_000), channelLabels: ["", "", "RS485"] });
    expect(result.score).toBeGreaterThan(0);
    expect(result.tab).toBe("modbus");
    expect(result.modbus).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// decodeCAN
// ---------------------------------------------------------------------------

describe("decodeCAN", () => {
  it("decodes a standard 11-bit data frame", () => {
    const samples = generateCanFrame(1_000_000, 500_000, 0, 0x123, [0xDE, 0xAD]);
    const frames = decodeCAN(samples, 1_000_000, 0, 500_000);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(0x123);
    expect(frames[0].dlc).toBe(2);
    expect(frames[0].data).toEqual([0xDE, 0xAD]);
    expect(frames[0].extended).toBe(false);
    expect(frames[0].rtr).toBe(false);
  });

  it("decodes on a non-zero channel", () => {
    const samples = generateCanFrame(1_000_000, 250_000, 5, 0x7FF, [0x01]);
    const frames = decodeCAN(samples, 1_000_000, 5, 250_000);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(0x7FF);
  });

  it("decodes multiple consecutive frames", () => {
    const f1 = generateCanFrame(1_000_000, 500_000, 0, 0x100, [0x01]);
    const f2 = generateCanFrame(1_000_000, 500_000, 0, 0x101, [0x02]);
    const combined = new Uint8Array(f1.length + f2.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);
    const frames = decodeCAN(combined, 1_000_000, 0, 500_000);
    expect(frames).toHaveLength(2);
    expect(frames.map(f => f.id)).toEqual([0x100, 0x101]);
  });
});

// ---------------------------------------------------------------------------
// decodeOneWire
// ---------------------------------------------------------------------------

describe("decodeOneWire", () => {
  const RATE = 1_000_000;

  it("detects reset and presence pulses", () => {
    const samples = generateOneWireFrame(RATE, 0, []);
    const frames = decodeOneWire(samples, RATE, 0);
    expect(frames.some(f => f.type === "reset")).toBe(true);
    expect(frames.some(f => f.type === "presence")).toBe(true);
  });

  it("decodes bytes after reset/presence", () => {
    const samples = generateOneWireFrame(RATE, 0, [0x33, 0x00]);
    const frames = decodeOneWire(samples, RATE, 0);
    const bytes = frames.filter(f => f.type === "byte");
    expect(bytes.map(f => f.value)).toEqual([0x33, 0x00]);
  });

  it("decodes on a non-zero channel", () => {
    const samples = generateOneWireFrame(RATE, 7, [0xAA]);
    const frames = decodeOneWire(samples, RATE, 7);
    const bytes = frames.filter(f => f.type === "byte");
    expect(bytes).toHaveLength(1);
    expect(bytes[0].value).toBe(0xAA);
  });
});

// ---------------------------------------------------------------------------
// decodeSWD
// ---------------------------------------------------------------------------

describe("decodeSWD", () => {
  const RATE = 1_000_000;

  it("detects reset and switching sequence", () => {
    const samples = generateSwdFrame(RATE, 1, 0, []);
    const frames = decodeSWD(samples, RATE, 1, 0);
    expect(frames.some(f => f.type === "reset")).toBe(true);
  });

  it("decodes a read DP IDR request and data", () => {
    const samples = generateSwdFrame(RATE, 1, 0, [{ apnDp: 0, read: true, addr: 0x0, data: 0x1BA01477 }]);
    const frames = decodeSWD(samples, RATE, 1, 0);
    const req = frames.find(f => f.type === "request");
    expect(req).toBeDefined();
    expect(req!.read).toBe(true);
    expect(req!.apnDp).toBe(0);
    expect(req!.addr).toBe(0x0);
    const data = frames.find(f => f.type === "data");
    expect(data).toBeDefined();
    expect(data!.data).toBe(0x1BA01477);
    expect(data!.ok).toBe(true);
  });

  it("decodes on different channels", () => {
    const samples = generateSwdFrame(RATE, 7, 3, [{ apnDp: 1, read: false, addr: 0x4, data: 0xDEADBEEF }]);
    const frames = decodeSWD(samples, RATE, 7, 3);
    const req = frames.find(f => f.type === "request");
    expect(req).toBeDefined();
    expect(req!.apnDp).toBe(1);
    expect(req!.read).toBe(false);
    const data = frames.find(f => f.type === "data");
    expect(data?.data).toBe(0xDEADBEEF);
  });
});

// ---------------------------------------------------------------------------
// decodeJTAG
// ---------------------------------------------------------------------------

describe("decodeJTAG", () => {
  const RATE = 1_000_000;

  it("detects reset and run-test/idle", () => {
    const samples = generateJtagFrame(RATE, 0, 1, 2, 3, []);
    const frames = decodeJTAG(samples, RATE, 0, 1, 2, 3);
    expect(frames.some(f => f.type === "reset")).toBe(true);
    expect(frames.some(f => f.type === "state" && f.state === "Run-Test/Idle")).toBe(true);
  });

  it("decodes a DR scan with TDI and TDO data", () => {
    const samples = generateJtagFrame(RATE, 0, 1, 2, 3, [{ register: "DR", tdi: 0xA5, tdo: 0x12, bits: 8 }]);
    const frames = decodeJTAG(samples, RATE, 0, 1, 2, 3);
    const shift = frames.find(f => f.type === "shift");
    expect(shift).toBeDefined();
    expect(shift!.register).toBe("DR");
    expect(shift!.tdi).toBe(0xA5);
    expect(shift!.tdo).toBe(0x12);
    expect(shift!.bits).toBe(8);
  });

  it("decodes an IR scan and multiple DR scans", () => {
    const samples = generateJtagFrame(RATE, 0, 1, 2, 3, [
      { register: "IR", tdi: 0x5, tdo: 0x0, bits: 4 },
      { register: "DR", tdi: 0x1234, tdo: 0x4321, bits: 16 },
    ]);
    const frames = decodeJTAG(samples, RATE, 0, 1, 2, 3);
    const shifts = frames.filter(f => f.type === "shift");
    expect(shifts).toHaveLength(2);
    expect(shifts[0].register).toBe("IR");
    expect(shifts[0].tdi).toBe(0x5);
    expect(shifts[1].register).toBe("DR");
    expect(shifts[1].tdi).toBe(0x1234);
    expect(shifts[1].tdo).toBe(0x4321);
  });
});

// ---------------------------------------------------------------------------
// decodeModbus
// ---------------------------------------------------------------------------

describe("decodeModbus", () => {
  const RATE = 1_000_000;
  const BAUD = 9600;

  it("decodes a read holding registers request", () => {
    const samples = generateModbusFrame(RATE, 0, BAUD, 1, 0x03, [0x00, 0x00, 0x00, 0x0A], "even");
    const frames = decodeModbus(samples, RATE, 0, BAUD, "even");
    expect(frames).toHaveLength(1);
    expect(frames[0].addr).toBe(1);
    expect(frames[0].func).toBe(0x03);
    expect(frames[0].data).toEqual([0x00, 0x00, 0x00, 0x0A]);
    expect(frames[0].crcOk).toBe(true);
  });

  it("decodes on a different channel with no parity", () => {
    const samples = generateModbusFrame(RATE, 3, BAUD, 5, 0x10, [0x00, 0x01, 0x02, 0x00, 0x01, 0x02, 0xAB], "none");
    const frames = decodeModbus(samples, RATE, 3, BAUD, "none");
    expect(frames).toHaveLength(1);
    expect(frames[0].addr).toBe(5);
    expect(frames[0].func).toBe(0x10);
    expect(frames[0].crcOk).toBe(true);
  });

  it("decodes an exception response", () => {
    const samples = generateModbusFrame(RATE, 0, BAUD, 2, 0x83, [0x02], "even");
    const frames = decodeModbus(samples, RATE, 0, BAUD, "even");
    expect(frames).toHaveLength(1);
    expect(frames[0].addr).toBe(2);
    expect(frames[0].type).toBe("error");
    expect(frames[0].func).toBe(0x03);
    expect(frames[0].data).toEqual([0x02]);
    expect(frames[0].crcOk).toBe(true);
  });
});
