import { formatSDiv, formatVDiv } from "./scopeConstants";
import type { TriggerState, VerticalState } from "./scopeTypes";

/* Bench-scope style status strip: every setting needed to read the trace stays on screen. */

interface Props {
  ch1: VerticalState;
  ch2: VerticalState;
  zeroActive: Record<"ch1" | "ch2", boolean>;
  sDiv: number;
  delayS: number;
  sampleRateLabel: string;
  trigger: TriggerState;
  running: boolean;
}

const CHANNEL_COLOR = { ch1: "#F59E0B", ch2: "#60A5FA" };
const SLOPE = { rise: "↑", fall: "↓", both: "↕" };
const SOURCE = { ch1: "1", ch2: "2", ext: "EXT", acline: "AC" };
const MODE = { auto: "Auto", normal: "Norm", single: "Single", smart: "Smart" };

export function formatSeconds(s: number): string {
  const a = Math.abs(s);
  if (a === 0) return "0s";
  if (a < 1e-6) return `${+(s * 1e9).toFixed(1)}ns`;
  if (a < 1e-3) return `${+(s * 1e6).toFixed(2)}µs`;
  if (a < 1) return `${+(s * 1e3).toFixed(2)}ms`;
  return `${+s.toFixed(3)}s`;
}

export function formatVolts(v: number): string {
  return Math.abs(v) < 1 ? `${+(v * 1e3).toFixed(1)}mV` : `${v.toFixed(2)}V`;
}

function Channel({ id, state, zeroed }: { id: "ch1" | "ch2"; state: VerticalState; zeroed: boolean }) {
  const color = state.enabled ? CHANNEL_COLOR[id] : undefined;
  return (
    <span className={`flex items-center gap-1.5 rounded border px-1.5 ${state.enabled ? "" : "opacity-40"}`}
      style={{ borderColor: color }} data-channel={id}>
      <span className="font-bold" style={{ color }}>{id === "ch1" ? "1" : "2"}</span>
      <span>{formatVDiv(state.vDiv)}</span>
      <span>{state.coupling.toUpperCase()}</span>
      <span>{state.probe}X</span>
      {zeroed && <span title="GND zero offset subtracted" className="text-fob-text-dim">Z</span>}
    </span>
  );
}

export function ScopeStatusBar({ ch1, ch2, zeroActive, sDiv, delayS, sampleRateLabel, trigger, running }: Props) {
  return (
    <div role="status" aria-label="Scope settings"
      className="flex items-center gap-3 shrink-0 rounded border border-fob-border bg-fob-surface px-2 py-0.5 font-mono text-[11px] whitespace-nowrap overflow-hidden">
      <Channel id="ch1" state={ch1} zeroed={ch1.enabled && zeroActive.ch1} />
      <Channel id="ch2" state={ch2} zeroed={ch2.enabled && zeroActive.ch2} />
      <span><b>H</b> {formatSDiv(sDiv)} {sampleRateLabel}</span>
      <span><b>D</b> {formatSeconds(delayS)}</span>
      <span><b>T</b> {SOURCE[trigger.source]} {SLOPE[trigger.slope]} {formatVolts(trigger.level)} {MODE[trigger.mode]}</span>
      <span className={`ml-auto font-bold ${running ? "text-green-400" : "text-red-400"}`}>{running ? "RUN" : "STOP"}</span>
    </div>
  );
}
