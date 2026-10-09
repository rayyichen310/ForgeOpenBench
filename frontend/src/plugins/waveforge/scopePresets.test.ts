import {expect,it} from 'vitest';
import {importPresets} from './scopePresets';

it('rejects incomplete imported settings before they can replace the live scope state',()=>{
  expect(importPresets(JSON.stringify([{name:'Broken',createdAt:1,state:{}}]))).toBeNull();
});
