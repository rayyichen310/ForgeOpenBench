import type {ScopeCapture} from './scopeExport';
import type {VerticalState} from './scopeTypes';
import {vDivToVpp} from './scopeConstants';

export type ScopeChannel = 'ch1' | 'ch2';
/** session: measured since this connection; stored: reloaded from the bridge file; replay: given with an SR replay. */
export type ZeroOrigin = 'session' | 'stored' | 'replay';
export interface ZeroCondition {
  hardwareRangeVpp: number;
  probe: number;
  sampleRate: number;
}
export interface ZeroCalibration extends ZeroCondition {
  offsetVolts: number;
  capturedAt: string;
  samples: number;
  origin?: ZeroOrigin;
}
export interface StoredZero extends ZeroCalibration {
  device: string;
  channel: ScopeChannel;
}
export type ZeroCalibrations = Partial<Record<ScopeChannel, ZeroCalibration>>;
export type CaptureZeroCalibration = Record<ScopeChannel, ZeroCalibration | null>;

/** Stored profiles stay usable after this age, but the panel asks for a new GND measurement. */
export const ZERO_STALE_DAYS = 30;

export function zeroCondition(vertical: VerticalState, rate: number): ZeroCondition {
  return {hardwareRangeVpp: vDivToVpp(vertical.vDiv / vertical.probe), probe: vertical.probe, sampleRate: rate};
}

/** Pick, per channel, the stored profile measured under the current range, probe and sample rate. */
export function selectZero(store: StoredZero[], ch1: VerticalState, ch2: VerticalState, rate: number): ZeroCalibrations {
  const selected: ZeroCalibrations = {};
  for (const [channel, vertical] of [['ch1', ch1], ['ch2', ch2]] as const) {
    const match = store.find(entry => entry.channel === channel && zeroMatches(entry, vertical, rate));
    if (match) {
      const {device: _device, channel: _channel, ...profile} = match;
      selected[channel] = profile;
    }
  }
  return selected;
}

export function zeroAgeDays(profile: ZeroCalibration, now = Date.now()): number {
  return Math.floor((now - Date.parse(profile.capturedAt)) / 86_400_000);
}

export function zeroMatches(profile: ZeroCalibration | undefined, vertical: VerticalState, rate: number): boolean {
  return !!profile && profile.sampleRate === rate && profile.probe === vertical.probe &&
    profile.hardwareRangeVpp === vDivToVpp(vertical.vDiv / vertical.probe);
}

export function zeroOffset(profile: ZeroCalibration | undefined, vertical: VerticalState, rate: number): number {
  return zeroMatches(profile, vertical, rate) ? profile!.offsetVolts : 0;
}

export function estimateZero(capture: ScopeCapture | null, channel: ScopeChannel, vertical: VerticalState, rate: number): ZeroCalibration {
  if (!capture) throw new Error('Capture GND in DC and Stop before zero calibration');
  const capturedVertical = channel === 'ch1' ? capture.settings.ch1Vertical : capture.settings.ch2Vertical;
  if (vertical.coupling !== 'dc' || capturedVertical.coupling !== 'dc')
    throw new Error('Zero calibration requires a DC capture; software GND coupling is not a GND measurement');
  const values = capture[channel];
  if (values.length < 100) throw new Error('Zero calibration requires at least 100 captured GND samples');
  const profile = {
    offsetVolts: values.reduce((sum, value) => sum + value, 0) / values.length,
    hardwareRangeVpp: vDivToVpp(capturedVertical.vDiv / capturedVertical.probe),
    probe: capturedVertical.probe, sampleRate: capture.sampleRate,
    capturedAt: capture.capturedAt, samples: values.length,
  };
  if (!zeroMatches(profile, vertical, rate)) throw new Error('Capture settings changed; capture GND again and Stop');
  return profile;
}

export function captureZero(profiles: ZeroCalibrations, capture: ScopeCapture,
  ch1: VerticalState, ch2: VerticalState, rate: number): CaptureZeroCalibration {
  const active = (channel: ScopeChannel, vertical: VerticalState) => {
    const capturedVertical = channel === 'ch1' ? capture.settings.ch1Vertical : capture.settings.ch2Vertical;
    return zeroMatches(profiles[channel], vertical, rate) &&
      zeroMatches(profiles[channel], capturedVertical, capture.sampleRate) ? profiles[channel]! : null;
  };
  return {ch1: active('ch1', ch1), ch2: active('ch2', ch2)};
}
