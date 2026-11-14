import { expect, it, vi } from 'vitest';
import { findTriggerIndex, movingAverage, renderNow, xyPaths, type RenderCtx } from './renderEngine';
import type { TriggerState } from './scopeTypes';

it('aligns to the most recent crossing with enough post-trigger samples', () => {
  const signal = Array.from({length: 4000}, (_, i) => i % 1000 >= 250 ? 1 : 0);
  const trigger: TriggerState = {source: 'ch1', level: 0.5, slope: 'rise', mode: 'normal', coupling: 'dc', holdoff: 0};
  const index = findTriggerIndex(signal, trigger, 1e6, 2000);
  expect(index).toBe(2250);
  expect(signal.length - index).toBeGreaterThanOrEqual(1500);
});

it('peak detect preserves the time span and narrow impulses', () => {
  const plot = {width:500,batch:(fn:()=>void)=>fn(),setData:vi.fn(),setScale:vi.fn()};
  const ctx = {
    plotRef:{current:plot},overviewPlotRef:{current:null},viewMode:'time',sampleRateRef:{current:1e6},
    mathRef:{current:{enabled:false}},phosphorEnabledRef:{current:false},horizontalRef:{current:{acquireMode:'peak',rollMode:false,position:0}},
    triggerRef:{current:{level:999,slope:'rise',source:'ch1',coupling:'dc'}},ch1VerticalRef:{current:{position:0,vDiv:1}},ch2VerticalRef:{current:{position:0,vDiv:1}},
    windowMs:10,phosphorTracesRef:{current:[]},plotThrottleRef:{current:0},forceTriggerRef:{current:null},chunkTimesRef:{current:[]},renderCountRef:{current:0},renderRateT0Ref:{current:1},
  } as unknown as RenderCtx;
  const signal=Array.from({length:20000},(_,i)=>i===15555?1:0);
  renderNow(ctx,signal,signal,2);
  const [xs,ys]=plot.setData.mock.calls[0][0] as Float64Array[];
  expect(xs[xs.length-1]-xs[0]).toBeCloseTo(0.009999,6);
  expect(Math.max(...ys)).toBe(1);
});

it('keeps CAL aligned for every packet phase instead of alternating with free-running frames', () => {
  const trigger: TriggerState = {source:'ch1',level:0.5,slope:'rise',mode:'auto',coupling:'dc',holdoff:0};
  for (let phase=0;phase<1000;phase+=100) {
    const signal = Array.from({length:4000},(_,i)=>(i+phase)%1000>=500 ? 1 : 0);
    expect(findTriggerIndex(signal,trigger,1e6,2000)).toBeGreaterThanOrEqual(500);
  }
});

it('ranges XY over all samples when X reverses direction', () => {
  const plot = {width:500,batch:(fn:()=>void)=>fn(),setData:vi.fn(),setScale:vi.fn()};
  const ctx = {plotRef:{current:plot},viewMode:'xy',mathRef:{current:{sourceA:'ch1',sourceB:'ch1'}},
    phosphorEnabledRef:{current:false},plotThrottleRef:{current:0},forceTriggerRef:{current:null},chunkTimesRef:{current:[]}} as unknown as RenderCtx;
  renderNow(ctx,[2,0,1,2],[0,0,0,0],1);
  expect(plot.setScale).toHaveBeenCalledWith('x',expect.objectContaining({min:expect.any(Number),max:expect.any(Number)}));
  const range=plot.setScale.mock.calls.find(([key])=>key==='x')![1];
  expect(range.min).toBeLessThanOrEqual(0);
  expect(range.max).toBeGreaterThanOrEqual(2);
});

it('draws XY sample pairs in acquisition order, including decreasing X', () => {
  const points:number[][]=[];
  vi.stubGlobal('Path2D',class {moveTo(x:number,y:number){points.push([x,y]);} lineTo(x:number,y:number){points.push([x,y]);}});
  try {
    xyPaths({data:[[2,0,1,2],[2,0,1,2]],valToPos:(v:number)=>v*10} as never,1,0,3);
    expect(points).toEqual([[20,20],[0,0],[10,10],[20,20]]);
  } finally {vi.unstubAllGlobals();}
});

it('moving average of a PWM over one period gives duty times high level', () => {
  const pwm = Array.from({length: 400}, (_, i) => i % 100 < 30 ? 3 : 0);   // 30 % duty, period 100
  const avg = movingAverage(pwm, 100);
  expect(avg[0]).toBe(3);                       // partial window at the start
  for (let i = 99; i < 400; i++) expect(avg[i]).toBeCloseTo(0.9, 12);
});

it('Math avg uses the window in seconds at the sample rate', () => {
  const plot = {width:500,batch:(fn:()=>void)=>fn(),setData:vi.fn(),setScale:vi.fn()};
  const ctx = {
    plotRef:{current:plot},overviewPlotRef:{current:null},viewMode:'time',sampleRateRef:{current:1e6},
    mathRef:{current:{enabled:true,sourceA:'ch2',sourceB:'ch1',op:'avg',avgS:1e-4}},phosphorEnabledRef:{current:false},
    horizontalRef:{current:{acquireMode:'normal',rollMode:false,position:0}},
    triggerRef:{current:{level:999,slope:'rise',source:'ch1',coupling:'dc'}},ch1VerticalRef:{current:{position:0,vDiv:1}},ch2VerticalRef:{current:{position:0,vDiv:1}},
    windowMs:10,phosphorTracesRef:{current:[]},plotThrottleRef:{current:0},forceTriggerRef:{current:null},chunkTimesRef:{current:[]},renderCountRef:{current:0},renderRateT0Ref:{current:1},
  } as unknown as RenderCtx;
  const ch2 = Array.from({length: 1000}, (_, i) => i % 100 < 25 ? 2 : 0);   // 25 % duty, 100 samples = 1e-4 s
  renderNow(ctx, new Array(1000).fill(0), ch2, 2);
  const ysM = plot.setData.mock.calls[0][0][3] as Float64Array;
  expect(ysM[999]).toBeCloseTo(0.5, 12);
});
