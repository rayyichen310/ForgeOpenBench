import {unzipAll} from './sigrokSrParser';
import {vDivToVpp} from './scopeConstants';
import type {ScopeCapture} from './scopeExport';
import type {ScopeChannel, ZeroCalibrations} from './scopeZero';

export interface ReplayWindow {
  /** Seconds from the first SR sample; omitted bounds keep the whole file. */
  startS?: number;
  endS?: number;
  /** SR time shown as 0 on the time axis. */
  timeZeroS?: number;
}

/** Read an SR written by this Scope; samples stay uncorrected, as stored. */
export async function parseScopeSr(buffer: ArrayBuffer): Promise<ScopeCapture> {
  const entries = new Map((await unzipAll(buffer)).map(entry => [entry.name, entry.data]));
  const settingsBytes = entries.get('scope-settings.json');
  if (!settingsBytes) throw new Error('SR has no scope-settings.json; only Scope SR files can be replayed');
  const meta = JSON.parse(new TextDecoder().decode(settingsBytes));
  const channels = [1, 2].map(index => {
    const data = entries.get(`analog-1-${index}-1`);
    if (!data || data.length !== meta.samples * 4) throw new Error(`SR CH${index} does not match ${meta.samples} samples`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return Array.from({length: meta.samples}, (_, i) => view.getFloat32(i * 4, true));
  });
  if (meta.settings?.sampleRate !== meta.sampleRate) throw new Error('SR settings do not match its sample rate');
  return {sampleRate: meta.sampleRate, capturedAt: meta.capturedAt, settings: meta.settings,
    ch1: channels[0], ch2: channels[1]};
}

export function replayWindow(capture: ScopeCapture, window: ReplayWindow = {}): ScopeCapture {
  const {sampleRate} = capture;
  const start = Math.max(0, Math.round((window.startS ?? 0) * sampleRate));
  const end = Math.min(capture.ch1.length, window.endS === undefined ? capture.ch1.length : Math.round(window.endS * sampleRate) + 1);
  if (end - start < 2) throw new Error('Replay window holds fewer than 2 samples');
  return {...capture, ch1: capture.ch1.slice(start, end), ch2: capture.ch2.slice(start, end),
    timeOffsetS: start / sampleRate - (window.timeZeroS ?? 0)};
}

/** Zero profiles bound to the replayed capture's own range, probe and sample rate. */
export function replayZero(capture: ScopeCapture, offsets: Partial<Record<ScopeChannel, number>>): ZeroCalibrations {
  const profiles: ZeroCalibrations = {};
  for (const channel of ['ch1', 'ch2'] as const) {
    const offsetVolts = offsets[channel];
    if (offsetVolts === undefined) continue;
    if (!Number.isFinite(offsetVolts)) throw new Error(`Invalid ${channel} zero offset`);
    const vertical = channel === 'ch1' ? capture.settings.ch1Vertical : capture.settings.ch2Vertical;
    profiles[channel] = {offsetVolts, probe: vertical.probe, sampleRate: capture.sampleRate,
      hardwareRangeVpp: vDivToVpp(vertical.vDiv / vertical.probe),
      capturedAt: capture.capturedAt, samples: capture.ch1.length};
  }
  return profiles;
}
