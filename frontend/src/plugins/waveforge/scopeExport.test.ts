import { describe, expect, it, vi } from 'vitest';
import { exportTraceCsv } from './scopeExport';
import { downloadBlob } from './exportUtils';
import type uPlot from 'uplot';

vi.mock('./exportUtils', () => ({makeTimestamp: () => 'fixture', downloadBlob: vi.fn()}));

describe('scope CSV', () => {
  it('exports exactly the selected series with matching headers', async () => {
    const plot = {data: [[0, 1], [10, 11], [20, 21], [30, 31]]} as unknown as uPlot;
    exportTraceCsv(plot, ['CH1', 'MATH'], 'time', [1, 3]);
    const blob = vi.mocked(downloadBlob).mock.calls[0][0];
    const csv = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(blob);
    });
    const rows = csv.split('\n');
    expect(rows[0]).toBe('time(s),CH1,MATH');
    expect(rows[1].split(',')).toEqual(['0.000000e+0','1.000000e+1','3.000000e+1']);
  });
});
