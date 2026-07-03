interface LaTriggerConfig {
  enabled: boolean;
  channel: number;
  edge: "rise" | "fall" | "both";
}

interface Props {
  trigger: LaTriggerConfig;
  onChange: (trigger: LaTriggerConfig) => void;
  disabled?: boolean;
}

export function LaTriggerPanel({ trigger, onChange, disabled = false }: Props) {
  return (
    <div className="flex flex-col gap-2 opacity-60">
      <label className="flex items-center gap-2 text-fob-text-dim cursor-pointer">
        <input
          type="checkbox"
          checked={trigger.enabled}
          onChange={e => onChange({ ...trigger, enabled: e.target.checked })}
          disabled={disabled}
          className="accent-fob-orange"
        />
        Enable trigger (single-mode only)
      </label>

      <label className="flex flex-col gap-1 text-fob-text-dim">
        Channel
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text disabled:opacity-50"
          value={trigger.channel}
          onChange={e => onChange({ ...trigger, channel: Number(e.target.value) })}
          disabled={disabled}
        >
          {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>D{i}</option>)}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-fob-text-dim">
        Edge
        <select
          className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text disabled:opacity-50"
          value={trigger.edge}
          onChange={e => onChange({ ...trigger, edge: e.target.value as "rise" | "fall" | "both" })}
          disabled={disabled}
        >
          <option value="rise">Rising</option>
          <option value="fall">Falling</option>
          <option value="both">Both</option>
        </select>
      </label>

      <div className="text-[10px] text-fob-text-dim">
        Trigger logic is implemented and tested; live wiring is coming in the next PR.
      </div>
    </div>
  );
}
