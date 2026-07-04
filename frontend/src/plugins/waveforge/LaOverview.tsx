import { useRef, useEffect, useCallback } from "react";
import type { LaChannel } from "./laChannelConfig";
import { CHANNEL_COLORS } from "./laChannelConfig";

interface Props {
  samples: Uint8Array;
  width: 8 | 16;
  channels: LaChannel[];
  zoomSamples?: number | null;
  panSample?: number;
  totalSamples: number;
  onPanChange?: (pan: number) => void;
}

const OVERVIEW_H = 64;

export function LaOverview(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; pan: number } | null>(null);

  const totalSamples = props.totalSamples;
  const zoom = Math.max(1, props.zoomSamples ?? totalSamples);
  const pan = Math.max(0, Math.min(props.panSample ?? 0, Math.max(totalSamples - zoom, 0)));

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = container.clientWidth;
    const cssH = OVERVIEW_H;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const visible = props.channels.filter(c => c.visible);
    const bps = props.width === 16 ? 2 : 1;
    const sPerPx = totalSamples / cssW;

    // Background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-surface").trim() || "#0b0c15";
    ctx.fillRect(0, 0, cssW, cssH);

    // Channel traces
    const count = Math.max(visible.length, 1);
    const rowH = cssH / count;
    visible.forEach((ch, i) => {
      const y = i * rowH + rowH * 0.5;
      const color = ch.enabled ? ch.color : CHANNEL_COLORS[ch.id];
      ctx.strokeStyle = color;
      ctx.lineWidth = ch.enabled ? 1.5 : 1;
      ctx.globalAlpha = ch.enabled ? 1 : 0.4;
      ctx.beginPath();

      let lastBit = -1;
      for (let px = 0; px < cssW; px++) {
        const s = Math.floor(px * sPerPx);
        if (s >= totalSamples) break;
        const off = s * bps;
        const lo = props.samples[off] ?? 0;
        const hi = bps === 2 ? (props.samples[off + 1] ?? 0) : 0;
        const v = (hi << 8) | lo;
        const bit = (v >> ch.id) & 1;
        const yHigh = y - rowH * 0.35;
        const yLow = y + rowH * 0.35;
        const py = bit ? yHigh : yLow;
        if (lastBit === -1) {
          ctx.moveTo(px, py);
        } else if (bit !== lastBit) {
          ctx.lineTo(px, lastBit ? yHigh : yLow);
          ctx.lineTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
        lastBit = bit;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Highlight current viewport
    const x = (pan / totalSamples) * cssW;
    const w = (zoom / totalSamples) * cssW;
    ctx.fillStyle = "rgba(59, 130, 246, 0.25)";
    ctx.fillRect(x, 0, w, cssH);
    ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, 0.5, w - 1, cssH - 1);
  }, [props, pan, totalSamples, zoom]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  const sampleFromX = (x: number) => {
    const cssW = containerRef.current?.clientWidth ?? 1;
    return Math.max(0, Math.min((x / cssW) * totalSamples, totalSamples - zoom));
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, pan };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const cssW = container.clientWidth;
    const dx = e.clientX - dragRef.current.x;
    const dSamples = (dx / cssW) * totalSamples;
    const newPan = Math.max(0, Math.min(dragRef.current.pan + dSamples, totalSamples - zoom));
    props.onPanChange?.(newPan);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const wasClick = Math.abs(e.clientX - dragRef.current.x) < 3;
    if (wasClick) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const newPan = Math.max(0, Math.min(sampleFromX(x) - zoom / 2, totalSamples - zoom));
        props.onPanChange?.(newPan);
      }
    }
    dragRef.current = null;
  };

  return (
    <div ref={containerRef} className="relative w-full h-[64px] overflow-hidden rounded border border-fob-border bg-fob-surface shrink-0 select-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        style={{ imageRendering: "pixelated" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </div>
  );
}
