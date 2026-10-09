import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CursorsPanel } from './CursorsPanel';

it('uses frequency units for FFT cursors instead of seconds and reciprocal time', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const container=document.createElement('div');
  const root=createRoot(container);
  try {
    await act(async()=>root.render(<CursorsPanel enabled onToggle={()=>{}} cursorA={{x:1000,y:1}} cursorB={{x:1500,y:2}} viewMode="fft"/>));
    await act(async()=>container.querySelector('button')!.click());
    expect(container.textContent).toContain('f=1.00kHz');
    expect(container.textContent).toContain('Δf=500Hz');
    expect(container.textContent).not.toContain('ΔT=');
    expect(container.textContent).not.toContain('1/ΔT');
  } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
