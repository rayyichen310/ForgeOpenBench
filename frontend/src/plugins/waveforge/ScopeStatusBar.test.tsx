import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ScopeStatusBar, formatSeconds } from './ScopeStatusBar';
import type { TriggerState, VerticalState } from './scopeTypes';

const ch: VerticalState = {enabled:true,vDiv:0.5,position:4,coupling:'dc',probe:10,invert:false,bwLimit:false};
const trigger: TriggerState = {source:'ch1',level:1.6,slope:'rise',mode:'normal',coupling:'dc',holdoff:0};

it('shows channel, timebase, delay, trigger and run state like a bench scope', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const container=document.createElement('div');
  const root=createRoot(container);
  try {
    await act(async()=>root.render(<ScopeStatusBar ch1={ch} ch2={{...ch,enabled:false,vDiv:1,coupling:'ac',probe:1}}
      zeroActive={{ch1:true,ch2:true}} sDiv={2e-8} delayS={-4e-9} sampleRateLabel="48 MS/s" trigger={trigger} running={false}/>));
    const [ch1,ch2]=[...container.querySelectorAll('[data-channel]')].map(e=>e.textContent);
    expect(ch1).toBe('1500mV/divDC10XZ');
    expect(ch2).toBe('21.0V/divAC1X');   // a disabled channel never shows the zero mark
    expect(container.textContent).toContain('H 20ns/div 48 MS/s');
    expect(container.textContent).toContain('D -4ns');
    expect(container.textContent).toContain('T 1 ↑ 1.60V Norm');
    expect(container.textContent).toContain('STOP');
  } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});

it('formats delays with SI prefixes', () => {
  expect(formatSeconds(0)).toBe('0s');
  expect(formatSeconds(2.5e-5)).toBe('25µs');
  expect(formatSeconds(-0.0012)).toBe('-1.2ms');
});
