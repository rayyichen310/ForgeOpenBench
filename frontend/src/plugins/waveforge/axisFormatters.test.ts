import {expect,it} from 'vitest';
import {divisionSplits} from './axisFormatters';

it('splits any scale into ten equal divisions with an exact zero line',()=>{
  const splits=divisionSplits(null as never,1,-0.5,4.5);
  expect(splits).toHaveLength(11);
  expect(splits[1]).toBe(0);
  expect(splits[10]).toBeCloseTo(4.5,12);
  expect(divisionSplits(null as never,0,-1.25e-5,3.75e-5)[3]).toBeCloseTo(2.5e-6,18);
  // A panned view such as -0.07..0.63 V leaves ~1.4e-17 V at the zero line; it must still read 0.
  const [min,max]=[-0.07,-0.07+0.7];
  expect(min+(max-min)*1/10).not.toBe(0);
  expect(divisionSplits(null as never,1,min,max)[1]).toBe(0);
});
