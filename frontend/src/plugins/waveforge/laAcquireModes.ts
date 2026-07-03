export type LaAcquireMode = "stopped" | "running" | "single-armed" | "single-held";

export interface LaTriggerConfig {
  enabled: boolean;
  channel: number;
  edge: "rise" | "fall" | "both";
}

export interface LaAcquireCtx {
  mode: LaAcquireMode;
  samples: Uint8Array;
  width: 8 | 16;
  trigger: LaTriggerConfig;
  totalSamples: number;
  armedAtSample: number;
  // timeout in samples before single-armed gives up
  timeoutSamples: number;
}

export interface LaAcquireResult {
  mode: LaAcquireMode;
  render: boolean;
  stop: boolean;
  triggered: boolean;
}

function bitAt(samples: Uint8Array, width: 8 | 16, sampleIndex: number, channel: number): 0 | 1 {
  const bps = width === 16 ? 2 : 1;
  const byteIdx = sampleIndex * bps;
  if (byteIdx >= samples.length) return 0;
  if (width === 16) {
    return channel < 8
      ? ((samples[byteIdx] >> channel) & 1) as 0 | 1
      : ((samples[byteIdx + 1] >> (channel - 8)) & 1) as 0 | 1;
  }
  return ((samples[byteIdx] >> channel) & 1) as 0 | 1;
}

export function detectEdge(
  samples: Uint8Array,
  width: 8 | 16,
  trigger: LaTriggerConfig,
  startIndex = 0
): boolean {
  if (!trigger.enabled || samples.length < 2) return false;
  for (let i = startIndex + 1; i * (width === 16 ? 2 : 1) < samples.length; i++) {
    const prev = bitAt(samples, width, i - 1, trigger.channel);
    const curr = bitAt(samples, width, i, trigger.channel);
    if (trigger.edge === "rise" && prev === 0 && curr === 1) return true;
    if (trigger.edge === "fall" && prev === 1 && curr === 0) return true;
    if (trigger.edge === "both" && prev !== curr) return true;
  }
  return false;
}

export function handleLaAcquireMode(ctx: LaAcquireCtx): LaAcquireResult {
  if (ctx.mode === "stopped" || ctx.mode === "single-held") {
    return { mode: ctx.mode, render: false, stop: false, triggered: false };
  }

  if (ctx.mode === "running") {
    return { mode: "running", render: true, stop: false, triggered: false };
  }

  // single-armed
  const triggered = detectEdge(ctx.samples, ctx.width, ctx.trigger);
  if (triggered) {
    return { mode: "single-held", render: true, stop: true, triggered: true };
  }

  if (ctx.totalSamples - ctx.armedAtSample > ctx.timeoutSamples) {
    return { mode: "single-held", render: true, stop: true, triggered: false };
  }

  return { mode: "single-armed", render: false, stop: false, triggered: false };
}
