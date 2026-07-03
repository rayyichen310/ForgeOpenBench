import { downloadBlob } from "./exportUtils";
import type { LaCapture } from "./laDecoders";

export type CsvExportMode = "row" | "transition";

export function exportLaCsv(capture: LaCapture, mode: CsvExportMode = "row"): string {
  const { sampleRate, width, samples } = capture;
  const labels = capture.channelLabels ?? Array.from({ length: width }, (_, i) => `D${i}`);
  if (mode === "transition") {
    const rows = [
      `# format: transition-only, samples: ${samples.length}, sampleRate: ${sampleRate}, width: ${width}`,
      "time,channel,value",
    ];
    let prev = 0;
    for (let s = 0; s < samples.length; s++) {
      const v = samples[s];
      if (v !== prev) {
        const time = (s / sampleRate).toExponential(12);
        for (let ch = 0; ch < width; ch++) {
          const bitNow = (v >> ch) & 1;
          const bitPrev = (prev >> ch) & 1;
          if (bitNow !== bitPrev) {
            rows.push(`${time},${labels[ch] ?? `D${ch}`},${bitNow}`);
          }
        }
        prev = v;
      }
    }
    return rows.join("\n");
  }
  // Row-per-sample
  const header = ["time", ...labels.slice(0, width)];
  const rows = [header.join(",")];
  for (let s = 0; s < samples.length; s++) {
    const v = samples[s];
    const row = [(s / sampleRate).toExponential(12)];
    for (let ch = 0; ch < width; ch++) row.push(String((v >> ch) & 1));
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

export function exportLaJson(capture: LaCapture): string {
  return JSON.stringify({
    source: capture.source,
    importedAt: capture.importedAt,
    sampleRate: capture.sampleRate,
    width: capture.width,
    channelLabels: capture.channelLabels,
    samples: bytesToBase64(capture.samples),
  }, null, 2);
}

export function downloadLaCapture(capture: LaCapture, filename: string, mode: CsvExportMode = "row") {
  let blob: Blob;
  let name: string;
  if (filename.endsWith(".json")) {
    blob = new Blob([exportLaJson(capture)], { type: "application/json" });
    name = filename;
  } else if (filename.endsWith(".csv")) {
    blob = new Blob([exportLaCsv(capture, mode)], { type: "text/csv" });
    name = filename;
  } else {
    blob = new Blob([exportLaCsv(capture, mode)], { type: "text/csv" });
    name = `${filename}.csv`;
  }
  downloadBlob(blob, name);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === "undefined"
    ? Buffer.from(binary, "binary").toString("base64")
    : btoa(binary);
}
