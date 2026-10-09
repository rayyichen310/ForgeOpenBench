import { expect, it, vi } from 'vitest';
import { handleAcquireMode, type AcquireCtx } from './acquireModes';

function context(): AcquireCtx {
  const signal = Array.from({length: 4000}, (_, i) => i % 1000 < 500 ? 0 : 1);
  return {
    mode: 'running', sourceBuf: signal, ch1Buf: signal, ch2Buf: signal,
    nowPerf: 2000, vpp: 5, windowMs: 2,
    triggerRef: {current: {source:'ch1',level:2,slope:'rise',mode:'normal',coupling:'dc',holdoff:0}},
    horizontalRef: {current: {sDiv:0.0002,position:0,acquireMode:'normal',averageCount:2,rollMode:false}},
    sampleRateRef:{current:1e6},plotThrottleRef:{current:0},triggerArmedRef:{current:true},lastTriggerAtRef:{current:-Infinity},
    smartStateRef:{current:'auto'},smartTriggerCountRef:{current:0},smartMissCountRef:{current:0},rollingTriggerTimesRef:{current:[]},rollingLockedSnapRef:{current:null},
    avgAccumCountRef:{current:0},avgBuf1Ref:{current:[]},avgBuf2Ref:{current:[]},phosphorTracesRef:{current:[]},normalMissCountRef:{current:11},lastAutoLevelT0Ref:{current:0},
    renderNow:vi.fn(),setAcquireMode:vi.fn(),setTriggerLevel:vi.fn(),stop:vi.fn(),
  };
}

it('normal mode waits without replacing the user trigger level', () => {
  const ctx = context();
  handleAcquireMode(ctx);
  expect(ctx.setTriggerLevel).not.toHaveBeenCalled();
  expect(ctx.renderNow).not.toHaveBeenCalled();
});

it('single mode remains held after the asynchronous stop completes', async () => {
  const ctx=context(); ctx.mode='single-armed'; ctx.triggerRef.current.level=0.5;
  ctx.stop=async()=>{await Promise.resolve();ctx.setAcquireMode('stopped');};
  handleAcquireMode(ctx);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(ctx.setAcquireMode).toHaveBeenLastCalledWith('single-held');
});

it('the trigger-panel Single selection also captures once', async () => {
  const ctx=context(); ctx.triggerRef.current.mode='single'; ctx.triggerRef.current.level=0.5;
  handleAcquireMode(ctx); await Promise.resolve();
  expect(ctx.stop).toHaveBeenCalledOnce();
  expect(ctx.setAcquireMode).toHaveBeenLastCalledWith('single-held');
});

it('averages equally sized trigger-aligned windows when the rolling buffer grows', () => {
  const ctx = context(); ctx.mode = 'averaging'; ctx.triggerRef.current.level = 0.5;
  handleAcquireMode(ctx);
  ctx.ch1Buf = ctx.ch1Buf.concat(ctx.ch1Buf.slice(0,1000));
  ctx.ch2Buf = ctx.ch1Buf; ctx.sourceBuf = ctx.ch1Buf;
  handleAcquireMode(ctx);
  expect(ctx.renderNow).toHaveBeenCalledOnce();
  const values = vi.mocked(ctx.renderNow).mock.calls[0][0];
  expect(values).toHaveLength(2000);
  expect(values.every(Number.isFinite)).toBe(true);
  expect(values.every(v=>v===0 || v===1)).toBe(true);
});
