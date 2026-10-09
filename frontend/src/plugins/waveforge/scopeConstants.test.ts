import { describe, expect, it } from 'vitest';
import { vDivToVpp } from './scopeConstants';

describe('scope hardware range', () => {
  it('selects the smallest supported input range covering ten divisions', () => {
    expect(vDivToVpp(0.1)).toBe(1);
    expect(vDivToVpp(0.2)).toBe(2);
    expect(vDivToVpp(0.5)).toBe(5);
    expect(vDivToVpp(1)).toBe(10);
    expect(vDivToVpp(0.01)).toBe(1);
  });
});
