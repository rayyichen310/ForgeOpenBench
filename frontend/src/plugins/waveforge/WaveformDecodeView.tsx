import { useState, useEffect, useRef, useCallback } from "react";
import type { UsbTransport } from "./UsbTransport";
import type { UsbDataChunk } from "./usbTypes";
import { decodeUartChunk, makeFakeUartSignal } from "./laDecoders";
import type { TickerRow } from "./laDecoders";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UartFrame {
  startSample: number;
  byte: number;
  parityOk: boolean | null;
  error: boolean;
}

interface DecodeResult {
  frames: UartFrame[];
  sampleRate: number;
}

function buildDecodeResult(
  samples: Uint8Array,
  sampleRate: number,
  baud: number,
  channel: number,
  dataBits: number,
  parity: "none" | "even" | "odd",
  stopBits: number,
  invertLogic: boolean,
): DecodeResult {
  const rows = decodeUartChunk(samples, sampleRate, baud, channel, 0, dataBits, parity, stopBits, invertLogic);
  return {
    sampleRate,
    frames: rows.map((r: TickerRow) => ({
      startSample: r.sample,
      byte: r.byte,
      parityOk: r.parityOk ?? null,
      error: r.error,
    })),
  };
}

function makeFakeUartSignalCompat(
  text: string,
  sampleRate: number,
  baud: number,
  channel: number,
  parity: "none" | "even" | "odd",
  stopBits: number,
): { samples: Uint8Array; sampleRate: number } {
  return makeFakeUartSignal(text, sampleRate, baud, channel, parity, stopBits);
}


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BAUDS = [110, 300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

export function WaveformDecodeView({ transport, isActive, connected }: Props) {
  const [baud,       setBaud]     = useState(115200);
  const [channel,    setChannel]  = useState(0);
  const [dataBits,   setDataBits] = useState(8);
  const [parity,     setParity]   = useState<"none"|"even"|"odd">("none");
  const [stopBits,   setStopBits] = useState(1);
  const [invertLogic,setInvert]   = useState(false);
  const [fakeText,   setFakeText] = useState("Hello FOB!");
  const [result,     setResult]   = useState<DecodeResult | null>(null);
  const [source,     setSource]   = useState<"live" | "fake">("fake");
  const [status,     setStatus]   = useState("Run fake signal to test");
  const [statusErr,  setStatusErr] = useState(false);
  const [capturing,  setCapturing] = useState(false);
  const [captureSec, setCaptureSec] = useState(1);

  const liveBufRef = useRef<Uint8Array>(new Uint8Array(0));
  const liveRateRef = useRef(0);

  // When tab becomes active, refresh status with current buffer state
  useEffect(() => {
    if (!isActive) return;
    if (liveBufRef.current.length > 0) {
      setStatus(`Ready — ${liveBufRef.current.length.toLocaleString()} samples buffered @ ${(liveRateRef.current/1e6).toFixed(1)} MS/s`);
    }
  }, [isActive]);

  // Collect live LA data — always active so Logic tab captures feed this buffer
  useEffect(() => {
    const off = transport.onData((chunk: UsbDataChunk) => {
      if (chunk.mode !== "la") return;
      const bytes = Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
      const merged = new Uint8Array(liveBufRef.current.length + bytes.length);
      merged.set(liveBufRef.current);
      merged.set(bytes, liveBufRef.current.length);
      liveBufRef.current = merged.slice(-1_000_000);  // keep last 1M samples
      liveRateRef.current = chunk.rate;
      if (isActive) {
        setStatus(`Buffered ${liveBufRef.current.length.toLocaleString()} samples @ ${(chunk.rate/1e6).toFixed(1)} MS/s`);
      }
    });
    return off;
  }, [transport, isActive]);

  const runDecode = useCallback(() => {
    let samples: Uint8Array;
    let sampleRate: number;

    if (source === "fake") {
      const gen = makeFakeUartSignalCompat(fakeText, baud * 16, baud, channel, parity, stopBits);
      samples = gen.samples;
      sampleRate = gen.sampleRate;
    } else {
      if (!liveBufRef.current.length) { setStatus("No live data captured yet — run Logic first"); return; }
      samples = liveBufRef.current;
      sampleRate = liveRateRef.current;
    }

    const r = buildDecodeResult(samples, sampleRate, baud, channel, dataBits, parity, stopBits, invertLogic);
    setResult(r);
    setStatus(r.frames.length
      ? `Decoded ${r.frames.length} frame${r.frames.length !== 1 ? "s" : ""}`
      : "No frames found — check baud rate and channel");
  }, [source, fakeText, baud, channel, dataBits, parity, stopBits, invertLogic]);

  const captureAndDecode = useCallback(async () => {
    if (capturing) return;
    if (!connected) { setStatus("No device connected — connect a device in Logic mode first"); setStatusErr(true); return; }
    if (transport.deviceInfo?.mode !== "la") { setStatus("Device is in Scope mode — switch to Logic mode (release H/P button, reconnect)"); setStatusErr(true); return; }
    setStatusErr(false);
    setCapturing(true);
    setStatus("Configuring capture...");
    liveBufRef.current = new Uint8Array(0);
    try {
      await transport.configure({ mode: "la", sample_rate_hz: Math.max(baud * 16, 1_000_000), sample_width: 8 });
      await transport.start();
      setStatus(`Capturing for ${captureSec}s...`);
      await new Promise(r => setTimeout(r, captureSec * 1000));
      await transport.stop();
      setStatus(`Captured ${liveBufRef.current.length.toLocaleString()} samples — decoding...`);
      await new Promise(r => setTimeout(r, 100));  // let last chunks arrive
      if (!liveBufRef.current.length) { setStatus("Capture ran but no data arrived — device may not be sending"); setStatusErr(true); return; }
      const r = buildDecodeResult(liveBufRef.current, liveRateRef.current, baud, channel, dataBits, parity, stopBits, invertLogic);
      setResult(r);
      setStatusErr(r.frames.length === 0);
      setStatus(r.frames.length
        ? `${r.frames.length} frame${r.frames.length !== 1 ? "s" : ""} decoded from ${liveBufRef.current.length.toLocaleString()} samples`
        : `No UART frames detected on D${channel} at ${baud.toLocaleString()} baud — check channel and baud rate`);
    } catch (e) {
      setStatus(`Capture failed: ${(e as Error).message}`);
      setStatusErr(true);
    } finally {
      setCapturing(false);
    }
  }, [capturing, connected, transport, baud, captureSec, channel, dataBits, parity, stopBits, invertLogic]);

  const clearResult = () => { setResult(null); liveBufRef.current = new Uint8Array(0); setStatus("Cleared"); setStatusErr(false); };

  const ascii = (b: number) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".";

  return (
    <div className="flex flex-col h-full gap-0 font-mono text-xs select-none">

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-fob-border bg-fob-surface">
        {/* Protocol (locked to UART for now) */}
        <span className="text-fob-text-dim">Protocol:</span>
        <span className="text-fob-orange font-bold">UART</span>

        <span className="text-fob-text/20">|</span>

        <span className="text-fob-text-dim">Baud:</span>
        <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
          value={baud} onChange={e => setBaud(Number(e.target.value))}>
          {BAUDS.map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
        </select>

        <span className="text-fob-text-dim">CH:</span>
        <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-12"
          value={channel} onChange={e => setChannel(Number(e.target.value))}>
          {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
        </select>

        <span className="text-fob-text-dim">Data:</span>
        <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-10"
          value={dataBits} onChange={e => setDataBits(Number(e.target.value))}>
          <option value={7}>7</option><option value={8}>8</option>
        </select>

        <span className="text-fob-text-dim">Parity:</span>
        <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
          value={parity} onChange={e => setParity(e.target.value as typeof parity)}>
          <option value="none">None</option>
          <option value="even">Even</option>
          <option value="odd">Odd</option>
        </select>

        <span className="text-fob-text-dim">Stop:</span>
        <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-10"
          value={stopBits} onChange={e => setStopBits(Number(e.target.value))}>
          <option value={1}>1</option><option value={2}>2</option>
        </select>

        <label className="flex items-center gap-1 text-fob-text-dim cursor-pointer">
          <input type="checkbox" checked={invertLogic} onChange={e => setInvert(e.target.checked)} />
          Inv
        </label>
      </div>

      {/* Source + fake text */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-fob-border bg-fob-surface">
        <span className="text-fob-text-dim">Source:</span>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="radio" checked={source === "fake"} onChange={() => setSource("fake")} />
          <span className={source === "fake" ? "text-fob-orange" : "text-fob-text-dim"}>Fake signal</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="radio" checked={source === "live"} onChange={() => setSource("live")} />
          <span className={source === "live" ? "text-fob-orange" : "text-fob-text-dim"}>Live capture</span>
        </label>

        {source === "fake" && (
          <>
            <span className="text-fob-text-dim">Text:</span>
            <input
              className="bg-fob-surface border border-fob-border rounded px-2 py-0.5 w-40"
              value={fakeText}
              onChange={e => setFakeText(e.target.value)}
              placeholder="Hello FOB!"
              maxLength={64}
            />
          </>
        )}

        <div className="flex-1" />
        {source === "live" && (
          <>
            <span className="text-fob-text-dim">Duration:</span>
            <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-16"
              value={captureSec} onChange={e => setCaptureSec(Number(e.target.value))}>
              <option value={0.5}>0.5s</option>
              <option value={1}>1s</option>
              <option value={2}>2s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
            </select>
            <button onClick={captureAndDecode} disabled={capturing}
              className={`px-3 py-1 rounded font-bold ${
                capturing ? "bg-fob-surface text-fob-text-dim cursor-wait" : "bg-fob-green hover:bg-fob-green/80"
              }`}>
              {capturing ? "Capturing..." : "Capture & Decode"}
            </button>
          </>
        )}
        {source === "fake" && (
          <button onClick={runDecode} disabled={capturing}
            className="px-3 py-1 rounded bg-fob-orange hover:bg-fob-orange/80 font-bold disabled:opacity-40">
            Decode
          </button>
        )}
        <button onClick={clearResult} disabled={capturing}
          className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border disabled:opacity-40">
          Clear
        </button>
      </div>

      {/* Status bar */}
      <div className={`px-3 py-1 border-b border-fob-border ${statusErr ? "text-fob-red" : "text-fob-text-dim"}`}>{status}</div>

      {/* Results */}
      <div className="flex-1 overflow-auto px-3 py-2">
        {!result || result.frames.length === 0 ? (
          <div className="text-fob-text-dim text-center mt-8">
            {source === "fake"
              ? "Enter text above and click Decode to test"
              : "Capture Logic data first, then click Decode"}
          </div>
        ) : (
          <>
            {/* ASCII string view */}
            <div className="mb-3 p-2 rounded bg-fob-surface border border-fob-border">
              <span className="text-fob-text-dim mr-2">ASCII:</span>
              <span className="text-fob-green tracking-wider">
                {result.frames.map(f => ascii(f.byte)).join("")}
              </span>
            </div>

            {/* Frame table */}
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-fob-text-dim text-left border-b border-fob-border">
                  <th className="pb-1 pr-4">#</th>
                  <th className="pb-1 pr-4">Sample</th>
                  <th className="pb-1 pr-4">Hex</th>
                  <th className="pb-1 pr-4">Dec</th>
                  <th className="pb-1 pr-4">Bin</th>
                  <th className="pb-1 pr-4">ASCII</th>
                  {parity !== "none" && <th className="pb-1 pr-4">Parity</th>}
                  <th className="pb-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.frames.map((f, i) => (
                  <tr key={i}
                    className={`border-b border-fob-border/20 ${f.error ? "text-fob-red" : f.parityOk === false ? "text-fob-orange" : "text-fob-text"}`}>
                    <td className="py-0.5 pr-4 text-fob-text-dim">{i}</td>
                    <td className="py-0.5 pr-4 text-fob-text-dim">{f.startSample}</td>
                    <td className="py-0.5 pr-4 font-bold">0x{f.byte.toString(16).padStart(2, "0").toUpperCase()}</td>
                    <td className="py-0.5 pr-4">{f.byte}</td>
                    <td className="py-0.5 pr-4 text-fob-text">{f.byte.toString(2).padStart(8, "0")}</td>
                    <td className="py-0.5 pr-4 text-fob-green">{ascii(f.byte)}</td>
                    {parity !== "none" && (
                      <td className="py-0.5 pr-4">{f.parityOk ? "✓" : "✗"}</td>
                    )}
                    <td className="py-0.5">
                      {f.error ? "⚠ framing" : f.parityOk === false ? "⚠ parity" : "✓ OK"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Hex dump */}
            <div className="mt-3 p-2 rounded bg-fob-surface border border-fob-border">
              <span className="text-fob-text-dim mr-2">Hex:</span>
              <span className="text-fob-orange tracking-widest">
                {result.frames.map(f => f.byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
