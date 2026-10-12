import {expect, it} from 'vitest';
import {estimateZero, zeroOffset} from './scopeZero';
import type {ScopeCapture} from './scopeExport';

const vertical = {enabled:true,vDiv:0.5,position:0,coupling:'dc' as const,probe:10 as const,invert:false,bwLimit:false};
const capture = {
  sampleRate:1e6,capturedAt:'2026-10-10T05:00:00Z',
  ch1:Array.from({length:100},(_,i)=>i%2 ? 0.25 : 0.23), ch2:Array(100).fill(-0.1),
  settings:{sampleRate:1e6,ch1Vertical:vertical,ch2Vertical:vertical},
} as ScopeCapture;

it('estimates each channel from original GND samples without accumulating a prior correction',()=>{
  const ch1=estimateZero(capture,'ch1',vertical,1e6);
  expect(ch1.offsetVolts).toBeCloseTo(0.24,12);
  expect(estimateZero(capture,'ch2',vertical,1e6).offsetVolts).toBeCloseTo(-0.1,12);
  expect(ch1).toMatchObject({sampleRate:1e6,probe:10,hardwareRangeVpp:1,samples:100,capturedAt:capture.capturedAt});
  expect(capture.ch1[0]).toBe(0.23);
});

it('applies only to the same range, probe and sample rate',()=>{
  const profile=estimateZero(capture,'ch1',vertical,1e6);
  expect(zeroOffset(profile,vertical,1e6)).toBeCloseTo(0.24);
  expect(zeroOffset(profile,{...vertical,position:3,vDiv:0.1},1e6)).toBeCloseTo(0.24);
  expect(zeroOffset(profile,{...vertical,vDiv:1},1e6)).toBeCloseTo(0.24);
  expect(zeroOffset(profile,{...vertical,vDiv:2},1e6)).toBe(0);
  expect(zeroOffset(profile,{...vertical,probe:1},1e6)).toBe(0);
  expect(zeroOffset(profile,vertical,12e6)).toBe(0);
  expect(zeroOffset(undefined,vertical,1e6)).toBe(0);
});

it('rejects missing, short, non-DC and mismatched captures',()=>{
  expect(()=>estimateZero(null,'ch1',vertical,1e6)).toThrow(/capture/i);
  expect(()=>estimateZero({...capture,ch1:[0.2]},'ch1',vertical,1e6)).toThrow(/100/);
  expect(()=>estimateZero(capture,'ch1',{...vertical,coupling:'gnd'},1e6)).toThrow(/DC/);
  expect(()=>estimateZero({...capture,settings:{...capture.settings,ch1Vertical:{...vertical,coupling:'ac'}}},'ch1',vertical,1e6)).toThrow(/DC/);
  expect(()=>estimateZero(capture,'ch1',vertical,12e6)).toThrow(/settings/i);
  expect(()=>estimateZero(capture,'ch1',{...vertical,probe:1},1e6)).toThrow(/settings/i);
});

it('selects the saved profile for each channel under the current conditions',async()=>{
  const {selectZero}=await import('./scopeZero');
  const entry={device:'d',offsetVolts:0.24,hardwareRangeVpp:1,probe:10 as const,sampleRate:1e6,capturedAt:'2026-10-10T00:00:00Z',samples:4002};
  const store=[{...entry,channel:'ch1' as const},{...entry,channel:'ch2' as const,offsetVolts:0.21,sampleRate:12e6}];
  expect(selectZero(store,vertical,vertical,1e6)).toEqual({ch1:{offsetVolts:0.24,hardwareRangeVpp:1,probe:10,sampleRate:1e6,
    capturedAt:'2026-10-10T00:00:00Z',samples:4002}});
  expect(selectZero(store,vertical,vertical,12e6).ch2?.offsetVolts).toBe(0.21);
  expect(selectZero(store,{...vertical,probe:1},vertical,1e6)).toEqual({});
});

it('marks saved profiles older than 30 days for recalibration',async()=>{
  const {describeZero}=await import('./ZeroPanel');
  const profile={offsetVolts:0.2446,hardwareRangeVpp:1,probe:10,sampleRate:1e6,capturedAt:'2026-10-10T00:00:00Z',samples:4002};
  const day=86_400_000, at=Date.parse(profile.capturedAt);
  expect(describeZero({...profile,origin:'stored'},true,at+3*day)).toBe('subtract 0.2446 V (active; saved 2026-10-10, 3 d ago)');
  expect(describeZero({...profile,origin:'stored'},true,at+31*day)).toContain('older than 30 days, recalibrate');
  expect(describeZero({...profile,origin:'session'},true,at+31*day)).not.toContain('recalibrate');
});
