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

export function inferDecoderDefaults(capture: LaCapture, skipAutoDetect = false): DecoderDefaults {
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
  // No labels matched — use signal-based auto-detection.
  if (!skipAutoDetect) {
    const auto = autoDetectLaProtocol(capture);
    if (auto.score > 0) {
      return {
        tab: auto.tab,
        uart: auto.uart ?? { baud: 115200, ch: uartCh },
        i2c: auto.i2c ?? { scl: 1, sda: 2, addrBits: 7 },
        spi: auto.spi ? { ...auto.spi, csActiveLow: true } : { mosi: detected.mosi, miso: detected.miso, sck: detected.sck, cs: cs >= 0 ? cs : 6, mode: 0, bits: 8, csActiveLow: true },
        can: auto.can ?? canDefaults,
        onewire: auto.onewire ?? oneWireDefaults,
        swd: auto.swd ?? swdDefaults,
        jtag: auto.jtag ?? jtagDefaults,
        modbus: auto.modbus ?? modbusDefaults,
        lin: auto.lin ?? linDefaults,
      };
    }
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

// ---------------------------------------------------------------------------
// Edge-list computation + signal classification (LUT auto-detect Stage 1)
// ---------------------------------------------------------------------------

export interface Edge {
  sample: number;       // sample index of transition
  rising: number;       // bitmask of channels that went high
  falling: number;      // bitmask of channels that went low
}

export function computeEdgeList(samples: Uint8Array, width: number): Edge[] {
  const maxCh = Math.min(width, 16);
  const edges: Edge[] = [];
  let prev = samples.length > 0 ? samples[0]! : 0;
  for (let s = 1; s < samples.length; s++) {
    const cur = samples[s]!;
    if (cur === prev) continue;
    let rising = 0, falling = 0;
    const diff = cur ^ prev;
    for (let ch = 0; ch < maxCh; ch++) {
      if (diff & (1 << ch)) {
        if (cur & (1 << ch)) rising |= (1 << ch);
        else falling |= (1 << ch);
      }
    }
    edges.push({ sample: s, rising, falling });
    prev = cur;
  }
  return edges;
}

export interface ChannelProfile {
  channel: number;
  transitionCount: number;
  idleState: number;        // 0 or 1
  isClock: boolean;
  cv: number;               // coefficient of variation of intervals
  intervals: number[];
  symbolTime: number;       // shortest recurring interval
  integerMultiple: boolean;
  minPulse: number;
  maxPulse: number;
}

export interface ClockDataLink {
  clock: number;
  data: number;
  symbolTimeRatio: number;
  activityOverlap: number;
}

export type SignalSignatureType =
  | "uart-start" | "i2c-start" | "i2c-stop" | "can-sof"
  | "onewire-reset" | "lin-break" | "swd-reset" | "jtag-state";

export interface SignalSignature {
  type: SignalSignatureType;
  channel: number;
  sampleIndex: number;
}

export type ChannelRole =
  | "clock" | "cs_enable" | "data_in" | "data_out"
  | "control" | "async" | "unknown";

export interface ChannelRoleEntry {
  channel: number;
  role: ChannelRole;
  confidence: number;  // 0..1
  reasons: string[];
}

export interface SignalProfile {
  edges: Edge[];
  channels: ChannelProfile[];
  activeChannels: number[];
  clocks: number[];
  dataChannels: number[];
  clockDataLinks: ClockDataLink[];
  signatures: SignalSignature[];
  roles: ChannelRoleEntry[];
}

export function computeChannelProfile(
  samples: Uint8Array,
  _width: number,
  ch: number,
  edges: Edge[],
): ChannelProfile {
  const mask = 1 << ch;

  // Collect transition samples for this channel
  const transitionSamples: number[] = [];
  for (const e of edges) {
    if (e.rising & mask || e.falling & mask) {
      transitionSamples.push(e.sample);
    }
  }

  const transitionCount = transitionSamples.length;

  // Idle state: majority vote on first 1% and last 1%
  const tailLen = Math.max(1, Math.floor(samples.length * 0.01));
  let highCount = 0, lowCount = 0;
  for (let s = 0; s < tailLen; s++) {
    if ((samples[s]! >> ch) & 1) highCount++; else lowCount++;
  }
  for (let s = samples.length - tailLen; s < samples.length; s++) {
    if ((samples[s]! >> ch) & 1) highCount++; else lowCount++;
  }
  const idleState = highCount >= lowCount ? 1 : 0;

  // Intervals between transitions
  const intervals: number[] = [];
  for (let i = 1; i < transitionSamples.length; i++) {
    intervals.push(transitionSamples[i]! - transitionSamples[i - 1]!);
  }

  // CV (coefficient of variation) — trimmed to exclude idle gaps
  let mean = 0, variance = 0;
  if (intervals.length > 0) {
    // Trimmed CV: exclude intervals > 3× median (idle gaps between transactions)
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const trimmed = intervals.filter(iv => iv <= median * 3);
    const useIntervals = trimmed.length >= 3 ? trimmed : intervals;
    mean = useIntervals.reduce((a, b) => a + b, 0) / useIntervals.length;
    variance = useIntervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / useIntervals.length;
  }
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 1;

  const isClock = cv < 0.4 && transitionCount >= 4;

  // Symbol time: shortest interval that recurs (min of intervals)
  const symbolTime = intervals.length > 0 ? Math.min(...intervals) : 0;

  // Integer-multiple check: all intervals ~ k * symbolTime (+/-10%)
  let integerMultiple = false;
  if (symbolTime > 0 && intervals.length >= 3) {
    integerMultiple = intervals.every(iv => {
      const k = Math.round(iv / symbolTime);
      if (k < 1) return false;
      const expected = k * symbolTime;
      return Math.abs(iv - expected) <= symbolTime * 0.1;
    });
  }

  // Min/max pulse
  const minPulse = intervals.length > 0 ? Math.min(...intervals) : 0;
  const maxPulse = intervals.length > 0 ? Math.max(...intervals) : 0;

  return {
    channel: ch,
    transitionCount,
    idleState,
    isClock,
    cv,
    intervals,
    symbolTime,
    integerMultiple,
    minPulse,
    maxPulse,
  };
}

export function detectClockDataLinks(
  clocks: ChannelProfile[],
  dataChannels: ChannelProfile[],
  edges: Edge[],
): ClockDataLink[] {
  const links: ClockDataLink[] = [];
  for (const clk of clocks) {
    for (const data of dataChannels) {
      if (data.channel === clk.channel) continue;
      // Symbol time ratio
      const symbolTimeRatio = clk.symbolTime > 0 ? data.symbolTime / clk.symbolTime : 0;
      // Activity overlap: fraction of data transitions within clock active windows
      const clkMask = 1 << clk.channel;
      const dataMask = 1 << data.channel;
      let dataInClock = 0, dataTotal = 0;
      for (const e of edges) {
        if (e.rising & dataMask || e.falling & dataMask) {
          dataTotal++;
          // Check if clock is toggling near this sample (within 1 symbolTime)
          const near = edges.some(e2 =>
            e2.sample >= e.sample - clk.symbolTime &&
            e2.sample <= e.sample + clk.symbolTime &&
            (e2.rising & clkMask || e2.falling & clkMask)
          );
          if (near) dataInClock++;
        }
      }
      const activityOverlap = dataTotal > 0 ? dataInClock / dataTotal : 0;
      if (activityOverlap > 0.5 && symbolTimeRatio > 0.5 && symbolTimeRatio < 2.0) {
        links.push({ clock: clk.channel, data: data.channel, symbolTimeRatio, activityOverlap });
      }
    }
  }
  return links;
}

export function detectSignatures(
  profiles: ChannelProfile[],
  edges: Edge[],
  samples: Uint8Array,
  rate: number,
  _width: number,
): SignalSignature[] {
  const sigs: SignalSignature[] = [];

  for (const p of profiles) {
    if (p.transitionCount < 2) continue;
    const mask = 1 << p.channel;

    // UART start: idle-high, first falling edge starts a pulse ~1 symbolTime
    if (p.idleState === 1 && !p.isClock && p.symbolTime > 0) {
      const firstFall = edges.find(e => e.falling & mask);
      if (firstFall) {
        // Check there's a rising edge within ~10 symbolTimes (a byte frame)
        const nextRise = edges.find(e =>
          e.sample > firstFall.sample &&
          e.rising & mask &&
          e.sample <= firstFall.sample + p.symbolTime * 12
        );
        if (nextRise) {
          sigs.push({ type: "uart-start", channel: p.channel, sampleIndex: firstFall.sample });
        }
      }
    }

    // CAN SOF: idle-high (recessive), falling edge after long idle, then bit-stuffing pattern
    if (p.idleState === 1 && !p.isClock && p.symbolTime > 0) {
      // Look for a gap > 10 symbolTimes before a falling edge (inter-frame space)
      let prevTransition = -1;
      for (const e of edges) {
        if (!(e.falling & mask)) continue;
        if (prevTransition >= 0 && e.sample - prevTransition > p.symbolTime * 10) {
          // Potential SOF — check for bit stuffing (>=5 same-level bits -> stuff)
          const sofSample = e.sample;
          let runLength = 1;
          let lastBit = 0;
          let stuffBits = 0;
          for (let s = sofSample; s < Math.min(sofSample + p.symbolTime * 30, samples.length); s++) {
            const bit = (samples[s]! >> p.channel) & 1;
            if (s === sofSample) { lastBit = bit; runLength = 1; continue; }
            if (bit === lastBit) {
              runLength++;
              if (runLength === 5) {
                stuffBits++;
                runLength = 1; // stuff bit resets
              }
            } else {
              runLength = 1;
              lastBit = bit;
            }
          }
          if (stuffBits >= 1) {
            sigs.push({ type: "can-sof", channel: p.channel, sampleIndex: sofSample });
            break;
          }
        }
        prevTransition = e.sample;
      }
    }

    // 1-Wire reset: long low pulse (~480µs) followed by presence pulse
    if (p.idleState === 1 && !p.isClock) {
      const resetSamples = Math.floor(rate * 0.0004); // ~400µs
      for (const e of edges) {
        if (!(e.falling & mask)) continue;
        // Find the rising edge after this falling edge
        const riseEdge = edges.find(e2 => e2.sample > e.sample && e2.rising & mask);
        if (riseEdge && riseEdge.sample - e.sample >= resetSamples * 0.5) {
          // Check for presence pulse after reset
          const presenceFall = edges.find(e2 =>
            e2.sample > riseEdge.sample &&
            e2.falling & mask &&
            e2.sample <= riseEdge.sample + resetSamples
          );
          if (presenceFall) {
            sigs.push({ type: "onewire-reset", channel: p.channel, sampleIndex: e.sample });
            break;
          }
        }
      }
    }

    // LIN break: >=11 bit-times of continuous low
    if (p.idleState === 1 && !p.isClock && p.symbolTime > 0) {
      const breakLen = p.symbolTime * 11;
      for (const e of edges) {
        if (!(e.falling & mask)) continue;
        const riseEdge = edges.find(e2 => e2.sample > e.sample && e2.rising & mask);
        if (riseEdge && riseEdge.sample - e.sample >= breakLen) {
          sigs.push({ type: "lin-break", channel: p.channel, sampleIndex: e.sample });
          break;
        }
      }
    }
  }

  // I2C start/stop: SDA falls while SCL high / SDA rises while SCL high
  const clockProfiles = profiles.filter(p => p.isClock);
  const allActive = profiles.filter(p => p.transitionCount > 0);
  for (const clk of clockProfiles) {
    for (const sda of allActive) {
      if (sda.channel === clk.channel) continue;
      const sdaMask = 1 << sda.channel;
      for (const e of edges) {
        // SDA falling while SCL high
        if (e.falling & sdaMask) {
          const sclHigh = (samples[Math.max(0, e.sample - 1)]! >> clk.channel) & 1;
          const sclHighAfter = (samples[Math.min(samples.length - 1, e.sample + 1)]! >> clk.channel) & 1;
          if (sclHigh && sclHighAfter) {
            sigs.push({ type: "i2c-start", channel: sda.channel, sampleIndex: e.sample });
            break;
          }
        }
      }
      for (const e of edges) {
        // SDA rising while SCL high
        if (e.rising & sdaMask) {
          const sclHigh = (samples[Math.max(0, e.sample - 1)]! >> clk.channel) & 1;
          const sclHighAfter = (samples[Math.min(samples.length - 1, e.sample + 1)]! >> clk.channel) & 1;
          if (sclHigh && sclHighAfter) {
            sigs.push({ type: "i2c-stop", channel: sda.channel, sampleIndex: e.sample });
            break;
          }
        }
      }
    }
  }

  // SWD reset: >=50 SWCLK cycles with SWDIO held
  const swdClkProfiles = profiles.filter(p => p.isClock && p.transitionCount >= 100);
  for (const clk of swdClkProfiles) {
    for (const dio of profiles) {
      if (dio.channel === clk.channel) continue;
      if (dio.transitionCount < 2) continue;
      // Check if SWDIO is stable (few transitions) while SWCLK has many
      if (dio.transitionCount <= 5 && clk.transitionCount >= 50) {
        sigs.push({ type: "swd-reset", channel: dio.channel, sampleIndex: 0 });
        break;
      }
    }
  }

  return sigs;
}

export function classifySignal(samples: Uint8Array, width: number, rate: number): SignalProfile {
  const maxCh = Math.min(width, 16);
  const edges = computeEdgeList(samples, width);

  const channels: ChannelProfile[] = [];
  for (let ch = 0; ch < maxCh; ch++) {
    channels.push(computeChannelProfile(samples, width, ch, edges));
  }

  const activeChannels = channels
    .filter(p => p.transitionCount > 0)
    .map(p => p.channel)
    .sort((a, b) => a - b);

  const clocks = channels.filter(p => p.isClock).map(p => p.channel);
  const dataChannels = activeChannels.filter(ch => !clocks.includes(ch));

  const clockProfiles = channels.filter(p => p.isClock);
  const dataProfiles = channels.filter(p => !p.isClock && p.transitionCount > 0);
  const clockDataLinks = detectClockDataLinks(clockProfiles, dataProfiles, edges);

  const signatures = detectSignatures(channels, edges, samples, rate, width);
  const roles = classifyChannelRoles(channels, clockDataLinks, edges);

  return { edges, channels, activeChannels, clocks, dataChannels, clockDataLinks, signatures, roles };
}

/**
 * Classify each active channel into a role based on edge patterns:
 * - clock: regular intervals (low CV), ~50% duty
 * - cs_enable: very few transitions, toggles at burst boundaries
 * - data_in: irregular transitions, correlated with clock rising edges
 * - data_out: irregular transitions, may be idle-high (UART) or idle-low
 * - control: moderate transitions, specific timing vs clock (TMS, SWDIO)
 * - async: no clock correlation, standalone (UART, CAN, OneWire, LIN)
 */
export function classifyChannelRoles(
  channels: ChannelProfile[],
  links: ClockDataLink[],
  edges: Edge[],
): ChannelRoleEntry[] {
  const active = channels.filter(p => p.transitionCount > 0);
  const linkedData = new Set<number>();
  for (const link of links) linkedData.add(link.data);

  // Compute burst boundaries: find the first and last transition across all channels
  let firstEdge = Infinity, lastEdge = 0;
  for (const p of active) {
    for (const e of edges) {
      const mask = 1 << p.channel;
      if (e.rising & mask || e.falling & mask) {
        if (e.sample < firstEdge) firstEdge = e.sample;
        if (e.sample > lastEdge) lastEdge = e.sample;
      }
    }
  }
  const burstSpan = lastEdge - firstEdge;

  const entries: ChannelRoleEntry[] = [];

  for (const p of active) {
    const reasons: string[] = [];
    let role: ChannelRole = "unknown";
    let confidence = 0;

    if (p.isClock) {
      role = "clock";
      confidence = 0.9;
      reasons.push(`CV=${p.cv.toFixed(2)} <0.4`);
      reasons.push(`${p.transitionCount} transitions`);
    } else if (linkedData.has(p.channel)) {
      // Linked to a clock — classify as data_in, data_out, or control
      const link = links.find(l => l.data === p.channel)!;
      const clkProfile = channels[link.clock]!;
      // Control channels (TMS, SWDIO): fewer transitions than data, moderate CV
      const transRatio = clkProfile.transitionCount > 0
        ? p.transitionCount / clkProfile.transitionCount : 1;
      if (transRatio < 0.15 && p.transitionCount >= 2) {
        role = "control";
        confidence = 0.7;
        reasons.push(`transRatio=${transRatio.toFixed(2)} (<0.15 → control)`);
        reasons.push(`linked to clock D${link.clock}`);
      } else if (transRatio < 0.3 && p.transitionCount <= 5) {
        // Very few transitions relative to clock — could be CS/enable
        role = "cs_enable";
        confidence = 0.6;
        reasons.push(`transRatio=${transRatio.toFixed(2)} (<0.3, ≤5 transitions → CS)`);
        reasons.push(`linked to clock D${link.clock}`);
      } else {
        // Data line — determine in/out by idle state
        // Idle-high suggests UART TX or SPI MISO (when not driven)
        // Idle-low suggests SPI MOSI or data output
        if (p.idleState === 1) {
          role = "data_out";
          confidence = 0.6;
          reasons.push(`idle-high → data_out`);
        } else {
          role = "data_in";
          confidence = 0.55;
          reasons.push(`idle-low → data_in`);
        }
        reasons.push(`linked to clock D${link.clock}`);
        reasons.push(`transRatio=${transRatio.toFixed(2)}`);
      }
    } else if (p.transitionCount <= 3 && burstSpan > 0) {
      // Very few transitions, not linked to a clock — likely CS/enable
      // Check if transitions are at burst boundaries
      const mask = 1 << p.channel;
      const transSamples: number[] = [];
      for (const e of edges) {
        if (e.rising & mask || e.falling & mask) transSamples.push(e.sample);
      }
      const nearStart = transSamples.some(s => Math.abs(s - firstEdge) < burstSpan * 0.1);
      const nearEnd = transSamples.some(s => Math.abs(s - lastEdge) < burstSpan * 0.1);
      if (nearStart && nearEnd) {
        role = "cs_enable";
        confidence = 0.7;
        reasons.push(`${p.transitionCount} transitions at burst boundaries`);
      } else {
        role = "async";
        confidence = 0.5;
        reasons.push(`${p.transitionCount} transitions, not at boundaries`);
      }
    } else {
      // Not linked to any clock — async protocol (UART, CAN, OneWire, LIN, Modbus)
      role = "async";
      confidence = 0.8;
      reasons.push(`no clock link, ${p.transitionCount} transitions`);
      if (p.idleState === 1) reasons.push(`idle-high (UART/CAN/LIN)`);
      else reasons.push(`idle-low (OneWire/Modbus)`);
    }

    entries.push({ channel: p.channel, role, confidence, reasons });
  }

  return entries;
}

/**
 * Group active channels into independent clusters using union-find.
 * Channels linked by clock-data pairs form one group.
 * Unlinked async channels each form their own group.
 */
export function groupChannelsByLinks(profile: SignalProfile): number[][] {
  const active = profile.activeChannels;
  if (active.length === 0) return [];

  const parent = new Map<number, number>();
  for (const ch of active) parent.set(ch, ch);
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const link of profile.clockDataLinks) {
    union(link.clock, link.data);
  }

  const groupMap = new Map<number, number[]>();
  for (const ch of active) {
    const root = find(ch);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(ch);
  }

  return Array.from(groupMap.values()).map(g => g.sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// Protocol LUT + property scoring (LUT auto-detect Stage 2)
// ---------------------------------------------------------------------------

export interface ProtocolEntry {
  tab: DecoderTab;
  minChannels: number;
  needsClock: boolean;
  idleHigh: boolean;
  requiredSignature?: SignalSignatureType;
  needsIntegerMultiple: boolean;
  needsChannelLink: boolean;
  weight: number;
}

export const PROTOCOL_LUT: ProtocolEntry[] = [
  { tab: "uart",    minChannels: 1, needsClock: false, idleHigh: true,  requiredSignature: "uart-start",    needsIntegerMultiple: true,  needsChannelLink: false, weight: 1 },
  { tab: "i2c",     minChannels: 2, needsClock: true,  idleHigh: true,  requiredSignature: "i2c-start",     needsIntegerMultiple: true,  needsChannelLink: true,  weight: 2 },
  { tab: "spi",     minChannels: 3, needsClock: true,  idleHigh: false,                                      needsIntegerMultiple: true,  needsChannelLink: true,  weight: 1 },
  { tab: "can",     minChannels: 1, needsClock: false, idleHigh: true,  requiredSignature: "can-sof",       needsIntegerMultiple: true,  needsChannelLink: false, weight: 5 },
  { tab: "onewire", minChannels: 1, needsClock: false, idleHigh: true,  requiredSignature: "onewire-reset", needsIntegerMultiple: false, needsChannelLink: false, weight: 3 },
  { tab: "swd",     minChannels: 2, needsClock: true,  idleHigh: false, requiredSignature: "swd-reset",     needsIntegerMultiple: true,  needsChannelLink: true,  weight: 3 },
  { tab: "jtag",    minChannels: 4, needsClock: true,  idleHigh: false,                                      needsIntegerMultiple: true,  needsChannelLink: true,  weight: 2 },
  { tab: "modbus",  minChannels: 1, needsClock: false, idleHigh: true,  requiredSignature: "uart-start",    needsIntegerMultiple: true,  needsChannelLink: false, weight: 3 },
  { tab: "lin",     minChannels: 1, needsClock: false, idleHigh: true,  requiredSignature: "lin-break",     needsIntegerMultiple: true,  needsChannelLink: false, weight: 3 },
];

export interface ScoredCandidate {
  entry: ProtocolEntry;
  propertyScore: number;
  reasons: string[];
}

export function scoreProtocolProperties(profile: SignalProfile): ScoredCandidate[] {
  const results: ScoredCandidate[] = [];

  for (const entry of PROTOCOL_LUT) {
    let score = 0;
    const reasons: string[] = [];

    // Channel count
    if (profile.activeChannels.length >= entry.minChannels) {
      score++;
      reasons.push(`${profile.activeChannels.length}ch >= ${entry.minChannels}`);
    } else {
      score--;
    }

    // Clock presence
    const hasClock = profile.clocks.length > 0;
    if (entry.needsClock && hasClock) {
      score++;
      reasons.push(`clock on D${profile.clocks.join("/D")}`);
    } else if (entry.needsClock && !hasClock) {
      score -= 2; // strong penalty — protocol requires clock but none found
    } else if (!entry.needsClock && !hasClock) {
      score++;
      reasons.push("no clock (async)");
    }

    // Idle state
    if (entry.idleHigh) {
      const allIdleHigh = profile.activeChannels.every(ch =>
        profile.channels[ch]?.idleState === 1
      );
      if (allIdleHigh) {
        score++;
        reasons.push("idle high");
      } else {
        score--;
      }
    }

    // Required signature
    if (entry.requiredSignature) {
      const sig = profile.signatures.find(s => s.type === entry.requiredSignature);
      if (sig) {
        score++;
        reasons.push(`${sig.type} at s${sig.sampleIndex}`);
      } else {
        score -= 2; // strong penalty — expected signature not found
      }
    }

    // Integer-multiple check
    if (entry.needsIntegerMultiple) {
      const anyIntMult = profile.activeChannels.some(ch =>
        profile.channels[ch]?.integerMultiple
      );
      if (anyIntMult) {
        score++;
        reasons.push("integer-multiple confirmed");
      } else {
        score--;
      }
    }

    // Channel linking (for multi-channel protocols)
    if (entry.needsChannelLink) {
      if (profile.clockDataLinks.length > 0) {
        score++;
        reasons.push(`${profile.clockDataLinks.length} clock-data link(s)`);
      } else {
        score -= 2; // strong penalty — no correlated clock-data pair
      }
    }

    results.push({ entry, propertyScore: score, reasons });
  }

  // Sort by property score descending, keep top candidates with score >= 3
  return results
    .filter(r => r.propertyScore >= 3)
    .sort((a, b) => b.propertyScore - a.propertyScore)
    .slice(0, 3);
}

/**
 * Auto-detect the most likely protocol in a capture.
 * Scores each candidate by the number of valid decoded frames/rows.
 * Returns the best match and its configuration.
 * Tries label-based detection first, then delegates to autoDetectLaProtocolMulti.
 */
export function autoDetectLaProtocol(capture: LaCapture): AutoDetectResult {
  // Label-based path: if labels explicitly identify a single protocol, use it.
  const labelDefaults = inferDecoderDefaults(capture, true);
  const labelResult = detectFromLabels(capture, labelDefaults);
  if (labelResult) return labelResult;

  // Signal-based path: multi-protocol detection, return top result.
  const results = autoDetectLaProtocolMulti(capture);
  return results[0] ?? { tab: "uart", score: 0, reason: "no active signal detected" };
}

/**
 * Multi-protocol auto-detection: groups channels via union-find, then runs
 * targeted decode per group. Returns all detected protocols sorted by score.
 */
export function autoDetectLaProtocolMulti(capture: LaCapture): AutoDetectResult[] {
  const samples = capture.samples;
  const rate = capture.sampleRate;
  const width = capture.width;

  // --- Stage 1: Signal classification via edge-list ---
  const profile = classifySignal(samples, width, rate);

  // --- Stage 2: Group channels into independent clusters ---
  const groups = groupChannelsByLinks(profile);

  const results: AutoDetectResult[] = [];
  const seenTabs = new Set<string>();

  // --- Stage 3a: Per-group targeted decode (uses grouping for multi-ch protocols) ---
  for (const group of groups) {
    const groupProfile = buildGroupProfile(profile, group);
    const candidates = scoreProtocolProperties(groupProfile);
    const groupBest = decodeTopCandidates(capture, profile, group, candidates);
    if (groupBest && groupBest.score > 0) {
      results.push(groupBest);
      seenTabs.add(groupBest.tab);
    }
  }

  // --- Stage 3b: Try single-channel protocols on ALL active channels (not just within groups) ---
  // This catches async protocols (UART, CAN, OneWire, Modbus, LIN) that may have been
  // missed if grouping put them in a group that scored as a different protocol.
  for (const ch of profile.activeChannels) {
    const asyncBest = tryAsyncProtocols(capture, ch);
    if (asyncBest && asyncBest.score > 0) {
      // Only add if we don't already have this protocol tab for this channel
      const key = `${asyncBest.tab}:${ch}`;
      if (!seenTabs.has(key)) {
        results.push(asyncBest);
        seenTabs.add(key);
      }
    }
  }

  // --- Stage 3c: Try multi-channel protocols on ALL active channel pairs/groups ---
  // This catches I2C, SPI, SWD, JTAG when clock-data link detection failed to group them.
  const multiBest = tryMultiChannelProtocols(capture, profile);
  for (const r of multiBest) {
    if (r.score > 0 && !seenTabs.has(r.tab)) {
      results.push(r);
      seenTabs.add(r.tab);
    }
  }

  // Fallback: if nothing produced results, try brute-force on all active channels
  if (results.length === 0) {
    const fallback = bruteForceDetect(capture, profile);
    if (fallback && fallback.score > 0) results.push(fallback);
  }

  return results.sort((a, b) => b.score - a.score);
}

/** Helper: try all single-channel (async) protocols on one channel. Returns best result. */
function tryAsyncProtocols(capture: LaCapture, ch: number): AutoDetectResult | null {
  const samples = capture.samples;
  const rate = capture.sampleRate;
  let best: AutoDetectResult | null = null;
  const bestScore = () => best?.score ?? 0;

  // UART
  const baud = estimateUartBaud(samples, rate, ch);
  const uartRows = decodeUartChunk(samples, rate, baud, ch);
  const uartValid = uartRows.filter(r => !r.error).length;
  if (uartValid > 0 && uartValid > bestScore()) {
    best = { tab: "uart", score: uartValid, reason: `UART ${baud.toLocaleString()} baud on D${ch}`, uart: { baud, ch } };
  }

  // CAN
  for (const canBaud of CAN_COMMON_BAUDS) {
    const canFrames = decodeCAN(samples, rate, ch, canBaud);
    const canScore = canFrames.length;
    if (canScore > 0 && canScore > bestScore()) {
      best = { tab: "can", score: canScore, reason: `CAN ${canBaud.toLocaleString()} baud on D${ch}`, can: { ch, baud: canBaud } };
    }
  }

  // OneWire
  const owFrames = decodeOneWire(samples, rate, ch);
  const owScore = owFrames.filter(f => f.type === "reset" || f.type === "presence").length;
  if (owScore > 0 && owScore > bestScore()) {
    best = { tab: "onewire", score: owScore, reason: `1-Wire on D${ch}`, onewire: { ch } };
  }

  // Modbus
  for (const mbBaud of [9600, 19200, 38400, 57600, 115200]) {
    for (const parity of (["even", "none", "odd"] as const)) {
      const mbFrames = decodeModbus(samples, rate, ch, mbBaud, parity);
      const mbScore = mbFrames.filter(f => f.crcOk).length * 3;
      if (mbScore > 0 && mbScore > bestScore()) {
        best = { tab: "modbus", score: mbScore, reason: `Modbus RTU ${mbBaud.toLocaleString()} baud D${ch}`, modbus: { ch, baud: mbBaud, parity } };
      }
    }
  }

  // LIN
  for (const linBaud of LIN_COMMON_BAUDS) {
    const linFrames = decodeLIN(samples, rate, ch, linBaud, "classic");
    const linScore = linFrames.filter(f => f.parityOk && f.checksumOk).length * 3;
    if (linScore > 0 && linScore > bestScore()) {
      best = { tab: "lin", score: linScore, reason: `LIN ${linBaud.toLocaleString()} baud D${ch}`, lin: { ch, baud: linBaud, checksum: "classic" } };
    }
  }

  return best;
}

/** Helper: try all multi-channel protocols using channel roles to narrow combinations. Returns best per protocol. */
function tryMultiChannelProtocols(capture: LaCapture, profile: SignalProfile): AutoDetectResult[] {
  const samples = capture.samples;
  const rate = capture.sampleRate;
  const width = capture.width;
  const active = profile.activeChannels;
  const roles = profile.roles;
  const results: AutoDetectResult[] = [];

  // Build role-based channel lists
  const clockChs = roles.filter(r => r.role === "clock").map(r => r.channel);
  const dataInChs = roles.filter(r => r.role === "data_in").map(r => r.channel);
  const dataOutChs = roles.filter(r => r.role === "data_out").map(r => r.channel);
  const controlChs = roles.filter(r => r.role === "control").map(r => r.channel);
  const csChs = roles.filter(r => r.role === "cs_enable").map(r => r.channel);
  const allDataChs = [...dataInChs, ...dataOutChs];

  // I2C: try (clock, data) pairs from roles, fallback to all pairs
  let bestI2c: AutoDetectResult | null = null;
  const i2cPairs: [number, number][] = [];
  if (clockChs.length > 0 && allDataChs.length > 0) {
    for (const clk of clockChs) for (const data of allDataChs) {
      if (clk !== data) { i2cPairs.push([clk, data]); i2cPairs.push([data, clk]); }
    }
  } else {
    for (let i = 0; i < active.length; i++) for (let j = 0; j < active.length; j++) {
      if (i !== j) i2cPairs.push([active[i]!, active[j]!]);
    }
  }
  for (const [scl, sda] of i2cPairs) {
    const frames = decodeI2C(samples, rate, scl, sda);
    let inTx = false, cb = 0, css = 0;
    for (const f of frames) {
      if (f.type === "start" || f.type === "repeated-start") { inTx = true; css++; }
      else if (f.type === "stop") { inTx = false; css++; }
      else if (f.type === "byte" && inTx) cb++;
    }
    const score = css * 2 + cb;
    if (score > 0 && score > (bestI2c?.score ?? 0)) {
      bestI2c = { tab: "i2c", score, reason: `I2C on D${scl}/D${sda}`, i2c: { scl, sda, addrBits: 7 } };
    }
  }
  if (bestI2c) results.push(bestI2c);

  // SPI: use role-based clock + data_in (MOSI) + data_out (MISO) + cs, fallback to detectSpiChannels
  let bestSpi: AutoDetectResult | null = null;
  let spiMosi: number, spiMiso: number, spiSck: number, spiCs: number;
  if (clockChs.length > 0 && dataInChs.length > 0) {
    spiSck = clockChs[0]!;
    spiMosi = dataInChs[0]!;
    spiMiso = dataOutChs[0] ?? spiMosi;
    spiCs = csChs[0] ?? -1;
  } else {
    const detected = detectSpiChannels(samples, width);
    spiMosi = detected.mosi; spiMiso = detected.miso; spiSck = detected.sck; spiCs = -1;
  }
  for (const mode of [0, 1, 2, 3] as const) {
    const frames = decodeSPI(samples, rate, spiMosi, spiMiso, spiSck, spiCs, mode, 8, true);
    if (frames.length > 0 && frames.length > (bestSpi?.score ?? 0)) {
      bestSpi = { tab: "spi", score: frames.length, reason: `SPI mode ${mode} on D${spiMosi}/D${spiSck}`, spi: { mosi: spiMosi, miso: spiMiso, sck: spiSck, cs: spiCs, mode, bits: 8 } };
    }
  }
  if (bestSpi) results.push(bestSpi);

  // SWD: try (clock, control) pairs from roles, fallback to all pairs
  let bestSwd: AutoDetectResult | null = null;
  const swdPairs: [number, number][] = [];
  if (clockChs.length > 0 && controlChs.length > 0) {
    for (const clk of clockChs) for (const dio of controlChs) {
      if (clk !== dio) swdPairs.push([dio, clk]);
    }
  } else {
    for (const dio of active) for (const clk of active) {
      if (dio !== clk) swdPairs.push([dio, clk]);
    }
  }
  for (const [dio, clk] of swdPairs) {
    const frames = decodeSWD(samples, rate, dio, clk);
    const score = frames.filter(f => f.type === "reset").length * 2 + frames.filter(f => f.type === "request").length;
    if (score > 0 && score > (bestSwd?.score ?? 0)) {
      bestSwd = { tab: "swd", score, reason: `SWD D${dio}/D${clk}`, swd: { swdio: dio, swclk: clk } };
    }
  }
  if (bestSwd) results.push(bestSwd);

  // JTAG: try (clock, control, data_in, data_out) from roles, fallback to exhaustive (capped)
  let bestJtag: AutoDetectResult | null = null;
  if (clockChs.length > 0 && controlChs.length > 0 && allDataChs.length >= 2) {
    const tck = clockChs[0]!, tms = controlChs[0]!;
    for (const tdi of dataInChs) {
      for (const tdo of dataOutChs) {
        if (tdi === tdo || tdi === tck || tdi === tms || tdo === tck || tdo === tms) continue;
        const frames = decodeJTAG(samples, rate, tck, tms, tdi, tdo);
        const score = frames.filter(f => f.type === "shift").length * 2 + frames.filter(f => f.type === "state").length;
        if (score > 0 && score > (bestJtag?.score ?? 0)) {
          bestJtag = { tab: "jtag", score, reason: `JTAG D${tck}/D${tms}/D${tdi}/D${tdo}`, jtag: { tck, tms, tdi, tdo } };
        }
      }
    }
  } else {
    // Fallback: exhaustive (capped at 8 channels)
    const jtagChannels = active.length <= 8 ? active : active.slice(0, 8);
    for (const tck of jtagChannels) {
      for (const tms of jtagChannels) {
        if (tms === tck) continue;
        for (const tdi of jtagChannels) {
          if (tdi === tck || tdi === tms) continue;
          for (const tdo of jtagChannels) {
            if (tdo === tck || tdo === tms || tdo === tdi) continue;
            const frames = decodeJTAG(samples, rate, tck, tms, tdi, tdo);
            const score = frames.filter(f => f.type === "shift").length * 2 + frames.filter(f => f.type === "state").length;
            if (score > 0 && score > (bestJtag?.score ?? 0)) {
              bestJtag = { tab: "jtag", score, reason: `JTAG D${tck}/D${tms}/D${tdi}/D${tdo}`, jtag: { tck, tms, tdi, tdo } };
            }
          }
        }
      }
    }
  }
  if (bestJtag) results.push(bestJtag);

  return results;
}

/** Helper: detect from label-based inference (extracted from autoDetectLaProtocol). */
function detectFromLabels(capture: LaCapture, labelDefaults: DecoderDefaults): AutoDetectResult | null {
  const samples = capture.samples;
  const rate = capture.sampleRate;

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
  return null;
}

/** Helper: build a subset SignalProfile for a specific channel group. */
function buildGroupProfile(profile: SignalProfile, group: number[]): SignalProfile {
  const groupSet = new Set(group);
  const channels = profile.channels.filter(ch => groupSet.has(ch.channel));
  const activeChannels = group.filter(ch => (profile.channels[ch]?.transitionCount ?? 0) > 0).sort((a, b) => a - b);
  const clocks = profile.clocks.filter(ch => groupSet.has(ch));
  const dataChannels = profile.dataChannels.filter(ch => groupSet.has(ch));
  const clockDataLinks = profile.clockDataLinks.filter(link => groupSet.has(link.clock) && groupSet.has(link.data));
  const signatures = profile.signatures.filter(sig => groupSet.has(sig.channel));
  const roles = profile.roles.filter(r => groupSet.has(r.channel));
  return { edges: profile.edges, channels, activeChannels, clocks, dataChannels, clockDataLinks, signatures, roles };
}

/** Helper: run targeted decode for top candidates on a channel group. */
function decodeTopCandidates(
  capture: LaCapture,
  profile: SignalProfile,
  group: number[],
  candidates: ScoredCandidate[],
): AutoDetectResult | null {
  const samples = capture.samples;
  const rate = capture.sampleRate;
  const width = capture.width;
  let best: AutoDetectResult | null = null;

  for (const cand of candidates) {
    const { entry, reasons } = cand;
    const reasonPrefix = reasons.join(", ");

    if (entry.tab === "uart") {
      for (const ch of group) {
        const baud = estimateUartBaud(samples, rate, ch);
        const rows = decodeUartChunk(samples, rate, baud, ch);
        const valid = rows.filter(r => !r.error).length;
        if (valid * entry.weight > (best?.score ?? 0)) {
          best = { tab: "uart", score: valid * entry.weight, reason: `UART ${baud.toLocaleString()} baud on D${ch} — ${reasonPrefix}`, uart: { baud, ch } };
        }
      }
    }

    if (entry.tab === "i2c") {
      const pairs: [number, number][] = [];
      if (profile.clockDataLinks.length > 0) {
        for (const link of profile.clockDataLinks) {
          if (!group.includes(link.clock) || !group.includes(link.data)) continue;
          pairs.push([link.clock, link.data]);
          pairs.push([link.data, link.clock]);
        }
      } else {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            pairs.push([group[i]!, group[j]!]);
          }
        }
      }
      for (const [scl, sda] of pairs) {
        const frames = decodeI2C(samples, rate, scl, sda);
        let inTx = false, completeBytes = 0, completeStartStop = 0;
        for (const f of frames) {
          if (f.type === "start" || f.type === "repeated-start") { inTx = true; completeStartStop++; }
          else if (f.type === "stop") { inTx = false; completeStartStop++; }
          else if (f.type === "byte" && inTx) completeBytes++;
        }
        const score = (completeStartStop * 2 + completeBytes) * entry.weight;
        if (score > (best?.score ?? 0)) {
          best = { tab: "i2c", score, reason: `I2C on D${scl}/D${sda} — ${reasonPrefix}`, i2c: { scl, sda, addrBits: 7 } };
        }
      }
    }

    if (entry.tab === "spi") {
      const detected = detectSpiChannels(samples, width);
      for (const mode of [0, 1, 2, 3] as const) {
        const frames = decodeSPI(samples, rate, detected.mosi, detected.miso, detected.sck, -1, mode, 8, true);
        const score = frames.length * entry.weight;
        if (score > (best?.score ?? 0)) {
          best = { tab: "spi", score, reason: `SPI mode ${mode} on D${detected.mosi}/D${detected.sck} — ${reasonPrefix}`, spi: { ...detected, mode, bits: 8, cs: -1 } };
        }
      }
    }

    if (entry.tab === "can") {
      for (const ch of group) {
        for (const baud of CAN_COMMON_BAUDS) {
          const frames = decodeCAN(samples, rate, ch, baud);
          const score = frames.length * entry.weight;
          if (score > (best?.score ?? 0)) {
            best = { tab: "can", score, reason: `CAN ${baud.toLocaleString()} baud on D${ch} — ${reasonPrefix}`, can: { ch, baud } };
          }
        }
      }
    }

    if (entry.tab === "onewire") {
      for (const ch of group) {
        const frames = decodeOneWire(samples, rate, ch);
        const score = frames.filter(f => f.type === "reset" || f.type === "presence").length * entry.weight;
        if (score > (best?.score ?? 0)) {
          best = { tab: "onewire", score, reason: `1-Wire on D${ch} — ${reasonPrefix}`, onewire: { ch } };
        }
      }
    }

    if (entry.tab === "swd") {
      for (const link of profile.clockDataLinks) {
        if (!group.includes(link.clock) || !group.includes(link.data)) continue;
        const frames = decodeSWD(samples, rate, link.data, link.clock);
        const score = (frames.filter(f => f.type === "reset").length * 2 + frames.filter(f => f.type === "request").length) * entry.weight;
        if (score > (best?.score ?? 0)) {
          best = { tab: "swd", score, reason: `SWD D${link.data}/D${link.clock} — ${reasonPrefix}`, swd: { swdio: link.data, swclk: link.clock } };
        }
      }
      if (profile.clockDataLinks.length === 0) {
        for (const dio of group) {
          for (const clk of group) {
            if (dio === clk) continue;
            const frames = decodeSWD(samples, rate, dio, clk);
            const score = (frames.filter(f => f.type === "reset").length * 2 + frames.filter(f => f.type === "request").length) * entry.weight;
            if (score > (best?.score ?? 0)) {
              best = { tab: "swd", score, reason: `SWD D${dio}/D${clk} — ${reasonPrefix}`, swd: { swdio: dio, swclk: clk } };
            }
          }
        }
      }
    }

    if (entry.tab === "jtag") {
      for (const tck of group) {
        for (const tms of group) {
          if (tms === tck) continue;
          for (const tdi of group) {
            if (tdi === tck || tdi === tms) continue;
            for (const tdo of group) {
              if (tdo === tck || tdo === tms || tdo === tdi) continue;
              const frames = decodeJTAG(samples, rate, tck, tms, tdi, tdo);
              const score = (frames.filter(f => f.type === "shift").length * 2 + frames.filter(f => f.type === "state").length) * entry.weight;
              if (score > (best?.score ?? 0)) {
                best = { tab: "jtag", score, reason: `JTAG D${tck}/D${tms}/D${tdi}/D${tdo} — ${reasonPrefix}`, jtag: { tck, tms, tdi, tdo } };
              }
            }
          }
        }
      }
    }

    if (entry.tab === "modbus") {
      for (const ch of group) {
        for (const baud of [9600, 19200, 38400, 57600, 115200]) {
          for (const parity of (["even", "none", "odd"] as const)) {
            const frames = decodeModbus(samples, rate, ch, baud, parity);
            const score = frames.filter(f => f.crcOk).length * entry.weight;
            if (score > (best?.score ?? 0)) {
              best = { tab: "modbus", score, reason: `Modbus RTU ${baud.toLocaleString()} baud D${ch} — ${reasonPrefix}`, modbus: { ch, baud, parity } };
            }
          }
        }
      }
    }

    if (entry.tab === "lin") {
      for (const ch of group) {
        for (const baud of LIN_COMMON_BAUDS) {
          const frames = decodeLIN(samples, rate, ch, baud, "classic");
          const score = frames.filter(f => f.parityOk && f.checksumOk).length * entry.weight;
          if (score > (best?.score ?? 0)) {
            best = { tab: "lin", score, reason: `LIN ${baud.toLocaleString()} baud D${ch} — ${reasonPrefix}`, lin: { ch, baud, checksum: "classic" } };
          }
        }
      }
    }
  }

  return best;
}

/** Helper: brute-force fallback when property scoring produces no candidates. */
function bruteForceDetect(capture: LaCapture, profile: SignalProfile): AutoDetectResult | null {
  const samples = capture.samples;
  const rate = capture.sampleRate;
  const width = capture.width;
  const active = profile.activeChannels;
  let best: AutoDetectResult = { tab: "uart", score: 0, reason: "no active signal detected" };

  for (const ch of active) {
    const baud = estimateUartBaud(samples, rate, ch);
    const rows = decodeUartChunk(samples, rate, baud, ch);
    const valid = rows.filter(r => !r.error).length;
    if (valid > best.score) {
      best = { tab: "uart", score: valid, reason: `UART ${baud.toLocaleString()} baud on D${ch} (fallback)`, uart: { baud, ch } };
    }
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const scl = active[i]!, sda = active[j]!;
      const frames = decodeI2C(samples, rate, scl, sda);
      let inTx = false, cb = 0, css = 0;
      for (const f of frames) {
        if (f.type === "start" || f.type === "repeated-start") { inTx = true; css++; }
        else if (f.type === "stop") { inTx = false; css++; }
        else if (f.type === "byte" && inTx) cb++;
      }
      const score = css * 2 + cb;
      if (score > best.score) {
        best = { tab: "i2c", score, reason: `I2C on D${scl}/D${sda} (fallback)`, i2c: { scl, sda, addrBits: 7 } };
      }
    }
  }
  const detected = detectSpiChannels(samples, width);
  for (const mode of [0, 1, 2, 3] as const) {
    const frames = decodeSPI(samples, rate, detected.mosi, detected.miso, detected.sck, -1, mode, 8, true);
    if (frames.length > best.score) {
      best = { tab: "spi", score: frames.length, reason: `SPI mode ${mode} on D${detected.mosi}/D${detected.sck} (fallback)`, spi: { ...detected, mode, bits: 8, cs: -1 } };
    }
  }
  for (const ch of active) {
    for (const baud of CAN_COMMON_BAUDS) {
      const frames = decodeCAN(samples, rate, ch, baud);
      if (frames.length * 5 > best.score) {
        best = { tab: "can", score: frames.length * 5, reason: `CAN ${baud.toLocaleString()} baud on D${ch} (fallback)`, can: { ch, baud } };
      }
    }
  }
  for (const ch of active) {
    const frames = decodeOneWire(samples, rate, ch);
    const score = frames.filter(f => f.type === "reset" || f.type === "presence").length;
    if (score > best.score) {
      best = { tab: "onewire", score, reason: `1-Wire on D${ch} (fallback)`, onewire: { ch } };
    }
  }
  for (const dio of active) {
    for (const clk of active) {
      if (dio === clk) continue;
      const frames = decodeSWD(samples, rate, dio, clk);
      const score = frames.filter(f => f.type === "reset").length * 2 + frames.filter(f => f.type === "request").length;
      if (score > best.score) {
        best = { tab: "swd", score, reason: `SWD D${dio}/D${clk} (fallback)`, swd: { swdio: dio, swclk: clk } };
      }
    }
  }
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
            best = { tab: "jtag", score, reason: `JTAG D${tck}/D${tms}/D${tdi}/D${tdo} (fallback)`, jtag: { tck, tms, tdi, tdo } };
          }
        }
      }
    }
  }
  for (const ch of active) {
    for (const baud of [9600, 19200, 38400, 57600, 115200]) {
      for (const parity of (["even", "none", "odd"] as const)) {
        const frames = decodeModbus(samples, rate, ch, baud, parity);
        const score = frames.filter(f => f.crcOk).length * 3;
        if (score > best.score) {
          best = { tab: "modbus", score, reason: `Modbus RTU ${baud.toLocaleString()} baud D${ch} (fallback)`, modbus: { ch, baud, parity } };
        }
      }
    }
  }
  for (const ch of active) {
    for (const baud of LIN_COMMON_BAUDS) {
      const frames = decodeLIN(samples, rate, ch, baud, "classic");
      const score = frames.filter(f => f.parityOk && f.checksumOk).length * 3;
      if (score > best.score) {
        best = { tab: "lin", score, reason: `LIN ${baud.toLocaleString()} baud D${ch} (fallback)`, lin: { ch, baud, checksum: "classic" } };
      }
    }
  }

  return best.score > 0 ? best : null;
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
