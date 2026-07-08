import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { IUsbTransport } from "./UsbTransport";
import { MockUsbTransport } from "./MockUsbTransport";
import { WaveformLaLegacyView } from "./WaveformLaLegacyView";
import { LaCanvas } from "./LaCanvas";
import { LaOverview } from "./LaOverview";
import { CollapsibleSection } from "./CollapsibleSection";
import { ChannelsPanel } from "./ChannelsPanel";
import { LaDecodersPanel } from "./LaDecodersPanel";
import { loadChannels, saveChannels } from "./laChannelConfig";
import type { LaChannel } from "./laChannelConfig";
import type { LaAcquireMode, LaAcquireResult, LaTriggerConfig } from "./laAcquireModes";
import { handleLaAcquireMode } from "./laAcquireModes";
import type { LaCapture, DecoderDefaults } from "./laDecoders";
import { inferDecoderDefaults, generateLaTestPattern, decodeUartChunk, decodeI2C, decodeSPI, decodeCAN, decodeOneWire, decodeSWD, decodeJTAG, decodeModbus, decodeLIN, findNearestUartFrame, findNearestI2CFrame, findNearestSpiFrame, findNearestCanFrame, findNearestOneWireFrame, findNearestSwdFrame, findNearestJtagFrame, findNearestModbusFrame, findNearestLinFrame } from "./laDecoders";
import { parseLaCsv, parseLaJson, detectLaFormat, streamSigrokSr } from "./laImport";
import { downloadLaCapture } from "./laExport";
import { LaHistoryBuffer, type LaCaptureMeta } from "./LaHistoryBuffer";
import { IncrementalClassifier, type ClassificationUpdate } from "./IncrementalClassifier";

interface Props {
  transport: IUsbTransport;
  isActive: boolean;
  connected: boolean;
}

interface Cursor {
  sample: number;
  dragging: boolean;
}

/** Scan samples and return which channels have at least one transition.
 *  Uses per-bit OR/AND over the whole buffer so it is O(samples) instead of O(samples * channels).
 */
function computeActiveChannels(
  samples: Uint8Array,
  width: number,
  bps: number,
  active: Set<number> = new Set(),
  orBits = 0,
  andBits = 0xffff
): { active: Set<number>; orBits: number; andBits: number } {
  let or = orBits;
  let and = andBits;
  if (bps === 2) {
    for (let i = 0; i < samples.length; i += 2) {
      const v = (samples[i + 1] << 8) | samples[i];
      or |= v;
      and &= v;
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      or |= v;
      and &= v;
    }
  }
  for (let ch = 0; ch < width; ch++) {
    if (active.has(ch)) continue;
    const mask = 1 << ch;
    const hasHigh = (or & mask) !== 0;
    const hasLow = (and & mask) === 0;
    if (hasHigh && hasLow) active.add(ch);
  }
  return { active, orBits: or, andBits: and };
}

function applyChannelVisibility(
  channels: LaChannel[],
  width: number,
  active: Set<number>,
  channelLabels?: string[]
): LaChannel[] {
  return channels.map(ch => ({
    ...ch,
    label: channelLabels?.[ch.id] ?? ch.label,
    visible: ch.id < width && active.has(ch.id),
    enabled: ch.id < width && active.has(ch.id),
  }));
}

// PR2 Phase 7 — DSO-style layout skeleton with Channels, Acquire, Trigger,
// Cursors, and bottom-docked Decoders panels. The acquire state machine is
// implemented and tested but not yet driving the live capture loop; that
// wiring is the next PR (live capture migration + data flow).
export function WaveformLaView(props: Props) {
  const [channels, setChannels] = useState<LaChannel[]>(loadChannels);
  const [sampleRate, setSampleRate] = useState(12_000_000);
  const width: 8 | 16 = 16; // future: width selector
  const [retentionBytes, setRetentionBytes] = useState(512 * 1024 * 1024); // 512 MB default
  const [acquireMode, setAcquireMode] = useState<LaAcquireMode>("stopped");
  const [showCursors, setShowCursors] = useState(false);
  const [cursorA, setCursorA] = useState<Cursor>({ sample: 0, dragging: false });
  const [cursorB, setCursorB] = useState<Cursor>({ sample: 0, dragging: false });
  const [trigger, setTrigger] = useState<LaTriggerConfig>({ enabled: false, channel: 0, edge: "rise" });
  const [zoomSamples, setZoomSamples] = useState<number | null>(null);
  const [panSample, setPanSample] = useState(0);
  const handlePacketClick = (sample: number) => {
    if (!captureMeta) return;
    const total = captureMeta.totalSamples;
    const currentZoom = zoomSamples ?? total;
    const targetZoom = Math.min(Math.max(currentZoom, 200), total);
    setZoomSamples(targetZoom === total ? null : targetZoom);
    setPanSample(Math.max(0, Math.min(sample - targetZoom / 2, total - targetZoom)));
  };

  // ── Time Machine: persistent chunked history buffer ──
  const historyRef = useRef(new LaHistoryBuffer());
  const fullCaptureRef = useRef<LaCapture | null>(null);
  const paddedBufferRef = useRef<{ captureId: string; samples: Uint8Array; paddedStartSample: number } | null>(null);
  const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
  const [captureMeta, setCaptureMeta] = useState<LaCaptureMeta | null>(null);
  const [windowedCapture, setWindowedCapture] = useState<LaCapture | null>(null);
  const [probeCapture, setProbeCapture] = useState<LaCapture | null>(null);
  const probeCaptureRef = useRef<LaCapture | null>(null);
  useEffect(() => { probeCaptureRef.current = probeCapture; }, [probeCapture]);

  // Live capture bookkeeping
  const activeTransportRef = useRef<IUsbTransport>(props.transport);
  const simTransportRef = useRef<IUsbTransport>(new MockUsbTransport());
  const liveCaptureIdRef = useRef<string | null>(null);
  const dataOffRef = useRef<(() => void) | null>(null);
  const stoppedOffRef = useRef<(() => void) | null>(null);
  const lastWriteRef = useRef<Promise<void>>(Promise.resolve());
  const liveTotalSamplesRef = useRef(0);
  const singleArmedAtRef = useRef(0);
  const followTailRef = useRef(false);
  const acquireModeRef = useRef<LaAcquireMode>(acquireMode);
  const liveOverviewRef = useRef<Uint8Array | null>(null);
  const liveOverviewStrideRef = useRef(1);
  const liveOverviewWriteRef = useRef(0);
  const liveTailRef = useRef<Uint8Array | null>(null);
  const liveTailStartRef = useRef(0);
  const liveTailWriteRef = useRef(0);
  const liveTailMaxSamplesRef = useRef(2_000_000);
  const [, setLiveOverviewTick] = useState(0);
  const classifierRef = useRef<IncrementalClassifier | null>(null);
  const lastProtocolRef = useRef<string>("");
  const [liveClassification, setLiveClassification] = useState<ClassificationUpdate | null>(null);
  useEffect(() => { acquireModeRef.current = acquireMode; }, [acquireMode]);

  const IN_MEMORY_THRESHOLD = 50 * 1024 * 1024; // 50 MB — slice synchronously, skip IndexedDB on pan/zoom
  const PADDING_FACTOR = 1.0; // 1× zoomSamples extra on each side for scroll buffer

  useEffect(() => {
    historyRef.current.init().catch(console.error);
  }, []);

  // Load visible window whenever capture or viewport changes
  useEffect(() => {
    if (!activeCaptureId || !captureMeta) {
      setWindowedCapture(null);
      fullCaptureRef.current = null;
      paddedBufferRef.current = null;
      return;
    }
    const total = Math.max(captureMeta.totalSamples, liveTotalSamplesRef.current);
    const zoom = zoomSamples ?? total;
    const pan = Math.max(0, Math.min(panSample, Math.max(total - zoom, 0)));
    const bps = captureMeta.width === 16 ? 2 : 1;

    // Fast path 0: live capture — slice from in-memory rolling tail buffer.
    const tail = liveTailRef.current;
    if (isRunning && tail && tail.length > 0) {
      const tailStart = liveTailStartRef.current;
      const validBytes = liveTailWriteRef.current;
      const tailSamples = validBytes / bps;
      const tailEnd = tailStart + tailSamples;
      if (pan + zoom <= tailEnd && pan >= tailStart) {
        const startByte = Math.round((pan - tailStart) * bps);
        const endByte = Math.min(startByte + Math.round(zoom * bps), validBytes);
        setWindowedCapture({
          sampleRate: captureMeta.sampleRate,
          width: captureMeta.width,
          samples: tail.subarray(startByte, endByte),
          source: captureMeta.source,
          importedAt: captureMeta.importedAt,
          channelLabels: captureMeta.channelLabels,
        });
        return;
      }
    }

    // Fast path 1: small captures stay in memory, slice synchronously
    const full = fullCaptureRef.current;
    if (full && full.samples.length <= IN_MEMORY_THRESHOLD) {
      const startByte = Math.round(pan * bps);
      const endByte = Math.min(Math.round((pan + zoom) * bps), total * bps);
      setWindowedCapture({
        sampleRate: captureMeta.sampleRate,
        width: captureMeta.width,
        samples: full.samples.subarray(startByte, endByte),
        source: captureMeta.source,
        importedAt: captureMeta.importedAt,
        channelLabels: captureMeta.channelLabels,
      });
      return;
    }

    // Fast path 2: viewport lies inside already-loaded padded buffer → slice synchronously
    const padded = paddedBufferRef.current;
    if (
      padded &&
      padded.captureId === activeCaptureId &&
      pan >= padded.paddedStartSample &&
      pan + zoom <= padded.paddedStartSample + Math.floor(padded.samples.length / bps)
    ) {
      const startByte = Math.round((pan - padded.paddedStartSample) * bps);
      const endByte = startByte + Math.round(zoom * bps);
      setWindowedCapture({
        sampleRate: captureMeta.sampleRate,
        width: captureMeta.width,
        samples: padded.samples.subarray(startByte, endByte),
        source: captureMeta.source,
        importedAt: captureMeta.importedAt,
        channelLabels: captureMeta.channelLabels,
      });
      return;
    }

    // Slow path: load padded window from IndexedDB
    let cancelled = false;
    historyRef.current.getWindow(activeCaptureId, pan, zoom, PADDING_FACTOR).then((samples) => {
      if (cancelled) return;
      const padSamples = PADDING_FACTOR > 0 ? Math.floor(zoom * PADDING_FACTOR) : 0;
      const paddedStart = Math.max(0, pan - padSamples);
      paddedBufferRef.current = { captureId: activeCaptureId, samples, paddedStartSample: paddedStart };
      const visibleStartByte = Math.round((pan - paddedStart) * bps);
      const visibleEndByte = visibleStartByte + Math.round(zoom * bps);
      setWindowedCapture({
        sampleRate: captureMeta.sampleRate,
        width: captureMeta.width,
        samples: samples.subarray(visibleStartByte, visibleEndByte),
        source: captureMeta.source,
        importedAt: captureMeta.importedAt,
        channelLabels: captureMeta.channelLabels,
      });
    }).catch((e) => {
      if (cancelled) return;
      console.error("[WaveformLaView] getWindow failed", e);
      setWindowedCapture(null);
      paddedBufferRef.current = null;
    });
    return () => { cancelled = true; };
  }, [activeCaptureId, captureMeta, panSample, zoomSamples]);

  // Load probe for auto-detect whenever capture changes (skipped during live capture)
  const liveActive = acquireMode === "running" || acquireMode === "single-armed";
  useEffect(() => {
    if (!activeCaptureId || !captureMeta || liveActive) {
      if (liveActive) return; // keep existing probe during live capture
      setProbeCapture(null);
      return;
    }
    let cancelled = false;
    historyRef.current.getProbe(activeCaptureId).then((samples) => {
      if (cancelled) return;
      setProbeCapture({
        sampleRate: captureMeta.sampleRate,
        width: captureMeta.width,
        samples,
        source: captureMeta.source,
        importedAt: captureMeta.importedAt,
        channelLabels: captureMeta.channelLabels,
      });
    }).catch((e) => {
      if (cancelled) return;
      console.error("[WaveformLaView] getProbe failed", e);
      setProbeCapture(null);
    });
    return () => { cancelled = true; };
  }, [activeCaptureId, captureMeta, liveActive]);

  const decoderDefaults = useMemo<DecoderDefaults>(() => {
    const probe = probeCapture ?? {
      sampleRate: 12_000_000, width: 16, samples: new Uint8Array(0), source: "none", importedAt: new Date().toISOString(),
    };
    return inferDecoderDefaults(probe);
  }, [probeCapture]);
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
    lin: decoderDefaults.lin,
  });
  useEffect(() => {
    setDecoderState({ tab: decoderDefaults.tab, uart: decoderDefaults.uart, i2c: decoderDefaults.i2c, spi: decoderDefaults.spi, can: decoderDefaults.can, onewire: decoderDefaults.onewire, swd: decoderDefaults.swd, jtag: decoderDefaults.jtag, modbus: decoderDefaults.modbus, lin: decoderDefaults.lin });
  }, [decoderDefaults]);

  const handleFrameNavigate = useCallback(async (direction: "next" | "previous") => {
    if (!activeCaptureId || !captureMeta) return;
    const total = captureMeta.totalSamples;
    const centerSample = panSample + (zoomSamples ?? total) / 2;
    const getWindow = (start: number, count: number) => historyRef.current.getWindow(activeCaptureId, start, count, 0);
    const { sampleRate } = captureMeta;
    let result: Awaited<ReturnType<typeof findNearestI2CFrame>> = null;
    const { tab } = decoderState;
    if (tab === "uart" && decoderState.uart) {
      result = await findNearestUartFrame(getWindow, sampleRate, decoderState.uart, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "i2c" && decoderState.i2c) {
      result = await findNearestI2CFrame(getWindow, sampleRate, decoderState.i2c, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "spi" && decoderState.spi) {
      result = await findNearestSpiFrame(getWindow, sampleRate, decoderState.spi, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "can" && decoderState.can) {
      result = await findNearestCanFrame(getWindow, sampleRate, decoderState.can, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "onewire" && decoderState.onewire) {
      result = await findNearestOneWireFrame(getWindow, sampleRate, decoderState.onewire, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "swd" && decoderState.swd) {
      result = await findNearestSwdFrame(getWindow, sampleRate, decoderState.swd, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "jtag" && decoderState.jtag) {
      result = await findNearestJtagFrame(getWindow, sampleRate, decoderState.jtag, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "modbus" && decoderState.modbus) {
      result = await findNearestModbusFrame(getWindow, sampleRate, decoderState.modbus, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    } else if (tab === "lin" && decoderState.lin) {
      result = await findNearestLinFrame(getWindow, sampleRate, decoderState.lin, centerSample, direction, { windowSize: 100_000, maxWindows: 20 });
    }
    if (result) handlePacketClick(result.startSample);
  }, [activeCaptureId, captureMeta, decoderState, panSample, zoomSamples]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mouseSampleRef = useRef(0);
  const loadGenerationRef = useRef(0);

  const handleChannelsChange = (next: LaChannel[]) => {
    saveChannels(next);
    setChannels(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (!captureMeta) return;
      const total = captureMeta.totalSamples;
      const zoom = zoomSamples ?? total;
      const pan = panSample;
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setShowCursors(true);
        const sample = mouseSampleRef.current;
        setCursorA(prev => ({ ...prev, sample }));
      } else if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        setShowCursors(true);
        const sample = mouseSampleRef.current;
        setCursorB(prev => ({ ...prev, sample }));
      } else if (e.key === "Escape") {
        setShowCursors(false);
      } else if (e.key === "0") {
        e.preventDefault();
        setZoomSamples(null);
        setPanSample(0);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoomSamples(Math.round(Math.max(10, zoom * 0.8)));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        const next = Math.round(zoom * 1.25);
        setZoomSamples(next >= total ? null : next);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const step = Math.max(1, Math.floor(zoom * 0.1));
        setPanSample(Math.max(0, pan - step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const step = Math.max(1, Math.floor(zoom * 0.1));
        setPanSample(Math.min(Math.max(0, total - zoom), pan + step));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureMeta, zoomSamples, panSample]);

  const [useLegacy, setUseLegacy] = useState(false);

  const isRunning = acquireMode === "running" || acquireMode === "single-armed";

  const handleStop = useCallback(async () => {
    dataOffRef.current?.();
    dataOffRef.current = null;
    stoppedOffRef.current?.();
    stoppedOffRef.current = null;
    followTailRef.current = false;
    const id = liveCaptureIdRef.current;
    if (id) {
      try { await activeTransportRef.current.stop(); } catch { /* already stopped */ }
      await lastWriteRef.current.catch(() => {});
      try { await historyRef.current.finalizeCapture(id); } catch (e) { console.error("[WaveformLaView] finalize failed", e); }
      const meta = await historyRef.current.getMeta(id);
      if (meta) setCaptureMeta(meta);
      // Load full capture into memory so overview timeline renders after stop.
      if (meta && meta.totalSamples <= 2_000_000) {
        const fullSamples = await historyRef.current.getWindow(id, 0, meta.totalSamples);
        fullCaptureRef.current = {
          sampleRate: meta.sampleRate,
          width: meta.width,
          samples: fullSamples,
          source: meta.source,
          importedAt: meta.importedAt,
          channelLabels: meta.channelLabels,
        };
      }
      liveCaptureIdRef.current = null;
      liveTailRef.current = null;
      liveTailStartRef.current = 0;
      liveTailWriteRef.current = 0;
      liveOverviewWriteRef.current = 0;
      // Zoom to full capture so user sees the whole pattern.
      setZoomSamples(null);
      setPanSample(0);
    }
    setAcquireMode("stopped");
  }, []);

  const startLiveCapture = useCallback(async (mode: "running" | "single-armed", transport: IUsbTransport = props.transport) => {
    if (isRunning) return;
    await handleStop();
    activeTransportRef.current = transport;
    setAcquireMode(mode);
    followTailRef.current = true;
    liveTotalSamplesRef.current = 0;
    singleArmedAtRef.current = 0;
    lastWriteRef.current = Promise.resolve();
    liveOverviewRef.current = null;
    liveOverviewWriteRef.current = 0;
    liveTailRef.current = null;
    liveTailStartRef.current = 0;
    liveTailWriteRef.current = 0;
    setLiveClassification(null);
    try {
      await transport.configure({ mode: "la", sample_rate_hz: sampleRate, sample_width: width });
      const effectiveRate = transport.effectiveSampleRate ?? sampleRate;
      const effectiveWidth = transport.effectiveWidth ?? width;
      const effectiveBps = effectiveWidth === 16 ? 2 : 1;
      const effectiveLabels = transport.effectiveChannelLabels ?? channels.map(c => c.label);
      classifierRef.current = new IncrementalClassifier(effectiveWidth, effectiveRate);
      lastProtocolRef.current = "";
      const id = await historyRef.current.createCapture({
        sampleRate: effectiveRate,
        width: effectiveWidth,
        source: "live",
        importedAt: new Date().toISOString(),
        channelLabels: effectiveLabels,
        chunkSize: 100_000,
        bps: effectiveBps,
        retentionBytes,
      });
      liveCaptureIdRef.current = id;
      setActiveCaptureId(id);
      // Clear stale view and zoom to show the full pattern (like Pattern button).
      fullCaptureRef.current = null;
      paddedBufferRef.current = null;
      setWindowedCapture(null);
      setZoomSamples(null); // show full capture — will be clamped to totalSamples
      setPanSample(0);
      liveOverviewStrideRef.current = 1; // no downsampling for short captures
      // Pre-allocate overview buffer: totalSamples * bps (sized conservatively)
      const overviewTotalBytes = Math.max(2000, effectiveRate * effectiveBps); // generous upper bound
      liveOverviewRef.current = new Uint8Array(overviewTotalBytes);
      liveOverviewWriteRef.current = 0;
      // Pre-allocate tail buffer at max size
      liveTailMaxSamplesRef.current = 2_000_000;
      liveTailRef.current = new Uint8Array(liveTailMaxSamplesRef.current * effectiveBps);
      liveTailWriteRef.current = 0;
      liveTailStartRef.current = 0;
      const meta = await historyRef.current.getMeta(id);
      if (meta) setCaptureMeta(meta);
      // Apply transport channel labels so UI and decoders match the pattern.
      if (transport.effectiveChannelLabels) {
        handleChannelsChange(channels.map(ch => ({
          ...ch,
          label: transport.effectiveChannelLabels?.[ch.id] ?? ch.label,
        })));
      }

      dataOffRef.current = transport.onData((chunk) => {
        if (chunk.mode !== "la" || !liveCaptureIdRef.current) return;
        const bytes = chunk.data?.length
          ? chunk.data
          : Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
        if (bytes.length === 0) return;
        const chunkSamples = chunk.samples;
        const captureId = liveCaptureIdRef.current;
        const isFirstChunk = liveTotalSamplesRef.current === 0;

        // Update total samples synchronously so follow-tail stays responsive
        // even if IDB writes are slow.
        liveTotalSamplesRef.current += chunkSamples;

        // Incrementally downsample for the live overview bar (in-place, no alloc).
        const stride = liveOverviewStrideRef.current;
        const bpsLocal = effectiveBps;
        const ovBuf = liveOverviewRef.current;
        if (ovBuf) {
          const nOverview = Math.ceil(chunkSamples / stride);
          for (let i = 0, j = 0; i < chunkSamples && j < nOverview; i += stride, j++) {
            const srcOff = i * bpsLocal;
            const dstOff = liveOverviewWriteRef.current + j * bpsLocal;
            if (dstOff + bpsLocal > ovBuf.length) break;
            ovBuf[dstOff] = bytes[srcOff] ?? 0;
            if (bpsLocal === 2) ovBuf[dstOff + 1] = bytes[srcOff + 1] ?? 0;
          }
          liveOverviewWriteRef.current = Math.min(
            liveOverviewWriteRef.current + nOverview * bpsLocal,
            ovBuf.length
          );
        }

        // Write into pre-allocated tail buffer (in-place, no alloc).
        const tailBuf = liveTailRef.current;
        if (tailBuf) {
          const writeBytes = bytes.length;
          const writeOff = liveTailWriteRef.current;
          const tailMaxBytes = tailBuf.length;
          if (writeOff + writeBytes <= tailMaxBytes) {
            // Fits — write at current offset.
            tailBuf.set(bytes, writeOff);
            liveTailWriteRef.current = writeOff + writeBytes;
          } else {
            // Overflow — shift left by one chunk and write at end.
            const shiftBytes = writeBytes;
            tailBuf.copyWithin(0, shiftBytes, tailMaxBytes);
            tailBuf.set(bytes, tailMaxBytes - writeBytes);
            liveTailWriteRef.current = tailMaxBytes;
            liveTailStartRef.current = liveTotalSamplesRef.current - (tailMaxBytes / bpsLocal);
          }
        }

        // Set probe from first chunk data directly — no IDB read needed.
        if (isFirstChunk) {
          setProbeCapture({
            sampleRate: effectiveRate,
            width: effectiveWidth,
            samples: bytes,
            source: "live",
            importedAt: new Date().toISOString(),
            channelLabels: effectiveLabels,
          });
        }

        // Feed chunk to incremental classifier for live protocol detection.
        const cls = classifierRef.current;
        if (cls) {
          const clsUpdate = cls.update(bytes, chunkSamples);
          setLiveClassification(clsUpdate);
          // Auto-update channel labels from classification
          if (clsUpdate.channelLabels.length > 0) {
            const newLabels = channels.map(ch => {
              const cl = clsUpdate.channelLabels.find(l => l.channel === ch.id);
              return cl && cl.confidence > 0.3 ? cl.label : ch.label;
            });
            // Only update if labels actually changed
            const oldLabels = channels.map(c => c.label);
            if (newLabels.some((l, i) => l !== oldLabels[i])) {
              handleChannelsChange(channels.map((ch, i) => ({ ...ch, label: newLabels[i] ?? ch.label })));
            }
          }
          // Refresh decoder when top protocol changes
          const topProto = clsUpdate.hypotheses[0]?.protocol ?? "";
          if (topProto && topProto !== lastProtocolRef.current && clsUpdate.stable) {
            lastProtocolRef.current = topProto;
            // Re-infer decoder defaults from the probe capture with new info
            const probe = probeCaptureRef.current;
            if (probe) {
              const newDefaults = inferDecoderDefaults(probe);
              setDecoderState({
                tab: newDefaults.tab,
                uart: newDefaults.uart,
                i2c: newDefaults.i2c,
                spi: newDefaults.spi,
                can: newDefaults.can,
                onewire: newDefaults.onewire,
                swd: newDefaults.swd,
                jtag: newDefaults.jtag,
                modbus: newDefaults.modbus,
                lin: newDefaults.lin,
              });
            }
          }
        }

        lastWriteRef.current = lastWriteRef.current.then(async () => {
          await historyRef.current.appendChunk(captureId, bytes);
          if (acquireModeRef.current === "single-armed") {
            const result: LaAcquireResult = handleLaAcquireMode({
              mode: "single-armed",
              samples: bytes,
              width: effectiveWidth,
              trigger,
              totalSamples: liveTotalSamplesRef.current,
              armedAtSample: singleArmedAtRef.current,
              timeoutSamples: sampleRate * 5,
            });
            if (result.stop) {
              setAcquireMode(result.mode);
              await handleStop();
            }
          }
        }).catch(e => console.error("[WaveformLaView] chunk write failed", e));
      });
      stoppedOffRef.current = transport.onStopped(() => { void handleStop(); });
      await transport.start();
    } catch (e) {
      console.error("[WaveformLaView] start failed", e);
      await handleStop();
    }
  }, [props.transport, sampleRate, width, trigger, channels, isRunning, handleStop, retentionBytes]);

  const handleRun = useCallback(() => startLiveCapture("running"), [startLiveCapture]);
  const handleSingle = useCallback(() => startLiveCapture("single-armed"), [startLiveCapture]);
  const handleSimulate = useCallback(() => startLiveCapture("running", simTransportRef.current), [startLiveCapture]);

  // While running, poll capture meta and follow the live tail.
  useEffect(() => {
    if (!isRunning || !activeCaptureId) return;
    const id = activeCaptureId;
    let cancelled = false;
    const tick = async () => {
      const meta = await historyRef.current.getMeta(id);
      if (cancelled || !meta) return;
      // Only update captureMeta when retention-related fields change — not on every
      // totalSamples bump, which would retrigger the window-load effect needlessly.
      setCaptureMeta(prev => {
        if (!prev) return meta;
        if (prev.storedBytes === meta.storedBytes &&
            prev.trimmedBeforeSample === meta.trimmedBeforeSample) return prev;
        return meta;
      });
      if (followTailRef.current) {
        const total = liveTotalSamplesRef.current || meta.totalSamples;
        const zoom = zoomSamples ?? total;
        const target = Math.max(0, total - zoom);
        setPanSample(prev => (prev === target ? prev : target));
      }
      // Trigger overview re-render with latest downsampled data.
      setLiveOverviewTick(v => v + 1);
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isRunning, activeCaptureId, zoomSamples]);

  // Clamp pan to the first retained sample so users cannot scroll into evicted history.
  useEffect(() => {
    const min = captureMeta?.trimmedBeforeSample ?? 0;
    if (panSample < min) setPanSample(min);
  }, [captureMeta?.trimmedBeforeSample, panSample]);

  // Stop capture when the view is hidden or unmounted.
  useEffect(() => {
    if (!props.isActive && isRunning) void handleStop();
  }, [props.isActive, isRunning, handleStop]);

  useEffect(() => {
    return () => { void handleStop(); };
  }, [handleStop]);

  const DECODE_LIMIT = 1_000_000; // do not run decoders on windows larger than 1M samples to avoid UI stalls
  const canDecode = windowedCapture && windowedCapture.samples.length / (windowedCapture.width === 16 ? 2 : 1) <= DECODE_LIMIT;
  const uartRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "uart" || !decoderState.uart) return [];
    return decodeUartChunk(windowedCapture.samples, windowedCapture.sampleRate, decoderState.uart.baud, decoderState.uart.ch).map(r => ({ ...r, sample: r.sample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const i2cRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "i2c" || !decoderState.i2c) return [];
    return decodeI2C(windowedCapture.samples, windowedCapture.sampleRate, decoderState.i2c.scl, decoderState.i2c.sda).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const spiRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "spi" || !decoderState.spi) return [];
    return decodeSPI(windowedCapture.samples, windowedCapture.sampleRate, decoderState.spi.mosi, decoderState.spi.miso, decoderState.spi.sck, decoderState.spi.cs, decoderState.spi.mode, decoderState.spi.bits, decoderState.spi.csActiveLow).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const canRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "can" || !decoderState.can) return [];
    return decodeCAN(windowedCapture.samples, windowedCapture.sampleRate, decoderState.can.ch, decoderState.can.baud).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const oneWireRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "onewire" || !decoderState.onewire) return [];
    return decodeOneWire(windowedCapture.samples, windowedCapture.sampleRate, decoderState.onewire.ch).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const swdRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "swd" || !decoderState.swd) return [];
    return decodeSWD(windowedCapture.samples, windowedCapture.sampleRate, decoderState.swd.swdio, decoderState.swd.swclk).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const jtagRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "jtag" || !decoderState.jtag) return [];
    return decodeJTAG(windowedCapture.samples, windowedCapture.sampleRate, decoderState.jtag.tck, decoderState.jtag.tms, decoderState.jtag.tdi, decoderState.jtag.tdo).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);
  const modbusRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "modbus" || !decoderState.modbus) return [];
    return decodeModbus(windowedCapture.samples, windowedCapture.sampleRate, decoderState.modbus.ch, decoderState.modbus.baud, decoderState.modbus.parity).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);

  const linRows = useMemo(() => {
    if (!canDecode || decoderState.tab !== "lin" || !decoderState.lin) return [];
    return decodeLIN(windowedCapture.samples, windowedCapture.sampleRate, decoderState.lin.ch, decoderState.lin.baud, decoderState.lin.checksum).map(r => ({ ...r, startSample: r.startSample + panSample, endSample: r.endSample + panSample }));
  }, [windowedCapture, decoderState, panSample, canDecode]);

  const totalSamples = useMemo(() => captureMeta?.totalSamples ?? 0, [captureMeta]);

  const triggerSample = useMemo(() => {
    if (!trigger.enabled) return undefined;
    const full = fullCaptureRef.current;
    if (!full || full.samples.length === 0) return undefined;
    const bps = full.width === 16 ? 2 : 1;
    const total = Math.floor(full.samples.length / bps);
    const channel = trigger.channel;
    let prevBit = -1;
    for (let s = 0; s < total; s++) {
      const off = s * bps;
      const lo = full.samples[off] ?? 0;
      const hi = bps === 2 ? (full.samples[off + 1] ?? 0) : 0;
      const v = (hi << 8) | lo;
      const bit = (v >> channel) & 1;
      if (prevBit !== -1) {
        if (trigger.edge === "rise" && prevBit === 0 && bit === 1) return s;
        if (trigger.edge === "fall" && prevBit === 1 && bit === 0) return s;
        if (trigger.edge === "both" && prevBit !== bit) return s;
      }
      prevBit = bit;
    }
    return undefined;
  }, [trigger, captureMeta]);
  const handleZoomIn = useCallback(() => {
    const zoom = zoomSamples ?? totalSamples;
    setZoomSamples(Math.round(Math.max(10, zoom * 0.8)));
  }, [zoomSamples, totalSamples]);
  const handleZoomOut = useCallback(() => {
    const zoom = zoomSamples ?? totalSamples;
    const next = Math.round(zoom * 1.25);
    setZoomSamples(next >= totalSamples ? null : next);
  }, [zoomSamples, totalSamples]);
  const handleFit = useCallback(() => {
    setZoomSamples(null);
    setPanSample(0);
  }, []);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isRunning) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const generation = ++loadGenerationRef.current;
    const format = detectLaFormat(file.name, file.type);
    let loaded: LaCapture;
    // Clear old in-memory state so a previous capture does not bleed into the new one.
    fullCaptureRef.current = null;
    paddedBufferRef.current = null;
    setWindowedCapture(null);
    setProbeCapture(null);
    // Remove the previous capture from IndexedDB to prevent unbounded growth.
    const oldCaptureId = activeCaptureId;
    setActiveCaptureId(null);
    setCaptureMeta(null);
    if (oldCaptureId) {
      await historyRef.current.deleteCapture(oldCaptureId).catch(e => console.error("[import] delete old capture failed", e));
    }
    if (format === "sigrok-sr") {
      const buf = await file.arrayBuffer();
      const { meta: sigMeta, chunks } = await streamSigrokSr(buf);
      const bps = sigMeta.width === 16 ? 2 : 1;
      const id = await historyRef.current.createCapture({
        sampleRate: sigMeta.sampleRate,
        width: sigMeta.width,
        source: sigMeta.source,
        importedAt: sigMeta.importedAt,
        channelLabels: sigMeta.channelLabels,
        chunkSize: 1_000_000,
        bps,
      });
      setActiveCaptureId(id);
      setSampleRate(sigMeta.sampleRate);
      setZoomSamples(null);
      setPanSample(0);
      setCaptureMeta(null);

      let fullSamples = new Uint8Array(0);
      let firstChunk = true;
      let chunkCount = 0;
      const activeChannels = new Set<number>();
      let orBits = 0;
      let andBits = 0xffff;
      for await (const chunk of chunks) {
        await historyRef.current.appendChunk(id, chunk);
        const res = computeActiveChannels(chunk, sigMeta.width, bps, activeChannels, orBits, andBits);
        orBits = res.orBits;
        andBits = res.andBits;
        chunkCount++;
        if (firstChunk) {
          const updated = await historyRef.current.getMeta(id);
          if (updated) {
            setCaptureMeta(updated);
            // Zoom to the first chunk and center it so the decoder only runs on a small window while the rest streams in.
            const initialZoom = Math.min(updated.totalSamples, 1_000_000);
            const initialPan = Math.max(0, Math.floor((updated.totalSamples - initialZoom) / 2));
            setZoomSamples(initialZoom);
            setPanSample(initialPan);
          }
          firstChunk = false;
        }
        if (fullSamples.length + chunk.length <= IN_MEMORY_THRESHOLD) {
          const combined = new Uint8Array(fullSamples.length + chunk.length);
          combined.set(fullSamples);
          combined.set(chunk, fullSamples.length);
          fullSamples = combined;
        }
        // Yield to the UI every few chunks so the page stays responsive during large streams.
        if (chunkCount % 10 === 0) await new Promise(r => setTimeout(r, 0));
      }
      const finalMeta = await historyRef.current.finalizeCapture(id);
      if (generation !== loadGenerationRef.current) return;
      setCaptureMeta(finalMeta);
      fullCaptureRef.current = { ...sigMeta, samples: fullSamples };
      handleChannelsChange(applyChannelVisibility(channels, sigMeta.width, activeChannels, sigMeta.channelLabels));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    } else if (format === "fob-json") {
      loaded = parseLaJson(await file.text());
    } else {
      loaded = parseLaCsv(await file.text()); // default CSV importer for .csv and unknown text
    }
    if (generation !== loadGenerationRef.current) return;
    fullCaptureRef.current = loaded;
    const bps = loaded.width === 16 ? 2 : 1;
    const id = await historyRef.current.createCapture({
      sampleRate: loaded.sampleRate,
      width: loaded.width,
      source: loaded.source,
      importedAt: loaded.importedAt,
      channelLabels: loaded.channelLabels,
      chunkSize: 1_000_000,
      bps,
    });
    await historyRef.current.appendChunk(id, loaded.samples);
    const meta = await historyRef.current.finalizeCapture(id);
    setActiveCaptureId(id);
    setCaptureMeta(meta);
    setSampleRate(loaded.sampleRate);
    const activeChannels = computeActiveChannels(loaded.samples, loaded.width, bps).active;
    handleChannelsChange(applyChannelVisibility(channels, loaded.width, activeChannels, loaded.channelLabels));
    setZoomSamples(null);
    setPanSample(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [activeCaptureId, channels, handleChannelsChange, setWindowedCapture, setProbeCapture, isRunning, handleStop]);

  const handlePattern = useCallback(async () => {
    if (isRunning) return;
    await handleStop();
    const generation = ++loadGenerationRef.current;
    const rate = 1_000_000;
    const { samples, dataEndSample } = generateLaTestPattern(rate, 1);
    const width = 8;
    const channelLabels = ["UART_TX", "I2C_SCL", "I2C_SDA", "SPI_MOSI", "SPI_MISO", "SPI_SCK", "SPI_CS"];
    // Drop old in-memory capture before allocating new one to reduce GC pressure.
    fullCaptureRef.current = null;
    paddedBufferRef.current = null;
    setWindowedCapture(null);
    setProbeCapture(null);
    // Remove the previous capture from IndexedDB to prevent unbounded growth.
    const oldCaptureId = activeCaptureId;
    setActiveCaptureId(null);
    setCaptureMeta(null);
    if (oldCaptureId) {
      await historyRef.current.deleteCapture(oldCaptureId).catch(e => console.error("[pattern] delete old capture failed", e));
    }
    const loaded: LaCapture = {
      sampleRate: rate,
      width,
      samples,
      source: "fob-pattern",
      importedAt: new Date().toISOString(),
      channelLabels,
    };
    fullCaptureRef.current = loaded;
    const id = await historyRef.current.createCapture({
      sampleRate: rate,
      width,
      source: "fob-pattern",
      importedAt: loaded.importedAt,
      channelLabels,
      chunkSize: 1_000_000,
      bps: 1,
    });
    await historyRef.current.appendChunk(id, samples);
    const meta = await historyRef.current.finalizeCapture(id);
    if (generation !== loadGenerationRef.current) return;
    setActiveCaptureId(id);
    setCaptureMeta(meta);
    setSampleRate(rate);
    const activeChannels = computeActiveChannels(samples, width, 1).active;
    handleChannelsChange(applyChannelVisibility(channels, width, activeChannels, channelLabels));
    // Auto-zoom to the active data region with a little idle padding so it isn't a sliver.
    const initialZoom = dataEndSample > 0 ? Math.ceil(dataEndSample * 1.5) : null;
    setZoomSamples(initialZoom);
    setPanSample(0);
  }, [isRunning, activeCaptureId, channels, handleChannelsChange, setWindowedCapture, setProbeCapture, handleStop]);

  const handleExport = useCallback(async () => {
    if (!activeCaptureId || !captureMeta) return;
    const fullSamples = await historyRef.current.getWindow(activeCaptureId, 0, captureMeta.totalSamples);
    const fullCapture: LaCapture = {
      sampleRate: captureMeta.sampleRate,
      width: captureMeta.width,
      samples: fullSamples,
      source: captureMeta.source,
      importedAt: captureMeta.importedAt,
      channelLabels: captureMeta.channelLabels,
    };
    downloadLaCapture(fullCapture, `capture-${captureMeta.sampleRate / 1e6}MHz-${captureMeta.width}bit.csv`);
  }, [activeCaptureId, captureMeta]);

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
          <WaveformLaLegacyView {...props} capture={windowedCapture} />
        </div>
      </div>
    );
  }

  const jsx = (
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
        <button
          onClick={handleSimulate}
          disabled={isRunning}
          className="px-3 py-1 rounded font-bold bg-fob-blue hover:bg-fob-blue/80 disabled:bg-fob-surface disabled:text-fob-text-dim"
        >
          Simulate
        </button>
        <span className="text-fob-text-dim">{acquireMode}</span>
        {liveClassification && liveClassification.hypotheses.length > 0 && (
          <span className="text-fob-text-dim text-xs">
            {liveClassification.hypotheses.map(h =>
              `${h.protocol.toUpperCase()} ${Math.round(h.confidence * 100)}%`
            ).join(" | ")}
          </span>
        )}
        {captureMeta && (
          <span className="text-fob-text-dim">
            {captureMeta.totalSamples.toLocaleString()} samples @ {(captureMeta.sampleRate / 1e6).toFixed(1)} MHz
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
          className="px-3 py-1.5 rounded text-sm bg-fob-surface border border-fob-border hover:bg-fob-border"
        >
          Import
        </button>
        <button
          onClick={handleExport}
          disabled={!activeCaptureId}
          className="px-3 py-1.5 rounded text-sm bg-fob-surface border border-fob-border hover:bg-fob-border disabled:text-fob-text-dim"
        >
          Export
        </button>
        <button
          onClick={handlePattern}
          disabled={isRunning}
          className="px-3 py-1.5 rounded text-sm bg-fob-blue text-fob-accent-text hover:bg-fob-blue/80 disabled:bg-fob-surface disabled:text-fob-text-dim"
          title="Load synthetic UART/I2C/SPI capture"
        >
          Pattern
        </button>
        <button
          onClick={() => setUseLegacy(true)}
          className="px-3 py-1.5 rounded text-sm bg-fob-surface border border-fob-border hover:bg-fob-border"
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
            <button onClick={handleFit} disabled={!windowedCapture} className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border disabled:text-fob-text-dim" title="Fit entire capture (0)">Fit</button>
            <button onClick={handleZoomOut} disabled={!windowedCapture} className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border disabled:text-fob-text-dim" title="Zoom out (−)">−</button>
            <button onClick={handleZoomIn} disabled={!windowedCapture} className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border disabled:text-fob-text-dim" title="Zoom in (+)">+</button>
            <span className="text-fob-text-dim w-24 text-right">{windowedCapture ? `${(zoomSamples ?? totalSamples).toLocaleString()} smp` : "—"}</span>
            <div className="w-px h-4 bg-fob-border mx-1" />
            <button
              onClick={() => setShowCursors(s => !s)}
              disabled={!windowedCapture}
              className={`px-2 py-0.5 rounded text-xs border ${showCursors ? "bg-fob-blue text-white border-fob-blue" : "bg-fob-surface border-fob-border hover:bg-fob-border"} disabled:text-fob-text-dim`}
              title="Toggle cursors (C/V)"
            >
              Cursors
            </button>
            <button
              onClick={() => setTrigger(t => ({ ...t, enabled: !t.enabled }))}
              disabled={!windowedCapture}
              className={`px-2 py-0.5 rounded text-xs border ${trigger.enabled ? "bg-fob-green text-white border-fob-green" : "bg-fob-surface border-fob-border hover:bg-fob-border"} disabled:text-fob-text-dim`}
              title="Toggle trigger"
            >
              Trigger
            </button>
          </div>
          {/* Main waveform canvas with decoder annotations */}
          <div className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0 min-w-0 select-none">
            {windowedCapture && windowedCapture.samples.length > 0 ? (
              <LaCanvas
                samples={windowedCapture.samples}
                totalSamples={totalSamples}
                sampleRate={windowedCapture.sampleRate}
                width={windowedCapture.width}
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
                linRows={linRows}
                decoderChannel={decoderState.uart?.ch}
                decoderSda={decoderState.i2c?.sda}
                decoderMosi={decoderState.spi?.mosi}
                decoderCan={decoderState.can?.ch}
                decoderOneWire={decoderState.onewire?.ch}
                decoderSwd={decoderState.swd}
                decoderJtag={decoderState.jtag}
                decoderModbus={decoderState.modbus}
                decoderLin={decoderState.lin}
                showCursors={showCursors}
                cursorA={cursorA.sample}
                cursorB={cursorB.sample}
                triggerSample={triggerSample}
                channelLabels={fullCaptureRef.current?.channelLabels}
                onPanChange={setPanSample}
                onZoomChange={setZoomSamples}
                onCursorAChange={sample => setCursorA(prev => ({ ...prev, sample }))}
                onCursorBChange={sample => setCursorB(prev => ({ ...prev, sample }))}
                onMouseSampleChange={sample => { mouseSampleRef.current = sample; }}
                onPacketClick={handlePacketClick}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-fob-text-dim text-xs">
                Import a capture or click Pattern to load a signal.
              </div>
            )}
          </div>
          {/* Viewport overview / minimap */}
          {fullCaptureRef.current && fullCaptureRef.current.samples.length > 0 ? (
            <LaOverview
              samples={fullCaptureRef.current.samples}
              width={fullCaptureRef.current.width}
              channels={channels}
              zoomSamples={zoomSamples}
              panSample={panSample}
              totalSamples={totalSamples}
              onPanChange={setPanSample}
            />
          ) : isRunning && liveOverviewRef.current && liveOverviewWriteRef.current > 0 ? (
            <LaOverview
              samples={liveOverviewRef.current.subarray(0, liveOverviewWriteRef.current)}
              width={captureMeta?.width ?? width}
              channels={channels}
              zoomSamples={zoomSamples}
              panSample={panSample}
              totalSamples={liveTotalSamplesRef.current || totalSamples}
              onPanChange={setPanSample}
              sampleStride={liveOverviewStrideRef.current}
            />
          ) : null}
          {/* Bottom decoders panel */}
          <div className="h-40 rounded border border-fob-border overflow-hidden bg-fob-surface shrink-0 min-w-0">
            <LaDecodersPanel
              capture={windowedCapture}
              sampleRate={sampleRate}
              panSample={panSample}
              zoomSamples={zoomSamples}
              running={isRunning}
              tab={decoderState.tab}
              defaultUart={decoderDefaults.uart}
              defaultI2c={decoderDefaults.i2c}
              defaultSpi={decoderDefaults.spi}
              defaultCan={decoderDefaults.can}
              defaultOneWire={decoderDefaults.onewire}
              defaultSwd={decoderDefaults.swd}
              defaultJtag={decoderDefaults.jtag}
              defaultModbus={decoderDefaults.modbus}
              defaultLin={decoderDefaults.lin}
              uartRows={uartRows}
              i2cRows={i2cRows}
              spiRows={spiRows}
              canRows={canRows}
              oneWireRows={oneWireRows}
              swdRows={swdRows}
              jtagRows={jtagRows}
              modbusRows={modbusRows}
              linRows={linRows}
              onChange={setDecoderState}
              onPacketClick={handlePacketClick}
              onFrameNavigate={handleFrameNavigate}
            />
          </div>
        </div>

        {/* Right panel */}
        <div className="w-72 flex flex-col gap-2 shrink-0 overflow-y-auto text-[11px] px-1 py-1">
          <CollapsibleSection title="Acquire">
            <div className="flex flex-col gap-2 p-1">
              <label className="flex flex-col gap-0.5">
                <span className="text-fob-text-dim">Retention budget (MB)</span>
                <input
                  type="number"
                  min={1}
                  max={4096}
                  value={Math.round(retentionBytes / (1024 * 1024))}
                  disabled={isRunning}
                  onChange={(e) => {
                    const mb = Math.max(1, Math.min(4096, parseInt(e.target.value, 10) || 0));
                    setRetentionBytes(mb * 1024 * 1024);
                  }}
                  className="w-full px-1 py-0.5 rounded bg-fob-surface border border-fob-border text-fob-text disabled:opacity-50"
                />
              </label>
              {captureMeta && (
                <div className="text-fob-text-dim">
                  <div>Used: {((captureMeta.storedBytes ?? 0) / (1024 * 1024)).toFixed(1)} MB</div>
                  {captureMeta.trimmedBeforeSample ? (
                    <div>Oldest retained: {(captureMeta.trimmedBeforeSample / captureMeta.sampleRate).toFixed(2)} s</div>
                  ) : (
                    <div>All data retained</div>
                  )}
                </div>
              )}
            </div>
          </CollapsibleSection>
          <CollapsibleSection title="Channels">
            <ChannelsPanel channels={channels} onChange={handleChannelsChange} />
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );

  return jsx;
}
