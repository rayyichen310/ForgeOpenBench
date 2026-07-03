// ---------------------------------------------------------------------------
// LA protocol decoders — pure functions over raw sample buffers.
// Extracted from WaveformLaView.tsx (PR: la-logic-extraction).
// ---------------------------------------------------------------------------

export const MAX_TICKER = 200; // max ticker rows to keep

export interface TickerRow { ts: number; byte: number; sample: number; error: boolean; parityOk?: boolean; }

export interface I2CFrame {
  startSample: number;
  endSample: number;
  ts: number;
  type: "start" | "repeated-start" | "stop" | "byte" | "ack" | "nack";
  addr?: number;     // 7-bit address
  data?: number;     // byte value
  rw?: "read" | "write";
}

export interface SPIFrame {
  startSample: number;
  endSample: number;
  ts: number;
  mosi?: number;
  miso?: number;
}

export type DecoderTab = "uart" | "i2c" | "spi";

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
  if (scl >= 0 && sda >= 0) {
    return { tab: "i2c", uart: { baud: 115200, ch: uartCh }, i2c: { scl, sda, addrBits: 7 }, spi: { mosi: mosi >= 0 ? mosi : 0, miso: miso >= 0 ? miso : 0, sck: sck >= 0 ? sck : 1, cs: cs >= 0 ? cs : -1, mode: 0, bits: 8, csActiveLow: true } };
  }
  const definedLabels = labels.filter((l) => l !== undefined && l !== "");
  const allNumeric = definedLabels.length > 0 && definedLabels.every(l => /^\d+$/.test(l));
  const detected = detectSpiChannels(capture.samples, capture.width);
  if ((mosi >= 0 && sck >= 0) || (sck >= 0 && cs >= 0)) {
    return { tab: "spi", uart: { baud: 115200, ch: uartCh }, i2c: { scl: scl >= 0 ? scl : 1, sda: sda >= 0 ? sda : 2, addrBits: 7 }, spi: { mosi: mosi >= 0 ? mosi : 0, miso: miso >= 0 ? miso : 1, sck: sck >= 0 ? sck : 2, cs: cs >= 0 ? cs : -1, mode: 0, bits: 8, csActiveLow: true } };
  }
  if (capture.source === "sigrok-sr" && allNumeric && definedLabels.length <= 4) {
    return { tab: "spi", uart: { baud: 115200, ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: -1, mode: 0, bits: 8, csActiveLow: true } };
  }
  return { tab: "uart", uart: { baud: estimateUartBaud(capture.samples, capture.sampleRate, uartCh), ch: uartCh }, i2c: { scl: 1, sda: 2, addrBits: 7 }, spi: { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true } };
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
    if (valid > 0) return { tab: "uart", score: valid, reason: `UART ${labelDefaults.uart.baud.toLocaleString()} baud on D${labelDefaults.uart.ch} (labels)`, uart: labelDefaults.uart };
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
        const expectedParity = parity === "even" ? (ones % 2 === 0 ? 1 : 0) : (ones % 2 === 1 ? 1 : 0);
        parityOk = parBit === expectedParity;
      }

      const stopBit = at(1 + dataBits + parityOffset);
      const error = stopBit !== 1 || parityOk === false;
      const absSample = baseSample + fs;
      rows.push({ ts: absSample / sampleRate, byte: v, sample: absSample, error, parityOk });
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
      pushBit(parity === "even" ? (ones % 2 === 0 ? 1 : 0) : (ones % 2 === 1 ? 1 : 0));
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
    // SCL rising edge: sample SDA
    if (inFrame && scl(i) === 0 && scl(i + 1) === 1) {
      const sampleIdx = i + 1;
      const b = sda(sampleIdx);
      if (bitCount < 8) {
        if (bitCount === 0) byteStart = sampleIdx;
        byte = (byte << 1) | b;
        bitCount++;
      } else {
        // ACK/NACK bit
        const ack = b === 0;
        const endSample = sampleIdx;
        if (isAddr) {
          const addr7 = byte >> 1;
          const rw = (byte & 1) ? "read" : "write";
          rows.push({ startSample: byteStart, endSample, ts: byteStart / sampleRate, type: "byte", addr: addr7, rw });
          isAddr = false;
        } else {
          rows.push({ startSample: byteStart, endSample, ts: byteStart / sampleRate, type: "byte", data: byte });
        }
        rows.push({ startSample: sampleIdx, endSample, ts: sampleIdx / sampleRate, type: ack ? "ack" : "nack" });
        byte = 0;
        bitCount = 0;
        if (rows.length > MAX_TICKER) break;
      }
      i = sampleIdx;
      continue;
    }
    i++;
  }
  return rows;
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

  while (i < samples.length) {
    const active = csActive(i);
    if (!inFrame && active) {
      inFrame = true;
      wordStart = i;
      mosi = 0; miso = 0; bitCount = 0;
      prevSck = bit(i, sckCh);
    } else if (inFrame && !active) {
      inFrame = false;
      if (bitCount > 0) {
        rows.push({ startSample: wordStart, endSample: i, ts: wordStart / sampleRate, mosi, miso });
      }
      if (rows.length > MAX_TICKER) break;
    }

    if (inFrame) {
      const sck = bit(i, sckCh);
      const rising = prevSck === 0 && sck === 1;
      const falling = prevSck === 1 && sck === 0;
      const sampleEdge = sampleRising ? rising : falling;
      if (sampleEdge) {
        mosi = (mosi << 1) | bit(i, mosiCh);
        miso = (miso << 1) | bit(i, misoCh);
        bitCount++;
        if (bitCount === bits) {
          rows.push({ startSample: wordStart, endSample: i, ts: wordStart / sampleRate, mosi, miso });
          mosi = 0; miso = 0; bitCount = 0;
          wordStart = i;
          if (rows.length > MAX_TICKER) break;
        }
      }
      prevSck = sck;
    }
    i++;
  }
  return rows;
}

// Generate a synthetic LA capture for offline decoder/UX testing.
// UART on D0, I2C on D1/D2, SPI on D3-D6 at 1 MHz 8-bit.
export function generateLaTestPattern(sampleRate: number, durationS: number): Uint8Array {
  const totalSamples = Math.floor(sampleRate * durationS);
  const samples = new Uint8Array(totalSamples);
  const bitTime = Math.floor(sampleRate / 115200);
  if (bitTime < 2) return samples;

  // UART on D0: "Hi\n" at 115200 baud
  const uartBits: number[] = [];
  const pushBit = (v: number, n: number) => { for (let i = 0; i < n; i++) uartBits.push(v); };
  const uartByte = (b: number) => {
    pushBit(0, bitTime); // start
    for (let i = 0; i < 8; i++) pushBit((b >> i) & 1, bitTime);
    pushBit(1, bitTime); // stop
  };
  uartByte(0x48); // H
  uartByte(0x69); // i
  uartByte(0x0A); // \n
  pushBit(1, bitTime * 10); // idle gap

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

  // Interleave each sub-pattern into the total buffer, scaling to fit.
  const uartScale = Math.max(1, Math.floor(totalSamples / uartBits.length));
  const i2cScale = Math.max(1, Math.floor(totalSamples / i2cBits.length));
  const spiScale = Math.max(1, Math.floor(totalSamples / spiBits.length));

  for (let s = 0; s < totalSamples; s++) {
    let byte = 0;
    const ui = Math.floor(s / uartScale);
    if (ui < uartBits.length) byte |= uartBits[ui] << 0;
    const ii = Math.floor(s / i2cScale);
    if (ii < i2cBits.length) {
      byte |= i2cBits[ii].scl << 1;
      byte |= i2cBits[ii].sda << 2;
    }
    const si = Math.floor(s / spiScale);
    if (si < spiBits.length) {
      byte |= spiBits[si].mosi << 3;
      byte |= spiBits[si].miso << 4;
      byte |= spiBits[si].sck << 5;
      byte |= spiBits[si].cs << 6;
    }
    samples[s] = byte;
  }
  return samples;
}
