import { useState } from "react";
import type { UsbTransport } from "./UsbTransport";
import { WaveformLaLegacyView } from "./WaveformLaLegacyView";
import { CollapsibleSection } from "./CollapsibleSection";
import { ChannelsPanel } from "./ChannelsPanel";
import { loadChannels, saveChannels } from "./laChannelConfig";
import type { LaChannel } from "./laChannelConfig";

interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

// PR2 Phase 2 — DSO-style layout skeleton.
// ChannelsPanel is wired in the right panel. Acquire, trigger, cursors, and
// bottom-docked decoders will be added in subsequent phases. The legacy view
// remains embedded in the canvas area until the new canvas is ready.
export function WaveformLaView(props: Props) {
  const [channels, setChannels] = useState<LaChannel[]>(loadChannels);

  const handleChannelsChange = (next: LaChannel[]) => {
    saveChannels(next);
    setChannels(next);
  };

  return (
    <div className="flex flex-col h-full bg-fob-surface text-fob-text font-mono text-xs select-none">
      {/* Placeholder toolbar — replaced with LA AcquireToolbar in Phase 4 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fob-border bg-fob-surface shrink-0">
        <span className="text-fob-text-dim">LA Toolbar (Phase 4)</span>
      </div>

      {/* Main area: canvas + right panel */}
      <div className="flex flex-1 gap-1 overflow-hidden min-h-0">
        <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-1">
          {/* Legacy canvas embedded during transition */}
          <div className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0 min-w-0 select-none">
            <WaveformLaLegacyView {...props} />
          </div>
          {/* Placeholder bottom decoders panel */}
          <div className="h-40 rounded border border-fob-border overflow-hidden bg-fob-surface shrink-0 min-w-0 p-2">
            <span className="text-fob-text-dim">Decoders panel (Phase 5)</span>
          </div>
        </div>

        {/* Right panel */}
        <div className="w-72 flex flex-col gap-2 shrink-0 overflow-y-auto text-[11px] px-1 py-1">
          <CollapsibleSection title="Channels">
            <ChannelsPanel channels={channels} onChange={handleChannelsChange} />
          </CollapsibleSection>
          <CollapsibleSection title="Acquire">
            <span className="text-fob-text-dim">Acquire panel (Phase 3)</span>
          </CollapsibleSection>
          <CollapsibleSection title="Trigger">
            <span className="text-fob-text-dim">Trigger panel (Phase 6)</span>
          </CollapsibleSection>
          <CollapsibleSection title="Cursors">
            <span className="text-fob-text-dim">Cursors panel (Phase 5)</span>
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}
