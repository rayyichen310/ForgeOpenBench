import { useState, useMemo, useEffect, useCallback } from "react";
import { decodeUartChunk, decodeI2C, decodeSPI, decodeCAN, decodeOneWire, decodeSWD, decodeJTAG, autoDetectLaProtocol, MAX_TICKER } from "./laDecoders";
import type { DecoderTab, LaCapture, AutoDetectResult } from "./laDecoders";
import { DEFAULT_BAUDS } from "./laChannelConfig";

interface UartConfig { baud: number; ch: number; }
interface I2cConfig { scl: number; sda: number; addrBits: 7 | 8; }
interface SpiConfig { mosi: number; miso: number; sck: number; cs: number; mode: 0 | 1 | 2 | 3; bits: 8 | 16; csActiveLow: boolean; }
interface CanConfig { ch: number; baud: number; }
interface OneWireConfig { ch: number; }
interface SwdConfig { swdio: number; swclk: number; }
interface JtagConfig { tck: number; tms: number; tdi: number; tdo: number; }

interface Props {
  frozenBuf?: Uint8Array | null;
  sampleRate?: number;
  capture?: LaCapture | null;
  running: boolean;
  defaultUart?: UartConfig;
  defaultI2c?: I2cConfig;
  defaultSpi?: SpiConfig;
  defaultCan?: CanConfig;
  defaultOneWire?: OneWireConfig;
  defaultSwd?: SwdConfig;
  defaultJtag?: JtagConfig;
  suggestedTab?: DecoderTab;
  onChange?: (state: { tab: DecoderTab; uart: UartConfig; i2c: I2cConfig; spi: SpiConfig; can: CanConfig; onewire: OneWireConfig; swd: SwdConfig; jtag: JtagConfig }) => void;
}

function ascii(b: number) {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
}

function fmt(ts: number) {
  return ts < 1e-3 ? `${(ts * 1e6).toFixed(0)}µs` : `${(ts * 1e3).toFixed(2)}ms`;
}

export function LaDecodersPanel({ frozenBuf, sampleRate, capture, running, defaultUart, defaultI2c, defaultSpi, defaultCan, defaultOneWire, defaultSwd, defaultJtag, suggestedTab, onChange }: Props) {
  const effectiveBuf = capture?.samples ?? frozenBuf ?? null;
  const effectiveRate = capture?.sampleRate ?? sampleRate ?? 0;
  const [tab, setTab] = useState<DecoderTab>(suggestedTab ?? "uart");
  const [uart, setUart] = useState<UartConfig>(defaultUart ?? { baud: 115200, ch: 0 });
  const [i2c, setI2c] = useState<I2cConfig>(defaultI2c ?? { scl: 1, sda: 2, addrBits: 7 });
  const [spi, setSpi] = useState<SpiConfig>(defaultSpi ?? { mosi: 3, miso: 4, sck: 5, cs: 6, mode: 0, bits: 8, csActiveLow: true });
  const [can, setCan] = useState<CanConfig>(defaultCan ?? { ch: 0, baud: 500000 });
  const [onewire, setOneWire] = useState<OneWireConfig>(defaultOneWire ?? { ch: 0 });
  const [swd, setSwd] = useState<SwdConfig>(defaultSwd ?? { swdio: 1, swclk: 0 });
  const [jtag, setJtag] = useState<JtagConfig>(defaultJtag ?? { tck: 0, tms: 1, tdi: 2, tdo: 3 });
  const [lastAutoDetect, setLastAutoDetect] = useState<AutoDetectResult | null>(null);

  useEffect(() => {
    if (suggestedTab) setTab(suggestedTab);
  }, [suggestedTab]);
  useEffect(() => { if (defaultUart) setUart(defaultUart); }, [defaultUart]);
  useEffect(() => { if (defaultI2c) setI2c(defaultI2c); }, [defaultI2c]);
  useEffect(() => { if (defaultSpi) setSpi(defaultSpi); }, [defaultSpi]);
  useEffect(() => { if (defaultCan) setCan(defaultCan); }, [defaultCan]);
  useEffect(() => { if (defaultOneWire) setOneWire(defaultOneWire); }, [defaultOneWire]);
  useEffect(() => { if (defaultSwd) setSwd(defaultSwd); }, [defaultSwd]);
  useEffect(() => { if (defaultJtag) setJtag(defaultJtag); }, [defaultJtag]);
  useEffect(() => { onChange?.({ tab, uart, i2c, spi, can, onewire, swd, jtag }); }, [tab, uart, i2c, spi, can, onewire, swd, jtag, onChange]);

  const handleAutoDetect = useCallback(() => {
    if (!effectiveBuf || effectiveBuf.length === 0 || effectiveRate <= 0) return;
    const cap = capture ?? { samples: effectiveBuf, sampleRate: effectiveRate, width: 8, source: "live", importedAt: new Date().toISOString() };
    const result = autoDetectLaProtocol(cap);
    setLastAutoDetect(result);
    setTab(result.tab);
    if (result.uart) setUart(result.uart);
    if (result.i2c) setI2c(result.i2c);
    if (result.spi) setSpi(s => ({ ...result.spi!, csActiveLow: s.csActiveLow }));
    if (result.can) setCan(result.can);
    if (result.onewire) setOneWire(result.onewire);
    if (result.swd) setSwd(result.swd);
    if (result.jtag) setJtag(result.jtag);
  }, [effectiveBuf, effectiveRate, capture]);

  const uartRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeUartChunk(effectiveBuf, effectiveRate, uart.baud, uart.ch).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, uart]);

  const i2cRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeI2C(effectiveBuf, effectiveRate, i2c.scl, i2c.sda).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, i2c]);

  const spiRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeSPI(effectiveBuf, effectiveRate, spi.mosi, spi.miso, spi.sck, spi.cs, spi.mode, spi.bits, spi.csActiveLow).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, spi]);

  const canRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeCAN(effectiveBuf, effectiveRate, can.ch, can.baud).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, can]);

  const oneWireRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeOneWire(effectiveBuf, effectiveRate, onewire.ch).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, onewire]);

  const swdRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeSWD(effectiveBuf, effectiveRate, swd.swdio, swd.swclk).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, swd]);

  const jtagRows = useMemo(() => {
    if (!effectiveBuf || effectiveBuf.length === 0) return [];
    return decodeJTAG(effectiveBuf, effectiveRate, jtag.tck, jtag.tms, jtag.tdi, jtag.tdo).slice(0, MAX_TICKER);
  }, [effectiveBuf, effectiveRate, jtag]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tabs */}
      <div className="flex items-center gap-1 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0">
        {(["uart", "i2c", "spi", "can", "onewire", "swd", "jtag"] as DecoderTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2 py-0.5 rounded font-bold uppercase ${tab === t ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface hover:bg-fob-border text-fob-text-dim"}`}
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

      {/* UART */}
      {tab === "uart" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">Baud:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
              value={uart.baud} onChange={e => setUart(c => ({ ...c, baud: Number(e.target.value) }))}>
              {DEFAULT_BAUDS.map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
            </select>
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={uart.ch} onChange={e => setUart(c => ({ ...c, ch: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {uartRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? `Listening on D${uart.ch} @ ${uart.baud.toLocaleString()} baud...` : "Load a capture or pattern to decode UART"}
              </div>
            ) : (
              uartRows.map((r, i) => (
                <div key={i} className={`flex gap-3 leading-5 ${r.error ? "text-fob-red" : "text-fob-text"}`}>
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className="text-fob-text-dim w-6 shrink-0">D{uart.ch}</span>
                  <span className="font-bold w-14 shrink-0 text-fob-yellow">0x{r.byte.toString(16).padStart(2, "0").toUpperCase()}</span>
                  <span className="w-8 shrink-0">{r.byte}</span>
                  <span className="text-fob-green w-6 shrink-0">{ascii(r.byte)}</span>
                  {r.error && <span className="text-fob-red">⚠ framing</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* I2C */}
      {tab === "i2c" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">SCL:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={i2c.scl} onChange={e => setI2c(c => ({ ...c, scl: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">SDA:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={i2c.sda} onChange={e => setI2c(c => ({ ...c, sda: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Addr:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
              value={i2c.addrBits} onChange={e => setI2c(c => ({ ...c, addrBits: Number(e.target.value) as 7 | 8 }))}>
              <option value={7}>7-bit</option>
              <option value={8}>8-bit</option>
            </select>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {i2cRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? "Stop capture to decode I2C" : "No I2C frames — check SCL/SDA channels"}
              </div>
            ) : (
              i2cRows.map((r, i) => (
                <div key={i} className="flex gap-3 leading-5 text-fob-text">
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className={`w-20 shrink-0 ${r.type === "start" || r.type === "repeated-start" ? "text-fob-green" : r.type === "stop" ? "text-fob-red" : r.type === "ack" ? "text-fob-green" : r.type === "nack" ? "text-fob-red" : "text-fob-yellow"}`}>
                    {r.type === "byte" && r.addr !== undefined ? `ADDR ${r.addr.toString(16).padStart(2, "0").toUpperCase()}${r.rw === "read" ? "R" : "W"}`
                      : r.type === "byte" ? `DATA 0x${r.data?.toString(16).padStart(2, "0").toUpperCase() ?? "--"}`
                      : r.type.toUpperCase()}
                  </span>
                  {r.type === "byte" && r.data !== undefined && <span className="text-fob-text-dim">0x{r.data.toString(16).padStart(2, "0").toUpperCase()} {r.data}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* SPI */}
      {tab === "spi" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">MOSI:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={spi.mosi} onChange={e => setSpi(c => ({ ...c, mosi: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">MISO:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={spi.miso} onChange={e => setSpi(c => ({ ...c, miso: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">SCK:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={spi.sck} onChange={e => setSpi(c => ({ ...c, sck: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">CS:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={spi.cs} onChange={e => setSpi(c => ({ ...c, cs: Number(e.target.value) }))}>
              <option value={-1}>None</option>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Mode:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
              value={spi.mode} onChange={e => setSpi(c => ({ ...c, mode: Number(e.target.value) as 0 | 1 | 2 | 3 }))}>
              {[0, 1, 2, 3].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-fob-text-dim">Bits:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
              value={spi.bits} onChange={e => setSpi(c => ({ ...c, bits: Number(e.target.value) as 8 | 16 }))}>
              <option value={8}>8</option>
              <option value={16}>16</option>
            </select>
            <label className="flex items-center gap-1 text-fob-text-dim cursor-pointer">
              <input type="checkbox" checked={spi.csActiveLow} onChange={e => setSpi(c => ({ ...c, csActiveLow: e.target.checked }))} />
              CS active low
            </label>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {spiRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? "Stop capture to decode SPI" : "No SPI frames — check channel assignments and mode"}
              </div>
            ) : (
              spiRows.map((r, i) => (
                <div key={i} className="flex gap-3 leading-5 text-fob-text">
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className="text-fob-blue shrink-0">MOSI 0x{r.mosi?.toString(16).padStart(spi.bits / 4, "0").toUpperCase() ?? "--"}</span>
                  <span className="text-fob-green shrink-0">MISO 0x{r.miso?.toString(16).padStart(spi.bits / 4, "0").toUpperCase() ?? "--"}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* CAN */}
      {tab === "can" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={can.ch} onChange={e => setCan(c => ({ ...c, ch: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">Baud:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
              value={can.baud} onChange={e => setCan(c => ({ ...c, baud: Number(e.target.value) }))}>
              {[125000, 250000, 500000, 800000, 1000000].map(b => <option key={b} value={b}>{(b / 1000).toFixed(0)}k</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {canRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? "Stop capture to decode CAN" : "No CAN frames — check channel and baud rate"}
              </div>
            ) : (
              canRows.map((r, i) => (
                <div key={i} className={`flex gap-3 leading-5 ${r.error ? "text-fob-red" : "text-fob-text"}`}>
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className="text-fob-blue shrink-0">{r.extended ? "Ext" : "Std"}</span>
                  <span className="text-fob-yellow shrink-0">ID 0x{r.id.toString(16).toUpperCase()}</span>
                  <span className="text-fob-text-dim shrink-0">DLC {r.dlc}</span>
                  <span className="text-fob-green shrink-0">{r.data.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}</span>
                  {r.error && <span className="text-fob-red">⚠</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 1-Wire */}
      {tab === "onewire" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">CH:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={onewire.ch} onChange={e => setOneWire(c => ({ ...c, ch: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {oneWireRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? "Stop capture to decode 1-Wire" : "No 1-Wire traffic — check channel"}
              </div>
            ) : (
              oneWireRows.map((r, i) => (
                <div key={i} className="flex gap-3 leading-5 text-fob-text">
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className="text-fob-blue shrink-0">{r.type.toUpperCase()}</span>
                  {r.value !== undefined && r.type === "byte" && (
                    <span className="text-fob-green shrink-0">0x{r.value.toString(16).padStart(2, "0").toUpperCase()}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* SWD */}
      {tab === "swd" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">DIO:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={swd.swdio} onChange={e => setSwd(c => ({ ...c, swdio: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">CLK:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={swd.swclk} onChange={e => setSwd(c => ({ ...c, swclk: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {swdRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? "Stop capture to decode SWD" : "No SWD traffic — check DIO/CLK channels"}
              </div>
            ) : (
              swdRows.map((r, i) => (
                <div key={i} className="flex gap-3 leading-5 text-fob-text">
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className="text-fob-blue shrink-0">{r.type.toUpperCase()}</span>
                  {r.type === "request" && (
                    <>
                      <span className="text-fob-yellow shrink-0">{r.read ? "R" : "W"}</span>
                      <span className="text-fob-text-dim shrink-0">{r.apnDp === 1 ? "AP" : "DP"}</span>
                      <span className="text-fob-green shrink-0">0x{r.addr!.toString(16).toUpperCase()}</span>
                    </>
                  )}
                  {r.type === "data" && r.data !== undefined && (
                    <span className="text-fob-green shrink-0">0x{r.data.toString(16).padStart(8, "0").toUpperCase()}</span>
                  )}
                  {r.ok === false && <span className="text-fob-red">⚠</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* JTAG */}
      {tab === "jtag" && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
            <span className="text-fob-text-dim">TCK:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={jtag.tck} onChange={e => setJtag(c => ({ ...c, tck: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">TMS:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={jtag.tms} onChange={e => setJtag(c => ({ ...c, tms: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">TDI:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={jtag.tdi} onChange={e => setJtag(c => ({ ...c, tdi: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
            <span className="text-fob-text-dim">TDO:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
              value={jtag.tdo} onChange={e => setJtag(c => ({ ...c, tdo: Number(e.target.value) }))}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
            {jtagRows.length === 0 ? (
              <div className="text-fob-text-dim text-center mt-4">
                {running ? "Stop capture to decode JTAG" : "No JTAG traffic — check TCK/TMS/TDI/TDO channels"}
              </div>
            ) : (
              jtagRows.map((r, i) => (
                <div key={i} className="flex gap-3 leading-5 text-fob-text">
                  <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                  <span className="text-fob-blue shrink-0">{r.type.toUpperCase()}</span>
                  {r.type === "state" && <span className="text-fob-yellow shrink-0">{r.state}</span>}
                  {r.type === "shift" && (
                    <>
                      <span className="text-fob-text-dim shrink-0">{r.register}</span>
                      <span className="text-fob-yellow shrink-0">TDI 0x{r.tdi!.toString(16).padStart(Math.ceil((r.bits ?? 1) / 4), "0").toUpperCase()}</span>
                      <span className="text-fob-green shrink-0">TDO 0x{r.tdo!.toString(16).padStart(Math.ceil((r.bits ?? 1) / 4), "0").toUpperCase()}</span>
                      <span className="text-fob-text-dim shrink-0">({r.bits} bits)</span>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
