import { expect, it } from 'vitest';
import { validateScopePatch } from './scopeSettings';

it('accepts partial real-device settings and rejects unsupported sources or invalid values', () => {
  expect(() => validateScopePatch({sampleRate: 1e6, ch1Vertical: {probe: 10}, math: {enabled: true, op: 'fft'}})).not.toThrow();
  expect(() => validateScopePatch({sampleRate: 12345})).toThrow();
  expect(() => validateScopePatch({trigger: {source: 'ext'}})).toThrow();
  expect(() => validateScopePatch({trigger: {holdoff: -1}})).toThrow();
  expect(() => validateScopePatch({horizontal: {sDiv: NaN}})).toThrow();
  expect(() => validateScopePatch({unknown: 1})).toThrow();
});
