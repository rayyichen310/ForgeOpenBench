import {expect,it,vi} from 'vitest';
import {makeDrawCursors,makeDrawTriggerLine} from './canvasOverlays';

it('hides saved cursor positions when the cursor switch is disabled',()=>{
  const ctx={save:vi.fn(),restore:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),arc:vi.fn(),fill:vi.fn()};
  const deps={enabledRef:{current:false},cursorARef:{current:{x:1,y:1}},cursorBRef:{current:null}};
  const draw=makeDrawCursors(deps);
  const plot={ctx,bbox:{top:0,height:100},valToPos:()=>10};
  draw(plot as never);
  expect(ctx.moveTo).not.toHaveBeenCalled();
  deps.enabledRef.current=true;
  draw(plot as never);
  expect(ctx.moveTo).toHaveBeenCalledOnce();
});

it('draws the trigger level on the plot y scale after the view is zoomed',()=>{
  const ctx={save:vi.fn(),restore:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fillText:vi.fn()};
  // A y view of -0.5..4.5 V over 100 px, as after wheel zoom on a held capture.
  const valToPos=(v:number)=>100-(v+0.5)/5*100;
  makeDrawTriggerLine({getLevel:()=>1.8,viewMode:'time'})({ctx,bbox:{left:0,width:200},valToPos} as never);
  expect(ctx.moveTo).toHaveBeenCalledWith(0,54);
});
