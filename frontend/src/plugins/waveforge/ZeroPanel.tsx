import {useState} from 'react';
import {ZERO_STALE_DAYS, zeroAgeDays} from './scopeZero';
import type {ScopeChannel, ZeroCalibration, ZeroCalibrations} from './scopeZero';

interface Props {
  profiles: ZeroCalibrations;
  active: Record<ScopeChannel, boolean>;
  disabled: boolean;
  onZero: (channel: ScopeChannel) => void;
  onReset: (channel: ScopeChannel) => void;
}

export function describeZero(profile: ZeroCalibration, active: boolean, now = Date.now()): string {
  const date = profile.capturedAt.slice(0, 10);
  const age = zeroAgeDays(profile, now);
  const source = profile.origin === 'replay' ? 'from SR replay'
    : profile.origin === 'stored' ? `saved ${date}, ${age} d ago` : `measured ${date}`;
  const stale = profile.origin === 'stored' && age > ZERO_STALE_DAYS
    ? ` — older than ${ZERO_STALE_DAYS} days, recalibrate` : '';
  return `subtract ${profile.offsetVolts.toFixed(4)} V (${active ? 'active' : 'settings mismatch'}; ${source})${stale}`;
}

export function ZeroPanel({profiles, active, disabled, onZero, onReset}: Props) {
  const [confirmed, setConfirmed] = useState(false);
  return <div className="flex flex-col gap-1 border border-fob-border rounded p-2">
    <span className="font-bold">Zero calibration</span>
    <p className="text-fob-text-dim">Connect the tip and ground clip to the same GND. Capture in DC, then Stop.</p>
    <label className="flex items-center gap-1">
      <input type="checkbox" aria-label="GND connection confirmed" checked={confirmed}
        onChange={event=>setConfirmed(event.target.checked)} />
      GND connection confirmed
    </label>
    {(['ch1','ch2'] as const).map(channel=><div key={channel} className="flex flex-col gap-1">
      <span>{channel.toUpperCase()}: {profiles[channel]
        ? describeZero(profiles[channel]!, active[channel])
        : 'not calibrated for this range, probe and rate'}</span>
      <div className="flex gap-1">
        <button disabled={disabled || !confirmed} className="border border-fob-border rounded px-2 disabled:opacity-40"
          onClick={()=>{onZero(channel);setConfirmed(false);}}>Zero {channel.toUpperCase()}</button>
        <button disabled={disabled || !profiles[channel]} className="border border-fob-border rounded px-2 disabled:opacity-40"
          onClick={()=>onReset(channel)}>Reset {channel.toUpperCase()} zero</button>
      </div>
    </div>)}
    <p className="text-fob-text-dim">Each zero is saved per range, probe and sample rate and reloaded on connect. SR samples stay uncorrected.</p>
  </div>;
}
