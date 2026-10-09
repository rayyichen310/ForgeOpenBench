import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {WaveformDsoView} from './WaveformDsoView';
import type {UsbTransport} from './UsbTransport';
import type {UsbDataChunk} from './usbTypes';

vi.mock('uplot',()=>({default:class {
  width=600; data:number[][]=[]; scales={x:{min:0,max:1},y:{min:0,max:1}};
  constructor(_options:unknown,data:number[][]){this.data=data;}
  setData(data:number[][]){this.data=data;}
  setScale(){} destroy(){} redraw(){} setSize(){} batch(fn:()=>void){fn();}
}}));

it.each(['auto','single'])('AutoSet from stopped %s mode captures fresh data before reporting success',async mode=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  sessionStorage.clear();
  let control:(action:string,params:Record<string,unknown>)=>Promise<unknown>;
  let onData:((chunk:UsbDataChunk)=>void)|null=null;
  const data=Uint8Array.from({length:8000},(_,i)=>i%2===1?128:((Math.floor(i/2)%1000)<500?134:185));
  const transport={
    deviceInfo:{mode:'dso'},
    registerScope:(handler:typeof control)=>{control=handler;return ()=>{};},
    configure:vi.fn(async()=>{}),stop:vi.fn(async()=>{}),onStopped:()=>()=>{},
    onData:(handler:typeof onData)=>{onData=handler;return ()=>{onData=null;};},
    start:vi.fn(async()=>{setTimeout(()=>onData?.({data,rate:1e6,b64:''} as UsbDataChunk),10);}),
  };
  const root=createRoot(document.createElement('div'));
  try {
    await act(async()=>root.render(<WaveformDsoView transport={transport as unknown as UsbTransport} connected isActive resetting/>));
    await act(async()=>{await control!('stop',{});});
    await act(async()=>{await control!('set',{trigger:{mode}});});
    await act(async()=>{await control!('autoset',{});});
    expect(transport.start).toHaveBeenCalledOnce();
    expect((await control!('status',{}) as {acquireMode:string}).acquireMode).toBe('running');
    expect((await control!('status',{}) as {trigger:{mode:string}}).trigger.mode).toBe('auto');
  } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});

it('saves a preset without relying on native browser prompt dialogs',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  localStorage.clear(); sessionStorage.clear();
  const transport={registerScope:()=>()=>{},onStopped:()=>()=>{}};
  const container=document.createElement('div');
  const root=createRoot(container);
  try {
    await act(async()=>root.render(<WaveformDsoView transport={transport as unknown as UsbTransport} connected={false} isActive/>));
    await act(async()=>Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Save')!.click());
    expect(container.querySelector('select option[value="Setup"]')).not.toBeNull();
    await act(async()=>Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Export')!.click());
    expect(JSON.parse((container.querySelector('textarea[aria-label="Preset JSON"]') as HTMLTextAreaElement).value)[0].name).toBe('Setup');
    await act(async()=>Array.from(container.querySelectorAll('button')).filter(button=>button.textContent==='Import JSON').at(-1)!.click());
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('select option[value="Setup"]')).not.toBeNull();
  } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
