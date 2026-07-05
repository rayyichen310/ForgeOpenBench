import { useRef, useEffect, useCallback, useState } from "react";
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
  channelLabels?: string[];
  onPanChange?: (pan: number) => void;
  onZoomChange?: (zoom: number | null) => void;
  onCursorAChange?: (sample: number) => void;
  onCursorBChange?: (sample: number) => void;
  onMouseSampleChange?: (sample: number) => void;
  onPacketClick?: (sample: number) => void;
}

const LABEL_WIDTH = DEFAULT_LABEL_WIDTH;
const CH_GAP = 4;
const RULER_H = 22;
const MIN_ROW_H = 44;

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
  const cursorDragRef = useRef<"A" | "B" | null>(null);
  const mouseSampleRef = useRef(0);
  const overlayRectsRef = useRef<Array<{ x: number; y: number; w: number; h: number; sample: number; text: string }>>([]);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const shiftRef = useRef(false);
  const selectionRef = useRef<{ startX: number; currentX: number } | null>(null);

  useEffect(() => {
    zoomRef.current = props.zoomSamples ?? null;
    wheelZoomRef.current = props.zoomSamples ?? null;
  }, [props.zoomSamples]);
  useEffect(() => {
    panRef.current = props.panSample;
    wheelPanRef.current = props.panSample ?? 0;
  }, [props.panSample]);
  useEffect(() => { onZoomRef.current = props.onZoomChange; }, [props.onZoomChange]);
  useEffect(() => { onPanRef.current = props.onPanChange; }, [props.onPanChange]);
  const onCursorARef = useRef(props.onCursorAChange);
  const onCursorBRef = useRef(props.onCursorBChange);
  const onMouseSampleRef = useRef(props.onMouseSampleChange);
  const onPacketClickRef = useRef(props.onPacketClick);
  useEffect(() => { onCursorARef.current = props.onCursorAChange; }, [props.onCursorAChange]);
  useEffect(() => { onCursorBRef.current = props.onCursorBChange; }, [props.onCursorBChange]);
  useEffect(() => { onMouseSampleRef.current = props.onMouseSampleChange; }, [props.onMouseSampleChange]);
  useEffect(() => { onPacketClickRef.current = props.onPacketClick; }, [props.onPacketClick]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") shiftRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shiftRef.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sample: number } | null>(null);

  const getChannelY = (idx: number, h: number) => {
    const used = props.channels.filter(c => c.visible);
    const count = Math.max(used.length, 1);
    const plotH = h - RULER_H - CH_GAP;
    const rowH = Math.max(MIN_ROW_H, plotH / count);
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

    // Label column background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-surface").trim() || "#141520";
    ctx.fillRect(0, RULER_H, LABEL_WIDTH, H - RULER_H);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim() || "#2a2d3e";
    ctx.beginPath();
    ctx.moveTo(LABEL_WIDTH, RULER_H);
    ctx.lineTo(LABEL_WIDTH, H);
    ctx.stroke();

    // Shift-drag selection rectangle
    const selection = selectionRef.current;
    if (selection) {
      const left = Math.min(selection.startX, selection.currentX);
      const right = Math.max(selection.startX, selection.currentX);
      ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1;
      ctx.fillRect(left, RULER_H, right - left, H - RULER_H);
      ctx.strokeRect(left + 0.5, RULER_H + 0.5, right - left - 1, H - RULER_H - 1);
    }

    // Faint vertical gridlines
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim() || "#2a2d3e";
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    for (let i = 1; i < divCount; i++) {
      const x = LABEL_WIDTH + (plotW * i) / divCount;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Channel traces
    visible.forEach((ch, i) => {
      const { y, rowH } = getChannelY(i, H);
      const color = ch.enabled ? ch.color : CHANNEL_COLORS[ch.id];
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-text").trim() || "#e5e7eb";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const label = props.channelLabels?.[ch.id] || ch.label || `D${ch.id}`;
      ctx.fillText(label, LABEL_WIDTH - 8, y);

      ctx.strokeStyle = color;
      ctx.lineWidth = ch.enabled ? 2 : 1;
      ctx.globalAlpha = ch.enabled ? 1 : 0.4;
      ctx.beginPath();

      const yHigh = y - rowH * 0.35;
      const yLow = y + rowH * 0.35;
      const chMask = 1 << ch.id;
      const sampleCount = props.samples.length / bps;
      const samples = props.samples;
      const panLocal = pan;
      const bpsLocal = bps;

      let lastBit = -1;
      for (let px = 0; px < plotW; px++) {
        const sStart = Math.floor(panLocal + px * sPerPx);
        const sEnd = Math.min(Math.floor(panLocal + (px + 1) * sPerPx), totalSamples);
        if (sStart >= totalSamples) break;
        if (sEnd <= sStart) continue;

        const firstOff = (sStart - panLocal) * bpsLocal;
        const firstLo = samples[firstOff] ?? 0;
        const firstHi = bpsLocal === 2 ? (samples[firstOff + 1] ?? 0) : 0;
        const firstBit = ((firstHi << 8) | firstLo) & chMask ? 1 : 0;

        const lastOff = (sEnd - 1 - panLocal) * bpsLocal;
        const lastLo = samples[lastOff] ?? 0;
        const lastHi = bpsLocal === 2 ? (samples[lastOff + 1] ?? 0) : 0;
        const lastBitPx = ((lastHi << 8) | lastLo) & chMask ? 1 : 0;

        let hasHigh = firstBit === 1 || lastBitPx === 1;
        let hasLow = firstBit === 0 || lastBitPx === 0;

        // When a pixel spans many samples, scan a few interior points so narrow pulses are not lost.
        if (!hasHigh || !hasLow) {
          const count = sEnd - sStart;
          const step = Math.max(1, Math.floor(count / 16));
          for (let s = sStart + step; s < sEnd - 1 && s < panLocal + sampleCount; s += step) {
            const off = (s - panLocal) * bpsLocal;
            const lo = samples[off] ?? 0;
            const hi = bpsLocal === 2 ? (samples[off + 1] ?? 0) : 0;
            const bit = ((hi << 8) | lo) & chMask ? 1 : 0;
            if (bit) hasHigh = true;
            else hasLow = true;
            if (hasHigh && hasLow) break;
          }
        }

        const x = LABEL_WIDTH + px;
        if (lastBit === -1) {
          ctx.moveTo(x, firstBit ? yHigh : yLow);
        } else if (firstBit !== lastBit) {
          ctx.lineTo(x, lastBit ? yHigh : yLow);
          ctx.lineTo(x, firstBit ? yHigh : yLow);
        } else {
          ctx.lineTo(x, firstBit ? yHigh : yLow);
        }

        if (hasHigh && hasLow) {
          // Activity is compressed inside this pixel column; draw a vertical band.
          ctx.lineTo(x, yHigh);
          ctx.lineTo(x, yLow);
          ctx.lineTo(x, lastBitPx ? yHigh : yLow);
          lastBit = lastBitPx;
        } else {
          lastBit = firstBit;
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Packet overlays
    overlayRectsRef.current = [];
    const drawPacket = (startSample: number, endSample: number, chIdx: number, text: string, color: string, error = false) => {
      if (endSample < pan || startSample > pan + zoom) return;
      const x1 = LABEL_WIDTH + ((Math.max(startSample, pan) - pan) / zoom) * plotW;
      const x2 = LABEL_WIDTH + ((Math.min(endSample, pan + zoom) - pan) / zoom) * plotW;
      const { y } = getChannelY(chIdx, H);
      const h = 16;
      const top = y - h / 2;
      const w = Math.max(x2 - x1, 14);
      ctx.fillStyle = error ? "rgba(239, 68, 68, 0.18)" : color + "18";
      ctx.strokeStyle = error ? "#ef4444" : color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x1, top, w, h, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = error ? "#ef4444" : color;
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      if (w > 20) {
        ctx.fillText(text, x1 + 4, y);
      }
      overlayRectsRef.current.push({ x: x1, y: top, w, h, sample: startSample, text });
    };

    if (props.decoderTab === "uart" && props.decoderRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderChannel);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderChannel ?? 0];
        props.decoderRows.forEach(r => {
          drawPacket(r.sample, r.endSample, chIdx, `0x${r.byte.toString(16).padStart(2, "0").toUpperCase()}`, color, r.error);
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
          if (r.type === "start") drawPacket(r.startSample, r.endSample, idx, "START", color);
          else if (r.type === "repeated-start") drawPacket(r.startSample, r.endSample, idx, "R-START", color);
          else if (r.type === "stop") drawPacket(r.startSample, r.endSample, idx, "STOP", color);
          else if (r.type === "byte" && r.addr !== undefined) drawPacket(r.startSample, r.endSample, idx, `A${r.addr.toString(16).padStart(2, "0")}${r.rw === "read" ? "R" : "W"}`, color);
          else if (r.type === "byte" && r.data !== undefined) drawPacket(r.startSample, r.endSample, idx, `0x${r.data.toString(16).padStart(2, "0")}`, color);
          else if (r.type === "ack") drawPacket(r.startSample, r.endSample, idx, "ACK", color);
          else if (r.type === "nack") drawPacket(r.startSample, r.endSample, idx, "NACK", color, true);
        });
      }
    }
    if (props.decoderTab === "spi" && props.spiRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderMosi);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderMosi ?? 0];
        const digits = 8 / 4;
        props.spiRows.forEach(r => {
          if (r.mosi !== undefined) drawPacket(r.startSample, r.endSample, chIdx, `M0x${r.mosi.toString(16).padStart(digits, "0").toUpperCase()}`, color);
          else if (r.miso !== undefined) drawPacket(r.startSample, r.endSample, chIdx, `S0x${r.miso.toString(16).padStart(digits, "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "can" && props.canRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderCan);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderCan ?? 0];
        props.canRows.forEach(r => {
          const label = `${r.extended ? "Ext" : "Std"} ID 0x${r.id.toString(16).toUpperCase()} ${r.data.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`;
          drawPacket(r.startSample, r.endSample, chIdx, label, color, r.error);
        });
      }
    }
    if (props.decoderTab === "onewire" && props.oneWireRows) {
      const chIdx = visible.findIndex(c => c.id === props.decoderOneWire);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderOneWire ?? 0];
        props.oneWireRows.forEach(r => {
          if (r.type === "reset") drawPacket(r.startSample, r.endSample, chIdx, "RST", color);
          else if (r.type === "presence") drawPacket(r.startSample, r.endSample, chIdx, "PRES", color);
          else if (r.type === "byte" && r.value !== undefined) drawPacket(r.startSample, r.endSample, chIdx, `0x${r.value.toString(16).padStart(2, "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "swd" && props.swdRows && props.decoderSwd) {
      const chIdx = visible.findIndex(c => c.id === props.decoderSwd?.swdio);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderSwd.swdio];
        props.swdRows.forEach(r => {
          if (r.type === "reset") drawPacket(r.startSample, r.endSample, chIdx, "RST", color);
          else if (r.type === "request") drawPacket(r.startSample, r.endSample, chIdx, `${r.read ? "R" : "W"}${r.apnDp === 1 ? "AP" : "DP"} 0x${r.addr!.toString(16)}`, color);
          else if (r.type === "data" && r.data !== undefined) drawPacket(r.startSample, r.endSample, chIdx, `0x${r.data.toString(16).padStart(8, "0").toUpperCase()}`, color, r.ok === false);
        });
      }
    }
    if (props.decoderTab === "jtag" && props.jtagRows && props.decoderJtag) {
      const tmsChIdx = visible.findIndex(c => c.id === props.decoderJtag?.tms);
      if (tmsChIdx >= 0) {
        const color = visible[tmsChIdx]?.color || CHANNEL_COLORS[props.decoderJtag.tms];
        props.jtagRows.forEach(r => {
          if (r.type === "reset") drawPacket(r.startSample, r.endSample, tmsChIdx, "RST", color);
          else if (r.type === "state") drawPacket(r.startSample, r.endSample, tmsChIdx, r.state ?? "", color);
          else if (r.type === "shift" && r.tdi !== undefined) drawPacket(r.startSample, r.endSample, tmsChIdx, `${r.register} 0x${r.tdi.toString(16).padStart(Math.ceil((r.bits ?? 1) / 4), "0").toUpperCase()}`, color);
        });
      }
    }
    if (props.decoderTab === "modbus" && props.modbusRows && props.decoderModbus) {
      const chIdx = visible.findIndex(c => c.id === props.decoderModbus?.ch);
      if (chIdx >= 0) {
        const color = visible[chIdx]?.color || CHANNEL_COLORS[props.decoderModbus.ch];
        props.modbusRows.forEach(r => {
          const label = `A${r.addr} F${r.func.toString(16).padStart(2, "0").toUpperCase()} ${r.data.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`;
          drawPacket(r.startSample, r.endSample, chIdx, label, color, !r.crcOk);
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

      // Measurement rail at the bottom
      const railH = 18;
      const railY = H - railH - 2;
      const readout = `A ${formatTime(props.cursorA / props.sampleRate)}   B ${formatTime(props.cursorB / props.sampleRate)}   Δt ${formatTime(Math.abs(props.cursorB - props.cursorA) / props.sampleRate)}`;
      ctx.font = "10px monospace";
      const rw = ctx.measureText(readout).width + 12;
      ctx.fillStyle = "rgba(11, 12, 21, 0.9)";
      ctx.fillRect(LABEL_WIDTH + 4, railY, rw, railH);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim() || "#2a2d3e";
      ctx.strokeRect(LABEL_WIDTH + 4.5, railY + 0.5, rw - 1, railH - 1);
      ctx.fillStyle = "#e5e7eb";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(readout, LABEL_WIDTH + 10, railY + 4);

      // Small markers at the rail for each cursor
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("A", xA, railY + 3);
      ctx.fillStyle = "#3b82f6";
      ctx.fillText("B", xB, railY + 3);
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
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("T", x + 2, RULER_H + 4);
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
  }, [scheduleDraw, props.samples, props.channels, props.cursorA, props.cursorB, props.triggerSample, props.showCursors, props.channelLabels]);

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

  const sampleFromX = (x: number) => {
    const zoom = zoomRef.current ?? totalSamples;
    const pan = panRef.current ?? 0;
    const plotW = Math.max(1, (canvasRef.current?.clientWidth || 0) - LABEL_WIDTH);
    const px = Math.max(0, Math.min(x - LABEL_WIDTH, plotW));
    return Math.round(pan + (px / plotW) * zoom);
  };

  const cursorNearX = (x: number) => {
    if (!props.showCursors) return null;
    const zoom = zoomRef.current ?? totalSamples;
    const pan = panRef.current ?? 0;
    const plotW = Math.max(1, (canvasRef.current?.clientWidth || 0) - LABEL_WIDTH);
    const threshold = 6;
    if (props.cursorA !== undefined) {
      const xA = LABEL_WIDTH + ((props.cursorA - pan) / zoom) * plotW;
      if (Math.abs(x - xA) < threshold) return "A";
    }
    if (props.cursorB !== undefined) {
      const xB = LABEL_WIDTH + ((props.cursorB - pan) / zoom) * plotW;
      if (Math.abs(x - xB) < threshold) return "B";
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    if (shiftRef.current) {
      selectionRef.current = { startX: x, currentX: x };
      return;
    }
    const near = cursorNearX(x);
    if (near) {
      cursorDragRef.current = near;
      return;
    }
    const hit = overlayRectsRef.current.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (hit) {
      onPacketClickRef.current?.(hit.sample);
      return;
    }
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, pan: panRef.current ?? 0 };
    dragDxRef.current = 0;
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const sample = sampleFromX(x);
    mouseSampleRef.current = sample;
    onMouseSampleRef.current?.(sample);

    const hit = overlayRectsRef.current.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    setTooltip(hit ? { x, y, text: hit.text } : null);

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = shiftRef.current ? "cell" : cursorNearX(x) ? "ew-resize" : hit ? "pointer" : "crosshair";
    }

    if (selectionRef.current) {
      selectionRef.current.currentX = x;
      scheduleDraw();
      return;
    }

    if (cursorDragRef.current) {
      const clamped = Math.max(0, Math.min(sample, totalSamples - 1));
      if (cursorDragRef.current === "A") onCursorARef.current?.(clamped);
      else onCursorBRef.current?.(clamped);
      return;
    }

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
    if (selectionRef.current) {
      const left = Math.min(selectionRef.current.startX, selectionRef.current.currentX);
      const right = Math.max(selectionRef.current.startX, selectionRef.current.currentX);
      selectionRef.current = null;
      if (right - left > 4) {
        const startSample = sampleFromX(left);
        const endSample = sampleFromX(right);
        const newZoom = Math.max(10, endSample - startSample);
        const newPan = Math.max(0, Math.min(startSample, totalSamples - newZoom));
        onZoomRef.current?.(newZoom === totalSamples ? null : newZoom);
        onPanRef.current?.(newPan);
      }
      return;
    }
    cursorDragRef.current = null;
    isPanningRef.current = false;
    panStartRef.current = null;
    dragDxRef.current = 0;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const sample = sampleFromX(x);
    setContextMenu({ x, y, sample });
  };
  const handleMenuDismiss = () => setContextMenu(null);
  const handleMenuFit = () => {
    onZoomRef.current?.(null);
    onPanRef.current?.(0);
    setContextMenu(null);
  };
  const handleMenuCursorA = () => {
    if (contextMenu) onCursorARef.current?.(Math.max(0, Math.min(contextMenu.sample, totalSamples - 1)));
    setContextMenu(null);
  };
  const handleMenuCursorB = () => {
    if (contextMenu) onCursorBRef.current?.(Math.max(0, Math.min(contextMenu.sample, totalSamples - 1)));
    setContextMenu(null);
  };

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden" onClick={handleMenuDismiss}>
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        style={{ imageRendering: "pixelated" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
      />
      {tooltip && (
        <div
          className="absolute z-10 pointer-events-none px-2 py-1 rounded border border-fob-border bg-fob-surface text-xs text-fob-text shadow"
          style={{ left: tooltip.x + 10, top: tooltip.y + 10 }}
        >
          {tooltip.text}
        </div>
      )}
      {contextMenu && (
        <div
          className="absolute z-20 rounded border border-fob-border bg-fob-surface shadow text-xs py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={handleMenuFit} className="w-full text-left px-3 py-1 hover:bg-fob-border text-fob-text">Fit entire capture</button>
          <button onClick={handleMenuCursorA} className="w-full text-left px-3 py-1 hover:bg-fob-border text-fob-text">Cursor A here</button>
          <button onClick={handleMenuCursorB} className="w-full text-left px-3 py-1 hover:bg-fob-border text-fob-text">Cursor B here</button>
        </div>
      )}
    </div>
  );
}
