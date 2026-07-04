import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { UsbTransport } from "./UsbTransport";
import { WaveformLaLegacyView } from "./WaveformLaLegacyView";
import { LaCanvas } from "./LaCanvas";
import { LaOverview } from "./LaOverview";
import { CollapsibleSection } from "./CollapsibleSection";
import { ChannelsPanel } from "./ChannelsPanel";
import { AcquirePanel } from "./AcquirePanel";
import { LaCursorsPanel } from "./LaCursorsPanel";
import { LaDecodersPanel } from "./LaDecodersPanel";
import { LaTriggerPanel } from "./LaTriggerPanel";
import { loadChannels, saveChannels } from "./laChannelConfig";
import type { LaChannel } from "./laChannelConfig";
import type { LaAcquireMode } from "./laAcquireModes";
import type { LaTriggerConfig } from "./laAcquireModes";
import type { LaCapture, DecoderDefaults } from "./laDecoders";
import { inferDecoderDefaults, generateLaTestPattern, decodeUartChunk, decodeI2C, decodeSPI, decodeCAN, decodeOneWire, decodeSWD, decodeJTAG, decodeModbus } from "./laDecoders";
import { parseLaCsv, parseLaJson, detectLaFormat, parseSigrokSr } from "./laImport";
import { downloadLaCapture } from "./laExport";

interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

interface Cursor {
  sample: number;
  dragging: boolean;
}

// PR2 Phase 7 — DSO-style layout skeleton with Channels, Acquire, Trigger,
// Cursors, and bottom-docked Decoders panels. The acquire state machine is
// implemented and tested but not yet driving the live capture loop; that
// wiring is the next PR (live capture migration + data flow).
export function WaveformLaView(props: Props) {
  const [channels, setChannels] = useState<LaChannel[]>(loadChannels);
  const [sampleRate, setSampleRate] = useState(12_000_000);
  const [width, setWidth] = useState<8 | 16>(16);
  const [timebaseIdx, setTimebaseIdx] = useState(6);
  const [acquireMode, setAcquireMode] = useState<LaAcquireMode>("stopped");
  const [showCursors, setShowCursors] = useState(false);
  const [cursorA, setCursorA] = useState<Cursor>({ sample: 0, dragging: false });
  const [cursorB, setCursorB] = useState<Cursor>({ sample: 0, dragging: false });
  const [trigger, setTrigger] = useState<LaTriggerConfig>({ enabled: false, channel: 0, edge: "rise" });
  const [capture, setCapture] = useState<LaCapture | null>(null);
  const decoderDefaults = useMemo<DecoderDefaults>(() => inferDecoderDefaults(capture ?? {
    sampleRate: 12_000_000, width: 16, samples: new Uint8Array(0), source: "none", importedAt: new Date().toISOString(),
  }), [capture]);
  const [zoomSamples, setZoomSamples] = useState<number | null>(null);
  const [panSample, setPanSample] = useState(0);
  const [decoderState, setDecoderState] = useState({
    tab: decoderDefaults.tab,
    uart: decoderDefaults.uart,
    i2c: decoderDefaults.i2c,
    spi: decoderDefaults.spi,
    can: decoderDefaults.can,
    onewire: decoderDefaults.onewire,
    swd: decoderDefaults.swd,
    jtag: decoderDefaults.jtag,
    modbus: decoderDefaults.modbus,
  });
  useEffect(() => {
    setDecoderState({ tab: decoderDefaults.tab, uart: decoderDefaults.uart, i2c: decoderDefaults.i2c, spi: decoderDefaults.spi, can: decoderDefaults.can, onewire: decoderDefaults.onewire, swd: decoderDefaults.swd, jtag: decoderDefaults.jtag, modbus: decoderDefaults.modbus });
  }, [decoderDefaults]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChannelsChange = (next: LaChannel[]) => {
    saveChannels(next);
    setChannels(next);
  };

  const [useLegacy, setUseLegacy] = useState(false);

  const isRunning = acquireMode === "running" || acquireMode === "single-armed";
  const handleRun = useCallback(() => setAcquireMode("running"), []);
  const handleStop = useCallback(() => setAcquireMode("stopped"), []);
  const handleSingle = useCallback(() => setAcquireMode("single-armed"), []);

  const uartRows = useMemo(() => {
    if (!capture || decoderState.tab !== "uart" || !decoderState.uart) return [];
    return decodeUartChunk(capture.samples, capture.sampleRate, decoderState.uart.baud, decoderState.uart.ch);
  }, [capture, decoderState]);
  const i2cRows = useMemo(() => {
    if (!capture || decoderState.tab !== "i2c" || !decoderState.i2c) return [];
    return decodeI2C(capture.samples, capture.sampleRate, decoderState.i2c.scl, decoderState.i2c.sda);
  }, [capture, decoderState]);
  const spiRows = useMemo(() => {
    if (!capture || decoderState.tab !== "spi" || !decoderState.spi) return [];
    return decodeSPI(capture.samples, capture.sampleRate, decoderState.spi.mosi, decoderState.spi.miso, decoderState.spi.sck, decoderState.spi.cs, decoderState.spi.mode, decoderState.spi.bits, decoderState.spi.csActiveLow);
  }, [capture, decoderState]);
  const canRows = useMemo(() => {
    if (!capture || decoderState.tab !== "can" || !decoderState.can) return [];
    return decodeCAN(capture.samples, capture.sampleRate, decoderState.can.ch, decoderState.can.baud);
  }, [capture, decoderState]);
  const oneWireRows = useMemo(() => {
    if (!capture || decoderState.tab !== "onewire" || !decoderState.onewire) return [];
    return decodeOneWire(capture.samples, capture.sampleRate, decoderState.onewire.ch);
  }, [capture, decoderState]);
  const swdRows = useMemo(() => {
    if (!capture || decoderState.tab !== "swd" || !decoderState.swd) return [];
    return decodeSWD(capture.samples, capture.sampleRate, decoderState.swd.swdio, decoderState.swd.swclk);
  }, [capture, decoderState]);
  const jtagRows = useMemo(() => {
    if (!capture || decoderState.tab !== "jtag" || !decoderState.jtag) return [];
    return decodeJTAG(capture.samples, capture.sampleRate, decoderState.jtag.tck, decoderState.jtag.tms, decoderState.jtag.tdi, decoderState.jtag.tdo);
  }, [capture, decoderState]);
  const modbusRows = useMemo(() => {
    if (!capture || decoderState.tab !== "modbus" || !decoderState.modbus) return [];
    return decodeModbus(capture.samples, capture.sampleRate, decoderState.modbus.ch, decoderState.modbus.baud, decoderState.modbus.parity);
  }, [capture, decoderState]);

  const totalSamples = useMemo(() => Math.floor((capture?.samples.length ?? 0) / ((capture?.width ?? 8) === 16 ? 2 : 1)), [capture]);
  const handleZoomIn = useCallback(() => {
    const zoom = zoomSamples ?? totalSamples;
    setZoomSamples(Math.max(10, zoom * 0.8));
  }, [zoomSamples, totalSamples]);
  const handleZoomOut = useCallback(() => {
    const zoom = zoomSamples ?? totalSamples;
    const next = zoom * 1.25;
    setZoomSamples(next >= totalSamples ? null : next);
  }, [zoomSamples, totalSamples]);
  const handleFit = useCallback(() => {
    setZoomSamples(null);
    setPanSample(0);
  }, []);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const format = detectLaFormat(file.name, file.type);
    let loaded: LaCapture;
    if (format === "sigrok-sr") {
      const buf = await file.arrayBuffer();
      loaded = await parseSigrokSr(buf);
    } else if (format === "fob-json") {
      loaded = parseLaJson(await file.text());
    } else {
      loaded = parseLaCsv(await file.text()); // default CSV importer for .csv and unknown text
    }
    setCapture(loaded);
    setSampleRate(loaded.sampleRate);
    setWidth(loaded.width);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handlePattern = useCallback(() => {
    if (isRunning) return;
    const rate = 1_000_000;
    const samples = generateLaTestPattern(rate, 1);
    const loaded: LaCapture = {
      sampleRate: rate,
      width: 8,
      samples,
      source: "fob-pattern",
      importedAt: new Date().toISOString(),
      channelLabels: ["UART_TX", "I2C_SCL", "I2C_SDA", "SPI_MOSI", "SPI_MISO", "SPI_SCK", "SPI_CS"],
    };
    setCapture(loaded);
    setSampleRate(rate);
    setWidth(8);
  }, [isRunning]);

  const handleExport = useCallback(() => {
    if (!capture) return;
    downloadLaCapture(capture, `capture-${capture.sampleRate / 1e6}MHz-${capture.width}bit.csv`);
  }, [capture]);

  if (useLegacy) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-fob-border bg-fob-surface shrink-0">
          <span className="text-fob-text-dim text-xs">Legacy LA view</span>
          <div className="flex-1" />
          <button
            onClick={() => setUseLegacy(false)}
            className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border"
          >
            New view
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <WaveformLaLegacyView {...props} capture={capture} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-fob-surface text-fob-text font-mono text-xs select-none">
      {/* Acquire toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fob-border bg-fob-surface shrink-0">
        <button
          onClick={handleRun}
          disabled={!props.connected || isRunning}
          className={`px-3 py-1 rounded font-bold ${isRunning ? "bg-fob-surface text-fob-text-dim" : "bg-fob-green hover:bg-fob-green/80"}`}
        >
          Run
        </button>
        <button
          onClick={handleStop}
          disabled={!isRunning}
          className={`px-3 py-1 rounded font-bold ${isRunning ? "bg-fob-red hover:bg-fob-red/80" : "bg-fob-surface text-fob-text-dim"}`}
        >
          Stop
        </button>
        <button
          onClick={handleSingle}
          disabled={!props.connected || isRunning}
          className="px-3 py-1 rounded font-bold bg-fob-orange hover:bg-fob-orange/80 disabled:bg-fob-surface disabled:text-fob-text-dim"
        >
          Single
        </button>
        <span className="text-fob-text-dim">{acquireMode}</span>
        {capture && (
          <span className="text-fob-text-dim">
            {capture.samples.length.toLocaleString()} samples @ {(capture.sampleRate / 1e6).toFixed(1)} MHz
          </span>
        )}
        <div className="flex-1" />
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,.sr"
          onChange={handleImport}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border"
        >
          Import
        </button>
        <button
          onClick={handleExport}
          disabled={!capture}
          className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border disabled:text-fob-text-dim"
        >
          Export
        </button>
        <button
          onClick={handlePattern}
          disabled={isRunning}
          className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border disabled:text-fob-text-dim"
          title="Load synthetic UART/I2C/SPI capture"
        >
          Pattern
        </button>
        <button
          onClick={() => setUseLegacy(true)}
          className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border"
        >
          Legacy
        </button>
      </div>

      {/* Main area: canvas + right panel */}
      <div className="flex flex-1 gap-1 overflow-hidden min-h-0">
        <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-1">
          {/* Canvas toolbar */}
          <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border border-fob-border rounded text-xs shrink-0">
            <span className="text-fob-text-dim">Waveform</span>
            <div className="flex-1" />
            <button onClick={handleFit} disabled={!capture} className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border disabled:text-fob-text-dim" title="Fit entire capture">Fit</button>
            <button onClick={handleZoomOut} disabled={!capture} className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border disabled:text-fob-text-dim" title="Zoom out">−</button>
            <button onClick={handleZoomIn} disabled={!capture} className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border disabled:text-fob-text-dim" title="Zoom in">+</button>
            <span className="text-fob-text-dim w-24 text-right">{capture ? `${(zoomSamples ?? totalSamples).toLocaleString()} smp` : "—"}</span>
          </div>
          {/* Main waveform canvas with decoder annotations */}
          <div className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0 min-w-0 select-none">
            {capture && capture.samples.length > 0 ? (
              <LaCanvas
                samples={capture.samples}
                sampleRate={capture.sampleRate}
                width={capture.width}
                channels={channels}
                zoomSamples={zoomSamples}
                panSample={panSample}
                decoderTab={decoderState.tab}
                decoderRows={uartRows}
                i2cRows={i2cRows}
                spiRows={spiRows}
                canRows={canRows}
                oneWireRows={oneWireRows}
                swdRows={swdRows}
                jtagRows={jtagRows}
                modbusRows={modbusRows}
                decoderChannel={decoderState.uart?.ch}
                decoderSda={decoderState.i2c?.sda}
                decoderMosi={decoderState.spi?.mosi}
                decoderCan={decoderState.can?.ch}
                decoderOneWire={decoderState.onewire?.ch}
                decoderSwd={decoderState.swd}
                decoderJtag={decoderState.jtag}
                decoderModbus={decoderState.modbus}
                showCursors={showCursors}
                cursorA={cursorA.sample}
                cursorB={cursorB.sample}
                onPanChange={setPanSample}
                onZoomChange={setZoomSamples}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-fob-text-dim text-xs">
                Import a capture or click Pattern to load a signal.
              </div>
            )}
          </div>
          {/* Viewport overview / minimap */}
          {capture && capture.samples.length > 0 && (
            <LaOverview
              samples={capture.samples}
              width={capture.width}
              channels={channels}
              zoomSamples={zoomSamples}
              panSample={panSample}
              totalSamples={totalSamples}
              onPanChange={setPanSample}
            />
          )}
          {/* Bottom decoders panel */}
          <div className="h-40 rounded border border-fob-border overflow-hidden bg-fob-surface shrink-0 min-w-0">
            <LaDecodersPanel
              capture={capture}
              sampleRate={sampleRate}
              running={isRunning}
              suggestedTab={decoderDefaults.tab}
              defaultUart={decoderDefaults.uart}
              defaultI2c={decoderDefaults.i2c}
              defaultSpi={decoderDefaults.spi}
              defaultCan={decoderDefaults.can}
              defaultOneWire={decoderDefaults.onewire}
              defaultSwd={decoderDefaults.swd}
              defaultJtag={decoderDefaults.jtag}
              defaultModbus={decoderDefaults.modbus}
              onChange={setDecoderState}
            />
          </div>
        </div>

        {/* Right panel */}
        <div className="w-72 flex flex-col gap-2 shrink-0 overflow-y-auto text-[11px] px-1 py-1">
          <CollapsibleSection title="Channels">
            <ChannelsPanel channels={channels} onChange={handleChannelsChange} />
          </CollapsibleSection>
          <CollapsibleSection title="Acquire">
            <AcquirePanel
              sampleRate={sampleRate}
              width={width}
              timebaseIdx={timebaseIdx}
              onSampleRateChange={setSampleRate}
              onWidthChange={setWidth}
              onTimebaseChange={setTimebaseIdx}
            />
          </CollapsibleSection>
          <CollapsibleSection title="Trigger">
            <LaTriggerPanel trigger={trigger} onChange={setTrigger} disabled={false} />
          </CollapsibleSection>
          <CollapsibleSection title="Cursors">
            <LaCursorsPanel
              enabled={showCursors}
              onToggle={setShowCursors}
              cursorA={cursorA}
              cursorB={cursorB}
              onCursorAChange={setCursorA}
              onCursorBChange={setCursorB}
              totalSamples={capture?.samples.length ?? 0}
            />
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}
