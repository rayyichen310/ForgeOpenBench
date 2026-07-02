import { SAMPLE_RATES, TIMEBASE_PRESETS } from "./laChannelConfig";

interface Props {
  sampleRate: number;
  width: 8 | 16;
  timebaseIdx: number;
  onSampleRateChange: (rate: number) => void;
  onWidthChange: (width: 8 | 16) => void;
  onTimebaseChange: (idx: number) => void;
  disabled?: boolean;
}

export function AcquirePanel({
  sampleRate,
  width,
  timebaseIdx,
  onSampleRateChange,
  onWidthChange,
  onTimebaseChange,
  disabled = false,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-fob-text-dim">
        Sample rate
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text disabled:opacity-50"
          value={sampleRate}
          onChange={e => onSampleRateChange(Number(e.target.value))}
          disabled={disabled}
        >
          {SAMPLE_RATES.map(r => (
            <option key={r.hz} value={r.hz} disabled={r.eightBitOnly && width === 16}>
              {r.label}{r.eightBitOnly && width === 16 ? " (8-bit only)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-fob-text-dim">
        Width
        <div className="flex gap-2">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="la-width"
              checked={width === 8}
              onChange={() => onWidthChange(8)}
              disabled={disabled}
            />
            8-bit
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="la-width"
              checked={width === 16}
              onChange={() => onWidthChange(16)}
              disabled={disabled}
            />
            16-bit
          </label>
        </div>
      </label>

      <label className="flex flex-col gap-1 text-fob-text-dim">
        Timebase
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text disabled:opacity-50"
          value={timebaseIdx}
          onChange={e => onTimebaseChange(Number(e.target.value))}
          disabled={disabled}
        >
          {TIMEBASE_PRESETS.map((t, i) => (
            <option key={i} value={i}>{t.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
