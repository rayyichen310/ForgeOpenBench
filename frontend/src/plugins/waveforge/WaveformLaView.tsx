import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type { UsbTransport } from "./UsbTransport";
import type { UsbDataChunk } from "./usbTypes";
import { RingBuffer } from "./RingBuffer";
import { globalBus } from "../../core/global_bus";
import { toast } from "../../shared/hooks/useToastStore";
import { MAX_TICKER, decodeUartChunk, decodeI2C, decodeSPI, generateLaTestPattern } from "./laDecoders";
import type { TickerRow, DecoderTab } from "./laDecoders";
import { DEFAULT_CHANNEL_HEIGHT, DEFAULT_CHANNEL_GAP, DEFAULT_LABEL_WIDTH, DEFAULT_RING_CAPACITY, DEFAULT_JITTER_CAP_SAMPLES, SAMPLE_RATES, TIMEBASE_PRESETS, CHANNEL_COLORS, DEFAULT_BAUDS, loadChannels, saveChannels, loadDecoders, saveDecoders } from "./laChannelConfig";
import type { LaChannel } from "./laChannelConfig";
import { makeTimestamp, downloadBlob, canvasToPngDataUrl } from "./exportUtils";

interface Cursor { sample: number; dragging: boolean; }


interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

const BAUDS = DEFAULT_BAUDS;

export function WaveformLaView({ transport, isActive, connected }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const ringRef      = useRef(new RingBuffer(DEFAULT_RING_CAPACITY));
  const frozenBufRef = useRef<Uint8Array | null>(null);
  const runningRef   = useRef(false);
  const rafRef       = useRef<number>(0);
  const dataOffRef   = useRef<(() => void) | null>(null);
  const tickerEndRef = useRef<HTMLDivElement>(null);

  // Jitter buffer — Uint16Array ring for smooth playback cursor
  const jitterBufRef       = useRef<Uint16Array | null>(null);
  const jitterWriteRef     = useRef(0);   // total samples written (monotonic)
  const readHeadRef        = useRef(0);   // playback cursor (snaps to write head on each chunk)
  // snap-to-latest: readHead always tracks write head — zero latency live display
  const snapDirtyRef = useRef(false); // true when new chunk arrived, rAF pending

  const [running,     setRunning]     = useState(false);
  const [sampleRate,  setSampleRate]  = useState(12_000_000);
  const [width,       setWidth]       = useState<8 | 16>(16);
  const [timebaseIdx, setTimebaseIdx] = useState(6); // 100 µs/div default
  const [channels,    setChannels]    = useState<LaChannel[]>(loadChannels);
  const [tickerRows,  setTickerRows]  = useState<TickerRow[]>([]);
  const [frozenKey,   setFrozenKey]   = useState(0);
  const decoderInit = useMemo(loadDecoders, []);
  const [decoderTab,  setDecoderTab]  = useState<DecoderTab>(decoderInit.tab);
  const [uartCfg,     setUartCfg]     = useState(decoderInit.uart);
  const [i2cCfg,      setI2cCfg]      = useState(decoderInit.i2c);
  const [spiCfg,      setSpiCfg]      = useState(decoderInit.spi);
  const [elapsedS,    setElapsedS]    = useState(0);
  const [showCursors, setShowCursors] = useState(false);
  const [cursorA,     setCursorA]     = useState<Cursor>({ sample: 0, dragging: false });
  const [cursorB,     setCursorB]     = useState<Cursor>({ sample: 0, dragging: false });
  const [zoomSamples, setZoomSamples] = useState<number | null>(null); // null = fit all
  const [panSample,   setPanSample]   = useState(0);
  const [classicMode, setClassicMode] = useState(false);
  const startTimeRef   = useRef(0);
  const elapsedSRef    = useRef(0); // mirrors elapsedS for use inside draw()
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveRateRef    = useRef(sampleRate);
  const liveWidthRef   = useRef<8|16>(width);
  const timebaseRef    = useRef(timebaseIdx);
  const decoderTabRef  = useRef(decoderTab);
  const uartCfgRef     = useRef(uartCfg);
  const i2cCfgRef      = useRef(i2cCfg);
  const spiCfgRef      = useRef(spiCfg);
  const showCursorsRef = useRef(showCursors);
  const cursorARef     = useRef(cursorA);
  const cursorBRef     = useRef(cursorB);
  const zoomSamplesRef = useRef(zoomSamples);
  const panSampleRef   = useRef(panSample);
  const classicModeRef = useRef(classicMode);
  const isPanningRef   = useRef(false);
  const panStartRef    = useRef<{ x: number; pan: number } | null>(null);

  useEffect(() => { timebaseRef.current = timebaseIdx; }, [timebaseIdx]);
  useEffect(() => { decoderTabRef.current = decoderTab; }, [decoderTab]);
  useEffect(() => { uartCfgRef.current = uartCfg; }, [uartCfg]);
  useEffect(() => { i2cCfgRef.current = i2cCfg; }, [i2cCfg]);
  useEffect(() => { spiCfgRef.current = spiCfg; }, [spiCfg]);
  useEffect(() => { showCursorsRef.current = showCursors; }, [showCursors]);
  useEffect(() => { cursorARef.current     = cursorA;     }, [cursorA]);
  useEffect(() => { cursorBRef.current     = cursorB;     }, [cursorB]);
  useEffect(() => { zoomSamplesRef.current = zoomSamples; }, [zoomSamples]);
  useEffect(() => { panSampleRef.current   = panSample;   }, [panSample]);
  useEffect(() => { classicModeRef.current = classicMode; }, [classicMode]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const bps = liveWidthRef.current === 16 ? 2 : 1;
    const rate = liveRateRef.current;
    const divCount = 10;
    const displayW = W - DEFAULT_LABEL_WIDTH;
    const isLive = runningRef.current;

    // Live: all accumulated data up to MAX_LIVE_WINDOW_S, expands as chunks arrive
    // Stopped: full captured buffer (frozen snapshot)
    let buf: Uint8Array;
    let windowS: number;
    let currentZoom: number;
    let currentPan: number;

    if (isLive) {
      // Snap-to-latest: always show last windowSec of data up to readHead
      const windowSec = TIMEBASE_PRESETS[timebaseRef.current].s * divCount;
      const maxSamples = Math.round(windowSec * rate);
      const jBuf = jitterBufRef.current;
      const readHead = Math.floor(readHeadRef.current);
      // Build window: [readHead-maxSamples, readHead) from jitter ring
      // Pad with zeros at front if not enough data yet (priming phase)
      const tmpBytes = new Uint8Array(maxSamples * bps); // zero-initialised = pad
      if (jBuf && readHead > 0) {
        const winStart = Math.max(0, readHead - maxSamples);
        const count = readHead - winStart;
        const dstOff = (maxSamples - count) * bps; // right-align in buffer
        for (let i = 0; i < count; i++) {
          const s = jBuf[(winStart + i) % DEFAULT_JITTER_CAP_SAMPLES];
          if (bps === 2) { tmpBytes[dstOff + i*2] = s & 0xFF; tmpBytes[dstOff + i*2+1] = (s >> 8) & 0xFF; }
          else { tmpBytes[dstOff + i] = s & 0xFF; }
        }
      }
      buf = tmpBytes;
      windowS = windowSec;
      currentZoom = maxSamples;
      currentPan = Math.max(0, readHead - maxSamples);
    } else {
      // Frozen snapshot: pan/zoom window
      const source = frozenBufRef.current ?? ringRef.current.tail(ringRef.current.count);
      const totalSamples = Math.floor(source.length / bps);
      const frozenZoom = zoomSamplesRef.current ?? totalSamples;
      const zoom = Math.max(100, Math.min(frozenZoom, totalSamples));
      const maxPan = Math.max(0, totalSamples - zoom);
      const pan = Math.max(0, Math.min(panSampleRef.current, maxPan));
      buf = source.slice(pan * bps, (pan + zoom) * bps);
      windowS = zoom / rate;
      currentZoom = zoom;
      currentPan = pan;
    }

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fob-surface').trim();
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--fob-border').trim();
    ctx.lineWidth = 1;
    for (let i = 0; i <= divCount; i++) {
      const x = DEFAULT_LABEL_WIDTH + (i * displayW) / divCount;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    if (buf.length === 0) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fob-text-dim').trim();
      ctx.font = "11px monospace";
      ctx.fillText("No data — press RUN to capture", DEFAULT_LABEL_WIDTH + 12, H / 2);
      return;
    }

    const bufSamples = Math.floor(buf.length / bps);
    // Live: fixed window, data right-aligned (pad zeros on left during priming)
    // Stopped: full buffer fills the display
    const filledPixels = displayW;
    const startPx = 0;

    const visibleChannels = channels.filter(c => c.visible);

    visibleChannels.forEach((ch, idx) => {
      const yMid = idx * (DEFAULT_CHANNEL_HEIGHT + DEFAULT_CHANNEL_GAP) + DEFAULT_CHANNEL_HEIGHT / 2 + 4;
      if (yMid > H - 14) return;
      const highY = yMid - DEFAULT_CHANNEL_HEIGHT / 3;
      const lowY  = yMid + DEFAULT_CHANNEL_HEIGHT / 3;

      ctx.fillStyle = ch.color;
      ctx.font = "9px monospace";
      ctx.fillText(ch.label, 2, yMid + 3);

      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      let prevState: 0 | 1 | null = null;
      let prevY = lowY;

      for (let px = startPx; px < filledPixels; px++) {
        // In live mode buf contains exactly the last windowSamples (or fewer if buffer not full yet)
        // px=0 is oldest sample, px=filledPixels-1 is newest
        const sampleIdx = isLive
          ? Math.floor((px / filledPixels) * bufSamples)
          : Math.floor((px / displayW) * bufSamples);
        const byteIdx = Math.min(sampleIdx * bps, buf.length - bps);

        const hwCh = ch.id;
        let bit: 0 | 1 = 0;
        if (liveWidthRef.current === 16) {
          bit = hwCh < 8 ? ((buf[byteIdx] >> hwCh) & 1) as 0|1 : ((buf[byteIdx + 1] >> (hwCh - 8)) & 1) as 0|1;
        } else {
          bit = ((buf[byteIdx] >> hwCh) & 1) as 0|1;
        }

        const x = DEFAULT_LABEL_WIDTH + px;
        const y = bit ? highY : lowY;

        if (prevState !== null && prevState !== bit) {
          ctx.lineTo(x, prevY);
          ctx.lineTo(x, y);
        }
        px === startPx ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        prevState = bit;
        prevY = y;
      }
      ctx.stroke();
    });

    // Time axis — rolling offset in live mode uses wall-clock elapsed (not sample count)
    // Sample count / rate diverges from real-time due to USB delivery pacing
    // Frozen mode: offset is the pan sample index converted to seconds
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fob-text-dim').trim();
    ctx.font = "9px monospace";
    const divS = windowS / divCount;
    const wallElapsedS = isLive && startTimeRef.current > 0
      ? (Date.now() - startTimeRef.current) / 1000
      : 0;
    const windowFilled = isLive && wallElapsedS >= windowS;
    const offsetS = isLive
      ? (windowFilled ? wallElapsedS - windowS : 0)
      : (panSampleRef.current / rate);
    const filledFrac = isLive ? Math.min(1, wallElapsedS / windowS) : 1;
    for (let i = 0; i <= divCount; i++) {
      if (i === 0 && offsetS === 0) continue;
      const frac = i / divCount;
      if (isLive && !windowFilled && frac < (1 - filledFrac)) continue;
      const x = DEFAULT_LABEL_WIDTH + (i * displayW) / divCount;
      const tS = offsetS + i * divS;
      const tMs = tS * 1000;
      const label = tMs < 1
        ? `${(tS*1e6).toFixed(0)}µs`
        : tMs < 1000
          ? `${tMs < 10 ? tMs.toFixed(2) : tMs < 100 ? tMs.toFixed(1) : Math.round(tMs)}ms`
          : tS < 100 ? `${tS.toFixed(1)}s` : `${Math.round(tS)}s`;
      ctx.fillText(label, x + 2, H - 3);
    }

    // Cursors: drawn after traces so they sit on top
    if (!isLive && showCursorsRef.current) {
      const totalSamples = Math.floor((frozenBufRef.current?.length ?? ringRef.current.count) / bps);
      const zoom = Math.max(1, zoomSamplesRef.current ?? totalSamples);
      const pan = panSampleRef.current;
      const sampleToX = (s: number) => DEFAULT_LABEL_WIDTH + ((s - pan) / zoom) * displayW;
      const drawCursorLine = (s: number, color: string, label: string, dash: number[]) => {
        const x = sampleToX(s);
        if (x < DEFAULT_LABEL_WIDTH || x > W) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.setLineDash([]);
        // Label + handle at top
        ctx.fillStyle = color;
        ctx.font = "bold 10px monospace";
        ctx.fillText(label, x + 3, 12);
        ctx.beginPath(); ctx.arc(x, 12, 3, 0, Math.PI * 2); ctx.fill();
      };
      drawCursorLine(cursorARef.current.sample, "#F87171", "A", [4, 4]);
      drawCursorLine(cursorBRef.current.sample, "#60A5FA", "B", [2, 2]);
    }

    // Decoder overlays on the active decoder's channel(s)
    const getChannelY = (chId: number) => {
      const idx = visibleChannels.findIndex(c => c.id === chId);
      if (idx < 0) return null;
      const yMid = idx * (DEFAULT_CHANNEL_HEIGHT + DEFAULT_CHANNEL_GAP) + DEFAULT_CHANNEL_HEIGHT / 2 + 4;
      if (yMid > H - 14) return null;
      return yMid;
    };
    const drawBubble = (sample: number, chId: number, text: string, color: string) => {
      const y = getChannelY(chId);
      if (y === null) return;
      const x = DEFAULT_LABEL_WIDTH + ((sample - currentPan) / currentZoom) * displayW;
      if (x < DEFAULT_LABEL_WIDTH || x > W) return;
      ctx.fillStyle = color;
      ctx.font = "bold 9px monospace";
      ctx.fillText(text, x + 2, y - 8);
    };
    const activeTab = decoderTabRef.current;
    if (activeTab === "uart") {
      const cfg = uartCfgRef.current;
      tickerRowsRef.current.slice(-20).forEach(r => {
        drawBubble(r.sample, cfg.ch, `0x${r.byte.toString(16).padStart(2, "0").toUpperCase()}`, CHANNEL_COLORS[cfg.ch]);
      });
    } else if (activeTab === "i2c") {
      const cfg = i2cCfgRef.current;
      i2cRowsRef.current.forEach(r => {
        if (r.type === "byte" && r.addr !== undefined) {
          drawBubble(r.startSample, cfg.sda, `A${r.addr.toString(16).padStart(2, "0")}${r.rw === "read" ? "R" : "W"}`, CHANNEL_COLORS[cfg.sda]);
        } else if (r.type === "byte" && r.data !== undefined) {
          drawBubble(r.startSample, cfg.sda, `0x${r.data.toString(16).padStart(2, "0")}`, CHANNEL_COLORS[cfg.sda]);
        }
      });
    } else if (activeTab === "spi") {
      const cfg = spiCfgRef.current;
      const digits = cfg.bits / 4;
      spiRowsRef.current.forEach(r => {
        if (r.mosi !== undefined) drawBubble(r.startSample, cfg.mosi, `M0x${r.mosi.toString(16).padStart(digits, "0").toUpperCase()}`, CHANNEL_COLORS[cfg.mosi]);
        if (r.miso !== undefined) drawBubble(r.startSample, cfg.miso, `S0x${r.miso.toString(16).padStart(digits, "0").toUpperCase()}`, CHANNEL_COLORS[cfg.miso]);
      });
    }

    // Stopped: show total capture info in top-right (wall-clock elapsed, not sample count)
    if (!isLive && elapsedSRef.current > 0) {
      const totalCapS = elapsedSRef.current;
      const capLabel = totalCapS < 1
        ? `${(totalCapS * 1000).toFixed(0)}ms total`
        : `${totalCapS.toFixed(1)}s total`;
      const winLabel = windowS < 1 ? `${(windowS*1000).toFixed(0)}ms window` : `${windowS.toFixed(1)}s window`;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fob-text-dim').trim();
      ctx.font = "9px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`${capLabel} / ${winLabel}`, W - 4, 11);
      ctx.textAlign = "left";
    }
  }, [channels, width]);

  // Snap-to-latest rAF: fires once per chunk, shows newest data immediately
  const rafLoop = useCallback(() => {
    rafRef.current = 0;
    snapDirtyRef.current = false;
    // Snap readHead to latest write
    readHeadRef.current = jitterWriteRef.current;
    draw();
  }, [draw]);

  const start = useCallback(async () => {
    if (!connected || runningRef.current) return;
    ringRef.current.reset();
    frozenBufRef.current = null;
    // Reset jitter ring
    jitterBufRef.current = new Uint16Array(DEFAULT_JITTER_CAP_SAMPLES);
    jitterWriteRef.current = 0;
    readHeadRef.current = 0;
    snapDirtyRef.current = false;
    try {
      await transport.configure({ mode: "la", sample_rate_hz: sampleRate, sample_width: width });
      dataOffRef.current?.();
      liveRateRef.current = sampleRate;
      dataOffRef.current = transport.onData((chunk: UsbDataChunk) => {
        if (chunk.mode !== "la") return;
        const decoded = Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
        liveRateRef.current  = chunk.rate;
        liveWidthRef.current = chunk.width;
        ringRef.current.push(decoded);
        // Push into jitter ring
        const jBuf = jitterBufRef.current;
        if (jBuf) {
          const bps2 = chunk.width === 16 ? 2 : 1;
          const nSamples = decoded.length / bps2;
          for (let i = 0; i < nSamples; i++) {
            const s = bps2 === 2
              ? decoded[i*2] | (decoded[i*2+1] << 8)
              : decoded[i];
            jBuf[jitterWriteRef.current % DEFAULT_JITTER_CAP_SAMPLES] = s;
            jitterWriteRef.current++;
          }
        }
        // Schedule one rAF draw if not already pending (coalesces rapid chunks)
        if (!snapDirtyRef.current && runningRef.current) {
          snapDirtyRef.current = true;
          rafRef.current = requestAnimationFrame(rafLoop);
        }
        // Live UART ticker decode (reads refs — always current even if baud/ch change while running)
        if (decoderTabRef.current === "uart") {
          const cfg = uartCfgRef.current;
          const baseSample = jitterWriteRef.current;
          const newRows = decodeUartChunk(decoded, chunk.rate, cfg.baud, cfg.ch, baseSample);
          if (newRows.length > 0) {
            setTickerRows(prev => [...prev, ...newRows].slice(-MAX_TICKER));
          }
        }
      });
      await transport.start();
      runningRef.current = true;
      elapsedSRef.current = 0;
      setElapsedS(0);
      startTimeRef.current = Date.now();
      elapsedTimerRef.current = setInterval(() => {
        const s = Math.round((Date.now() - startTimeRef.current) / 1000);
        elapsedSRef.current = s;
        setElapsedS(s);
      }, 1000);
      setRunning(true);
      rafRef.current = requestAnimationFrame(rafLoop);
    } catch (e) {
      console.warn("[LA] start error", e);
    }
  }, [connected, sampleRate, width, transport, rafLoop]);

  const stop = useCallback(async () => {
    // Freeze from jitter ring (last 500ms) — better than 8MB byte ring at high rates
    const jBuf = jitterBufRef.current;
    const written = jitterWriteRef.current;
    const bpsFreeze = liveWidthRef.current === 16 ? 2 : 1;
    if (jBuf && written > 0) {
      const capSamples = Math.min(written, DEFAULT_JITTER_CAP_SAMPLES);
      const frozen = new Uint8Array(capSamples * bpsFreeze);
      for (let i = 0; i < capSamples; i++) {
        const s = jBuf[(written - capSamples + i) % DEFAULT_JITTER_CAP_SAMPLES];
        if (bpsFreeze === 2) { frozen[i*2] = s & 0xFF; frozen[i*2+1] = (s >> 8) & 0xFF; }
        else { frozen[i] = s & 0xFF; }
      }
      frozenBufRef.current = frozen;
    } else {
      frozenBufRef.current = ringRef.current.tail(ringRef.current.count);
    }
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
    // Capture final elapsed (wall-clock, high-res) before startTimeRef goes stale
    const finalElapsedS = startTimeRef.current > 0
      ? (Date.now() - startTimeRef.current) / 1000
      : elapsedSRef.current;
    elapsedSRef.current = finalElapsedS;
    startTimeRef.current = 0; // mark stale so info label doesn't reuse it
    // Auto-fit timebase: use wall-clock elapsed as primary (immune to USB delivery pacing)
    const fitS = finalElapsedS > 0 ? finalElapsedS
      : (frozenBufRef.current?.length ?? 0) / bpsFreeze / liveRateRef.current;
    if (fitS > 0) {
      const divS = fitS / 10;
      let best = TIMEBASE_PRESETS.length - 1;
      for (let i = 0; i < TIMEBASE_PRESETS.length; i++) {
        if (TIMEBASE_PRESETS[i].s >= divS) { best = i; break; }
      }
      timebaseRef.current = best;
      setTimebaseIdx(best);
    }
    setRunning(false);
    setFrozenKey(k => k + 1);
    dataOffRef.current?.();
    dataOffRef.current = null;
    try { await transport.stop(); } catch { }
    draw();
  }, [transport, draw]);

  // Auto-reset when backend capture loop exits
  useEffect(() => {
    return transport.onStopped(() => {
      if (!runningRef.current) return;
      const jBuf2 = jitterBufRef.current;
      const written2 = jitterWriteRef.current;
      const bpsF2 = liveWidthRef.current === 16 ? 2 : 1;
      if (jBuf2 && written2 > 0) {
        const capSamples2 = Math.min(written2, DEFAULT_JITTER_CAP_SAMPLES);
        const frozen2 = new Uint8Array(capSamples2 * bpsF2);
        for (let i = 0; i < capSamples2; i++) {
          const s = jBuf2[(written2 - capSamples2 + i) % DEFAULT_JITTER_CAP_SAMPLES];
          if (bpsF2 === 2) { frozen2[i*2] = s & 0xFF; frozen2[i*2+1] = (s >> 8) & 0xFF; }
          else { frozen2[i] = s & 0xFF; }
        }
        frozenBufRef.current = frozen2;
      } else {
        frozenBufRef.current = ringRef.current.tail(ringRef.current.count);
      }
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
      setRunning(false);
      setFrozenKey(k => k + 1);
      draw();
    });
  }, [transport, draw]);

  // Auto-scroll ticker
  useEffect(() => {
    tickerEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tickerRows]);

  // Stop when tab hidden or device disconnects
  useEffect(() => {
    if (!isActive || !connected) {
      if (runningRef.current) void stop();
      else { dataOffRef.current?.(); dataOffRef.current = null; }
    }
  }, [isActive, connected, running, stop]);

  // Redraw on config change
  useEffect(() => { if (!running) draw(); }, [draw, running]);

  // Redraw when pan/zoom, cursors, or decoder config/rows change
  useEffect(() => { if (!running) draw(); }, [draw, running, zoomSamples, panSample, showCursors, cursorA, cursorB, decoderTab, uartCfg, i2cCfg, spiCfg, frozenKey]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const updateChannel = (id: number, patch: Partial<LaChannel>) => {
    setChannels(prev => {
      const next = prev.map(c => c.id === id ? { ...c, ...patch } : c);
      saveChannels(next);
      return next;
    });
  };

  const moveChannel = (fromIndex: number, toIndex: number) => {
    setChannels(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      saveChannels(next);
      return next;
    });
  };

  const resetChannels = () => {
    const next = Array.from({ length: 16 }, (_, i) => ({
      id: i,
      label: `D${i}`,
      color: CHANNEL_COLORS[i],
      enabled: true,
      visible: true,
      decoder: null,
    }));
    setChannels(next);
    saveChannels(next);
  };

  // W1 — CSV export
  const exportCsv = useCallback(() => {
    const frozen = frozenBufRef.current;
    if (!frozen || frozen.length === 0) return;
    const bps = liveWidthRef.current === 16 ? 2 : 1;
    const rate = liveRateRef.current;
    const nSamples = Math.floor(frozen.length / bps);
    const header = ["sample", "time_us", ...Array.from({ length: 16 }, (_, i) => `ch${i}`)].join(",");
    const rows: string[] = [header];
    for (let i = 0; i < nSamples; i++) {
      const word = bps === 2
        ? (frozen[i * 2] | (frozen[i * 2 + 1] << 8))
        : frozen[i];
      const timeUs = ((i / rate) * 1_000_000).toFixed(3);
      const bits = Array.from({ length: 16 }, (_, b) => (word >> b) & 1);
      rows.push([i, timeUs, ...bits].join(","));
    }
    downloadBlob(new Blob([rows.join("\n")], { type: "text/csv" }), `waveforge-${makeTimestamp()}.csv`);
  }, []);

  // W2 — Screenshot → project captures folder
  const saveSnapshot = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const dataUrl = await canvasToPngDataUrl(canvas);
      const name = `waveforge-${Date.now()}.png`;
      const r = await fetch("/api/v1/waveforge/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin: "waveforge", value: dataUrl, name, timestamp: Date.now() / 1000, unit: "png", meta: {} })
      });
      if (!r.ok) throw new Error("Snapshot save failed");
      const j = await r.json();
      toast.success(`Saved ${j.filename}`);
      globalBus.emit("workspace.counts.refresh");
    } catch (err) {
      console.error("Snapshot save failed:", err);
      toast.error("Snapshot save failed");
    }
  }, []);

  // Frozen buffer navigation helpers
  const getFrozenTotalSamples = useCallback(() => {
    const bps = liveWidthRef.current === 16 ? 2 : 1;
    return Math.floor((frozenBufRef.current?.length ?? ringRef.current.count) / bps);
  }, []);

  const clampPan = useCallback((pan: number, zoom: number) => {
    const total = getFrozenTotalSamples();
    const maxPan = Math.max(0, total - zoom);
    return Math.max(0, Math.min(pan, maxPan));
  }, [getFrozenTotalSamples]);

  const sampleFromX = useCallback((x: number, pan: number, zoom: number, displayW: number) => {
    return Math.round(pan + ((x - DEFAULT_LABEL_WIDTH) / displayW) * zoom);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    if (runningRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const displayW = canvas.width - DEFAULT_LABEL_WIDTH;
    if (x < DEFAULT_LABEL_WIDTH) return; // ignore wheel over labels
    const total = getFrozenTotalSamples();
    if (total <= 100) return;
    const zoom = zoomSamplesRef.current ?? total;
    const pan = panSampleRef.current;
    const factor = e.deltaY < 0 ? 0.8 : 1.25; // zoom in on up, out on down
    const newZoom = Math.max(100, Math.min(Math.round(zoom * factor), total));
    const sampleUnderCursor = pan + ((x - DEFAULT_LABEL_WIDTH) / displayW) * zoom;
    let newPan = Math.round(sampleUnderCursor - ((x - DEFAULT_LABEL_WIDTH) / displayW) * newZoom);
    newPan = clampPan(newPan, newZoom);
    setZoomSamples(newZoom === total ? null : newZoom);
    setPanSample(newPan);
    e.preventDefault();
  }, [clampPan, getFrozenTotalSamples]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (runningRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const displayW = canvas.width - DEFAULT_LABEL_WIDTH;
    const total = getFrozenTotalSamples();
    const zoom = zoomSamplesRef.current ?? total;
    const pan = panSampleRef.current;

    // Cursor hit-test (10px tolerance)
    if (showCursorsRef.current) {
      const a = cursorARef.current.sample;
      const b = cursorBRef.current.sample;
      const aX = DEFAULT_LABEL_WIDTH + ((a - pan) / zoom) * displayW;
      const bX = DEFAULT_LABEL_WIDTH + ((b - pan) / zoom) * displayW;
      const hitA = Math.abs(x - aX) < 10;
      const hitB = Math.abs(x - bX) < 10;
      if (hitA || hitB) {
        if (hitA) setCursorA(prev => ({ ...prev, dragging: true }));
        if (hitB) setCursorB(prev => ({ ...prev, dragging: true }));
        return;
      }
    }

    // Pan drag (only if zoomed in)
    if (zoom < total) {
      isPanningRef.current = true;
      panStartRef.current = { x, pan };
    }
  }, [getFrozenTotalSamples, sampleFromX]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (runningRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const displayW = canvas.width - DEFAULT_LABEL_WIDTH;
    const total = getFrozenTotalSamples();
    const zoom = zoomSamplesRef.current ?? total;
    const pan = panSampleRef.current;
    const sample = Math.max(0, Math.min(sampleFromX(x, pan, zoom, displayW), total - 1));

    if (cursorARef.current.dragging) {
      setCursorA(prev => ({ ...prev, sample }));
    } else if (cursorBRef.current.dragging) {
      setCursorB(prev => ({ ...prev, sample }));
    } else if (isPanningRef.current && panStartRef.current) {
      const deltaPx = x - panStartRef.current.x;
      const deltaSamples = Math.round((deltaPx / displayW) * zoom);
      const newPan = clampPan(panStartRef.current.pan - deltaSamples, zoom);
      setPanSample(newPan);
    }
  }, [clampPan, getFrozenTotalSamples, sampleFromX]);

  const handleCanvasMouseUp = useCallback(() => {
    setCursorA(prev => ({ ...prev, dragging: false }));
    setCursorB(prev => ({ ...prev, dragging: false }));
    isPanningRef.current = false;
    panStartRef.current = null;
  }, []);

  const resetZoom = useCallback(() => {
    setZoomSamples(null);
    setPanSample(0);
  }, []);

  const zoomIn = useCallback(() => {
    const total = getFrozenTotalSamples();
    const zoom = zoomSamplesRef.current ?? total;
    const newZoom = Math.max(100, Math.round(zoom / 1.25));
    const center = panSampleRef.current + zoom / 2;
    let newPan = Math.round(center - newZoom / 2);
    newPan = clampPan(newPan, newZoom);
    setZoomSamples(newZoom === total ? null : newZoom);
    setPanSample(newPan);
  }, [clampPan, getFrozenTotalSamples]);

  const zoomOut = useCallback(() => {
    const total = getFrozenTotalSamples();
    const zoom = zoomSamplesRef.current ?? total;
    const newZoom = Math.min(total, Math.round(zoom * 1.25));
    const center = panSampleRef.current + zoom / 2;
    let newPan = Math.round(center - newZoom / 2);
    newPan = clampPan(newPan, newZoom);
    setZoomSamples(newZoom === total ? null : newZoom);
    setPanSample(newPan);
  }, [clampPan, getFrozenTotalSamples]);

  // Reset cursors to current visible window edges when enabling
  useEffect(() => {
    if (!showCursors) return;
    const total = getFrozenTotalSamples();
    const zoom = zoomSamplesRef.current ?? total;
    const pan = panSampleRef.current;
    setCursorA({ sample: pan, dragging: false });
    setCursorB({ sample: Math.max(pan, Math.min(total - 1, pan + zoom - 1)), dragging: false });
  }, [showCursors, getFrozenTotalSamples]);

  // Reset pan/zoom when capture starts
  useEffect(() => {
    if (running) { setZoomSamples(null); setPanSample(0); setTickerRows([]); }
  }, [running]);

  // Offline test pattern: synthetic capture with UART, I2C, and SPI traffic
  const loadTestPattern = useCallback(() => {
    if (runningRef.current) void stop();
    const rate = 1_000_000;
    liveRateRef.current = rate;
    liveWidthRef.current = 8;
    setSampleRate(rate);
    setWidth(8);
    frozenBufRef.current = generateLaTestPattern(rate, 1);
    setTickerRows([]);
    setRunning(false);
    setElapsedS(0);
    elapsedSRef.current = 0;
    setFrozenKey(k => k + 1);
    draw();
  }, [stop, draw]);

  // Persist decoder config
  useEffect(() => {
    saveDecoders({ tab: decoderTab, uart: uartCfg, i2c: i2cCfg, spi: spiCfg });
  }, [decoderTab, uartCfg, i2cCfg, spiCfg]);

  // Decode I2C/SPI from frozen buffer when tab/config changes
  const i2cRows = useMemo(() => {
    if (decoderTab !== "i2c" || running) return [];
    const buf = frozenBufRef.current;
    if (!buf || buf.length === 0) return [];
    return decodeI2C(buf, liveRateRef.current, i2cCfg.scl, i2cCfg.sda).slice(0, MAX_TICKER);
  }, [decoderTab, i2cCfg, frozenKey, running]);

  const spiRows = useMemo(() => {
    if (decoderTab !== "spi" || running) return [];
    const buf = frozenBufRef.current;
    if (!buf || buf.length === 0) return [];
    return decodeSPI(buf, liveRateRef.current, spiCfg.mosi, spiCfg.miso, spiCfg.sck, spiCfg.cs, spiCfg.mode, spiCfg.bits, spiCfg.csActiveLow).slice(0, MAX_TICKER);
  }, [decoderTab, spiCfg, frozenKey, running]);

  const tickerRowsRef = useRef(tickerRows);
  const i2cRowsRef = useRef(i2cRows);
  const spiRowsRef = useRef(spiRows);
  useEffect(() => { tickerRowsRef.current = tickerRows; }, [tickerRows]);
  useEffect(() => { i2cRowsRef.current = i2cRows; }, [i2cRows]);
  useEffect(() => { spiRowsRef.current = spiRows; }, [spiRows]);

  const ascii = (b: number) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".";

  // Format elapsed time as mm:ss.mmm
  const fmt = (s: number) => {
    const ms = Math.round(s * 1000);
    return `+${(ms / 1000).toFixed(3)}s`;
  };

  // Human-readable time for cursor panel
  const formatTime = (s: number) => {
    if (!isFinite(s)) return "—";
    const abs = Math.abs(s);
    if (abs < 1e-6) return `${(s * 1e9).toFixed(1)}ns`;
    if (abs < 1e-3) return `${(s * 1e6).toFixed(1)}µs`;
    if (abs < 1) return `${(s * 1e3).toFixed(2)}ms`;
    return `${s.toFixed(3)}s`;
  };

  // Human-readable frequency for cursor panel
  const formatFreq = (hz: number) => {
    if (!isFinite(hz) || hz <= 0) return "—";
    if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)}MHz`;
    if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)}kHz`;
    return `${hz.toFixed(1)}Hz`;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top pane: controls + canvas */}
      <div className="flex flex-col min-h-0" style={{ flex: "3 1 0", overflow: "hidden" }}>
      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap p-2 pb-1 shrink-0">
        <label className="text-fob-text-dim">Rate:</label>
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-xs"
          value={sampleRate}
          onChange={e => setSampleRate(Number(e.target.value))}
          disabled={running}
        >
          {SAMPLE_RATES.map(r => (
            <option key={r.hz} value={r.hz}
              disabled={r.eightBitOnly && width === 16}>
              {r.label}{r.eightBitOnly ? " (8-bit)" : ""}
            </option>
          ))}
        </select>

        <label className="text-fob-text-dim">Width:</label>
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-xs"
          value={width}
          onChange={e => setWidth(Number(e.target.value) as 8 | 16)}
          disabled={running}
        >
          <option value={16}>16-bit</option>
          <option value={8}>8-bit</option>
        </select>

        <label className="text-fob-text-dim">Time/div:</label>
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-xs"
          value={timebaseIdx}
          onChange={e => setTimebaseIdx(Number(e.target.value))}
          disabled={!running}
          title={running ? "Live window" : "Zoom with wheel/buttons when stopped"}
        >
          {TIMEBASE_PRESETS.map((p, i) => (
            <option key={i} value={i}>{p.label}</option>
          ))}
        </select>

        <div className="flex-1" />

        {!running && (
          <button onClick={loadTestPattern} className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border text-xs font-mono" title="Load synthetic UART/I2C/SPI capture">Pattern</button>
        )}

        {!running && frozenBufRef.current && frozenBufRef.current.length > 0 && (<>
          <button onClick={exportCsv} className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border text-xs font-mono">CSV</button>
          <button onClick={saveSnapshot} className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border text-xs font-mono" title="Save canvas to active NoteForge note">📷</button>
          <button
            onClick={() => setShowCursors(v => !v)}
            className={`px-2 py-1 rounded text-xs font-mono ${showCursors ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface hover:bg-fob-border"}`}
            title="Toggle cursors"
          >
            Cursors
          </button>
          <button onClick={resetZoom} className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border text-xs font-mono" title="Fit entire buffer">Fit</button>
          <button onClick={zoomIn} className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border text-xs font-mono" title="Zoom in">+</button>
          <button onClick={zoomOut} className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border text-xs font-mono" title="Zoom out">−</button>
          <label className="flex items-center gap-1 text-fob-text-dim text-xs cursor-pointer" title="Use buttons/scrollbar instead of wheel/drag">
            <input type="checkbox" checked={classicMode} onChange={e => setClassicMode(e.target.checked)} />
            Classic
          </label>
        </>)}

        {running && (
          <span className="text-fob-text-dim font-mono text-xs tabular-nums">
            {String(Math.floor(elapsedS / 60)).padStart(2, "0")}:{String(elapsedS % 60).padStart(2, "0")}s
          </span>
        )}
        {running
          ? <button onClick={stop}  className="px-3 py-1 rounded bg-fob-red text-fob-text font-bold">Stop</button>
          : <button onClick={start} disabled={!connected} className="px-3 py-1 rounded bg-fob-green hover:bg-fob-green/80 text-fob-accent-text disabled:opacity-40 font-bold">Run</button>
        }
      </div>

      {/* Channel controls */}
      <div className="flex flex-wrap gap-2 px-2 py-1 shrink-0 items-center">
        {channels.map((ch, i) => (
          <div
            key={ch.id}
            draggable
            onDragStart={e => {
              e.dataTransfer.setData("text/plain", String(i));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={e => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={e => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData("text/plain"));
              if (!isNaN(from) && from !== i) moveChannel(from, i);
            }}
            className="flex items-center px-2 py-1 rounded text-sm font-mono border select-none"
            style={{
              borderColor: ch.color,
              color:       ch.enabled ? ch.color : getComputedStyle(document.documentElement).getPropertyValue('--fob-border').trim(),
              background:  ch.enabled ? `${ch.color}18` : "transparent",
              opacity:     ch.visible ? 1 : 0.5,
            }}
          >
            <span className="cursor-grab active:cursor-grabbing text-base leading-none px-1" title="Drag to reorder">≡</span>
            <input
              type="text"
              value={ch.label}
              onChange={e => updateChannel(ch.id, { label: e.target.value.slice(0, 8) })}
              className="w-12 bg-transparent text-center text-sm focus:outline-none focus:ring-1 focus:ring-fob-border rounded"
              title="Click to rename"
            />
            <button
              onClick={() => updateChannel(ch.id, { visible: !ch.visible })}
              title={ch.visible ? "Hide trace" : "Show trace"}
              className="leading-none px-1.5 py-1 hover:bg-fob-border/50"
            >
              {ch.visible ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              )}
            </button>
            <button
              onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })}
              title={ch.enabled ? "Disable capture" : "Enable capture"}
              className="leading-none px-1.5 py-1 hover:bg-fob-border/50"
            >
              {ch.enabled ? "✅" : "⬜"}
            </button>
            {ch.decoder && <span className="text-base leading-none px-1" title={`Decoder: ${ch.decoder}`}>🔍</span>}
            {/* Fallback arrows for touch/RPi */}
            <button
              onClick={() => moveChannel(i, Math.max(0, i - 1))}
              disabled={i === 0}
              className="leading-none px-1.5 py-1 hover:bg-fob-border/50 disabled:opacity-30"
              title="Move up"
            >▲</button>
            <button
              onClick={() => moveChannel(i, Math.min(channels.length - 1, i + 1))}
              disabled={i === channels.length - 1}
              className="leading-none px-1.5 py-1 hover:bg-fob-border/50 disabled:opacity-30"
              title="Move down"
            >▼</button>
          </div>
        ))}
        <button
          onClick={resetChannels}
          className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border"
          title="Reset channel order and labels"
        >
          Reset
        </button>
      </div>

      {/* Canvas — fills remaining space in top pane */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <canvas
          ref={canvasRef}
          className="w-full rounded border border-fob-border min-h-0 cursor-crosshair flex-1"
          style={{ imageRendering: "pixelated" }}
          onWheel={handleWheel}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseUp}
        />

        {/* Cursor measurements panel */}
        {showCursors && (
          <div className="absolute top-1 left-1 z-10 rounded border border-fob-border bg-fob-surface/90 px-2 py-1 text-[10px] font-mono shadow pointer-events-none">
            <div className="flex gap-3">
              <span className="text-fob-red">A {formatTime(cursorA.sample / sampleRate)}</span>
              <span className="text-fob-blue">B {formatTime(cursorB.sample / sampleRate)}</span>
            </div>
            {cursorA.sample !== cursorB.sample && (
              <div className="flex gap-2 text-fob-text">
                <span>Δt {formatTime(Math.abs(cursorB.sample - cursorA.sample) / sampleRate)}</span>
                <span>1/Δt {formatFreq(sampleRate / Math.abs(cursorB.sample - cursorA.sample))}</span>
                <span>Δs {Math.abs(cursorB.sample - cursorA.sample)}</span>
              </div>
            )}
          </div>
        )}

        {/* Classic mode scrollbar */}
        {classicMode && !running && frozenBufRef.current && frozenBufRef.current.length > 0 && (() => {
          const total = Math.floor(frozenBufRef.current.length / (liveWidthRef.current === 16 ? 2 : 1));
          const zoom = zoomSamples ?? total;
          return zoom < total ? (
            <input
              type="range"
              min={0}
              max={total - zoom}
              value={Math.min(panSample, total - zoom)}
              onChange={e => setPanSample(Number(e.target.value))}
              className="w-full h-4 mt-1 accent-fob-orange cursor-pointer"
            />
          ) : null;
        })()}
      </div>
      </div>{/* end top pane */}

      {/* Decoders panel — bottom 40% */}
      <div className="flex flex-col border-t border-fob-border min-h-0" style={{ flex: "2 1 0" }}>
        {/* Tabs */}
        <div className="flex items-center gap-1 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0">
          {(["uart", "i2c", "spi"] as DecoderTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setDecoderTab(tab)}
              className={`px-2 py-0.5 rounded font-bold uppercase ${decoderTab === tab ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface hover:bg-fob-border text-fob-text-dim"}`}
            >
              {tab}
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={() => setTickerRows([])}
            className="px-2 py-0.5 rounded bg-fob-surface hover:bg-fob-border text-fob-text">
            Clear
          </button>
        </div>

        {/* UART controls + rows */}
        {decoderTab === "uart" && (
          <>
            <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0">
              <span className="text-fob-text-dim">Baud:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
                value={uartCfg.baud} onChange={e => setUartCfg(c => ({ ...c, baud: Number(e.target.value) }))}>
                {BAUDS.map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
              </select>
              <span className="text-fob-text-dim">CH:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={uartCfg.ch} onChange={e => setUartCfg(c => ({ ...c, ch: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">{running ? "Live" : "Frozen"}</span>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[11px] px-2 py-1 space-y-0">
              {tickerRows.length === 0 ? (
                <div className="text-fob-text-dim text-center mt-4">
                  {running ? `Listening on D${uartCfg.ch} @ ${uartCfg.baud.toLocaleString()} baud...` : "Start capture to see live decode, or switch to I2C/SPI for frozen decode"}
                </div>
              ) : (
                tickerRows.map((r, i) => (
                  <div key={i} className={`flex gap-3 leading-5 ${r.error ? "text-fob-red" : "text-fob-text"}`}>
                    <span className="text-fob-text-dim w-16 shrink-0">{fmt(r.ts)}</span>
                    <span className="text-fob-text-dim w-6 shrink-0">D{uartCfg.ch}</span>
                    <span className="font-bold w-14 shrink-0 text-fob-yellow">0x{r.byte.toString(16).padStart(2,"0").toUpperCase()}</span>
                    <span className="w-8 shrink-0">{r.byte}</span>
                    <span className="text-fob-green w-6 shrink-0">{ascii(r.byte)}</span>
                    {r.error && <span className="text-fob-red">⚠ framing</span>}
                  </div>
                ))
              )}
              <div ref={tickerEndRef} />
            </div>
          </>
        )}

        {/* I2C controls + rows */}
        {decoderTab === "i2c" && (
          <>
            <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
              <span className="text-fob-text-dim">SCL:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={i2cCfg.scl} onChange={e => setI2cCfg(c => ({ ...c, scl: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">SDA:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={i2cCfg.sda} onChange={e => setI2cCfg(c => ({ ...c, sda: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">Addr:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
                value={i2cCfg.addrBits} onChange={e => setI2cCfg(c => ({ ...c, addrBits: Number(e.target.value) as 7 | 8 }))}>
                <option value={7}>7-bit</option>
                <option value={8}>8-bit</option>
              </select>
              <span className="text-fob-text-dim">{running ? "Paused while running" : `Rows: ${i2cRows.length}`}</span>
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
                      {r.type === "byte" && r.addr !== undefined ? `ADDR ${r.addr.toString(16).padStart(2,"0").toUpperCase()}${r.rw === "read" ? "R" : "W"}`
                        : r.type === "byte" ? `DATA 0x${r.data?.toString(16).padStart(2,"0").toUpperCase() ?? "--"}`
                        : r.type.toUpperCase()}
                    </span>
                    {r.type === "byte" && r.data !== undefined && <span className="text-fob-text-dim">0x{r.data.toString(16).padStart(2,"0").toUpperCase()} {r.data}</span>}
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* SPI controls + rows */}
        {decoderTab === "spi" && (
          <>
            <div className="flex items-center gap-2 px-2 py-1 bg-fob-surface border-b border-fob-border text-xs shrink-0 flex-wrap">
              <span className="text-fob-text-dim">MOSI:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={spiCfg.mosi} onChange={e => setSpiCfg(c => ({ ...c, mosi: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">MISO:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={spiCfg.miso} onChange={e => setSpiCfg(c => ({ ...c, miso: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">SCK:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={spiCfg.sck} onChange={e => setSpiCfg(c => ({ ...c, sck: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">CS:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 w-14"
                value={spiCfg.cs} onChange={e => setSpiCfg(c => ({ ...c, cs: Number(e.target.value) }))}>
                {Array.from({length: 16}, (_, i) => <option key={i} value={i}>D{i}</option>)}
              </select>
              <span className="text-fob-text-dim">Mode:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
                value={spiCfg.mode} onChange={e => setSpiCfg(c => ({ ...c, mode: Number(e.target.value) as 0|1|2|3 }))}>
                {[0,1,2,3].map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="text-fob-text-dim">Bits:</span>
              <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
                value={spiCfg.bits} onChange={e => setSpiCfg(c => ({ ...c, bits: Number(e.target.value) as 8|16 }))}>
                <option value={8}>8</option>
                <option value={16}>16</option>
              </select>
              <label className="flex items-center gap-1 text-fob-text-dim cursor-pointer">
                <input type="checkbox" checked={spiCfg.csActiveLow} onChange={e => setSpiCfg(c => ({ ...c, csActiveLow: e.target.checked }))} />
                CS active low
              </label>
              <span className="text-fob-text-dim">{running ? "Paused while running" : `Rows: ${spiRows.length}`}</span>
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
                    <span className="text-fob-blue shrink-0">MOSI 0x{r.mosi?.toString(16).padStart(spiCfg.bits/4,"0").toUpperCase() ?? "--"}</span>
                    <span className="text-fob-green shrink-0">MISO 0x{r.miso?.toString(16).padStart(spiCfg.bits/4,"0").toUpperCase() ?? "--"}</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
