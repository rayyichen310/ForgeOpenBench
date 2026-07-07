// ---------------------------------------------------------------------------
// LA protocol decoders — pure functions over raw sample buffers.
// Extracted from WaveformLaView.tsx (PR: la-logic-extraction).
// ---------------------------------------------------------------------------

export const MAX_TICKER = 200; // max ticker rows to keep

export interface TickerRow { ts: number; byte: number; sample: number; endSample: number; error: boolean; parityOk?: boolean; bitSamples?: number; }

export interface I2CFrame {
  startSample: number;
  endSample: number;
  ts: number;
  type: "start" | "repeated-start" | "stop" | "byte" | "ack" | "nack";
  addr?: number;     // 7-bit address
  data?: number;     // byte value
  rw?: "read" | "write";
  bitSamples?: number; // SCL period, for clock-aware UI rendering
}

export interface SPIFrame {
  startSample: number;
  endSample: number;
  ts: number;
  mosi?: number;
  miso?: number;
  bitSamples?: number; // SCK period, for clock-aware UI rendering
}

export interface CANFrame {
  startSample: number;
  endSample: number;
  ts: number;
  id: number;
  extended: boolean;
  rtr: boolean;
  dlc: number;
  data: number[];
  error?: boolean;
  bitSamples?: number; // CAN bit period, for clock-aware UI rendering
}

export interface OneWireFrame {
  startSample: number;
  endSample: number;
  ts: number;
  type: "reset" | "presence" | "byte";
  value?: number;
  bitSamples?: number; // 1-Wire bit period, for clock-aware UI rendering
}

export interface SWDFrame {
  startSample: number;
  endSample: number;
  ts: number;
  type: "reset" | "request" | "data";
  apnDp?: 0 | 1;
  read?: boolean;
  addr?: number;
  data?: number;
  ok?: boolean;
  bitSamples?: number; // SWDCLK period, for clock-aware UI rendering
}

export interface JTAGFrame {
  startSample: number;
  endSample: number;
  ts: number;
  type: "state" | "shift" | "reset";
  state?: string;
  register?: "DR" | "IR";
  tdi?: number;
  tdo?: number;
  bits?: number;
  bitSamples?: number; // TCK period, for clock-aware UI rendering
}

export interface ModbusFrame {
  startSample: number;
  endSample: number;
  ts: number;
  type: "request" | "response" | "error";
  addr: number;
  func: number;
  data: number[];
  crcOk: boolean;
  bitSamples?: number; // UART bit period, for clock-aware UI rendering
}

export interface LINFrame {
  startSample: number;
  endSample: number;
  ts: number;
  id: number;            // 6-bit ID
  pid: number;           // full 8-bit protected identifier
  parityOk: boolean;
  data: number[];
  checksum: number;
  checksumOk: boolean;
  type: "unconditional" | "diagnostic" | "user" | "reserved";
  bitSamples?: number;   // measured bit period for clock-aware UI rendering
}

export type DecoderTab = "uart" | "i2c" | "spi" | "can" | "onewire" | "swd" | "jtag" | "modbus" | "lin";

export interface LaCapture {
  sampleRate: number;
  width: 8 | 16;
  samples: Uint8Array;
  source: string;
  importedAt: string;
  channelLabels?: string[];
}

export interface DecoderDefaults {
  tab: DecoderTab;
  uart: { baud: number; ch: number };
  i2c: { scl: number; sda: number; addrBits: 7 | 8 };
  spi: { mosi: number; miso: number; sck: number; cs: number; mode: 0 | 1 | 2 | 3; bits: 8 | 16; csActiveLow: boolean };
  can: { ch: number; baud: number };
  onewire: { ch: number };
  swd: { swdio: number; swclk: number };
  jtag: { tck: number; tms: number; tdi: number; tdo: number };
  modbus: { ch: number; baud: number; parity: "none" | "even" | "odd" };
  lin: { ch: number; baud: number; checksum: "classic" | "enhanced" };
}

export function inferDecoderDefaults(capture: LaCapture): DecoderDefaults {
  const labels = capture.channelLabels ?? [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const find = (names: string[]) => {
    for (let i = 0; i < labels.length; i++) {
      const l = norm(labels[i] ?? "");
      if (names.some(n => l.includes(n))) return i;
    }
    return -1;
  };
  const tx = find(["tx", "uarttx", "uart_tx"]);
  const scl = find(["scl"]);
  const sda = find(["sda"]);
  const mosi = find(["mosi"]);
  const miso = find(["miso"]);
  const sck = find(["sck", "clk", "spiclk"]);
  const cs = find(["cs", "ss", "nss"]);

  const uartCh = tx >= 0 ? tx : 0;
  const canCh = find(["can", "canrx", "can_rx", "rx"]);
  const canDefaults = { ch: canCh >= 0 ? canCh : 0, baud: 500000 };
  const oneWireCh = find(["onewire", "1wire", "1w", "ow", "dq"]);
  const oneWireDefaults = { ch: oneWireCh >= 0 ? oneWireCh : 0 };
  const swdClk = find(["swclk", "swclktdi"]);
  const swdDio = find(["swdio", "swdio TMS"]);
  const swdDefaults = { swclk: swdClk >= 0 ? swdClk : 0, swdio: swdDio >= 0 ? swdDio : 1 };
  const jtagTck = find(["tck", "jtagtck"]);
  const jtagTms = find(["tms", "jtagtms"]);
  const jtagTdi = find(["tdi", "jtagtdi"]);
  const jtagTdo = find(["tdo", "jtagtdo"]);
  const jtagDefaults = { tck: jtagTck >= 0 ? jtagTck : 0, tms: jtagTms >= 0 ? jtagTms : 1, tdi: jtagTdi >= 0 ? jtagTdi : 2, tdo: jtagTdo >= 0 ? jtagTdo : 3 };
  const modbusCh = find(["rs485", "modbus", "485"]);
  const modbusDefaults = { ch: modbusCh >= 0 ? modbusCh : uartCh, baud: 9600, parity: "even" as const };
  const linCh = find(["lin"]);
  const linDefaults = { ch: linCh >= 0 ? linCh : 0, baud: 19200, checksum: "classic" as const };
  if (scl >= 0 && sda >= 0) {
    return { tab: "i2c", uart: { baud: 115200, ch: uartCh }, i2c: { scl, sda, addrBits: 7 }, spi: { mosi: mosi >= 0 ? mosi : 0, miso: miso >= 0 ? miso : 0, sck: sck >= 0 ? sck : 1, cs: cs >= 0 ? cs : -1, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  const definedLabels = labels.filter((l) => l !== undefined && l !== "");
  const allNumeric = definedLabels.length > 0 && definedLabels.every(l => /^\d+$/.test(l));
  const detected = detectSpiChannels(capture.samples, capture.width);
  if ((mosi >= 0 && sck >= 0) || (sck >= 0 && cs >= 0)) {
    return { tab: "spi", uart: { baud: 115200, ch: uartCh }, i2c: { scl: scl >= 0 ? scl : 1, sda: sda >= 0 ? sda : 2, addrBits: 7 }, spi: { mosi: mosi >= 0 ? mosi : 0, miso: miso >= 0 ? miso : 1, sck: sck >= 0 ? sck : 2, cs: cs >= 0 ? cs : -1, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (capture.source === "sigrok-sr" && allNumeric && definedLabels.length <= 4) {
    return { tab: "spi", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: -1, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (swdClk >= 0 && swdDio >= 0) {
    return { tab: "swd", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (jtagTck >= 0 && jtagTms >= 0) {
    return { tab: "jtag", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (modbusCh >= 0) {
    return { tab: "modbus", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (linCh >= 0) {
    return { tab: "lin", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  // TX/RX labels strongly indicate UART; prefer that over CAN/1-Wire fallbacks.
  if (tx >= 0) {
    return { tab: "uart", uart: { baud: estimateUartBaud(capture.samples, capture.sampleRate, uartCh), ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (canCh >= 0) {
    return { tab: "can", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  if (oneWireCh >= 0) {
    return { tab: "onewire", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
  }
  return { tab: "uart", uart: { baud: estimateUartBaud(capture.samples, capture.sampleRate, uartCh), ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true }, can: canDefaults, onewire: oneWireDefaults, swd: swdDefaults, jtag: jtagDefaults, modbus: modbusDefaults, lin: linDefaults };
}

export function estimateUartBaud(samples: Uint8Array, sampleRate: number, ch: number): number {
  const widths: number[] = [];
  let last = 0;
  let lastS = 0;
  for (let s = 0; s < samples.length; s++) {
    const v = (samples[s] >> ch) & 1;
    if (v !== last) {
      widths.push(s - lastS);
      last = v;
      lastS = s;
    }
  }
  const positive = widths.filter(w => w > 0).sort((a, b) => a - b);
  if (positive.length === 0) return 115200;
  const minW = positive[0]!;
  // Short pulses are one bit; idle periods are much longer. Use median of short pulses.
  const short = positive.filter(w => w <= minW * 3);
  const bitW = short[Math.floor(short.length / 2)] ?? minW;
  const baud = Math.round(sampleRate / bitW);
  const std = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1_000_000];
  let best = 115200;
  let bestErr = Infinity;
  for (const b of std) {
    const err = Math.abs(baud - b);
    if (err < bestErr) { bestErr = err; best = b; }
  }
  return best;
}

export function detectSpiChannels(samples: Uint8Array, width: number): { sck: number; mosi: number; miso: number; cs: number } {
  const maxCh = Math.min(width, 16);
  // Count transitions per channel.
  const transitions = Array.from({ length: maxCh }, () => 0);
  const last = new Int8Array(maxCh).fill(-1);
  for (let s = 0; s < samples.length; s++) {
    const byte = samples[s]!;
    for (let ch = 0; ch < maxCh; ch++) {
      const v = (byte >> ch) & 1;
      if (last[ch] !== -1 && v !== last[ch]) transitions[ch]++;
      last[ch] = v;
    }
  }
  // Clock is the channel with the most transitions.
  const sorted = transitions.map((c, ch) => ({ ch, c })).sort((a, b) => b.c - a.c);
  const sck = sorted[0]?.c ? sorted[0].ch : 2;
  // MOSI/MISO are the next two most active channels, excluding SCK.
  const others = sorted.filter(s => s.ch !== sck).slice(0, 2);
  const mosi = others[0]?.ch ?? 0;
  const miso = others[1]?.ch ?? 1;
  // CS is not detectable from transitions alone; leave it for manual or default.
  const cs = 6;
  return { sck, mosi, miso, cs };
}

export function getActiveChannels(samples: Uint8Array, width: number): number[] {
  const maxCh = Math.min(width, 16);
  const active = new Set<number>();
  const last = new Int8Array(maxCh).fill(-1);
  for (let s = 0; s < samples.length; s++) {
    const byte = samples[s]!;
    for (let ch = 0; ch < maxCh; ch++) {
      const v = (byte >> ch) & 1;
      if (last[ch] !== -1 && v !== last[ch]) active.add(ch);
      last[ch] = v;
    }
  }
  return Array.from(active).sort((a, b) => a - b);
}

export interface AutoDetectResult {
  tab: DecoderTab;
  score: number;
  reason: string;
  uart?: { baud: number; ch: number };
  i2c?: { scl: number; sda: number; addrBits: 7 | 8 };
  spi?: { mosi: number; miso: number; sck: number; cs: number; mode: 0 | 1 | 2 | 3; bits: 8 | 16 };
  can?: { ch: number; baud: number };
  onewire?: { ch: number };
  swd?: { swdio: number; swclk: number };
  jtag?: { tck: number; tms: number; tdi: number; tdo: number };
  modbus?: { ch: number; baud: number; parity: "none" | "even" | "odd" };
  lin?: { ch: number; baud: number; checksum: "classic" | "enhanced" };
}

/**
 * Auto-detect the most likely protocol in a capture.
 * Scores each candidate by the number of valid decoded frames/rows.
 * Returns the best match and its configuration.
 */
export function autoDetectLaProtocol(capture: LaCapture): AutoDetectResult {
  const samples = capture.samples;
  const rate = capture.sampleRate;
  const width = capture.width;

  // If the capture has explicit probe labels, use label-based inference first.
  const labelDefaults = inferDecoderDefaults(capture);
  if (labelDefaults.tab === "i2c" && labelDefaults.i2c) {
    const frames = decodeI2C(samples, rate, labelDefaults.i2c.scl, labelDefaults.i2c.sda);
    const score = frames.filter(f => f.type === "start" || f.type === "stop").length * 2 + frames.filter(f => f.type === "byte").length;
    if (score > 0) return { tab: "i2c", score, reason: `I2C on D${labelDefaults.i2c.scl}/D${labelDefaults.i2c.sda} (labels)`, i2c: labelDefaults.i2c };
  }
  if (labelDefaults.tab === "spi" && labelDefaults.spi) {
    const frames = decodeSPI(samples, rate, labelDefaults.spi.mosi, labelDefaults.spi.miso, labelDefaults.spi.sck, labelDefaults.spi.cs, labelDefaults.spi.mode, labelDefaults.spi.bits, labelDefaults.spi.csActiveLow);
    if (frames.length > 0) return { tab: "spi", score: frames.length, reason: `SPI mode ${labelDefaults.spi.mode} on D${labelDefaults.spi.mosi}/D${labelDefaults.spi.sck} (labels)`, spi: labelDefaults.spi };
  }
  if (labelDefaults.tab === "uart" && labelDefaults.uart) {
    const rows = decodeUartChunk(samples, rate, labelDefaults.uart.baud, labelDefaults.uart.ch);
    const valid = rows.filter(r => !r.error).length;
    if (valid > 0) {
      // If the same bytes also decode as valid Modbus RTU frames, prefer Modbus.
      for (const parity of ["none", "even", "odd"] as const) {
        const mbFrames = decodeModbus(samples, rate, labelDefaults.uart.ch, labelDefaults.uart.baud, parity);
        const mbValid = mbFrames.filter(f => f.crcOk).length;
        if (mbValid > 0) {
          return { tab: "modbus", score: mbValid * 3, reason: `Modbus RTU ${labelDefaults.uart.baud.toLocaleString()} baud on D${labelDefaults.uart.ch} (labels)`, modbus: { ch: labelDefaults.uart.ch, baud: labelDefaults.uart.baud, parity } };
        }
      }
      return { tab: "uart", score: valid, reason: `UART ${labelDefaults.uart.baud.toLocaleString()} baud on D${labelDefaults.uart.ch} (labels)`, uart: labelDefaults.uart };
    }
  }
  if (labelDefaults.tab === "can" && labelDefaults.can) {
    const frames = decodeCAN(samples, rate, labelDefaults.can.ch, labelDefaults.can.baud);
    if (frames.length > 0) return { tab: "can", score: frames.length, reason: `CAN ${labelDefaults.can.baud.toLocaleString()} baud on D${labelDefaults.can.ch} (labels)`, can: labelDefaults.can };
  }
  if (labelDefaults.tab === "onewire" && labelDefaults.onewire) {
    const frames = decodeOneWire(samples, rate, labelDefaults.onewire.ch);
    const resetFrames = frames.filter(f => f.type === "reset" || f.type === "presence").length;
    if (resetFrames > 0) return { tab: "onewire", score: resetFrames, reason: `1-Wire on D${labelDefaults.onewire.ch} (labels)`, onewire: labelDefaults.onewire };
  }
  if (labelDefaults.tab === "swd" && labelDefaults.swd) {
    const frames = decodeSWD(samples, rate, labelDefaults.swd.swdio, labelDefaults.swd.swclk);
    const resetFrames = frames.filter(f => f.type === "reset").length;
    if (resetFrames > 0) return { tab: "swd", score: resetFrames, reason: `SWD on D${labelDefaults.swd.swdio}/D${labelDefaults.swd.swclk} (labels)`, swd: labelDefaults.swd };
  }
  if (labelDefaults.tab === "jtag" && labelDefaults.jtag) {
    const frames = decodeJTAG(samples, rate, labelDefaults.jtag.tck, labelDefaults.jtag.tms, labelDefaults.jtag.tdi, labelDefaults.jtag.tdo);
    const stateFrames = frames.filter(f => f.type === "state" || f.type === "shift").length;
    if (stateFrames > 0) return { tab: "jtag", score: stateFrames, reason: `JTAG on D${labelDefaults.jtag.tck}/D${labelDefaults.jtag.tms}/D${labelDefaults.jtag.tdi}/D${labelDefaults.jtag.tdo} (labels)`, jtag: labelDefaults.jtag };
  }
  if (labelDefaults.tab === "modbus" && labelDefaults.modbus) {
    const frames = decodeModbus(samples, rate, labelDefaults.modbus.ch, labelDefaults.modbus.baud, labelDefaults.modbus.parity);
    const validFrames = frames.filter(f => f.crcOk).length;
    if (validFrames > 0) return { tab: "modbus", score: validFrames, reason: `Modbus RTU ${labelDefaults.modbus.baud.toLocaleString()} baud on D${labelDefaults.modbus.ch} (labels)`, modbus: labelDefaults.modbus };
  }
  if (labelDefaults.tab === "lin" && labelDefaults.lin) {
    for (const baud of LIN_COMMON_BAUDS) {
      const frames = decodeLIN(samples, rate, labelDefaults.lin.ch, baud, labelDefaults.lin.checksum);
      const valid = frames.filter(f => f.parityOk && f.checksumOk).length;
      if (valid > 0) return { tab: "lin", score: valid * 3, reason: `LIN ${baud.toLocaleString()} baud on D${labelDefaults.lin.ch} (labels)`, lin: { ch: labelDefaults.lin.ch, baud, checksum: labelDefaults.lin.checksum } };
    }
  }

  const active = getActiveChannels(samples, width);
  let best: AutoDetectResult = { tab: "uart", score: 0, reason: "no active signal detected" };

  // UART: try each active channel as TX.
  for (const ch of active) {
    const baud = estimateUartBaud(samples, rate, ch);
    const rows = decodeUartChunk(samples, rate, baud, ch);
    const valid = rows.filter(r => !r.error).length;
    if (valid > best.score) {
      best = { tab: "uart", score: valid, reason: `UART ${baud.toLocaleString()} baud on D${ch}`, uart: { baud, ch } };
    }
  }

  // I2C: try each pair of active channels as SCL/SDA.
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const scl = active[i]!;
      const sda = active[j]!;
      const frames = decodeI2C(samples, rate, scl, sda);
      const score = frames.filter(f => f.type === "start" || f.type === "stop").length * 2 + frames.filter(f => f.type === "byte").length;
      if (score > best.score) {
        best = { tab: "i2c", score, reason: `I2C on D${scl}/D${sda}`, i2c: { scl, sda, addrBits: 7 } };
      }
    }
  }

  // SPI: detect clock/data channels, then try all 4 modes.
  const detected = detectSpiChannels(samples, width);
  for (const mode of [0, 1, 2, 3] as const) {
    const frames = decodeSPI(samples, rate, detected.mosi, detected.miso, detected.sck, -1, mode, 8, true);
    if (frames.length > best.score) {
      best = { tab: "spi", score: frames.length, reason: `SPI mode ${mode} on D${detected.mosi}/D${detected.sck}`, spi: { ...detected, mode, bits: 8, cs: -1 } };
    }
  }

  // CAN: try each active channel at common baud rates.
  for (const ch of active) {
    for (const baud of CAN_COMMON_BAUDS) {
      const frames = decodeCAN(samples, rate, ch, baud);
      if (frames.length > best.score) {
        best = { tab: "can", score: frames.length, reason: `CAN ${baud.toLocaleString()} baud on D${ch}`, can: { ch, baud } };
      }
    }
  }

  // 1-Wire: try each active channel.
  for (const ch of active) {
    const frames = decodeOneWire(samples, rate, ch);
    const score = frames.filter(f => f.type === "reset" || f.type === "presence").length;
    if (score > best.score) {
      best = { tab: "onewire", score, reason: `1-Wire on D${ch}`, onewire: { ch } };
    }
  }

  // SWD: try pairs of active channels as SWDIO/SWCLK.
  for (let dio = 0; dio < Math.min(width, 16); dio++) {
    for (let clk = 0; clk < Math.min(width, 16); clk++) {
      if (dio === clk) continue;
      if (!active.includes(dio) || !active.includes(clk)) continue;
      const frames = decodeSWD(samples, rate, dio, clk);
      const score = frames.filter(f => f.type === "reset").length * 2 + frames.filter(f => f.type === "request").length;
      if (score > best.score) {
        best = { tab: "swd", score, reason: `SWD D${dio}/D${clk}`, swd: { swdio: dio, swclk: clk } };
      }
    }
  }

  // JTAG: try quadruples of active channels as TCK/TMS/TDI/TDO.
  for (const tck of active) {
    for (const tms of active) {
      if (tms === tck) continue;
      for (const tdi of active) {
        if (tdi === tck || tdi === tms) continue;
        for (const tdo of active) {
          if (tdo === tck || tdo === tms || tdo === tdi) continue;
          const frames = decodeJTAG(samples, rate, tck, tms, tdi, tdo);
          const score = frames.filter(f => f.type === "shift").length * 2 + frames.filter(f => f.type === "state").length;
          if (score > best.score) {
            best = { tab: "jtag", score, reason: `JTAG D${tck}/D${tms}/D${tdi}/D${tdo}`, jtag: { tck, tms, tdi, tdo } };
          }
        }
      }
    }
  }

  // Modbus: try each active channel at common RTU bauds.
  for (const ch of active) {
    for (const baud of [9600, 19200, 38400, 57600, 115200]) {
      for (const parity of (["even", "none", "odd"] as const)) {
        const frames = decodeModbus(samples, rate, ch, baud, parity);
        const score = frames.filter(f => f.crcOk).length * 3;
        if (score > best.score) {
          best = { tab: "modbus", score, reason: `Modbus RTU ${baud.toLocaleString()} baud D${ch}`, modbus: { ch, baud, parity } };
        }
      }
    }
  }

  // LIN: try each active channel at common baud rates.
  for (const ch of active) {
    for (const baud of LIN_COMMON_BAUDS) {
      const frames = decodeLIN(samples, rate, ch, baud, "classic");
      const score = frames.filter(f => f.parityOk && f.checksumOk).length * 3;
      if (score > best.score) {
        best = { tab: "lin", score, reason: `LIN ${baud.toLocaleString()} baud D${ch}`, lin: { ch, baud, checksum: "classic" } };
      }
    }
  }

  return best;
}



export function decodeUartChunk(
  samples: Uint8Array,
  sampleRate: number,
  baud: number,
  channel: number,
  baseSample = 0,
  dataBits = 8,
  parity: "none" | "even" | "odd" = "none",
  stopBits = 1,
  invertLogic = false
): TickerRow[] {
  const spb = sampleRate / baud;
  const rows: TickerRow[] = [];
  const bit = (s: number) => {
    const raw = (samples[Math.max(0, Math.min(samples.length - 1, s))] >> channel) & 1;
    return invertLogic ? raw ^ 1 : raw;
  };
  let i = 0;
  while (i < samples.length - 1) {
    if (bit(i) === 1 && bit(i + 1) === 0) {
      const fs = i + 1;
      const at = (n: number) => bit(Math.round(fs + (n + 0.5) * spb));
      if (at(0) !== 0) { i++; continue; }
      let v = 0;
      for (let b = 0; b < dataBits; b++) v |= at(b + 1) << b;

      let parityOffset = 0;
      let parityOk: boolean | undefined = undefined;
      if (parity !== "none") {
        parityOffset = 1;
        const parBit = at(dataBits + 1);
        const ones = v.toString(2).split("").filter(c => c === "1").length;
        const expectedParity = parity === "even" ? (ones % 2 === 1 ? 1 : 0) : (ones % 2 === 0 ? 1 : 0);
        parityOk = parBit === expectedParity;
      }

      const stopBit = at(1 + dataBits + parityOffset);
      const error = stopBit !== 1 || parityOk === false;
      const absSample = baseSample + fs;
      const endSample = absSample + Math.round((1 + dataBits + parityOffset + stopBits) * spb);
      const bitSamples = Math.max(1, Math.round(spb));
      rows.push({ ts: absSample / sampleRate, byte: v, sample: absSample, endSample, error, parityOk, bitSamples });
      // Advance to the middle of the stop bit, then scan for the next idle -> start edge.
      // This avoids landing exactly on the next start bit when spb is non-integer.
      i = Math.round(fs + (dataBits + parityOffset + 1 + stopBits / 2) * spb);
    } else { i++; }
  }
  return rows;
}

export function makeFakeUartSignal(
  text: string,
  sampleRate: number,
  baud: number,
  channel: number,
  parity: "none" | "even" | "odd" = "none",
  stopBits = 1
): { samples: Uint8Array; sampleRate: number } {
  const samplesPerBit = Math.round(sampleRate / baud);
  const bits: number[] = [];
  const pushBit = (b: number, count = 1) => {
    for (let i = 0; i < count * samplesPerBit; i++) bits.push(b);
  };

  pushBit(1, 2); // idle
  for (const ch of text) {
    const value = ch.charCodeAt(0);
    pushBit(0); // start bit
    for (let b = 0; b < 8; b++) pushBit((value >> b) & 1); // LSB first
    if (parity !== "none") {
      const ones = value.toString(2).split("").filter(c => c === "1").length;
      pushBit(parity === "even" ? (ones % 2 === 1 ? 1 : 0) : (ones % 2 === 0 ? 1 : 0));
    }
    pushBit(1, stopBits); // stop bit(s)
    pushBit(1); // inter-byte gap
  }
  pushBit(1, 2); // trailing idle

  const samples = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) samples[i] = bits[i] << channel;
  return { samples, sampleRate };
}

export function decodeI2C(
  samples: Uint8Array, sampleRate: number, sclCh: number, sdaCh: number
): I2CFrame[] {
  const rows: I2CFrame[] = [];
  const bit = (s: number, ch: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> ch) & 1;
  const scl = (s: number) => bit(s, sclCh);
  const sda = (s: number) => bit(s, sdaCh);
  let i = 0;
  let inFrame = false;
  let byteStart = 0;
  let byte = 0;
  let bitCount = 0;
  let isAddr = true;
  let lastSclRise = -1;
  let sclPeriodSum = 0;
  let sclPeriodCount = 0;

  while (i < samples.length - 1) {
    // START: SDA falling while SCL high (SCL must stay high across both samples)
    if (scl(i) === 1 && scl(i + 1) === 1 && sda(i) === 1 && sda(i + 1) === 0) {
      const type = inFrame ? "repeated-start" : "start";
      rows.push({ startSample: i, endSample: i, ts: i / sampleRate, type });
      inFrame = true;
      isAddr = true;
      bitCount = 0;
      byte = 0;
      i++;
      continue;
    }
    // STOP: SDA rising while SCL high (SCL must stay high across both samples)
    if (inFrame && scl(i) === 1 && scl(i + 1) === 1 && sda(i) === 0 && sda(i + 1) === 1) {
      rows.push({ startSample: i, endSample: i, ts: i / sampleRate, type: "stop" });
      inFrame = false;
      isAddr = true;
      bitCount = 0;
      byte = 0;
      i++;
      continue;
    }
    // SCL rising edge: sample SDA, also measure clock period
    if (scl(i) === 0 && scl(i + 1) === 1) {
      const sampleIdx = i + 1;
      if (lastSclRise >= 0) {
        sclPeriodSum += sampleIdx - lastSclRise;
        sclPeriodCount++;
      }
      lastSclRise = sampleIdx;
      if (inFrame) {
        const b = sda(sampleIdx);
        if (bitCount < 8) {
          if (bitCount === 0) byteStart = sampleIdx;
          byte = (byte << 1) | b;
          bitCount++;
        } else {
          // ACK/NACK bit
          const ack = b === 0;
          const endSample = sampleIdx;
          const bitSamples = sclPeriodCount > 0 ? Math.round(sclPeriodSum / sclPeriodCount) : 0;
          if (isAddr) {
            const addr7 = byte >> 1;
            const rw = (byte & 1) ? "read" : "write";
            rows.push({ startSample: byteStart, endSample, ts: byteStart / sampleRate, type: "byte", addr: addr7, rw, bitSamples });
            isAddr = false;
          } else {
            rows.push({ startSample: byteStart, endSample, ts: byteStart / sampleRate, type: "byte", data: byte, bitSamples });
          }
          rows.push({ startSample: sampleIdx, endSample, ts: sampleIdx / sampleRate, type: ack ? "ack" : "nack", bitSamples });
          byte = 0;
          bitCount = 0;
          if (rows.length > MAX_TICKER) break;
        }
      }
      i = sampleIdx;
      continue;
    }
    i++;
  }
  // Backfill START/STOP rows with the measured SCL period so they render at the same scale.
  const avgBitSamples = sclPeriodCount > 0 ? Math.round(sclPeriodSum / sclPeriodCount) : 0;
  for (const r of rows) {
    if (r.bitSamples === undefined) r.bitSamples = avgBitSamples;
  }
  return rows;
}

export interface FrameSearchResult {
  startSample: number;
  endSample: number;
  ts: number;
  type?: string;
  error?: boolean;
}

export async function searchFrames<T extends FrameSearchResult>(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  decodeWindow: (window: Uint8Array) => T[],
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<T | null> {
  const windowSize = options?.windowSize ?? 100_000;
  const maxWindows = options?.maxWindows ?? 20;

  let windowsChecked = 0;
  let startSample = direction === "next" ? centerSample + 1 : Math.max(0, centerSample - windowSize);

  while (windowsChecked < maxWindows) {
    const count = windowSize;
    const window = await getWindow(startSample, count);
    if (window.length === 0) break;

    const frames = decodeWindow(window);
    if (direction === "next") {
      for (const f of frames) {
        const absStart = startSample + f.startSample;
        if (absStart > centerSample) {
          return { ...f, startSample: absStart, endSample: startSample + f.endSample };
        }
      }
      startSample += windowSize;
    } else {
      let candidate: T | null = null;
      for (const f of frames) {
        const absEnd = startSample + f.endSample;
        if (absEnd < centerSample) {
          candidate = { ...f, startSample: startSample + f.startSample, endSample: absEnd };
        }
      }
      if (candidate) return candidate;
      if (startSample === 0) break;
      startSample = Math.max(0, startSample - windowSize);
    }
    windowsChecked++;
  }
  return null;
}

export function findNearestI2CFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { scl: number; sda: number },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeI2C(window, sampleRate, config.scl, config.sda),
    centerSample,
    direction,
    options
  );
}

export function findNearestUartFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { baud: number; ch: number },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeUartChunk(window, sampleRate, config.baud, config.ch).map(r => ({
      startSample: r.sample,
      endSample: r.endSample,
      ts: r.ts,
      type: r.error ? "error" : "byte",
      error: r.error,
    })),
    centerSample,
    direction,
    options
  );
}

export function findNearestSpiFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { mosi: number; miso: number; sck: number; cs: number; mode: 0 | 1 | 2 | 3; bits: 8 | 16; csActiveLow: boolean },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeSPI(window, sampleRate, config.mosi, config.miso, config.sck, config.cs, config.mode, config.bits, config.csActiveLow).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: "word",
    })),
    centerSample,
    direction,
    options
  );
}

export function findNearestCanFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { ch: number; baud: number },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeCAN(window, sampleRate, config.ch, config.baud).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: "frame",
      error: r.error,
    })),
    centerSample,
    direction,
    options
  );
}

export function findNearestOneWireFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { ch: number },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeOneWire(window, sampleRate, config.ch).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: r.type,
    })),
    centerSample,
    direction,
    options
  );
}

export function findNearestSwdFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { swdio: number; swclk: number },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeSWD(window, sampleRate, config.swdio, config.swclk).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: r.type,
      error: !r.ok,
    })),
    centerSample,
    direction,
    options
  );
}

export function findNearestJtagFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { tck: number; tms: number; tdi: number; tdo: number },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeJTAG(window, sampleRate, config.tck, config.tms, config.tdi, config.tdo).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: r.type,
    })),
    centerSample,
    direction,
    options
  );
}

export function findNearestModbusFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { ch: number; baud: number; parity: "none" | "even" | "odd" },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeModbus(window, sampleRate, config.ch, config.baud, config.parity).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: r.type,
      error: !r.crcOk,
    })),
    centerSample,
    direction,
    options
  );
}

export function decodeSPI(
  samples: Uint8Array, sampleRate: number, mosiCh: number, misoCh: number,
  sckCh: number, csCh: number, mode: 0 | 1 | 2 | 3, bits: 8 | 16, csActiveLow: boolean
): SPIFrame[] {
  const rows: SPIFrame[] = [];
  const bit = (s: number, ch: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> ch) & 1;
  const hasCs = csCh >= 0;
  const cs = (s: number) => hasCs ? bit(s, csCh) : 0;
  const csActive = (s: number) => hasCs ? (csActiveLow ? cs(s) === 0 : cs(s) === 1) : true;

  // Determine sample edge: CPHA 0 = sample on first edge, CPHA 1 = sample on second edge
  const cpha = mode & 1;
  const cpol = (mode >> 1) & 1;
  const sampleRising = cpha === 0 ? cpol === 0 : cpol === 1;

  let i = 0;
  let inFrame = false;
  let wordStart = 0;
  let mosi = 0;
  let miso = 0;
  let bitCount = 0;
  let prevSck = 0;
  let lastSckEdge = -1;
  let periodSum = 0;
  let periodCount = 0;

  while (i < samples.length) {
    const active = csActive(i);
    if (!inFrame && active) {
      inFrame = true;
      wordStart = i;
      mosi = 0; miso = 0; bitCount = 0;
      prevSck = bit(i, sckCh);
      lastSckEdge = -1;
      periodSum = 0;
      periodCount = 0;
    } else if (inFrame && !active) {
      inFrame = false;
      if (bitCount > 0) {
        const bitSamples = periodCount > 0 ? Math.round(periodSum / periodCount) : 0;
        rows.push({ startSample: wordStart, endSample: i, ts: wordStart / sampleRate, mosi, miso, bitSamples });
      }
      if (rows.length > MAX_TICKER) break;
    }

    if (inFrame) {
      const sck = bit(i, sckCh);
      const rising = prevSck === 0 && sck === 1;
      const falling = prevSck === 1 && sck === 0;
      if (rising || falling) {
        if (lastSckEdge >= 0) {
          periodSum += i - lastSckEdge;
          periodCount++;
        }
        lastSckEdge = i;
      }
      const sampleEdge = sampleRising ? rising : falling;
      if (sampleEdge) {
        mosi = (mosi << 1) | bit(i, mosiCh);
        miso = (miso << 1) | bit(i, misoCh);
        bitCount++;
        if (bitCount === bits) {
          const bitSamples = periodCount > 0 ? Math.round(periodSum / periodCount) : 0;
          rows.push({ startSample: wordStart, endSample: i, ts: wordStart / sampleRate, mosi, miso, bitSamples });
          mosi = 0; miso = 0; bitCount = 0;
          wordStart = i;
          lastSckEdge = -1;
          periodSum = 0;
          periodCount = 0;
          if (rows.length > MAX_TICKER) break;
        }
      }
      prevSck = sck;
    }
    i++;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CAN decoder
// ---------------------------------------------------------------------------

const CAN_COMMON_BAUDS = [125000, 250000, 500000, 800000, 1000000];

export function estimateCanBaud(samples: Uint8Array, sampleRate: number, ch: number): number {
  const widths: number[] = [];
  let last = 1;
  let lastS = 0;
  for (let s = 0; s < samples.length; s++) {
    const v = (samples[s] >> ch) & 1;
    if (v !== last) {
      widths.push(s - lastS);
      last = v;
      lastS = s;
    }
  }
  const positive = widths.filter(w => w > 0).sort((a, b) => a - b);
  if (positive.length === 0) return 500000;
  const minW = positive[0]!;
  const short = positive.filter(w => w <= minW * 3);
  const bitW = short[Math.floor(short.length / 2)] ?? minW;
  const baud = Math.round(sampleRate / bitW);
  let best = 500000;
  let bestErr = Infinity;
  for (const b of CAN_COMMON_BAUDS) {
    const err = Math.abs(baud - b);
    if (err < bestErr) { bestErr = err; best = b; }
  }
  return best;
}

export function decodeCAN(
  samples: Uint8Array,
  sampleRate: number,
  channel: number,
  baud: number
): CANFrame[] {
  const spb = sampleRate / baud;
  const bit = (s: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> channel) & 1;
  const frames: CANFrame[] = [];
  let i = 0;
  while (i < samples.length - 1) {
    // Look for recessive -> dominant edge (SOF)
    if (bit(i) === 1 && bit(i + 1) === 0) {
      const sof = i + 1;
      const sampleBit = (n: number) => bit(Math.round(sof + (n + 0.5) * spb));
      const read = (n: number, len: number) => {
        let v = 0;
        for (let k = 0; k < len; k++) v = (v << 1) | sampleBit(n + k);
        return v;
      };
      let n = 0; // after SOF
      // SOF
      const sofBit = sampleBit(0);
      if (sofBit !== 0) { i++; continue; }
      n = 1;
      // Arbitration: 11-bit ID
      const id = read(n, 11);
      n += 11;
      let rtr = sampleBit(n++) === 1;
      const ide = sampleBit(n++);
      sampleBit(n++); // r0
      let extended = false;
      let extId = 0;
      if (ide === 1) {
        // Extended frame: SRR + 18-bit extended ID + IDE + RTR + r1 + r0
        extended = true;
        const srr = sampleBit(n++);
        extId = read(n, 18);
        n += 18;
        const ide2 = sampleBit(n++);
        const rtr2 = sampleBit(n++);
        if (srr !== 1 || ide2 !== 1) { i++; continue; }
        rtr = rtr2 === 1;
        sampleBit(n++); // r1
        sampleBit(n++); // r0 extended
      }
      // Control: DLC (4 bits)
      const dlc = read(n, 4);
      n += 4;
      const dataLen = Math.min(8, dlc);
      // Data field
      const data: number[] = [];
      for (let b = 0; b < dataLen; b++) {
        data.push(read(n, 8));
        n += 8;
      }
      // CRC 15 bits (skip destuffing for this basic decoder)
      read(n, 15);
      n += 15;
      // CRC delimiter
      const crcDelimOk = sampleBit(n++) === 1;
      // ACK slot
      const ack = sampleBit(n++);
      sampleBit(n++); // ack delimiter
      // EOF: 7 recessive bits
      let eofOk = true;
      for (let k = 0; k < 7; k++) if (sampleBit(n + k) !== 1) eofOk = false;
      n += 7;
      const endSample = Math.min(samples.length - 1, Math.round(sof + n * spb));
      const error = ack !== 0 || !crcDelimOk || !eofOk;
      if (!error) {
        const bitSamples = Math.max(1, Math.round(spb));
        frames.push({
          startSample: sof,
          endSample,
          ts: sof / sampleRate,
          id: extended ? ((id << 18) | extId) : id,
          extended,
          rtr,
          dlc,
          data,
          error,
          bitSamples,
        });
        if (frames.length > MAX_TICKER) break;
      }
      // Advance to after EOF or just past this frame
      i = endSample + 1;
      continue;
    }
    i++;
  }
  return frames;
}

// Generate a synthetic LA capture for offline decoder/UX testing.
// UART on D0, I2C on D1/D2, SPI on D3-D6 at 1 MHz 8-bit.
// All decoder traffic is placed as short bursts at the start; the rest is idle.
export function generateLaTestPattern(
  sampleRate: number,
  durationS: number
): { samples: Uint8Array; dataEndSample: number } {
  const totalSamples = Math.floor(sampleRate * durationS);
  const samples = new Uint8Array(totalSamples);
  const bitTime = Math.floor(sampleRate / 115200);
  if (bitTime < 2) return { samples, dataEndSample: 0 };

  // UART on D0: "Hi\n" at 115200 baud
  const uartBits: number[] = [];
  const pushUart = (v: number, n: number) => { for (let i = 0; i < n; i++) uartBits.push(v); };
  const uartByte = (b: number) => {
    pushUart(0, bitTime); // start
    for (let i = 0; i < 8; i++) pushUart((b >> i) & 1, bitTime);
    pushUart(1, bitTime); // stop
  };
  uartByte(0x48); // H
  uartByte(0x69); // i
  uartByte(0x0A); // \n
  pushUart(1, bitTime * 10); // idle gap

  // I2C on D1=SCL, D2=SDA (7-bit addr 0x50, write, data 0x01 0x02 0x03)
  const i2cBits: Array<{ scl: number; sda: number }> = [];
  const pushI2c = (scl: number, sda: number, n: number) => { for (let i = 0; i < n; i++) i2cBits.push({ scl, sda }); };
  const i2cBit = (sda: number) => {
    pushI2c(0, sda, bitTime); // SCL low, set SDA
    pushI2c(1, sda, bitTime); // SCL high
    pushI2c(0, sda, bitTime); // SCL low
  };
  const i2cStart = () => { pushI2c(1, 1, bitTime); pushI2c(1, 0, bitTime); };
  const i2cStop = () => { pushI2c(0, 0, bitTime); pushI2c(1, 0, bitTime); pushI2c(1, 1, bitTime); };
  const i2cByte = (byte: number, ack: boolean) => {
    for (let i = 7; i >= 0; i--) i2cBit((byte >> i) & 1);
    i2cBit(ack ? 0 : 1);
  };
  pushI2c(1, 1, bitTime * 4); // idle
  i2cStart();
  i2cByte(0xA0, true); // 0x50 + W
  i2cByte(0x01, true);
  i2cByte(0x02, true);
  i2cByte(0x03, true);
  i2cStop();
  pushI2c(1, 1, bitTime * 4); // idle

  // SPI on D3=MOSI, D4=MISO, D5=SCK, D6=CS (mode 0, CS active low)
  const spiBits: Array<{ mosi: number; miso: number; sck: number; cs: number }> = [];
  const pushSpi = (mosi: number, miso: number, sck: number, cs: number, n: number) => {
    for (let i = 0; i < n; i++) spiBits.push({ mosi, miso, sck, cs });
  };
  const spiBit = (mosi: number, miso: number) => {
    pushSpi(mosi, miso, 0, 0, bitTime); // leading edge
    pushSpi(mosi, miso, 1, 0, bitTime); // trailing edge
  };
  const spiByte = (mosi: number, miso: number) => {
    for (let i = 7; i >= 0; i--) spiBit((mosi >> i) & 1, (miso >> i) & 1);
  };
  pushSpi(0, 0, 0, 1, bitTime); // idle
  pushSpi(0, 0, 0, 0, bitTime); // CS active
  spiByte(0xA5, 0x12);
  spiByte(0x5A, 0x34);
  pushSpi(0, 0, 0, 1, bitTime); // CS inactive

  // Place each burst sequentially at the start of the buffer, leave the rest idle.
  let cursor = 0;
  const writeUart = () => {
    for (let i = 0; i < uartBits.length && cursor < totalSamples; i++, cursor++) {
      samples[cursor] |= uartBits[i] << 0;
    }
  };
  const writeI2c = () => {
    for (let i = 0; i < i2cBits.length && cursor < totalSamples; i++, cursor++) {
      samples[cursor] |= i2cBits[i].scl << 1;
      samples[cursor] |= i2cBits[i].sda << 2;
    }
  };
  const writeSpi = () => {
    for (let i = 0; i < spiBits.length && cursor < totalSamples; i++, cursor++) {
      samples[cursor] |= spiBits[i].mosi << 3;
      samples[cursor] |= spiBits[i].miso << 4;
      samples[cursor] |= spiBits[i].sck << 5;
      samples[cursor] |= spiBits[i].cs << 6;
    }
  };
  writeUart();
  writeI2c();
  writeSpi();
  return { samples, dataEndSample: cursor };
}

// Generate a single CAN standard frame bit stream (MSB-first) on the given channel.
// Does not include bit stuffing; suitable for decoder unit tests.
export function generateCanFrame(
  sampleRate: number,
  baud: number,
  channel: number,
  id: number,
  data: number[],
  rtr = false
): Uint8Array {
  const spb = Math.max(1, Math.floor(sampleRate / baud));
  const bits: number[] = [];
  const pushBits = (v: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  // SOF
  bits.push(0);
  // 11-bit ID
  pushBits(id & 0x7FF, 11);
  // RTR + IDE + r0
  bits.push(rtr ? 1 : 0);
  bits.push(0); // IDE
  bits.push(0); // r0
  // DLC
  pushBits(Math.min(8, data.length), 4);
  // Data
  for (const b of data) pushBits(b, 8);
  // CRC 15 bits (zeros for test)
  pushBits(0, 15);
  // CRC delimiter + ACK slot + ACK delimiter + EOF (7 recessive)
  bits.push(1, 0, 1, 1, 1, 1, 1, 1, 1);
  // IFS (3 recessive)
  bits.push(1, 1, 1);

  // Add leading and trailing idle recessive bits so the decoder can locate SOFs.
  const idleBits = 4;
  const totalSamples = (idleBits + bits.length + idleBits) * spb;
  const samples = new Uint8Array(totalSamples);
  for (let i = 0; i < idleBits; i++) {
    for (let j = 0; j < spb; j++) samples[i * spb + j] = 1 << channel;
  }
  for (let i = 0; i < bits.length; i++) {
    for (let j = 0; j < spb; j++) {
      samples[(idleBits + i) * spb + j] = bits[i] << channel;
    }
  }
  for (let i = 0; i < idleBits; i++) {
    for (let j = 0; j < spb; j++) {
      samples[(idleBits + bits.length + i) * spb + j] = 1 << channel;
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// 1-Wire decoder
// ---------------------------------------------------------------------------

const ONEWIRE_RESET_MIN_US = 480;
const ONEWIRE_WRITE1_MAX_US = 15;
const ONEWIRE_PRESENCE_MIN_US = 60;
const ONEWIRE_PRESENCE_MAX_US = 240;

export function decodeOneWire(
  samples: Uint8Array,
  sampleRate: number,
  channel: number
): OneWireFrame[] {
  const frames: OneWireFrame[] = [];
  const bit = (s: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> channel) & 1;

  let i = 0;
  while (i < samples.length - 1) {
    // Look for falling edge from idle high.
    if (bit(i) === 1 && bit(i + 1) === 0) {
      const fall = i + 1;
      // Measure low duration.
      let lowEnd = fall;
      while (lowEnd < samples.length && bit(lowEnd) === 0) lowEnd++;
      const lowSamples = lowEnd - fall;
      const lowUs = (lowSamples / sampleRate) * 1_000_000;
      if (lowUs >= ONEWIRE_RESET_MIN_US) {
        // Reset pulse detected. Look for presence pulse after release.
        let highEnd = lowEnd;
        while (highEnd < samples.length && bit(highEnd) === 1) highEnd++;
        const highSamples = highEnd - lowEnd;
        const highUs = (highSamples / sampleRate) * 1_000_000;
        const presenceStart = highEnd;
        let presenceEnd = presenceStart;
        while (presenceEnd < samples.length && bit(presenceEnd) === 0) presenceEnd++;
        const presenceSamples = presenceEnd - presenceStart;
        const presenceUs = (presenceSamples / sampleRate) * 1_000_000;
        const hasPresence = highUs >= 15 && highUs <= 60 && presenceUs >= ONEWIRE_PRESENCE_MIN_US && presenceUs <= ONEWIRE_PRESENCE_MAX_US;
        frames.push({ startSample: fall, endSample: lowEnd, ts: fall / sampleRate, type: "reset" });
        if (hasPresence) {
          frames.push({ startSample: presenceStart, endSample: presenceEnd, ts: presenceStart / sampleRate, type: "presence" });
        }
        i = hasPresence ? presenceEnd : lowEnd;
        continue;
      }

      // Normal write/read slot: low duration determines bit.
      // Any low pulse < reset threshold is a slot; reset was handled above.
      const bitValue = lowUs <= ONEWIRE_WRITE1_MAX_US ? 1 : 0;
      frames.push({ startSample: fall, endSample: lowEnd, ts: fall / sampleRate, type: "byte", value: bitValue });
      i = lowEnd;
      continue;
    }
    i++;
  }

  // Group consecutive byte-value bits into bytes (LSB first). A reset/presence starts a new packet.
  const grouped: OneWireFrame[] = [];
  let current: OneWireFrame[] = [];
  for (const f of frames) {
    if (f.type === "reset" || f.type === "presence") {
      if (current.length > 0) {
        const byteValue = current.reduce((v, b, idx) => v | ((b.value ?? 0) << idx), 0);
        grouped.push({ startSample: current[0].startSample, endSample: current[current.length - 1].endSample, ts: current[0].ts, type: "byte", value: byteValue });
        current = [];
      }
      grouped.push(f);
    } else if (f.type === "byte") {
      current.push(f);
      if (current.length === 8) {
        const byteValue = current.reduce((v, b, idx) => v | ((b.value ?? 0) << idx), 0);
        grouped.push({ startSample: current[0].startSample, endSample: current[current.length - 1].endSample, ts: current[0].ts, type: "byte", value: byteValue });
        current = [];
      }
    }
  }
  if (current.length > 0) {
    const byteValue = current.reduce((v, b, idx) => v | ((b.value ?? 0) << idx), 0);
    grouped.push({ startSample: current[0].startSample, endSample: current[current.length - 1].endSample, ts: current[0].ts, type: "byte", value: byteValue });
  }
  return grouped.slice(0, MAX_TICKER);
}

// Generate a 1-Wire reset + presence pulse followed by a byte stream on the given channel.
export function generateOneWireFrame(
  sampleRate: number,
  channel: number,
  data: number[]
): Uint8Array {
  const usToS = (us: number) => Math.max(1, Math.floor((us * sampleRate) / 1_000_000));
  const out: number[] = [];
  const push = (v: number, samples: number) => { for (let i = 0; i < samples; i++) out.push(v << channel); };
  // Idle
  push(1, usToS(100));
  // Reset pulse (master low 500µs)
  push(0, usToS(500));
  // Release, wait for presence
  push(1, usToS(30));
  // Presence pulse (slave low 120µs)
  push(0, usToS(120));
  // Recovery
  push(1, usToS(100));
  // Write each byte LSB-first
  for (const b of data) {
    for (let i = 0; i < 8; i++) {
      const bit = (b >> i) & 1;
      if (bit === 1) {
        push(0, usToS(6));  // write-1 low
        push(1, usToS(64)); // remainder of slot
      } else {
        push(0, usToS(60)); // write-0 low
        push(1, usToS(10)); // remainder of slot
      }
    }
  }
  push(1, usToS(100));
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// SWD decoder
// ---------------------------------------------------------------------------

const SWD_RESET_MIN_BITS = 50;
const SWD_SWITCHING_SEQUENCE = 0x79bc; // JTAG-to-SWD selection, 16 bits LSB-first

export function decodeSWD(
  samples: Uint8Array,
  sampleRate: number,
  swdioCh: number,
  swclkCh: number
): SWDFrame[] {
  const frames: SWDFrame[] = [];
  const bit = (ch: number, s: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> ch) & 1;

  // Extract SWDIO values on every SWCLK rising edge, plus the sample index of each edge.
  const bits: { v: number; s: number }[] = [];
  let lastClk = 0;
  for (let s = 1; s < samples.length; s++) {
    const clk = bit(swclkCh, s);
    if (clk === 1 && lastClk === 0) {
      bits.push({ v: bit(swdioCh, s), s });
    }
    lastClk = clk;
  }
  if (bits.length === 0) return frames;

  let i = 0;
  while (i < bits.length) {
    // Line reset: SWDIO high for >= 50 SWCLK cycles.
    if (bits[i].v === 1) {
      let runStart = i;
      while (i < bits.length && bits[i].v === 1) i++;
      const runLen = i - runStart;
      if (runLen >= SWD_RESET_MIN_BITS) {
        frames.push({
          startSample: bits[runStart].s,
          endSample: bits[i - 1].s,
          ts: bits[runStart].s / sampleRate,
          type: "reset",
        });
        continue;
      }
      // Short run of 1s: back up to the first 1 and let normal parsing run.
      i = runStart;
    }

    // Switching sequence detection (JTAG-to-SWD: 0x79BC, 16 bits LSB-first).
    if (i + 16 <= bits.length) {
      let seq = 0;
      for (let k = 0; k < 16; k++) seq |= (bits[i + k].v << k);
      if (seq === SWD_SWITCHING_SEQUENCE) {
        i += 16;
        continue; // consume switching sequence silently
      }
    }

    // Try to parse a request packet: 8 bits.
    if (i + 8 <= bits.length) {
      const start = bits[i].v;
      const apnDp = bits[i + 1].v as 0 | 1;
      const read = bits[i + 2].v === 1;
      const a2 = bits[i + 3].v;
      const a3 = bits[i + 4].v;
      const parity = bits[i + 5].v;
      const stop = bits[i + 6].v;
      const park = bits[i + 7].v;
      const readBit = read ? 1 : 0;
      const computedParity = (apnDp + readBit + a2 + a3) & 1;
      const ok = start === 1 && stop === 0 && park === 1 && parity === computedParity;
      if (ok) {
        const addr = (a2 << 2) | (a3 << 3);
        const reqStart = bits[i].s;
        const reqEnd = bits[i + 7].s;
        frames.push({
          startSample: reqStart,
          endSample: reqEnd,
          ts: reqStart / sampleRate,
          type: "request",
          apnDp,
          read,
          addr,
          ok: true,
        });
        // Try to capture the following data phase: 32 bits + parity after 1 turnaround bit.
        const dataStartIdx = i + 8 + 1; // request + turnaround
        if (dataStartIdx + 32 + 1 <= bits.length) {
          let data = 0;
          for (let k = 0; k < 32; k++) data |= (bits[dataStartIdx + k].v << k);
          data = data >>> 0;
          const dataParity = bits[dataStartIdx + 32].v;
          const computedDataParity = ((data >>> 0).toString(2).match(/1/g)?.length ?? 0) & 1;
          frames.push({
            startSample: bits[dataStartIdx].s,
            endSample: bits[dataStartIdx + 32].s,
            ts: bits[dataStartIdx].s / sampleRate,
            type: "data",
            data,
            ok: dataParity === computedDataParity,
          });
          i = dataStartIdx + 32 + 1;
          continue;
        }
        i += 8;
        continue;
      }
    }

    i++;
  }

  return frames.slice(0, MAX_TICKER);
}

// Generate a synthetic SWD pattern on the given channels.
// Drives SWCLK on swclkCh and SWDIO on swdioCh.
export function generateSwdFrame(
  sampleRate: number,
  swdioCh: number,
  swclkCh: number,
  requests: { apnDp: 0 | 1; read: boolean; addr: number; data?: number }[]
): Uint8Array {
  const halfBit = Math.max(1, Math.floor(sampleRate / 1_000_000)); // 1 µs half-period => 500 kHz SWCLK
  const out: number[] = [];
  const clkMask = 1 << swclkCh;
  const dioMask = 1 << swdioCh;
  const push = (dio: number, clk: number, n: number) => {
    for (let i = 0; i < n; i++) out.push((dio ? dioMask : 0) | (clk ? clkMask : 0));
  };
  const writeBit = (dio: number) => { push(dio, 0, halfBit); push(dio, 1, halfBit); };

  // Idle low
  push(0, 0, halfBit * 10);
  // Line reset: 55 cycles with SWDIO high
  for (let i = 0; i < 55; i++) writeBit(1);
  // Switching sequence: 0x79BC LSB-first
  for (let i = 0; i < 16; i++) writeBit((SWD_SWITCHING_SEQUENCE >> i) & 1);
  // Idle
  for (let i = 0; i < 8; i++) writeBit(0);

  for (const req of requests) {
    const a2 = (req.addr >> 2) & 1;
    const a3 = (req.addr >> 3) & 1;
    const readBit = req.read ? 1 : 0;
    const parity = (req.apnDp + readBit + a2 + a3) & 1;
    const header = (1 << 0) | (req.apnDp << 1) | (readBit << 2) | (a2 << 3) | (a3 << 4) | (parity << 5) | (0 << 6) | (1 << 7);
    for (let i = 0; i < 8; i++) writeBit((header >> i) & 1);
    // Turnaround cycle
    writeBit(0);
    // Data phase: 32 bits + parity
    const data = req.data ?? 0;
    for (let i = 0; i < 32; i++) writeBit((data >> i) & 1);
    const dataParity = ((data >>> 0).toString(2).match(/1/g)?.length ?? 0) & 1;
    writeBit(dataParity);
    // Turnaround cycle
    writeBit(0);
  }

  push(0, 0, halfBit * 10);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// JTAG decoder
// ---------------------------------------------------------------------------

const JTAG_STATES: Record<string, Record<string, string>> = {
  "Test-Logic-Reset": { "0": "Run-Test/Idle", "1": "Test-Logic-Reset" },
  "Run-Test/Idle": { "0": "Run-Test/Idle", "1": "Select-DR-Scan" },
  "Select-DR-Scan": { "0": "Capture-DR", "1": "Select-IR-Scan" },
  "Capture-DR": { "0": "Shift-DR", "1": "Exit1-DR" },
  "Shift-DR": { "0": "Shift-DR", "1": "Exit1-DR" },
  "Exit1-DR": { "0": "Pause-DR", "1": "Update-DR" },
  "Pause-DR": { "0": "Pause-DR", "1": "Exit2-DR" },
  "Exit2-DR": { "0": "Shift-DR", "1": "Update-DR" },
  "Update-DR": { "0": "Run-Test/Idle", "1": "Select-DR-Scan" },
  "Select-IR-Scan": { "0": "Capture-IR", "1": "Test-Logic-Reset" },
  "Capture-IR": { "0": "Shift-IR", "1": "Exit1-IR" },
  "Shift-IR": { "0": "Shift-IR", "1": "Exit1-IR" },
  "Exit1-IR": { "0": "Pause-IR", "1": "Update-IR" },
  "Pause-IR": { "0": "Pause-IR", "1": "Exit2-IR" },
  "Exit2-IR": { "0": "Shift-IR", "1": "Update-IR" },
  "Update-IR": { "0": "Run-Test/Idle", "1": "Select-DR-Scan" },
};

export function decodeJTAG(
  samples: Uint8Array,
  sampleRate: number,
  tckCh: number,
  tmsCh: number,
  tdiCh: number,
  tdoCh: number
): JTAGFrame[] {
  const frames: JTAGFrame[] = [];
  const bit = (ch: number, s: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> ch) & 1;

  // Extract TMS/TDI/TDO values on every TCK rising edge.
  const edges: { tms: number; tdi: number; tdo: number; s: number }[] = [];
  let lastTck = 0;
  for (let s = 1; s < samples.length; s++) {
    const tck = bit(tckCh, s);
    if (tck === 1 && lastTck === 0) {
      edges.push({ tms: bit(tmsCh, s), tdi: bit(tdiCh, s), tdo: bit(tdoCh, s), s });
    }
    lastTck = tck;
  }
  if (edges.length === 0) return frames;

  let state = "Test-Logic-Reset";
  // Count initial TMS=1 cycles to confirm reset; emit reset frame once we leave reset.
  let resetStart = 0;
  let resetBits = 0;
  let inReset = true;
  let shiftStart = 0;
  let shiftTdi = 0;
  let shiftTdo = 0;
  let shiftBits = 0;
  let shiftRegister: "DR" | "IR" | null = null;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const nextState = JTAG_STATES[state]?.[String(e.tms)] ?? state;

    if (inReset) {
      if (e.tms === 1) {
        resetBits++;
        continue;
      }
      if (resetBits >= 5) {
        frames.push({ startSample: resetStart, endSample: e.s, ts: resetStart / sampleRate, type: "reset" });
      }
      inReset = false;
      state = nextState;
      // Emit the transition from reset to Run-Test/Idle.
      frames.push({ startSample: e.s, endSample: e.s, ts: e.s / sampleRate, type: "state", state: nextState });
      continue;
    }

    if (state !== nextState) {
      // Emit state transition frame.
      frames.push({ startSample: e.s, endSample: e.s, ts: e.s / sampleRate, type: "state", state: nextState });

      // If entering a shift state, start collecting.
      if (nextState === "Shift-DR" || nextState === "Shift-IR") {
        shiftRegister = nextState === "Shift-DR" ? "DR" : "IR";
        shiftStart = e.s;
        shiftBits = 0;
        shiftTdi = 0;
        shiftTdo = 0;
      }
    }

    // Capture bit on any edge belonging to a shift (entry, intermediate, and exit edges).
    if (shiftRegister && (state.startsWith("Shift-") || nextState.startsWith("Shift-"))) {
      shiftTdi |= (e.tdi << shiftBits);
      shiftTdo |= (e.tdo << shiftBits);
      shiftBits++;
    }

    // If leaving a shift state, emit the captured shift data now that the exit bit is included.
    if (shiftRegister && !nextState.startsWith("Shift-")) {
      if (shiftBits > 0) {
        const mask = shiftBits >= 32 ? 0xffffffff : (1 << shiftBits) - 1;
        frames.push({
          startSample: shiftStart,
          endSample: e.s,
          ts: shiftStart / sampleRate,
          type: "shift",
          register: shiftRegister,
          tdi: shiftTdi & mask,
          tdo: shiftTdo & mask,
          bits: shiftBits,
        });
      }
      shiftRegister = null;
      shiftBits = 0;
      shiftTdi = 0;
      shiftTdo = 0;
    }

    state = nextState;
  }

  // If we ended mid-shift, emit remaining data.
  if (shiftRegister && shiftBits > 0) {
    const last = edges[edges.length - 1];
    const mask = shiftBits >= 32 ? 0xffffffff : (1 << shiftBits) - 1;
    frames.push({
      startSample: shiftStart,
      endSample: last.s,
      ts: shiftStart / sampleRate,
      type: "shift",
      register: shiftRegister,
      tdi: shiftTdi & mask,
      tdo: shiftTdo & mask,
      bits: shiftBits,
    });
  }

  return frames.slice(0, MAX_TICKER);
}

// Generate a synthetic JTAG pattern on the given channels.
// Drives TCK on tckCh, TMS on tmsCh, TDI on tdiCh, and TDO on tdoCh.
export function generateJtagFrame(
  sampleRate: number,
  tckCh: number,
  tmsCh: number,
  tdiCh: number,
  tdoCh: number,
  scans: { register: "DR" | "IR"; tdi: number; tdo: number; bits: number }[]
): Uint8Array {
  const halfBit = Math.max(1, Math.floor(sampleRate / 1_000_000)); // 1 µs half-period => 1 MHz TCK
  const out: number[] = [];
  const tckMask = 1 << tckCh;
  const tmsMask = 1 << tmsCh;
  const tdiMask = 1 << tdiCh;
  const tdoMask = 1 << tdoCh;
  const push = (tms: number, tdi: number, tdo: number, tck: number, n: number) => {
    for (let i = 0; i < n; i++) out.push((tms ? tmsMask : 0) | (tdi ? tdiMask : 0) | (tdo ? tdoMask : 0) | (tck ? tckMask : 0));
  };
  const cycle = (tms: number, tdi: number, tdo: number) => { push(tms, tdi, tdo, 0, halfBit); push(tms, tdi, tdo, 1, halfBit); };

  // Reset: 5 TMS=1 cycles, then Run-Test/Idle
  for (let i = 0; i < 5; i++) cycle(1, 0, 0);
  cycle(0, 0, 0); // Run-Test/Idle

  for (const scan of scans) {
    // Select scan path: Run-Test/Idle -> Select-DR/IR -> Capture -> Shift
    if (scan.register === "DR") {
      cycle(1, 0, 0); // Select-DR-Scan
    } else {
      cycle(1, 0, 0); // Select-DR-Scan
      cycle(1, 0, 0); // Select-IR-Scan
    }
    cycle(0, 0, 0); // Capture
    // Shift data bits
    for (let i = 0; i < scan.bits; i++) {
      const tdi = (scan.tdi >> i) & 1;
      const tdo = (scan.tdo >> i) & 1;
      const tms = i === scan.bits - 1 ? 1 : 0; // last bit exits shift
      cycle(tms, tdi, tdo);
    }
    // Exit1 -> Update -> Run-Test/Idle
    cycle(1, 0, 0); // Exit1
    cycle(0, 0, 0); // Update-DR/IR -> Run-Test/Idle
  }

  cycle(0, 0, 0); // stay in Run-Test/Idle
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Modbus RTU decoder
// ---------------------------------------------------------------------------

// Modbus CRC-16 (polynomial 0x8005, init 0xFFFF).
function modbusCrc(data: number[]): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xffff;
}

export function decodeModbus(
  samples: Uint8Array,
  sampleRate: number,
  channel: number,
  baud: number,
  parity: "none" | "even" | "odd" = "even"
): ModbusFrame[] {
  const frames: ModbusFrame[] = [];
  // Decode bytes with 8 data bits and the selected parity.
  const rows = decodeUartChunk(samples, sampleRate, baud, channel, 0, 8, parity, 1);
  if (rows.length < 2) return frames;

  // A Modbus RTU frame ends with a silent interval of at least 3.5 character times.
  const charSamples = sampleRate / baud;
  const byteSamples = charSamples * (parity === "none" ? 10 : 11); // 1 start + 8 data + (1 parity) + 1 stop
  const gapSamples = charSamples * 3.5;

  // Group rows into frames by inter-frame silence (measured from end of previous byte to start of next).
  let current: typeof rows = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i > 0) {
      const prevEnd = rows[i - 1].sample + Math.round(byteSamples);
      const gap = row.sample - prevEnd;
      if (gap >= gapSamples) {
        if (current.length >= 2) {
          const frame = parseModbusFrame(current, sampleRate);
          if (frame) frames.push(frame);
        }
        current = [];
      }
    }
    current.push(row);
  }
  if (current.length >= 2) {
    const frame = parseModbusFrame(current, sampleRate);
    if (frame) frames.push(frame);
  }

  return frames.slice(0, MAX_TICKER);
}

function parseModbusFrame(rows: TickerRow[], sampleRate: number): ModbusFrame | null {
  const bytes = rows.map(r => r.byte);
  if (bytes.length < 4) return null;
  const addr = bytes[0];
  const func = bytes[1];
  const payload = bytes.slice(0, -2);
  const crcReceived = bytes[bytes.length - 1] * 256 + bytes[bytes.length - 2];
  const crcComputed = modbusCrc(payload);
  const crcOk = crcReceived === crcComputed;
  const data = bytes.slice(2, -2);
  const type = func & 0x80 ? "error" : "request";
  const bitSamples = rows[0]?.bitSamples ?? 0;
  return {
    startSample: rows[0].sample,
    endSample: rows[rows.length - 1].sample,
    ts: rows[0].sample / sampleRate,
    type,
    addr,
    func: func & 0x7f,
    data,
    crcOk,
    bitSamples,
  };
}

// Generate a synthetic Modbus RTU pattern on the given channel.
// Supports 8E1 (even) or 8N1 by setting parity.
export function generateModbusFrame(
  sampleRate: number,
  channel: number,
  baud: number,
  addr: number,
  func: number,
  data: number[],
  parity: "none" | "even" | "odd" = "even"
): Uint8Array {
  const payload = [addr, func, ...data];
  const crc = modbusCrc(payload);
  const bytes = [...payload, crc & 0xff, (crc >> 8) & 0xff];

  const spb = Math.max(1, Math.floor(sampleRate / baud));
  const bits: number[] = [];
  const pushBit = (b: number, n: number) => { for (let i = 0; i < n; i++) bits.push(b); };
  const byte = (b: number) => {
    pushBit(0, spb); // start
    for (let i = 0; i < 8; i++) pushBit((b >> i) & 1, spb);
    if (parity !== "none") {
      const ones = b.toString(2).split("").filter(c => c === "1").length;
      const parBit = parity === "even" ? (ones % 2 === 1 ? 1 : 0) : (ones % 2 === 0 ? 1 : 0);
      pushBit(parBit, spb);
    }
    pushBit(1, spb); // stop
    pushBit(1, spb); // inter-byte gap
  };

  // Leading idle (3.5 char times of silence)
  pushBit(1, Math.round(spb * 11 * 3.5));
  for (const b of bytes) byte(b);
  // Trailing idle
  pushBit(1, Math.round(spb * 11 * 3.5));

  const samples = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) samples[i] = bits[i] << channel;
  return samples;
}

// --- LIN decoder ---

const LIN_COMMON_BAUDS = [2400, 9600, 19200];

// LIN 2.x data length table indexed by 6-bit ID (0–15 → 2,2,4,4,8,8,8,8,2,2,4,4,8,8,1,2; 16–63 → 8).
const LIN_DATA_LENGTH: number[] = (() => {
  const tbl: number[] = [];
  const low: number[] = [2, 2, 4, 4, 8, 8, 8, 8, 2, 2, 4, 4, 8, 8, 1, 2];
  for (let i = 0; i < 64; i++) tbl.push(i < 16 ? low[i]! : 8);
  return tbl;
})();

function linParityOk(pid: number): boolean {
  const id = pid & 0x3f;
  const p0 = ((id >> 0) ^ (id >> 1) ^ (id >> 2) ^ (id >> 4)) & 1;
  const p1 = ((id >> 1) ^ (id >> 3) ^ (id >> 4) ^ (id >> 5)) & 1;
  return ((p0 << 6) | (p1 << 7)) === (pid & 0xc0);
}

function linChecksum(data: number[], pid: number, mode: "classic" | "enhanced"): number {
  let sum = mode === "enhanced" ? pid : 0;
  for (const d of data) sum = (sum + d) & 0xff;
  return (~sum) & 0xff;
}

function linFrameType(id: number): "unconditional" | "diagnostic" | "user" | "reserved" {
  if (id === 0x3c || id === 0x3d) return "diagnostic";
  if (id === 0x3e) return "reserved";
  if (id >= 0x3f) return "user";
  return "unconditional";
}

export function decodeLIN(
  samples: Uint8Array,
  sampleRate: number,
  channel: number,
  baud: number,
  checksumMode: "classic" | "enhanced" = "classic"
): LINFrame[] {
  const spb = Math.max(1, Math.floor(sampleRate / baud));
  const bit = (s: number) => (samples[Math.max(0, Math.min(samples.length - 1, s))] >> channel) & 1;
  const frames: LINFrame[] = [];
  let i = 0;
  const breakThreshold = Math.round(13 * spb);

  while (i < samples.length - 1) {
    // Detect break: falling edge followed by dominant (low) for >= 13 bit times.
    if (bit(i) === 1 && bit(i + 1) === 0) {
      const breakStart = i + 1;
      let lowRun = 0;
      let j = breakStart;
      while (j < samples.length && bit(j) === 0) { lowRun++; j++; }
      if (lowRun < breakThreshold) { i++; continue; }

      // Break delimiter: at least 1 recessive bit — j already points to the first recessive sample.
      if (j >= samples.length) { i = j; continue; }

      // Sync field starts after the 1-bit delimiter.
      const syncStart = j + spb;
      const sampleBit = (n: number) => bit(Math.round(syncStart + (n + 0.5) * spb));
      const readByte = (offset: number) => {
        let v = 0;
        for (let b = 0; b < 8; b++) v |= (sampleBit(offset + b) << b);
        return v;
      };

      // Sync byte should be 0x55 (LSB first: 1,0,1,0,1,0,1,0)
      const syncByte = readByte(0);
      if (syncByte !== 0x55) { i = syncStart + Math.round(8 * spb); continue; }

      // PID
      const pidOffset = 8;
      const pid = readByte(pidOffset);
      const id = pid & 0x3f;
      const parityOk = linParityOk(pid);

      // Data length
      const dataLen = LIN_DATA_LENGTH[id] ?? 8;
      const dataOffset = pidOffset + 8;
      const data: number[] = [];
      for (let b = 0; b < dataLen; b++) data.push(readByte(dataOffset + b * 8));

      // Checksum
      const ckOffset = dataOffset + dataLen * 8;
      const checksum = readByte(ckOffset);
      const expectedCk = linChecksum(data, pid, checksumMode);
      const checksumOk = checksum === expectedCk;

      const frameEndSample = syncStart + Math.round((ckOffset + 8) * spb);
      const frameStartSample = breakStart;

      frames.push({
        startSample: frameStartSample,
        endSample: frameEndSample,
        ts: frameStartSample / sampleRate,
        id,
        pid,
        parityOk,
        data,
        checksum,
        checksumOk,
        type: linFrameType(id),
        bitSamples: Math.max(1, Math.round(spb)),
      });

      i = frameEndSample;
    } else {
      i++;
    }
  }
  return frames;
}

export function findNearestLinFrame(
  getWindow: (startSample: number, sampleCount: number) => Promise<Uint8Array>,
  sampleRate: number,
  config: { ch: number; baud: number; checksum: "classic" | "enhanced" },
  centerSample: number,
  direction: "next" | "previous",
  options?: { windowSize?: number; maxWindows?: number }
): Promise<FrameSearchResult | null> {
  return searchFrames(
    getWindow,
    (window) => decodeLIN(window, sampleRate, config.ch, config.baud, config.checksum).map(r => ({
      startSample: r.startSample,
      endSample: r.endSample,
      ts: r.ts,
      type: r.type,
      error: !r.parityOk || !r.checksumOk,
    })),
    centerSample,
    direction,
    options
  );
}

// Generate a synthetic LIN frame on the given channel.
export function generateLinFrame(
  sampleRate: number,
  channel: number,
  baud: number,
  id: number,
  data: number[],
  checksumMode: "classic" | "enhanced" = "classic"
): Uint8Array {
  const spb = Math.max(1, Math.floor(sampleRate / baud));
  const bits: number[] = [];
  const pushBit = (b: number, n: number) => { for (let i = 0; i < n; i++) bits.push(b); };

  // Compute PID with parity
  const p0 = ((id >> 0) ^ (id >> 1) ^ (id >> 2) ^ (id >> 4)) & 1;
  const p1 = ((id >> 1) ^ (id >> 3) ^ (id >> 4) ^ (id >> 5)) & 1;
  const pid = (id & 0x3f) | (p0 << 6) | (p1 << 7);

  const ck = linChecksum(data, pid, checksumMode);

  // Idle
  pushBit(1, spb * 2);

  // Break: dominant for 13+ bit times
  pushBit(0, spb * 13);
  // Break delimiter: recessive for 1 bit time
  pushBit(1, spb);

  // Sync byte 0x55 (LSB first)
  const syncByte = 0x55;
  for (let b = 0; b < 8; b++) pushBit((syncByte >> b) & 1, spb);

  // PID (LSB first)
  for (let b = 0; b < 8; b++) pushBit((pid >> b) & 1, spb);

  // Data bytes (LSB first)
  for (const d of data) {
    for (let b = 0; b < 8; b++) pushBit((d >> b) & 1, spb);
  }

  // Checksum (LSB first)
  for (let b = 0; b < 8; b++) pushBit((ck >> b) & 1, spb);

  // Trailing idle
  pushBit(1, spb * 2);

  const samples = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) samples[i] = bits[i] << channel;
  return samples;
}
