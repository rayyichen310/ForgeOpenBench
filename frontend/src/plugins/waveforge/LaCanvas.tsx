import { useRef, useEffect, useCallback } from "react";
import type { LaChannel } from "./laChannelConfig";
import { CHANNEL_COLORS, DEFAULT_LABEL_WIDTH } from "./laChannelConfig";
import type { DecoderTab, TickerRow, I2CFrame, SPIFrame, CANFrame, OneWireFrame, SWDFrame, JTAGFrame, ModbusFrame } from "./laDecoders";

interface Props {
  samples: Uint8Array;
  totalSamples: number;
  sampleRate: number;
  width: 8 | 16;
  channels: LaChannel[];
  zoomSamples?: number | null;
  panSample?: number;
  decoderTab?: DecoderTab;
  decoderRows?: TickerRow[];
  i2cRows?: I2CFrame[];
  spiRows?: SPIFrame[];
  canRows?: CANFrame[];
  oneWireRows?: OneWireFrame[];
  swdRows?: SWDFrame[];
  jtagRows?: JTAGFrame[];
  modbusRows?: ModbusFrame[];
  decoderChannel?: number;
  decoderSda?: number;
  decoderMosi?: number;
  decoderCan?: number;
  decoderOneWire?: number;
  decoderSwd?: { swdio: number; swclk: number };
  decoderJtag?: { tck: number; tms: number; tdi: number; tdo: number };
  decoderModbus?: { ch: number; baud: number; parity: "none" | "even" | "odd" };
  showCursors?: boolean;
  cursorA?: number;
  cursorB?: number;
  triggerSample?: number;
  onPanChange?: (pan: number) => void;
  onZoomChange?: (zoom: number | null) => void;
}

const LABEL_WIDTH = DEFAULT_LABEL_WIDTH;
const CH_GAP = 4;
const RULER_H = 22;

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
  const totalSamples = props.totalSamples;

  // Mutable refs for latest prop values (avoid stale closure in rAF callbacks)
  const zoomRef = useRef(props.zoomSamples);
  const panRef = useRef(props.panSample);
  const onZoomRef = useRef(props.onZoomChange);
  const onPanRef = useRef(props.onPanChange);
  // Local mutable zoom/pan for wheel handler — updated immediately so successive
  // wheel events never read stale prop values before React re-render arrives.
  const wheelZoomRef = useRef<number | null>(null);
  const wheelPanRef = useRef(0);
  const drawRafRef = useRef(0);
  const wheelAccumRef = useRef({ deltaY: 0, offsetX: 0, hasEvent: false });
  const wheelRafRef = useRef(0);
  const dragDxRef = useRef(0);
  const dragRafRef = useRef(0);

  useEffect(() => {
    zoomRef.current = props.zoomSamples;
    wheelZoomRef.current = props.zoomSamples;
  }, [props.zoomSamples]);
  useEffect(() => {
    panRef.current = props.panSample;
    wheelPanRef.current = props.panSample ?? 0;
  }, [props.panSample]);
  useEffect(() => { onZoomRef.current = props.onZoomChange; }, [props.onZoomChange]);
  useEffect(() => { onPanRef.current = props.onPanChange; }, [props.onPanChange]);

  const getChannelY = (idx: number, h: number) => {
    const used = props.channels.filter(c => c.visible);
    const count = Math.max(used.length, 1);
    const plotH = h - RULER_H - CH_GAP;
    const rowH = plotH / count;
    const y = RULER_H + CH_GAP + idx * rowH + rowH * 0.5;
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

    // Time ruler
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-surface").trim() || "#0b0c15";
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim() || "#2a2d3e";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(W, RULER_H - 0.5);
    ctx.stroke();
    const divCount = 10;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-text-dim").trim() || "#6b7280";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= divCount; i++) {
      const x = LABEL_WIDTH + (plotW * i) / divCount;
      const s = pan + (i / divCount) * zoom;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTime(s / props.sampleRate), x, RULER_H / 2);
    }

    // Grid
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim() || "#2a2d3e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= divCount; i++) {
      const x = LABEL_WIDTH + (plotW * i) / divCount;
      ctx.moveTo(x, RULER_H);
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
        const sampleInCapture = Math.floor(pan + px * sPerPx);
        if (sampleInCapture >= totalSamples) break;
        const s = sampleInCapture - pan; // index within the windowed buffer
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
    if (props.decoderTab === "can" && props.canRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderCan);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderCan ?? 0];
        props.canRows.forEach(r => {
          const label = r.extended ? `ExtID 0x${r.id.toString(16).toUpperCase()}` : `ID 0x${r.id.toString(16).toUpperCase()}`;
          drawBubble(r.startSample, chIdx, label, color);
          if (r.data.length > 0) {
            drawBubble(r.endSample, chIdx, r.data.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" "), color);
          }
        });
      }
    }
    if (props.decoderTab === "onewire" && props.oneWireRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderOneWire);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderOneWire ?? 0];
        props.oneWireRows.forEach(r => {
          if (r.type === "reset") drawBubble(r.startSample, chIdx, "RST", color);
          else if (r.type === "presence") drawBubble(r.startSample, chIdx, "PRES", color);
          else if (r.type === "byte" && r.value !== undefined) drawBubble(r.startSample, chIdx, `0x${r.value.toString(16).padStart(2, "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "swd" && props.swdRows && props.decoderSwd) {
      const chIdx = visible.findIndex(c => c.id === props.decoderSwd?.swdio);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderSwd.swdio];
        props.swdRows.forEach(r => {
          if (r.type === "reset") drawBubble(r.startSample, chIdx, "RST", color);
          else if (r.type === "request") drawBubble(r.startSample, chIdx, `${r.read ? "R" : "W"}${r.apnDp === 1 ? "AP" : "DP"} 0x${r.addr!.toString(16)}`, color);
          else if (r.type === "data" && r.data !== undefined) drawBubble(r.startSample, chIdx, `0x${r.data.toString(16).padStart(8, "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "jtag" && props.jtagRows && props.decoderJtag) {
      const tmsChIdx = visible.findIndex(c => c.id === props.decoderJtag?.tms);
      if (tmsChIdx >= 0) {
        const color = visible[tmsChIdx]?.color || CHANNEL_COLORS[props.decoderJtag.tms];
        props.jtagRows.forEach(r => {
          if (r.type === "reset") drawBubble(r.startSample, tmsChIdx, "RST", color);
          else if (r.type === "state") drawBubble(r.startSample, tmsChIdx, r.state ?? "", color);
          else if (r.type === "shift" && r.tdi !== undefined) drawBubble(r.startSample, tmsChIdx, `${r.register} 0x${r.tdi.toString(16).padStart(Math.ceil((r.bits ?? 1) / 4), "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "modbus" && props.modbusRows && props.decoderModbus) {
      const chIdx = visible.findIndex(c => c.id === props.decoderModbus?.ch);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderModbus.ch];
        props.modbusRows.forEach(r => {
          drawBubble(r.startSample, chIdx, `A${r.addr} F${r.func.toString(16).padStart(2, "0").toUpperCase()}`, color);
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

    // Trigger indicator
    if (props.triggerSample !== undefined) {
      const t = props.triggerSample;
      const x = LABEL_WIDTH + ((t - pan) / zoom) * plotW;
      const inView = t >= pan && t <= pan + zoom;
      const color = "#22c55e";
      if (inView) {
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("T", x + 2, 2);
      } else {
        ctx.fillStyle = color;
        const atLeft = t < pan;
        const ax = atLeft ? LABEL_WIDTH + 8 : W - 8;
        const ay = RULER_H + 6;
        ctx.beginPath();
        if (atLeft) {
          ctx.moveTo(ax + 6, ay); ctx.lineTo(ax, ay + 4); ctx.lineTo(ax + 6, ay + 8);
        } else {
          ctx.moveTo(ax - 6, ay); ctx.lineTo(ax, ay + 4); ctx.lineTo(ax - 6, ay + 8);
        }
        ctx.fill();
      }
    }
  }, [props, totalSamples]);

  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  const scheduleDraw = useCallback(() => {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      drawRef.current();
    });
  }, []);

  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw, props.samples, props.channels, props.cursorA, props.cursorB, props.triggerSample]);

  useEffect(() => {
    const handleResize = () => scheduleDraw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [scheduleDraw]);

  // Native wheel listener with { passive: false } so preventDefault works
  // Coalesced via rAF: multiple wheel events within one frame collapse to one update.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAccumRef.current.deltaY += e.deltaY;
      wheelAccumRef.current.offsetX = e.offsetX;
      wheelAccumRef.current.hasEvent = true;
      if (!wheelRafRef.current) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = 0;
          const acc = wheelAccumRef.current;
          if (!acc.hasEvent) return;
          // Use local mutable refs so successive wheel events compound smoothly
          // even before React prop updates arrive.
          const zoom = wheelZoomRef.current ?? zoomRef.current ?? totalSamples;
          const pan = wheelPanRef.current ?? panRef.current ?? 0;
          const dy = Math.abs(acc.deltaY);
          const factor = 1 + Math.min(dy / 50, 0.5); // 1.02–1.5x depending on scroll velocity
          const delta = acc.deltaY > 0 ? factor : 1 / factor;
          const newZoom = Math.max(10, Math.min(Math.round(zoom * delta), totalSamples));
          const plotW = Math.max(1, (canvasRef.current?.clientWidth || 0) - LABEL_WIDTH);
          // Clamp pointer position to the plot area so zoom-to-cursor is stable
          const pxRaw = acc.offsetX - LABEL_WIDTH;
          const px = Math.max(0, Math.min(pxRaw, plotW));
          // sample under the cursor before zoom
          const focusSample = pan + (px / plotW) * zoom;
          // keep that same sample under the same pixel after zoom
          const newPan = Math.round(Math.max(0, Math.min(focusSample - (px / plotW) * newZoom, totalSamples - newZoom)));
          wheelZoomRef.current = newZoom;
          wheelPanRef.current = newPan;
          onZoomRef.current?.(newZoom === totalSamples ? null : newZoom);
          onPanRef.current?.(newPan);
          acc.deltaY = 0;
          acc.hasEvent = false;
        });
      }
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [totalSamples]);

  const handleMouseDown = (e: React.MouseEvent) => {
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, pan: panRef.current ?? 0 };
    dragDxRef.current = 0;
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanningRef.current || !panStartRef.current) return;
    dragDxRef.current = e.clientX - panStartRef.current.x;
    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0;
        if (!isPanningRef.current || !panStartRef.current) return;
        const zoom = zoomRef.current ?? totalSamples;
        const plotW = Math.max(1, (canvasRef.current?.clientWidth || 0) - LABEL_WIDTH);
        const dSamples = (dragDxRef.current / plotW) * zoom;
        onPanRef.current?.(Math.round(Math.max(0, Math.min(panStartRef.current.pan - dSamples, totalSamples - zoom))));
      });
    }
  };
  const handleMouseUp = () => {
    isPanningRef.current = false;
    panStartRef.current = null;
    dragDxRef.current = 0;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
  };

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        style={{ imageRendering: "pixelated" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}
