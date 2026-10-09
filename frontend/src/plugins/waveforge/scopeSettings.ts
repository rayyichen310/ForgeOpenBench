import { VDIV_STEPS, SDIV_STEPS, SAMPLE_RATES_DSO } from './scopeConstants';

const vertical = {enabled: 'boolean', vDiv: VDIV_STEPS, position: 'number', coupling: ['dc','ac','gnd'], probe: [1,10,100], invert: 'boolean', bwLimit: 'boolean'};
const schema: Record<string, unknown> = {
  ch1Vertical: vertical, ch2Vertical: vertical,
  horizontal: {sDiv: SDIV_STEPS, position: 'number', acquireMode: ['normal','peak','average'], averageCount: 'positive', rollMode: 'boolean'},
  trigger: {source: ['ch1','ch2'], level: 'number', slope: ['rise','fall','both'], mode: ['auto','normal','single','smart'], coupling: ['dc','ac','hfrej','lfrej','noiserej'], holdoff: 'nonnegative'},
  math: {enabled: 'boolean', sourceA: ['ch1','ch2'], sourceB: ['ch1','ch2'], op: ['add','sub','mul','div','fft','xy']},
  sampleRate: SAMPLE_RATES_DSO.map(rate => rate.hz), phosphorEnabled: 'boolean', phosphorIntensity: 'nonnegative', phosphorTracesCount: 'positive',
};

export function validateScopePatch(patch: Record<string, unknown>): void {
  const validate = (value: unknown, rule: unknown, path: string): void => {
    if (Array.isArray(rule)) { if (!rule.includes(value)) throw new Error(`Unsupported ${path}`); return; }
    if (typeof rule === 'object' && rule !== null) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${path}`);
      for (const [key, item] of Object.entries(value)) {
        if (!(key in rule)) throw new Error(`Unknown setting ${path}.${key}`);
        validate(item, (rule as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return;
    }
    if (rule === 'boolean') { if (typeof value !== 'boolean') throw new Error(`Invalid ${path}`); return; }
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule === 'positive' && value <= 0) || (rule === 'nonnegative' && value < 0)) throw new Error(`Invalid ${path}`);
  };
  validate(patch, schema, 'scope');
}
