import { useRef, useEffect, useCallback } from "react";
import type { LaChannel } from "./laChannelConfig";
import { CHANNEL_COLORS, DEFAULT_LABEL_WIDTH } from "./laChannelConfig";
import type { DecoderTab, TickerRow, I2CFrame, SPIFrame } from "./laDecoders";

interface Props {
  samples: Uint8Array;
  sampleRate: number;
  width: 8 | 16;
  channels: LaChannel[];
  zoomSamples?: number | null;
  panSample?: number;
  decoderTab?: DecoderTab;
  decoderRows?: TickerRow[];
  i2cRows?: I2CFrame[];
  spiRows?: SPIFrame[];
  decoderChannel?: number;
  decoderSda?: number;
  decoderMosi?: number;
  showCursors?: boolean;
  cursorA?: number;
  cursorB?: number;
  onPanChange?: (pan: number) => void;
  onZoomChange?: (zoom: number | null) => void;
}

const LABEL_WIDTH = DEFAULT_LABEL_WIDTH;
const CH_GAP = 4;

function formatTime(s: number): string {
  if (!isFinite(s)) return "—";
  const abs = Math.abs(s);
  if (abs < 1e-6) return `${(s * 1e9).toFixed(1)}ns`;
  if (abs < 1e-3) return `${(s * 1e6).toFixed(1)}µs`;
  return `${(s * 1e3).toFixed(2)}ms`;
}

export function LaCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; pan: number } | null>(null);
  const totalSamples = Math.floor(props.samples.length / (props.width === 16 ? 2 : 1));

  const getChannelY = (idx: number, h: number) => {
    const used = props.channels.filter(c => c.visible);
    const count = Math.max(used.length, 1);
    const rowH = (h - CH_GAP) / count;
    const y = CH_GAP + idx * rowH + rowH * 0.5;
    return { y, rowH };
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW;
    const H = cssH;
    const plotW = Math.max(W - LABEL_WIDTH, 1);

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-surface").trim() || "#0b0c15";
    ctx.fillRect(0, 0, W, H);

    const visible = props.channels.filter(c => c.visible);
    const bps = props.width === 16 ? 2 : 1;
    const zoom = props.zoomSamples ?? totalSamples;
    const pan = Math.max(0, Math.min(props.panSample ?? 0, Math.max(totalSamples - zoom, 0)));
    const sPerPx = zoom / plotW;

    // Grid / time axis
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim() || "#2a2d3e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const x = LABEL_WIDTH + (plotW * i) / 10;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();

    // Channel traces
    visible.forEach((ch, i) => {
      const { y, rowH } = getChannelY(i, H);
      const color = ch.enabled ? ch.color : CHANNEL_COLORS[ch.id];
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-text-dim").trim() || "#6b7280";
      ctx.font = "10px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(ch.label || `D${ch.id}`, LABEL_WIDTH - 6, y);

      ctx.strokeStyle = color;
      ctx.lineWidth = ch.enabled ? 2 : 1;
      ctx.globalAlpha = ch.enabled ? 1 : 0.4;
      ctx.beginPath();

      let lastBit = -1;
      for (let px = 0; px < plotW; px++) {
        const s = Math.floor(pan + px * sPerPx);
        if (s >= totalSamples) break;
        const off = s * bps;
        const lo = props.samples[off] ?? 0;
        const hi = bps === 2 ? (props.samples[off + 1] ?? 0) : 0;
        const v = (hi << 8) | lo;
        const bit = (v >> ch.id) & 1;
        const yHigh = y - rowH * 0.35;
        const yLow = y + rowH * 0.35;
        const py = bit ? yHigh : yLow;
        const x = LABEL_WIDTH + px;
        if (lastBit === -1) {
          ctx.moveTo(x, py);
        } else if (bit !== lastBit) {
          ctx.lineTo(x, lastBit ? yHigh : yLow);
          ctx.lineTo(x, py);
        } else {
          ctx.lineTo(x, py);
        }
        lastBit = bit;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Decoder annotations
    const drawBubble = (sample: number, chIdx: number, text: string, color: string) => {
      if (sample < pan || sample > pan + zoom) return;
      const x = LABEL_WIDTH + ((sample - pan) / zoom) * plotW;
      const { y } = getChannelY(chIdx, H);
      ctx.fillStyle = color + "18";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x + 2, y - 11, ctx.measureText(text).width + 8, 14, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + 6, y - 4);
    };

    if (props.decoderTab === "uart" && props.decoderRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderChannel);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderChannel ?? 0];
        props.decoderRows.forEach(r => {
          drawBubble(r.sample, chIdx, `0x${r.byte.toString(16).padStart(2, "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "i2c" && props.i2cRows) {
      const sclIdx = visible.findIndex(c => c.id === props.decoderChannel);
      const sdaIdx = visible.findIndex(c => c.id === props.decoderSda);
      const idx = sdaIdx >= 0 ? sdaIdx : sclIdx;
      if (idx >= 0) {
        const color = visible[idx]?.color || CHANNEL_COLORS[props.decoderSda ?? 0];
        props.i2cRows.forEach(r => {
          if (r.type === "byte" && r.addr !== undefined) {
            drawBubble(r.startSample, idx, `A${r.addr.toString(16).padStart(2, "0")}${r.rw === "read" ? "R" : "W"}`, color);
          } else if (r.type === "byte" && r.data !== undefined) {
            drawBubble(r.startSample, idx, `0x${r.data.toString(16).padStart(2, "0")}`, color);
          }
        });
      }
    }
    if (props.decoderTab === "spi" && props.spiRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderMosi);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderMosi ?? 0];
        const digits = 8 / 4;
        props.spiRows.forEach(r => {
          if (r.mosi !== undefined) drawBubble(r.startSample, chIdx, `M0x${r.mosi.toString(16).padStart(digits, "0").toUpperCase()}`, color);
          else if (r.miso !== undefined) drawBubble(r.startSample, chIdx, `S0x${r.miso.toString(16).padStart(digits, "0").toUpperCase()}`, color);
        });
      }
    }

    // Cursors
    if (props.showCursors && props.cursorA !== undefined && props.cursorB !== undefined) {
      const xA = LABEL_WIDTH + ((props.cursorA - pan) / zoom) * plotW;
      const xB = LABEL_WIDTH + ((props.cursorB - pan) / zoom) * plotW;
      ctx.strokeStyle = "#ef4444";
      ctx.beginPath(); ctx.moveTo(xA, 0); ctx.lineTo(xA, H); ctx.stroke();
      ctx.strokeStyle = "#3b82f6";
      ctx.beginPath(); ctx.moveTo(xB, 0); ctx.lineTo(xB, H); ctx.stroke();
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(`A ${formatTime(props.cursorA / props.sampleRate)}`, xA + 2, 12);
      ctx.fillText(`B ${formatTime(props.cursorB / props.sampleRate)}`, xB + 2, H - 4);
      if (props.cursorA !== props.cursorB) {
        ctx.fillText(`Δt ${formatTime(Math.abs(props.cursorB - props.cursorA) / props.sampleRate)}`, xA + 2, 24);
      }
    }
  }, [props, totalSamples]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoom = props.zoomSamples ?? totalSamples;
    const pan = props.panSample ?? 0;
    const delta = e.deltaY > 0 ? 1.1 : 0.9;
    const newZoom = Math.max(10, Math.min(zoom * delta, totalSamples));
    const px = e.nativeEvent.offsetX - LABEL_WIDTH;
    const plotW = (canvasRef.current?.clientWidth || 0) - LABEL_WIDTH;
    const focusSample = pan + (Math.max(0, Math.min(px, plotW)) / Math.max(1, plotW)) * zoom;
    const newPan = Math.max(0, Math.min(focusSample - (px / Math.max(1, plotW)) * newZoom, totalSamples - newZoom));
    props.onZoomChange?.(newZoom === totalSamples ? null : newZoom);
    props.onPanChange?.(newPan);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, pan: props.panSample ?? 0 };
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanningRef.current || !panStartRef.current) return;
    const zoom = props.zoomSamples ?? totalSamples;
    const plotW = Math.max(1, (canvasRef.current?.clientWidth || 0) - LABEL_WIDTH);
    const dx = e.clientX - panStartRef.current.x;
    const dSamples = (dx / plotW) * zoom;
    props.onPanChange?.(Math.max(0, Math.min(panStartRef.current.pan - dSamples, totalSamples - zoom)));
  };
  const handleMouseUp = () => {
    isPanningRef.current = false;
    panStartRef.current = null;
  };

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        style={{ imageRendering: "pixelated" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}
