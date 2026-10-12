import {expect, it} from 'vitest';
import {parseScopeSr, replayWindow, replayZero} from './scopeReplay';
import {captureZero} from './scopeZero';

// Stored (uncompressed) ZIP, enough for unzipAll.
function storedZip(files: Record<string, Uint8Array>): ArrayBuffer {
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = new TextEncoder().encode(name);
    const lh = new Uint8Array(30 + n.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true); lh.set(n, 30);
    const cd = new Uint8Array(46 + n.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true); cd.set(n, 46);
    local.push(lh, data); central.push(cd); offset += lh.length + data.length;
  }
  const size = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const parts = [...local, ...central, eocd];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out.buffer;
}

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
