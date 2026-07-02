import type { UsbTransport } from "./UsbTransport";
import { WaveformLaLegacyView } from "./WaveformLaLegacyView";

interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

// PR2 Phase 1 — skeleton wrapper around the legacy LA view.
// The new DSO-style panel layout, acquire state machine, and component
// extraction will replace this delegation in subsequent phases.
export function WaveformLaView(props: Props) {
  return <WaveformLaLegacyView {...props} />;
}
