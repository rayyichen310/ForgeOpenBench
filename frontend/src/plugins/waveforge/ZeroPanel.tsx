import {useState} from 'react';
import type {ScopeChannel, ZeroCalibrations} from './scopeZero';

interface Props {
  profiles: ZeroCalibrations;
  active: Record<ScopeChannel, boolean>;
  disabled: boolean;
  onZero: (channel: ScopeChannel) => void;
  onReset: (channel: ScopeChannel) => void;
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
        ? `subtract ${profiles[channel]!.offsetVolts.toFixed(4)} V (${active[channel] ? 'active' : 'settings mismatch'})`
        : 'not calibrated'}</span>
      <div className="flex gap-1">
        <button disabled={disabled || !confirmed} className="border border-fob-border rounded px-2 disabled:opacity-40"
          onClick={()=>{onZero(channel);setConfirmed(false);}}>Zero {channel.toUpperCase()}</button>
        <button disabled={disabled || !profiles[channel]} className="border border-fob-border rounded px-2 disabled:opacity-40"
          onClick={()=>onReset(channel)}>Reset {channel.toUpperCase()} zero</button>
      </div>
    </div>)}
    <p className="text-fob-text-dim">SR samples stay uncorrected. Recalibrate after reopening Scope.</p>
  </div>;
}
