import { expect, it, vi } from 'vitest';
import { findTriggerIndex, renderNow, type RenderCtx } from './renderEngine';
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
