import {expect, it} from 'vitest';
import {parseScopeSr, replayWindow, replayZero} from './scopeReplay';
import {captureZero} from './scopeZero';
import {storedZip} from './test-fixtures/storedZip';

const vertical = {enabled:true,vDiv:1,position:2,coupling:'dc' as const,probe:10 as const,invert:false,bwLimit:false};
const settings = {sampleRate:1e6,ch1Vertical:vertical,ch2Vertical:{...vertical,enabled:false},
  horizontal:{sDiv:0.0005,position:0,acquireMode:'normal',averageCount:4,rollMode:false},
  trigger:{source:'ch1',level:1.8,slope:'rise',mode:'auto',coupling:'dc',holdoff:0},
  math:{enabled:false,sourceA:'ch1',sourceB:'ch1',op:'div'},phosphorEnabled:false};
const floats = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);
const sr = () => storedZip({
  'scope-settings.json': new TextEncoder().encode(JSON.stringify({samples:4,sampleRate:1e6,capturedAt:'2026-10-10T05:00:00Z',settings})),
  'analog-1-1-1': floats([0.25, 0.5, 3.5, 3.75]), 'analog-1-2-1': floats([1, 2, 3, 4]),
});

it('restores the stored samples and settings without correction', async () => {
  const capture = await parseScopeSr(sr());
  expect(capture.ch1).toEqual([0.25, 0.5, 3.5, 3.75]);
  expect(capture.ch2).toEqual([1, 2, 3, 4]);
  expect(capture.settings).toEqual(settings);
  expect(capture.sampleRate).toBe(1e6);
});

it('keeps original sample times when a window is replayed', async () => {
  const held = replayWindow(await parseScopeSr(sr()), {startS: 1e-6, endS: 2e-6, timeZeroS: 2e-6});
  expect(held.ch1).toEqual([0.5, 3.5]);
  expect(held.timeOffsetS).toBeCloseTo(-1e-6, 15);
});

it('binds replay zero offsets to the capture conditions', async () => {
  const capture = await parseScopeSr(sr());
  const zero = replayZero(capture, {ch1: 0.25});
  expect(zero.ch2).toBeUndefined();
  const active = captureZero(zero, capture, capture.settings.ch1Vertical, capture.settings.ch2Vertical, 1e6);
  expect(active.ch1?.offsetVolts).toBe(0.25);
  expect(captureZero(zero, capture, {...vertical, probe:1 as const}, vertical, 1e6).ch1).toBeNull();
});

it('rejects files without Scope settings', async () => {
  await expect(parseScopeSr(storedZip({'analog-1-1-1': floats([1])}))).rejects.toThrow('scope-settings.json');
});
