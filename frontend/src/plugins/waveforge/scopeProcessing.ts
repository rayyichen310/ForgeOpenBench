import type { TriggerState, VerticalState } from './scopeTypes';

function lowPass(values: number[], cutoff: number, rate: number): number[] {
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoff / rate);
  let previous = values[0] ?? 0;
  return values.map(value => (previous += alpha * (value - previous)));
}

export function processChannel(values: number[], coupling: VerticalState['coupling'], invert: boolean, bwLimit: boolean, rate: number, zeroOffset = 0): number[] {
  if (coupling === 'gnd') return values.map(() => 0);
  const mean = coupling === 'ac' && values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const processed = values.map(value => (value - (coupling === 'ac' ? mean : zeroOffset)) * (invert ? -1 : 1));
  return bwLimit ? lowPass(processed, 20e6, rate) : processed;
}

export function triggerSamples(values: number[], coupling: TriggerState['coupling'], rate: number): number[] {
  if (coupling === 'ac') return processChannel(values, 'ac', false, false, rate);
  if (coupling === 'hfrej') return lowPass(values, 50e3, rate);
  if (coupling === 'lfrej') {
    const baseline = lowPass(values, 50e3, rate);
    return values.map((value, i) => value - baseline[i]);
  }
  return values;
}
