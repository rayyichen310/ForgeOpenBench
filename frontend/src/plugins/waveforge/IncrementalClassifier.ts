import {
  type Edge,
  type ChannelProfile,
  type SignalProfile,
  type ScoredCandidate,
  type DecoderTab,
  computeEdgeList,
  computeChannelProfile,
  detectClockDataLinks,
  detectSignatures,
  scoreProtocolProperties,
  groupChannelsByLinks,
  classifyChannelRoles,
} from "./laDecoders";

// ---------------------------------------------------------------------------
// Per-channel-group hypothesis tracking
// ---------------------------------------------------------------------------

export interface ChannelGroupHypothesis {
  channels: number[];
  protocol: DecoderTab;
  confidence: number;       // 0..1
  propertyScore: number;
  reasons: string[];
  edgesSeen: number;
  minEdgesForProtocol: number;
}

export interface ChannelLabel {
  channel: number;
  label: string;
  confidence: number;       // 0..1
}

export interface ClassificationUpdate {
  hypotheses: ChannelGroupHypothesis[];
  channelLabels: ChannelLabel[];
  totalEdges: number;
  totalSamples: number;
  stable: boolean;          // true if top hypothesis confidence > 0.7
}

// Minimum edges needed for reasonable confidence per protocol
const MIN_EDGES: Record<DecoderTab, number> = {
  uart: 10,
  i2c: 8,
  spi: 12,
  can: 20,
  onewire: 8,
  swd: 12,
  jtag: 16,
  modbus: 20,
  lin: 15,
};

/**
 * Stateful, append-only incremental protocol classifier.
 *
 * Maintains growing edge list + per-channel running stats. Each chunk update
 * appends new edges and re-scores hypotheses without recomputing from scratch.
 *
 * Supports per-channel-group hypotheses so multiple protocols can be detected
 * simultaneously on different channel clusters (e.g., UART on D0 + I2C on D1/D2).
 */
export class IncrementalClassifier {
  private width: number;
  private rate: number;
  private allEdges: Edge[] = [];
  private totalSamples = 0;
  private sampleBuffer: Uint8Array = new Uint8Array(0);
  private lastUpdate: ClassificationUpdate | null = null;
  private onUpdateCb: ((update: ClassificationUpdate) => void) | null = null;

  constructor(width: number, rate: number) {
    this.width = width;
    this.rate = rate;
  }

  /** Register a callback fired after each classification update. */
  onUpdate(cb: (update: ClassificationUpdate) => void): void {
    this.onUpdateCb = cb;
  }

  /**
   * Append a new chunk of samples. Extracts edges from the chunk (with
   * sample offset adjustment), merges into the growing edge list, and
   * re-scores hypotheses.
   */
  update(chunkBytes: Uint8Array, chunkSamples: number): ClassificationUpdate {
    const offset = this.totalSamples;

    // Grow sample buffer (needed for signature detection which reads raw samples)
    const newBuf = new Uint8Array(this.sampleBuffer.length + chunkBytes.length);
    newBuf.set(this.sampleBuffer, 0);
    newBuf.set(chunkBytes, this.sampleBuffer.length);
    this.sampleBuffer = newBuf;

    // Extract edges from the new chunk, adjusting sample indices by offset
    const chunkEdges = computeEdgeList(chunkBytes, this.width);
    for (const e of chunkEdges) {
      this.allEdges.push({ sample: e.sample + offset, rising: e.rising, falling: e.falling });
    }

    this.totalSamples += chunkSamples;

    // Build current SignalProfile from accumulated state
    const profile = this.buildProfile();

    // Score candidates
    const candidates = scoreProtocolProperties(profile);

    // Group channels into independent clusters based on clock-data links
    const groups = this.groupChannels(profile);

    // Build per-group hypotheses
    const hypotheses: ChannelGroupHypothesis[] = [];
    for (const group of groups) {
      const groupCandidates = this.scoreGroup(group, candidates, profile);
      if (groupCandidates.length > 0) {
        const top = groupCandidates[0]!;
        const edgesSeen = group.reduce((sum, ch) => sum + (profile.channels[ch]?.transitionCount ?? 0), 0);
        const minEdges = MIN_EDGES[top.entry.tab] ?? 10;
        const confidence = this.computeConfidence(top.propertyScore, edgesSeen, minEdges);
        hypotheses.push({
          channels: group,
          protocol: top.entry.tab,
          confidence,
          propertyScore: top.propertyScore,
          reasons: top.reasons,
          edgesSeen,
          minEdgesForProtocol: minEdges,
        });
      }
    }

    // Build channel labels from hypotheses
    const channelLabels = this.buildChannelLabels(hypotheses, profile);

    const stable = hypotheses.length > 0 && hypotheses[0]!.confidence > 0.7;
    const update: ClassificationUpdate = {
      hypotheses: hypotheses.sort((a, b) => b.confidence - a.confidence),
      channelLabels,
      totalEdges: this.allEdges.length,
      totalSamples: this.totalSamples,
      stable,
    };
    this.lastUpdate = update;
    this.onUpdateCb?.(update);
    return update;
  }

  /** Get the latest classification update without running a new one. */
  getLatest(): ClassificationUpdate | null {
    return this.lastUpdate;
  }

  /** Reset all state for a new capture. */
  reset(): void {
    this.allEdges = [];
    this.totalSamples = 0;
    this.sampleBuffer = new Uint8Array(0);
    this.lastUpdate = null;
  }

  // --- Internal methods ---

  private buildProfile(): SignalProfile {
    const maxCh = Math.min(this.width, 16);
    const channels: ChannelProfile[] = [];
    for (let ch = 0; ch < maxCh; ch++) {
      channels.push(computeChannelProfile(this.sampleBuffer, this.width, ch, this.allEdges));
    }

    const activeChannels = channels
      .filter(p => p.transitionCount > 0)
      .map(p => p.channel)
      .sort((a, b) => a - b);

    const clocks = channels.filter(p => p.isClock).map(p => p.channel);
    const dataChannels = activeChannels.filter(ch => !clocks.includes(ch));

    const clockProfiles = channels.filter(p => p.isClock);
    const dataProfiles = channels.filter(p => !p.isClock && p.transitionCount > 0);
    const clockDataLinks = detectClockDataLinks(clockProfiles, dataProfiles, this.allEdges);

    const signatures = detectSignatures(channels, this.allEdges, this.sampleBuffer, this.rate, this.width);
    const roles = classifyChannelRoles(channels, clockDataLinks, this.allEdges);

    return {
      edges: this.allEdges,
      channels,
      activeChannels,
      clocks,
      dataChannels,
      clockDataLinks,
      signatures,
      roles,
    };
  }

  private groupChannels(profile: SignalProfile): number[][] {
    return groupChannelsByLinks(profile);
  }

  /**
   * Score candidates for a specific channel group.
   * Filters to candidates whose minChannels <= group size and whose
   * required channels (clock, data) are present in the group.
   */
  private scoreGroup(
    group: number[],
    candidates: ScoredCandidate[],
    _profile: SignalProfile,
  ): ScoredCandidate[] {
    return candidates
      .filter(c => c.entry.minChannels <= group.length)
      .filter(c => {
        // For clock-requiring protocols, group must contain a clock channel
        if (c.entry.needsClock) {
          // Check if any channel in the group is a clock
          // We can infer this from the candidate reasons containing "clock on D"
          return c.reasons.some(r => r.startsWith("clock on D"));
        }
        // For channel-link protocols, group must have >1 channel
        if (c.entry.needsChannelLink) {
          return group.length > 1;
        }
        // For async protocols, single-channel groups are fine
        return true;
      })
      .sort((a, b) => b.propertyScore - a.propertyScore);
  }

  /**
   * Compute confidence (0..1) from property score and edge count.
   *
   * confidence = (propertyScore / maxPossibleScore) × min(1, edgesSeen / minEdges)
   *
   * maxPossibleScore is roughly 6 (channel count + clock + idle + signature + integer-multiple + channel-link).
   */
  private computeConfidence(propertyScore: number, edgesSeen: number, minEdges: number): number {
    const maxScore = 6;
    const scoreFactor = Math.max(0, Math.min(1, propertyScore / maxScore));
    const edgeFactor = Math.min(1, edgesSeen / minEdges);
    return scoreFactor * edgeFactor;
  }

  private buildChannelLabels(
    hypotheses: ChannelGroupHypothesis[],
    profile: SignalProfile,
  ): ChannelLabel[] {
    const labels: ChannelLabel[] = [];
    const labeled = new Set<number>();

    for (const h of hypotheses) {
      const proto = h.protocol;
      const conf = h.confidence;
      const chs = h.channels;

      if (proto === "uart" && chs.length >= 1) {
        labels.push({ channel: chs[0]!, label: `UART TX (${Math.round(conf * 100)}%)`, confidence: conf });
        labeled.add(chs[0]!);
      } else if (proto === "i2c" && chs.length >= 2) {
        // Clock channel is the one with lower CV
        const clk = profile.clocks.find(c => chs.includes(c));
        const sda = chs.find(c => c !== clk);
        if (clk !== undefined) {
          labels.push({ channel: clk, label: `SCL (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(clk);
        }
        if (sda !== undefined) {
          labels.push({ channel: sda, label: `SDA (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(sda);
        }
      } else if (proto === "spi" && chs.length >= 3) {
        const clk = profile.clocks.find(c => chs.includes(c));
        if (clk !== undefined) {
          labels.push({ channel: clk, label: `SCK (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(clk);
        }
        const others = chs.filter(c => c !== clk);
        if (others[0] !== undefined) {
          labels.push({ channel: others[0], label: `MOSI (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(others[0]);
        }
        if (others[1] !== undefined) {
          labels.push({ channel: others[1], label: `MISO (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(others[1]);
        }
      } else if (proto === "can" && chs.length >= 1) {
        labels.push({ channel: chs[0]!, label: `CAN (${Math.round(conf * 100)}%)`, confidence: conf });
        labeled.add(chs[0]!);
      } else if (proto === "onewire" && chs.length >= 1) {
        labels.push({ channel: chs[0]!, label: `1-Wire (${Math.round(conf * 100)}%)`, confidence: conf });
        labeled.add(chs[0]!);
      } else if (proto === "swd" && chs.length >= 2) {
        const clk = profile.clocks.find(c => chs.includes(c));
        const dio = chs.find(c => c !== clk);
        if (clk !== undefined) {
          labels.push({ channel: clk, label: `SWCLK (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(clk);
        }
        if (dio !== undefined) {
          labels.push({ channel: dio, label: `SWDIO (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(dio);
        }
      } else if (proto === "jtag" && chs.length >= 4) {
        const clk = profile.clocks.find(c => chs.includes(c));
        if (clk !== undefined) {
          labels.push({ channel: clk, label: `TCK (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(clk);
        }
        const others = chs.filter(c => c !== clk);
        const names = ["TMS", "TDI", "TDO"];
        for (let i = 0; i < others.length && i < 3; i++) {
          labels.push({ channel: others[i]!, label: `${names[i]} (${Math.round(conf * 100)}%)`, confidence: conf });
          labeled.add(others[i]!);
        }
      } else if (proto === "modbus" && chs.length >= 1) {
        labels.push({ channel: chs[0]!, label: `RS485 (${Math.round(conf * 100)}%)`, confidence: conf });
        labeled.add(chs[0]!);
      } else if (proto === "lin" && chs.length >= 1) {
        labels.push({ channel: chs[0]!, label: `LIN (${Math.round(conf * 100)}%)`, confidence: conf });
        labeled.add(chs[0]!);
      }
    }

    // Unlabeled active channels
    for (const ch of profile.activeChannels) {
      if (!labeled.has(ch)) {
        labels.push({ channel: ch, label: `D${ch}`, confidence: 0 });
      }
    }

    return labels;
  }
}
