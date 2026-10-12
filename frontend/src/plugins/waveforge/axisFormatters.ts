import type uPlot from "uplot";

/** Ten screen divisions, like a scope graticule: lines stay fixed while the scale changes. */
export function divisionSplits(_u: uPlot, _axis: number, min: number, max: number): number[] {
  // Snap rounding residue to 0 so the centre line is not labelled "-0.00V".
  return Array.from({ length: 11 }, (_, i) => {
    const value = min + (max - min) * i / 10;
    return Math.abs(value) < Math.abs(max - min) * 1e-9 ? 0 : value;
  });
}

export function timeAxisValues(_u: uPlot, splits: number[]): string[] {
  const maxVal = Math.max(...splits.map(Math.abs));
  if (maxVal < 1e-6) return splits.map(v => `${(v * 1e9).toFixed(0)}ns`);
  if (maxVal < 1e-3) return splits.map(v => `${(v * 1e6).toFixed(1)}µs`);
  if (maxVal < 1)    return splits.map(v => `${(v * 1e3).toFixed(maxVal < 0.01 ? 2 : 1)}ms`);
  return splits.map(v => `${v.toFixed(2)}s`);
}

export function freqAxisValues(_u: uPlot, splits: number[]): string[] {
  const maxVal = Math.max(...splits);
  if (maxVal >= 1e6) return splits.map(v => `${(v / 1e6).toFixed(1)}MHz`);
  if (maxVal >= 1e3) return splits.map(v => `${(v / 1e3).toFixed(1)}kHz`);
  return splits.map(v => `${v.toFixed(0)}Hz`);
}

export function makeVoltAxisValues(vpp: number): (_u: uPlot, splits: number[]) => string[] {
  const useMV = vpp < 2;
  return (_u, splits) => {
    if (useMV) return splits.map(v => `${(v * 1e3).toFixed(0)}mV`);
    return splits.map(v => `${v.toFixed(2)}V`);
  };
}
