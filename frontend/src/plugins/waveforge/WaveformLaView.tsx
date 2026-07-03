import { useState, useCallback } from "react";
import type { UsbTransport } from "./UsbTransport";
import { WaveformLaLegacyView } from "./WaveformLaLegacyView";
import { CollapsibleSection } from "./CollapsibleSection";
import { ChannelsPanel } from "./ChannelsPanel";
import { AcquirePanel } from "./AcquirePanel";
import { LaCursorsPanel } from "./LaCursorsPanel";
import { LaDecodersPanel } from "./LaDecodersPanel";
import { LaTriggerPanel } from "./LaTriggerPanel";
import { loadChannels, saveChannels } from "./laChannelConfig";
import type { LaChannel } from "./laChannelConfig";
import type { LaAcquireMode } from "./laAcquireModes";
import type { LaTriggerConfig } from "./laAcquireModes";

interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

interface Cursor {
  sample: number;
  dragging: boolean;
}

// PR2 Phase 7 — DSO-style layout skeleton with Channels, Acquire, Trigger,
// Cursors, and bottom-docked Decoders panels. The acquire state machine is
// implemented and tested but not yet driving the live capture loop; that
// wiring is the next PR (live capture migration + data flow).
export function WaveformLaView(props: Props) {
  const [channels, setChannels] = useState<LaChannel[]>(loadChannels);
  const [sampleRate, setSampleRate] = useState(12_000_000);
  const [width, setWidth] = useState<8 | 16>(16);
  const [timebaseIdx, setTimebaseIdx] = useState(6);
  const [acquireMode, setAcquireMode] = useState<LaAcquireMode>("stopped");
  const [showCursors, setShowCursors] = useState(false);
  const [cursorA, setCursorA] = useState<Cursor>({ sample: 0, dragging: false });
  const [cursorB, setCursorB] = useState<Cursor>({ sample: 0, dragging: false });
  const [trigger, setTrigger] = useState<LaTriggerConfig>({ enabled: false, channel: 0, edge: "rise" });

  const handleChannelsChange = (next: LaChannel[]) => {
    saveChannels(next);
    setChannels(next);
  };

  const [useLegacy, setUseLegacy] = useState(false);

  const isRunning = acquireMode === "running" || acquireMode === "single-armed";
  const handleRun = useCallback(() => setAcquireMode("running"), []);
  const handleStop = useCallback(() => setAcquireMode("stopped"), []);
  const handleSingle = useCallback(() => setAcquireMode("single-armed"), []);

  if (useLegacy) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-fob-border bg-fob-surface shrink-0">
          <span className="text-fob-text-dim text-xs">Legacy LA view</span>
          <div className="flex-1" />
          <button
            onClick={() => setUseLegacy(false)}
            className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border"
          >
            New view
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <WaveformLaLegacyView {...props} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-fob-surface text-fob-text font-mono text-xs select-none">
      {/* Acquire toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fob-border bg-fob-surface shrink-0">
        <button
          onClick={handleRun}
          disabled={!props.connected || isRunning}
          className={`px-3 py-1 rounded font-bold ${isRunning ? "bg-fob-surface text-fob-text-dim" : "bg-fob-green hover:bg-fob-green/80"}`}
        >
          Run
        </button>
        <button
          onClick={handleStop}
          disabled={!isRunning}
          className={`px-3 py-1 rounded font-bold ${isRunning ? "bg-fob-red hover:bg-fob-red/80" : "bg-fob-surface text-fob-text-dim"}`}
        >
          Stop
        </button>
        <button
          onClick={handleSingle}
          disabled={!props.connected || isRunning}
          className="px-3 py-1 rounded font-bold bg-fob-orange hover:bg-fob-orange/80 disabled:bg-fob-surface disabled:text-fob-text-dim"
        >
          Single
        </button>
        <span className="text-fob-text-dim">{acquireMode}</span>
        <div className="flex-1" />
        <button
          onClick={() => setUseLegacy(true)}
          className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border"
        >
          Legacy
        </button>
      </div>

      {/* Main area: canvas + right panel */}
      <div className="flex flex-1 gap-1 overflow-hidden min-h-0">
        <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-1">
          {/* Legacy canvas embedded during transition */}
          <div className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0 min-w-0 select-none">
            <WaveformLaLegacyView {...props} />
          </div>
          {/* Bottom decoders panel */}
          <div className="h-40 rounded border border-fob-border overflow-hidden bg-fob-surface shrink-0 min-w-0">
            <LaDecodersPanel frozenBuf={null} sampleRate={sampleRate} running={isRunning} />
          </div>
        </div>

        {/* Right panel */}
        <div className="w-72 flex flex-col gap-2 shrink-0 overflow-y-auto text-[11px] px-1 py-1">
          <CollapsibleSection title="Channels">
            <ChannelsPanel channels={channels} onChange={handleChannelsChange} />
          </CollapsibleSection>
          <CollapsibleSection title="Acquire">
            <AcquirePanel
              sampleRate={sampleRate}
              width={width}
              timebaseIdx={timebaseIdx}
              onSampleRateChange={setSampleRate}
              onWidthChange={setWidth}
              onTimebaseChange={setTimebaseIdx}
            />
          </CollapsibleSection>
          <CollapsibleSection title="Trigger">
            <LaTriggerPanel trigger={trigger} onChange={setTrigger} disabled={false} />
          </CollapsibleSection>
          <CollapsibleSection title="Cursors">
            <LaCursorsPanel
              enabled={showCursors}
              onToggle={setShowCursors}
              cursorA={cursorA}
              cursorB={cursorB}
              onCursorAChange={setCursorA}
              onCursorBChange={setCursorB}
              totalSamples={0}
            />
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}
