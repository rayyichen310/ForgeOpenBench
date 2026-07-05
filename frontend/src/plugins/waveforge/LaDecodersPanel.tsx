import { useState, useMemo, useEffect, useCallback } from "react";
import { autoDetectLaProtocol } from "./laDecoders";
import type { DecoderTab, LaCapture, AutoDetectResult, TickerRow, I2CFrame, SPIFrame, CANFrame, OneWireFrame, SWDFrame, JTAGFrame, ModbusFrame } from "./laDecoders";
import { DEFAULT_BAUDS, DEFAULT_LABEL_WIDTH } from "./laChannelConfig";

interface UartConfig { baud: number; ch: number; }
interface I2cConfig { scl: number; sda: number; addrBits: 7 | 8; }
interface SpiConfig { mosi: number; miso: number; sck: number; cs: number; mode: 0 | 1 | 2 | 3; bits: 8 | 16; csActiveLow: boolean; }
interface CanConfig { ch: number; baud: number; }
interface OneWireConfig { ch: number; }
interface SwdConfig { swdio: number; swclk: number; }
interface JtagConfig { tck: number; tms: number; tdi: number; tdo: number; }
interface ModbusConfig { ch: number; baud: number; parity: "none" | "even" | "odd"; }

interface Props {
  frozenBuf?: Uint8Array | null;
  sampleRate?: number;
  capture?: LaCapture | null;
  panSample?: number;
  zoomSamples?: number | null;
  running: boolean;
  tab: DecoderTab;
  defaultUart?: UartConfig;
  defaultI2c?: I2cConfig;
  defaultSpi?: SpiConfig;
  defaultCan?: CanConfig;
  defaultOneWire?: OneWireConfig;
  defaultSwd?: SwdConfig;
  defaultJtag?: JtagConfig;
  defaultModbus?: ModbusConfig;
  uartRows?: TickerRow[];
  i2cRows?: I2CFrame[];
  spiRows?: SPIFrame[];
  canRows?: CANFrame[];
  oneWireRows?: OneWireFrame[];
  swdRows?: SWDFrame[];
  jtagRows?: JTAGFrame[];
  modbusRows?: ModbusFrame[];
  onChange?: (state: { tab: DecoderTab; uart: UartConfig; i2c: I2cConfig; spi: SpiConfig; can: CanConfig; onewire: OneWireConfig; swd: SwdConfig; jtag: JtagConfig; modbus: ModbusConfig }) => void;
  onPacketClick?: (sample: number) => void;
  onFrameNavigate?: (direction: "next" | "previous") => void;
}

interface TicketItem { sample: number; endSample: number; label: string; error: boolean; bitSamples?: number; }

export function LaDecodersPanel({ frozenBuf, sampleRate, capture, panSample, zoomSamples, running, tab, defaultUart, defaultI2c, defaultSpi, defaultCan, defaultOneWire, defaultSwd, defaultJtag, defaultModbus, uartRows, i2cRows, spiRows, canRows, oneWireRows, swdRows, jtagRows, modbusRows, onChange, onPacketClick, onFrameNavigate }: Props) {
  const [debouncedCapture, setDebouncedCapture] = useState(capture);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedCapture(capture), 150);
    return () => clearTimeout(id);
  }, [capture]);
  const effectiveBuf = debouncedCapture?.samples ?? frozenBuf ?? null;
  const effectiveRate = debouncedCapture?.sampleRate ?? sampleRate ?? 0;
  const [uart, setUart] = useState<UartConfig>(defaultUart ?? { baud: 115200, ch: 0 });
  const [i2c, setI2c] = useState<I2cConfig>(defaultI2c ?? { scl: 1, sda: 2, addrBits: 7 });
  const [spi, setSpi] = useState<SpiConfig>(defaultSpi ?? { mosi: 3, miso: 4, sck: 5, cs: 6, mode: 0, bits: 8, csActiveLow: true });
  const [can, setCan] = useState<CanConfig>(defaultCan ?? { ch: 0, baud: 500000 });
  const [onewire, setOneWire] = useState<OneWireConfig>(defaultOneWire ?? { ch: 0 });
  const [swd, setSwd] = useState<SwdConfig>(defaultSwd ?? { swdio: 1, swclk: 0 });
  const [jtag, setJtag] = useState<JtagConfig>(defaultJtag ?? { tck: 0, tms: 1, tdi: 2, tdo: 3 });
  const [modbus, setModbus] = useState<ModbusConfig>(defaultModbus ?? { ch: 0, baud: 9600, parity: "even" });
  const [lastAutoDetect, setLastAutoDetect] = useState<AutoDetectResult | null>(null);

  useEffect(() => { if (defaultUart) setUart(defaultUart); }, [defaultUart]);
  useEffect(() => { if (defaultI2c) setI2c(defaultI2c); }, [defaultI2c]);
  useEffect(() => { if (defaultSpi) setSpi(defaultSpi); }, [defaultSpi]);
  useEffect(() => { if (defaultCan) setCan(defaultCan); }, [defaultCan]);
  useEffect(() => { if (defaultOneWire) setOneWire(defaultOneWire); }, [defaultOneWire]);
  useEffect(() => { if (defaultSwd) setSwd(defaultSwd); }, [defaultSwd]);
  useEffect(() => { if (defaultJtag) setJtag(defaultJtag); }, [defaultJtag]);
  useEffect(() => { if (defaultModbus) setModbus(defaultModbus); }, [defaultModbus]);

  const handleChange = useCallback((patch: Partial<{ tab: DecoderTab; uart: UartConfig; i2c: I2cConfig; spi: SpiConfig; can: CanConfig; onewire: OneWireConfig; swd: SwdConfig; jtag: JtagConfig; modbus: ModbusConfig }>) => {
    onChange?.({ tab: patch.tab ?? tab, uart: patch.uart ?? uart, i2c: patch.i2c ?? i2c, spi: patch.spi ?? spi, can: patch.can ?? can, onewire: patch.onewire ?? onewire, swd: patch.swd ?? swd, jtag: patch.jtag ?? jtag, modbus: patch.modbus ?? modbus });
  }, [onChange, tab, uart, i2c, spi, can, onewire, swd, jtag, modbus]);

  const handleAutoDetect = useCallback(() => {
    if (!effectiveBuf || effectiveBuf.length === 0 || effectiveRate <= 0) return;
    const cap = capture ?? { samples: effectiveBuf, sampleRate: effectiveRate, width: 8, source: "live", importedAt: new Date().toISOString() };
    const result = autoDetectLaProtocol(cap);
    setLastAutoDetect(result);
    const patch: Partial<{ tab: DecoderTab; uart: UartConfig; i2c: I2cConfig; spi: SpiConfig; can: CanConfig; onewire: OneWireConfig; swd: SwdConfig; jtag: JtagConfig; modbus: ModbusConfig }> = { tab: result.tab };
    if (result.uart) patch.uart = result.uart;
    if (result.i2c) patch.i2c = result.i2c;
    if (result.spi) patch.spi = { ...result.spi, csActiveLow: spi.csActiveLow };
    if (result.can) patch.can = result.can;
    if (result.onewire) patch.onewire = result.onewire;
    if (result.swd) patch.swd = result.swd;
    if (result.jtag) patch.jtag = result.jtag;
    if (result.modbus) patch.modbus = result.modbus;
    handleChange(patch);
  }, [effectiveBuf, effectiveRate, capture, handleChange, spi.csActiveLow]);

  const stripRows = useMemo<TicketItem[]>(() => {
    const pan = panSample ?? 0;
    const bps = (capture?.width ?? 8) === 16 ? 2 : 1;
    const range = zoomSamples ?? (capture ? Math.floor(capture.samples.length / bps) : 0);
    const start = pan;
    const end = pan + range;
    const items: TicketItem[] = [];
    const clamp = (s: number) => Math.max(start, Math.min(s, end));
    if (tab === "uart" && uartRows) {
      uartRows.forEach(r => items.push({ sample: clamp(r.sample), endSample: clamp(r.endSample), label: `0x${r.byte.toString(16).padStart(2, "0").toUpperCase()}`, error: r.error, bitSamples: r.bitSamples }));
    } else if (tab === "i2c" && i2cRows) {
      i2cRows.forEach(r => {
        let label = "";
        if (r.type === "start") label = "START";
        else if (r.type === "repeated-start") label = "R-START";
        else if (r.type === "stop") label = "STOP";
        else if (r.type === "byte" && r.addr !== undefined) label = `A${r.addr.toString(16).padStart(2, "0")}${r.rw === "read" ? "R" : "W"}`;
        else if (r.type === "byte" && r.data !== undefined) label = `0x${r.data.toString(16).padStart(2, "0")}`;
        else if (r.type === "ack") label = "ACK";
        else if (r.type === "nack") label = "NACK";
        items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label, error: r.type === "nack", bitSamples: r.bitSamples });
      });
    } else if (tab === "spi" && spiRows) {
      const digits = 8 / 4;
      spiRows.forEach(r => {
        const parts: string[] = [];
        if (r.mosi !== undefined) parts.push(`M0x${r.mosi.toString(16).padStart(digits, "0").toUpperCase()}`);
        if (r.miso !== undefined) parts.push(`S0x${r.miso.toString(16).padStart(digits, "0").toUpperCase()}`);
        const label = parts.join(" ");
        items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label, error: false, bitSamples: r.bitSamples });
      });
    } else if (tab === "can" && canRows) {
      canRows.forEach(r => items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label: `${r.extended ? "Ext" : "Std"} ID 0x${r.id.toString(16).toUpperCase()}`, error: !!r.error, bitSamples: r.bitSamples }));
    } else if (tab === "onewire" && oneWireRows) {
      oneWireRows.forEach(r => {
        let label = "";
        if (r.type === "reset") label = "RST";
        else if (r.type === "presence") label = "PRES";
        else if (r.type === "byte" && r.value !== undefined) label = `0x${r.value.toString(16).padStart(2, "0").toUpperCase()}`;
        items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label, error: false, bitSamples: r.bitSamples });
      });
    } else if (tab === "swd" && swdRows) {
      swdRows.forEach(r => {
        let label = "";
        if (r.type === "reset") label = "RST";
        else if (r.type === "request") label = `${r.read ? "R" : "W"}${r.apnDp === 1 ? "AP" : "DP"} 0x${r.addr!.toString(16)}`;
        else if (r.type === "data" && r.data !== undefined) label = `0x${r.data.toString(16).padStart(8, "0").toUpperCase()}`;
        items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label, error: r.type === "data" && r.ok === false, bitSamples: r.bitSamples });
      });
    } else if (tab === "jtag" && jtagRows) {
      jtagRows.forEach(r => {
        let label = "";
        if (r.type === "reset") label = "RST";
        else if (r.type === "state") label = r.state ?? "";
        else if (r.type === "shift" && r.tdi !== undefined) label = `${r.register} 0x${r.tdi.toString(16).padStart(Math.ceil((r.bits ?? 1) / 4), "0").toUpperCase()}`;
        items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label, error: false, bitSamples: r.bitSamples });
      });
    } else if (tab === "modbus" && modbusRows) {
      modbusRows.forEach(r => items.push({ sample: clamp(r.startSample), endSample: clamp(r.endSample), label: `A${r.addr} F${r.func.toString(16).padStart(2, "0").toUpperCase()}`, error: !r.crcOk, bitSamples: r.bitSamples }));
    }
    return items.filter(r => r.endSample > start && r.sample < end);
  }, [tab, uartRows, i2cRows, spiRows, canRows, oneWireRows, swdRows, jtagRows, modbusRows, panSample, zoomSamples, capture]);

  const jsx = (
    <div className="flex flex-col h-full min-h-0">
      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0">
        {(["uart", "i2c", "spi", "can", "onewire", "swd", "jtag", "modbus"] as DecoderTab[]).map(t => (
          <button
            key={t}
            onClick={() => handleChange({ tab: t })} 
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border whitespace-nowrap transition-colors ${tab === t ? "bg-fob-orange text-fob-accent-text border-fob-orange" : "bg-fob-surface border-fob-border hover:bg-fob-border text-fob-text-dim"}`}
          >
            {t}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={handleAutoDetect}
          disabled={!effectiveBuf || effectiveBuf.length === 0 || effectiveRate <= 0}
          className="px-2 py-0.5 rounded bg-fob-blue text-fob-accent-text hover:bg-fob-blue/80 disabled:bg-fob-surface disabled:text-fob-text-dim"
          title="Auto-detect protocol, channels, and baud"
        >
          Auto
        </button>
      </div>
      {lastAutoDetect && (
        <div className="px-2 py-0.5 text-[10px] text-fob-text-dim border-b border-fob-border bg-fob-surface shrink-0">
          Auto-detect: {lastAutoDetect.reason} (score {lastAutoDetect.score})
        </div>
      )}

      {/* Control bar */}
      <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
        {tab === "uart" && (
          <>
            <span className="text-fob-text-dim">Baud:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5" value={uart.baud} onChange={e => { const next = { ...uart, baud: Number(e.target.value) }; setUart(next); handleChange({ uart: next }); }}>
              {DEFAULT_BAUDS.map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
            </select>
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={uart.ch} onChange={e => { const next = { ...uart, ch: Number(e.target.value) }; setUart(next); handleChange({ uart: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </>
        )}
        {tab === "i2c" && (
          <>
            <span className="text-fob-text-dim">SCL:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={i2c.scl} onChange={e => { const next = { ...i2c, scl: Number(e.target.value) }; setI2c(next); handleChange({ i2c: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">SDA:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={i2c.sda} onChange={e => { const next = { ...i2c, sda: Number(e.target.value) }; setI2c(next); handleChange({ i2c: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Addr:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5" value={i2c.addrBits} onChange={e => { const next = { ...i2c, addrBits: Number(e.target.value) as 7 | 8 }; setI2c(next); handleChange({ i2c: next }); }}>
              <option value={7}>7-bit</option>
              <option value={8}>8-bit</option>
            </select>
            <button className="px-2 py-0.5 rounded border border-fob-border bg-fob-surface hover:bg-fob-border disabled:opacity-40" onClick={() => onFrameNavigate?.("previous")} disabled={!onFrameNavigate}>← Prev</button>
            <button className="px-2 py-0.5 rounded border border-fob-border bg-fob-surface hover:bg-fob-border disabled:opacity-40" onClick={() => onFrameNavigate?.("next")} disabled={!onFrameNavigate}>Next →</button>
          </>
        )}
        {tab === "spi" && (
          <>
            <span className="text-fob-text-dim">MOSI:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={spi.mosi} onChange={e => { const next = { ...spi, mosi: Number(e.target.value) }; setSpi(next); handleChange({ spi: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">MISO:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={spi.miso} onChange={e => { const next = { ...spi, miso: Number(e.target.value) }; setSpi(next); handleChange({ spi: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">SCK:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={spi.sck} onChange={e => { const next = { ...spi, sck: Number(e.target.value) }; setSpi(next); handleChange({ spi: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">CS:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={spi.cs} onChange={e => { const next = { ...spi, cs: Number(e.target.value) }; setSpi(next); handleChange({ spi: next }); }}>
              <option value={-1}>None</option>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Mode:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5" value={spi.mode} onChange={e => { const next = { ...spi, mode: Number(e.target.value) as 0 | 1 | 2 | 3 }; setSpi(next); handleChange({ spi: next }); }}>
              {[0, 1, 2, 3].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-fob-text-dim">Bits:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5" value={spi.bits} onChange={e => { const next = { ...spi, bits: Number(e.target.value) as 8 | 16 }; setSpi(next); handleChange({ spi: next }); }}>
              <option value={8}>8</option>
              <option value={16}>16</option>
            </select>
            <label className="flex items-center gap-1 text-fob-text-dim cursor-pointer">
              <input type="checkbox" checked={spi.csActiveLow} onChange={e => { const next = { ...spi, csActiveLow: e.target.checked }; setSpi(next); handleChange({ spi: next }); }} />
              CS active low
            </label>
          </>
        )}
        {tab === "can" && (
          <>
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={can.ch} onChange={e => { const next = { ...can, ch: Number(e.target.value) }; setCan(next); handleChange({ can: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Baud:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5" value={can.baud} onChange={e => { const next = { ...can, baud: Number(e.target.value) }; setCan(next); handleChange({ can: next }); }}>
              {[125000, 250000, 500000, 800000, 1000000].map(b => <option key={b} value={b}>{(b / 1000).toFixed(0)}k</option>)}
            </select>
          </>
        )}
        {tab === "onewire" && (
          <>
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={onewire.ch} onChange={e => { const next = { ...onewire, ch: Number(e.target.value) }; setOneWire(next); handleChange({ onewire: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </>
        )}
        {tab === "swd" && (
          <>
            <span className="text-fob-text-dim">DIO:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={swd.swdio} onChange={e => { const next = { ...swd, swdio: Number(e.target.value) }; setSwd(next); handleChange({ swd: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">CLK:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={swd.swclk} onChange={e => { const next = { ...swd, swclk: Number(e.target.value) }; setSwd(next); handleChange({ swd: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </>
        )}
        {tab === "jtag" && (
          <>
            <span className="text-fob-text-dim">TCK:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={jtag.tck} onChange={e => { const next = { ...jtag, tck: Number(e.target.value) }; setJtag(next); handleChange({ jtag: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">TMS:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={jtag.tms} onChange={e => { const next = { ...jtag, tms: Number(e.target.value) }; setJtag(next); handleChange({ jtag: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">TDI:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={jtag.tdi} onChange={e => { const next = { ...jtag, tdi: Number(e.target.value) }; setJtag(next); handleChange({ jtag: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">TDO:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={jtag.tdo} onChange={e => { const next = { ...jtag, tdo: Number(e.target.value) }; setJtag(next); handleChange({ jtag: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </>
        )}
        {tab === "modbus" && (
          <>
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14" value={modbus.ch} onChange={e => { const next = { ...modbus, ch: Number(e.target.value) }; setModbus(next); handleChange({ modbus: next }); }}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Baud:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-20" value={modbus.baud} onChange={e => { const next = { ...modbus, baud: Number(e.target.value) }; setModbus(next); handleChange({ modbus: next }); }}>
              {[9600, 19200, 38400, 57600, 115200].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <span className="text-fob-text-dim">Parity:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-16" value={modbus.parity} onChange={e => { const next = { ...modbus, parity: e.target.value as "none" | "even" | "odd" }; setModbus(next); handleChange({ modbus: next }); }}>
              <option value="even">Even</option>
              <option value="odd">Odd</option>
              <option value="none">None</option>
            </select>
          </>
        )}
      </div>

      {/* Ticket strip */}
      <div className="flex-1 relative overflow-hidden bg-fob-bg" style={{ paddingLeft: DEFAULT_LABEL_WIDTH }}>
        {stripRows.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-fob-text-dim text-xs text-center px-4">
            {running ? (
              <>Listening for {tab.toUpperCase()} traffic...</>
            ) : capture ? (
              <>No {tab.toUpperCase()} events in this view — zoom out or pan to find traffic</>
            ) : (
              <>Load a capture or pattern to decode {tab.toUpperCase()}</>
            )}
          </div>
        ) : (
          <div className="absolute inset-0">
            {stripRows.map((r, i) => {
              const start = panSample ?? 0;
              const bps = (capture?.width ?? 8) === 16 ? 2 : 1;
              const range = zoomSamples ?? (capture ? Math.floor(capture.samples.length / bps) : 0);
              if (range <= 0) return null;
              const left = ((r.sample - start) / range) * 100;
              const sr = capture?.sampleRate ?? sampleRate ?? 0;
              // Clock-aware minimum: at least 2 bit periods if the decoder measured one, else 25ms fallback.
              const fallbackMinSamples = sr > 0 ? (sr * 25) / 1000 : 0;
              const minSamples = r.bitSamples && r.bitSamples > 0 ? r.bitSamples * 2 : fallbackMinSamples;
              const nextStart = stripRows[i + 1]?.sample ?? (start + range);
              const widthSamples = Math.min(Math.max(r.endSample - r.sample, minSamples), Math.max(1, nextStart - r.sample));
              const width = Math.max((widthSamples / range) * 100, 1.5);
              return (
                <button
                  key={i}
                  className={`absolute top-1/2 -translate-y-1/2 px-1 py-0.5 rounded text-[10px] font-mono border truncate transition-colors z-0 hover:z-10 ${r.error ? "bg-fob-red/10 border-fob-red text-fob-red" : "bg-fob-surface border-fob-border text-fob-text hover:border-fob-text-dim"}`}
                  style={{ left: `${left}%`, width: `${width}%`, minWidth: "40px" }}
                  onClick={() => onPacketClick?.(r.sample)}
                  title={r.label}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return jsx;
}
