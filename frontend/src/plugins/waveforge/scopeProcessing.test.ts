import { describe, expect, it } from 'vitest';
import { processChannel, triggerSamples } from './scopeProcessing';

describe('scope channel processing', () => {
  it('keeps DC values, grounds the trace, and removes AC offset', () => {
    const values = [2, 4, 2, 4];
    expect(processChannel(values, 'dc', false, false, 1e6)).toEqual(values);
    expect(processChannel(values, 'gnd', false, false, 1e6)).toEqual([0, 0, 0, 0]);
    expect(processChannel(values, 'ac', false, false, 1e6)).toEqual([-1, 1, -1, 1]);
    expect(processChannel(values, 'dc', true, false, 1e6)).toEqual([-2, -4, -2, -4]);
  });
  it('makes trigger coupling affect trigger input, not measured samples', () => {
    const raw = [2, 4, 2, 4];
    expect(triggerSamples(raw, 'ac', 1e6)).toEqual([-1, 1, -1, 1]);
    expect(raw).toEqual([2, 4, 2, 4]);
    expect(triggerSamples(raw, 'hfrej', 1e6)[1]).toBeLessThan(4);
  });
});
