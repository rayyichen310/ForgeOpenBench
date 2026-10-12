import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {WaveformDsoView} from './WaveformDsoView';
import type {UsbTransport} from './UsbTransport';
import type {UsbDataChunk} from './usbTypes';
import type {StoredZero, ZeroCalibration, ZeroCondition} from './scopeZero';

// In-memory stand-in for the bridge's zero profile file; it survives re-renders and reconnects.
function zeroStoreMock(store:StoredZero[]=[]) {
  const same=(entry:StoredZero,channel:string,c:ZeroCondition)=>entry.channel===channel&&entry.hardwareRangeVpp===c.hardwareRangeVpp&&
    entry.probe===c.probe&&entry.sampleRate===c.sampleRate;
  return {store,
    loadZeroProfiles:vi.fn(async(device:string)=>store.filter(entry=>entry.device===device).map(entry=>({...entry}))),
    saveZeroProfile:vi.fn(async(device:string,channel:'ch1'|'ch2',profile:ZeroCalibration)=>{
      store.splice(0,store.length,...store.filter(entry=>!(entry.device===device&&same(entry,channel,profile))),{...profile,device,channel});
      return store.map(entry=>({...entry}));}),
    deleteZeroProfile:vi.fn(async(device:string,channel:'ch1'|'ch2',condition:ZeroCondition)=>{
      store.splice(0,store.length,...store.filter(entry=>!(entry.device===device&&same(entry,channel,condition))));
      return store.map(entry=>({...entry}));}),
  };
}

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
    deviceInfo:{mode:'dso'},...zeroStoreMock(),
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

async function scopeCaptureFixture(zero=zeroStoreMock()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  sessionStorage.clear();
  let control:(action:string,params:Record<string,unknown>)=>Promise<any>;
  let onData:((chunk:UsbDataChunk)=>void)|null=null;
  const saved=vi.fn(async()=>({path:'captures/test.sr'}));
  const transport={deviceInfo:{mode:'dso',name:'Hantek 6022BL (Scope)'},...zero,registerScope:(handler:typeof control)=>{control=handler;return ()=>{};},
    configure:vi.fn(async()=>{}),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{}),onStopped:()=>()=>{},
    onData:(handler:typeof onData)=>{onData=handler;return ()=>{onData=null;};},exportScopeSr:saved};
  const container=document.createElement('div');
  const root=createRoot(container);
  await act(async()=>root.render(<WaveformDsoView transport={transport as unknown as UsbTransport} connected isActive resetting/>));
  const command=async(action:string,params:Record<string,unknown>={})=>{
    let result:any;
    await act(async()=>{result=await control!(action,params);});
    return result;
  };
  const push=async(data:Uint8Array,rate=1e6,discontinuous=false)=>{
    await act(async()=>onData?.({data,rate,b64:'',discontinuous} as UsbDataChunk));
  };
  const close=async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();};
  const setConnected=async(connected:boolean)=>{
    await act(async()=>root.render(<WaveformDsoView transport={transport as unknown as UsbTransport} connected={connected} isActive resetting/>));
  };
  // load-sr resolves only after React renders the held capture, so it must run outside act().
  const send=async(action:string,params:Record<string,unknown>={})=>{
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',false);
    try {return await control!(action,params);} finally {vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);}
  };
  return {command,send,push,close,setConnected,container,saved,transport,zero};
}

function floats(base64:string):number[] {
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  const view=new DataView(bytes.buffer);
  return Array.from({length:bytes.length/4},(_,i)=>view.getFloat32(i*4,true));
}

const zeroSettings={sampleRate:1e6,ch1Vertical:{probe:10,vDiv:0.5,coupling:'dc'},
  ch2Vertical:{probe:10,vDiv:0.5,coupling:'dc'},trigger:{mode:'auto'},horizontal:{sDiv:0.0002}};
const groundData=Uint8Array.from({length:8000},(_,i)=>i%2 ? 160 : 134);

it('zeroes CH1 immediately, preserves raw SR, isolates CH2 and resets without acquiring again',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await scope.command('run'); await scope.push(groundData); await scope.command('stop');
    const before=await scope.command('sr');
    await scope.command('zero',{channel:'ch1',groundConfirmed:true});
    expect((await scope.command('status')).ch1Meas.dc).toBeCloseTo(0,12);
    expect((await scope.command('status')).ch2Meas.dc).toBeCloseTo(1.25,12);
    const after=await scope.command('sr');
    expect(after.channels).toEqual(before.channels);
    expect(after.zeroCorrectionAppliedToSamples).toBe(false);
    expect(after.zeroCalibration.ch1.offsetVolts).toBe(0.234375);
    expect(after.zeroCalibration.ch2).toBeNull();
    const csv=await scope.command('csv');
    expect(csv.csv.split('\n')[1].split(',').slice(1).map(Number)).toEqual([0,1.25]);
    expect(csv.settings.zeroActive.ch1).toBe(true);
    await scope.command('set',{math:{enabled:true,op:'sub',sourceA:'ch1',sourceB:'ch2'}});
    expect((await scope.command('csv')).csv.split('\n')[1].split(',').slice(1).map(Number)).toEqual([0,1.25,-1.25]);
    await scope.command('zero',{channel:'ch1',groundConfirmed:true});
    expect((await scope.command('status')).zeroCalibration.ch1.offsetVolts).toBe(0.234375);
    await scope.command('zero-reset',{channel:'ch1'});
    expect((await scope.command('status')).ch1Meas.dc).toBe(0.234375);
    expect((await scope.command('sr')).channels).toEqual(before.channels);
    expect(scope.transport.start).toHaveBeenCalledTimes(1);
  } finally {await scope.close();}
});

it('uses corrected voltages for new acquisitions and suspends correction on changed conditions',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await scope.command('run'); await scope.push(groundData); await scope.command('stop');
    await scope.command('zero',{channel:'ch1',groundConfirmed:true});
    await scope.command('run');
    const high=Uint8Array.from({length:8000},(_,i)=>i%2 ? 160 : 222);
    await scope.push(high); await scope.command('stop');
    expect((await scope.command('status')).ch1Meas.dc).toBe(3.4375);
    expect(floats((await scope.command('sr')).channels[0].data)[0]).toBe(3.671875);
    for(const patch of [{sampleRate:12e6},{sampleRate:1e6,ch1Vertical:{vDiv:2}},
                       {ch1Vertical:{vDiv:0.5,probe:1}}]) {
      await scope.command('set',patch);
      expect((await scope.command('status')).zeroActive.ch1).toBe(false);
      expect((await scope.command('status')).ch1Meas.dc).toBe(3.671875);
    }
    await scope.command('set',zeroSettings);
    expect((await scope.command('status')).zeroActive.ch1).toBe(true);
    expect((await scope.command('status')).ch1Meas.dc).toBe(3.4375);
    await scope.command('set',{ch1Vertical:{coupling:'ac'}});
    await scope.command('run'); await scope.push(high); await scope.command('stop');
    expect((await scope.command('status')).ch1Meas.dc).toBeCloseTo(0,12);
  } finally {await scope.close();}
});

it('requires explicit ground confirmation, Stop, DC and current capture conditions',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await expect(scope.command('zero',{channel:'ch1',groundConfirmed:true})).rejects.toThrow(/capture/i);
    await scope.command('run'); await scope.push(groundData);
    await expect(scope.command('zero',{channel:'ch1',groundConfirmed:true})).rejects.toThrow(/Stop/);
    await scope.command('stop');
    await expect(scope.command('zero',{channel:'ch1'})).rejects.toThrow(/GND/);
    await expect(scope.command('zero',{channel:'ch3',groundConfirmed:true})).rejects.toThrow(/channel/i);
    await expect(scope.command('zero',{channel:'ch1',groundConfirmed:'true'})).rejects.toThrow(/GND/);
    await scope.command('set',{ch1Vertical:{coupling:'gnd'}});
    await expect(scope.command('zero',{channel:'ch1',groundConfirmed:true})).rejects.toThrow(/DC/);
    await scope.command('set',{ch1Vertical:{coupling:'dc'},sampleRate:12e6});
    await expect(scope.command('zero',{channel:'ch1',groundConfirmed:true})).rejects.toThrow(/settings/i);
  } finally {await scope.close();}
});

it('Stop retains the calibrated averaged display rather than replacing it with the last raw frame',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await scope.command('run'); await scope.push(groundData); await scope.command('stop');
    await scope.command('zero',{channel:'ch1',groundConfirmed:true});
    await scope.command('set',{horizontal:{acquireMode:'average',averageCount:2},trigger:{level:0.5}});
    await scope.command('run');
    for (const high of [160,192]) {
      const pulse=Uint8Array.from({length:8000},(_,i)=>i%2 ? 160 : (Math.floor(i/2)%1000<500 ? 134 : high));
      await scope.push(pulse,1e6,true);
    }
    const averaged:string=(await scope.command('csv')).csv;
    const highs=averaged.split('\n').slice(1).map(row=>Number(row.split(',')[1]));
    expect(Math.max(...highs)).toBeCloseTo(1.640625);
    await scope.command('stop');
    expect((await scope.command('csv')).csv).toBe(averaged);
  } finally {await scope.close();}
});

it('Single compares its trigger threshold with corrected voltages',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await scope.command('run'); await scope.push(groundData); await scope.command('stop');
    await scope.command('zero',{channel:'ch1',groundConfirmed:true});
    await scope.command('set',{trigger:{source:'ch1',level:0.3,slope:'rise',coupling:'dc'}});
    await scope.command('single');
    // Raw levels cross 0.3 V; subtracting the GND baseline leaves 0 to 0.15625 V.
    const pulse=Uint8Array.from({length:8000},(_,i)=>i%2 ? 160 : (Math.floor(i/2)%1000<500 ? 134 : 138));
    await scope.push(pulse);
    expect((await scope.command('status')).acquireMode).toBe('single-armed');
    await scope.command('set',{trigger:{level:0.1}});
    await scope.push(pulse);
    expect((await scope.command('status')).acquireMode).toBe('single-held');
  } finally {await scope.close();}
});

it('web GND confirmation and Zero CH2 share CLI state, and reconnect restores the saved profile',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await scope.command('run'); await scope.push(groundData); await scope.command('stop');
    const button=Array.from(scope.container.querySelectorAll('button')).find(b=>b.textContent==='Zero CH2')!;
    expect(button).toBeDefined(); expect(button.disabled).toBe(true);
    await act(async()=>{(scope.container.querySelector('input[aria-label="GND connection confirmed"]') as HTMLInputElement).click();});
    await act(async()=>button.click());
    expect((await scope.command('status')).zeroCalibration.ch2.offsetVolts).toBe(1.25);
    expect((await scope.command('status')).ch2Meas.dc).toBe(0);
    expect((await scope.command('status')).ch1Meas.dc).toBe(0.234375);
    expect((await scope.command('status')).zeroCalibration.ch2.origin).toBe('session');
    await scope.setConnected(false);
    expect((await scope.command('status')).zeroCalibration).toEqual({});
    await scope.setConnected(true);
    // The saved profile comes back for the same conditions; a new zero still needs a fresh GND capture.
    expect((await scope.command('status')).zeroCalibration.ch2).toMatchObject({offsetVolts:1.25,origin:'stored'});
    expect((await scope.command('status')).zeroActive.ch2).toBe(true);
    await expect(scope.command('zero',{channel:'ch2',groundConfirmed:true})).rejects.toThrow(/capture/i);
  } finally {await scope.close();}
});

it.each(['stop','single'])('SR retains unprocessed dual-channel samples and capture settings after %s',async mode=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',{sampleRate:1e6,ch1Vertical:{probe:10,vDiv:0.5,coupling:'gnd',invert:true,bwLimit:true},
      ch2Vertical:{enabled:false},trigger:{level:0.5,mode:'auto'},horizontal:{sDiv:0.0002}});
    if(mode==='single') {
      await scope.command('set',{ch1Vertical:{coupling:'dc',invert:false,bwLimit:false}});
      await scope.command('single');
    } else await scope.command('run');
    const data=Uint8Array.from({length:8000},(_,i)=>i%2===1?160:(Math.floor(i/2)%1000<500?128:192));
    await scope.push(data);
    if(mode==='stop') await scope.command('stop');
    const snapshot=await scope.command('sr');
    expect(snapshot.samples).toBe(4000);
    expect(snapshot.sampleRate).toBe(1e6);
    expect(snapshot.hardwareRangesVpp).toEqual({CH1:1,CH2:5});
    expect(snapshot.channels.map((ch:{name:string})=>ch.name)).toEqual(['CH1','CH2']);
    expect(floats(snapshot.channels[0].data).slice(499,502)).toEqual([0,2.5,2.5]);
    expect(floats(snapshot.channels[1].data).every(v=>v===0.625)).toBe(true);
    expect((await scope.command('status')).acquireMode).toBe(mode==='single'?'single-held':'stopped');
    await scope.command('set',{sampleRate:2e6,ch1Vertical:{probe:1,vDiv:2}});
    expect(await scope.command('sr')).toEqual(snapshot);
    await act(async()=>Array.from(scope.container.querySelectorAll('button')).find(button=>button.textContent==='SR')!.click());
    expect(scope.saved).toHaveBeenCalledWith(snapshot);
    await scope.command('clear');
    await expect(scope.command('sr')).rejects.toThrow('No captured samples');
  } finally {await scope.close();}
});

it('SR never joins across a dropped frame or rate/range/probe change and respects the sample cap',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',{sampleRate:1e6,trigger:{mode:'auto'},horizontal:{sDiv:0.02}});
    await expect(scope.command('sr')).rejects.toThrow('No captured samples');
    await scope.command('run');
    await scope.push(new Uint8Array(4000).fill(128));
    await scope.push(new Uint8Array(2000).fill(160),1e6,true);
    expect((await scope.command('sr')).samples).toBe(1000);
    await scope.push(new Uint8Array(6000).fill(192),2e6);
    expect((await scope.command('sr')).samples).toBe(3000);
    await scope.command('set',{sampleRate:2e6,ch1Vertical:{probe:10,vDiv:0.5}});
    await scope.push(new Uint8Array(500000).fill(160),2e6);
    const capped=await scope.command('sr');
    expect(capped.samples).toBe(200000);
    expect(floats(capped.channels[0].data)[0]).toBe(1.25);
    await scope.command('set',{ch1Vertical:{probe:1,vDiv:0.05}});
    await scope.push(new Uint8Array(4000).fill(160),2e6);
    const changed=await scope.command('sr');
    expect(changed.samples).toBe(2000);
    expect(floats(changed.channels[0].data)[0]).toBe(0.125);
    await scope.command('stop');
    await scope.command('run');
    await expect(scope.command('sr')).rejects.toThrow('No captured samples');
  } finally {await scope.close();}
});

it('measurements selects readout keys from the CLI and rejects unknown keys',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
  sessionStorage.clear();
  let control:(action:string,params:Record<string,unknown>)=>Promise<unknown>;
  const transport={registerScope:(handler:typeof control)=>{control=handler;return ()=>{};},onStopped:()=>()=>{}};
  const host=document.createElement('div');
  const root=createRoot(host);
  try {
    await act(async()=>root.render(<WaveformDsoView transport={transport as unknown as UsbTransport} connected={false} isActive/>));
    expect(host.textContent).toContain('F=');
    await act(async()=>{await control!('measurements',{ch1:['vpp','vrms'],ch2:['vpp','vrms']});});
    expect(host.textContent).not.toContain('F=');
    await expect(control!('measurements',{ch1:['bogus']})).rejects.toThrow('measurement keys');
    await expect(control!('measurements',{ch3:['vpp']})).rejects.toThrow('measurement keys');
  } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});

it('saves zero per condition, restores it in a new view, and resets only the current condition',async()=>{
  const first=await scopeCaptureFixture();
  try {
    await first.command('set',zeroSettings);
    await first.command('run'); await first.push(groundData); await first.command('stop');
    await first.command('zero',{channel:'ch1',groundConfirmed:true});
    expect(first.zero.saveZeroProfile).toHaveBeenCalledWith('Hantek 6022BL (Scope)','ch1',
      expect.objectContaining({offsetVolts:0.234375,hardwareRangeVpp:1,probe:10,sampleRate:1e6,samples:4000}));
  } finally {await first.close();}
  const reopened=await scopeCaptureFixture(zeroStoreMock(first.zero.store));
  try {
    await reopened.command('set',zeroSettings);
    expect((await reopened.command('status')).zeroCalibration.ch1).toMatchObject({offsetVolts:0.234375,origin:'stored'});
    await reopened.command('run'); await reopened.push(groundData); await reopened.command('stop');
    expect((await reopened.command('status')).ch1Meas.dc).toBeCloseTo(0,12);
    await reopened.command('set',{sampleRate:12e6});
    expect((await reopened.command('status')).zeroActive.ch1).toBe(false);
    expect((await reopened.command('status')).zeroCalibration.ch1).toBeUndefined();
    await reopened.command('set',{sampleRate:1e6});
    await reopened.command('zero-reset',{channel:'ch1'});
    expect(reopened.zero.store).toEqual([]);
    expect((await reopened.command('status')).zeroCalibration.ch1).toBeUndefined();
  } finally {await reopened.close();}
});

it('a failed save leaves the previous zero in place and reports the error',async()=>{
  const scope=await scopeCaptureFixture();
  try {
    await scope.command('set',zeroSettings);
    await scope.command('run'); await scope.push(groundData); await scope.command('stop');
    scope.zero.saveZeroProfile.mockRejectedValueOnce(new Error('disk full'));
    await expect(scope.command('zero',{channel:'ch1',groundConfirmed:true})).rejects.toThrow('disk full');
    expect((await scope.command('status')).zeroCalibration).toEqual({});
    expect((await scope.command('status')).ch1Meas.dc).toBe(0.234375);
  } finally {await scope.close();}
});

it('an SR replay keeps its own zero even when a saved profile matches, until the next Run',async()=>{
  const {storedZip}=await import('./test-fixtures/storedZip');
  const vertical={enabled:true,vDiv:0.5,position:0,coupling:'dc',probe:10,invert:false,bwLimit:false};
  const settings={sampleRate:1e6,ch1Vertical:vertical,ch2Vertical:vertical,
    horizontal:{sDiv:0.0002,position:0,acquireMode:'normal',averageCount:4,rollMode:false},
    trigger:{source:'ch1',level:1,slope:'rise',mode:'auto',coupling:'dc',holdoff:0},
    math:{enabled:false,sourceA:'ch1',sourceB:'ch1',op:'div'},phosphorEnabled:false};
  const floats32=(n:number,v:number)=>new Uint8Array(new Float32Array(n).fill(v).buffer);
  const sr=storedZip({'scope-settings.json':new TextEncoder().encode(JSON.stringify({samples:200,sampleRate:1e6,
    capturedAt:'2026-10-10T05:00:00Z',settings})),'analog-1-1-1':floats32(200,3.5),'analog-1-2-1':floats32(200,0.3)});
  const data=btoa(String.fromCharCode(...new Uint8Array(sr)));
  const scope=await scopeCaptureFixture(zeroStoreMock([{device:'Hantek 6022BL (Scope)',channel:'ch1',offsetVolts:0.1,
    hardwareRangeVpp:1,probe:10,sampleRate:1e6,capturedAt:'2026-10-11T00:00:00Z',samples:4000}]));
  try {
    await scope.send('load-sr',{data,zero:{ch1:0.25}});
    expect((await scope.command('status')).zeroCalibration.ch1).toMatchObject({offsetVolts:0.25,origin:'replay'});
    expect((await scope.command('status')).ch1Meas.dc).toBeCloseTo(3.25,6);
    await scope.command('run');
    expect((await scope.command('status')).zeroCalibration.ch1).toMatchObject({offsetVolts:0.1,origin:'stored'});
  } finally {await scope.close();}
});
