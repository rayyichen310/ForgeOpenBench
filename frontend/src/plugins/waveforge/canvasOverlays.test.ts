import {expect,it,vi} from 'vitest';
import {makeDrawCursors} from './canvasOverlays';

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
