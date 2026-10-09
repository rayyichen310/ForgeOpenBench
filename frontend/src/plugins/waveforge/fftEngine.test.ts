import { expect, it } from 'vitest';
import { fftMagnitude, findFftPeaks } from './fftEngine';

it('locates a known 1kHz signal using the supplied sample rate', () => {
  const rate=128000;
  const signal=Array.from({length:4096},(_,i)=>Math.sin(2*Math.PI*1000*i/rate));
  const spectrum=fftMagnitude(signal,rate);
  const peaks=findFftPeaks(spectrum.freqs,spectrum.mags,1);
  expect(peaks[0].freq).toBe(1000);
  expect(peaks[0].mag).toBeCloseTo(0.5,8);
});
