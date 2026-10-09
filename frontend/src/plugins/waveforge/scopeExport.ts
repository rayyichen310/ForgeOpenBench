import type uPlot from "uplot";
import { makeTimestamp, downloadBlob } from "./exportUtils";

export function traceCsv(
  plot: uPlot | null,
  seriesNames: string[],
  viewMode: "time" | "fft" | "xy" = "time",
  seriesIndices: number[] = seriesNames.map((_, i) => i + 1)
): string {
  if (!plot || !plot.data || plot.data[0].length === 0) throw new Error('No captured trace to export');
  const xs = plot.data[0] as Float64Array | number[];
  const rows: string[] = [];
  const xLabel = viewMode === "fft" ? "frequency(hz)" : viewMode === "xy" ? "x" : "time(s)";
  const header = [xLabel, ...seriesNames].join(",");
  rows.push(header);
  const len = xs.length;
  for (let i = 0; i < len; i++) {
    const t = Array.isArray(xs) ? xs[i] : xs[i];
    const cells: (string | number)[] = [t.toExponential(6)];
    for (const s of seriesIndices) {
      const ys = plot.data[s] as Float64Array | number[];
      const v = ys && ys.length > i ? (Array.isArray(ys) ? ys[i] : ys[i]) : "";
      cells.push(typeof v === "number" ? v.toExponential(6) : "");
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n");
}

export function exportTraceCsv(plot: uPlot | null, seriesNames: string[], viewMode: "time" | "fft" | "xy" = "time", seriesIndices?: number[]): void {
  if (!plot || !plot.data || plot.data[0].length === 0) return;
  const blob = new Blob([traceCsv(plot, seriesNames, viewMode, seriesIndices)], { type: "text/csv" });
  downloadBlob(blob, `scope-trace-${makeTimestamp()}.csv`);
}

export function exportPlotPng(plot: uPlot | null, filename?: string): void {
  if (!plot) return;
  const canvas = plot.root.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, filename || `scope-screen-${makeTimestamp()}.png`);
  }, "image/png");
}
