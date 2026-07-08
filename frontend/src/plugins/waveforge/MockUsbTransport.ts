import type { IUsbTransport } from "./UsbTransport";
import type { UsbConfig, UsbDataChunk } from "./usbTypes";
import { generateLaTestPattern } from "./laDecoders";

/**
 * Software-only UsbTransport stand-in for smoke-testing the LA live capture
 * path without hardware. Emits the LA test pattern as binary chunks at a
 * throttled cadence, so WaveformLaView behaves exactly as if data were arriving
 * from the USB bridge.
 *
 * Uses 8-bit width at 1 MHz to match the Pattern button exactly.
 * The full 1-second pattern is generated once and streamed in 50ms chunks;
 * after the pattern data ends, the remaining chunks are idle zeros.
 */
export class MockUsbTransport implements IUsbTransport {
  private dataHandlers = new Set<(chunk: UsbDataChunk) => void>();
  private stopHandlers = new Set<() => void>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: UsbConfig | null = null;
  private _effectiveRate = 0;
  private _effectiveWidth: 8 | 16 = 8;

  get effectiveSampleRate(): number { return this._effectiveRate; }
  get effectiveWidth(): 8 | 16 { return this._effectiveWidth; }
  get effectiveChannelLabels(): string[] {
    return ["UART_TX", "I2C_SCL", "I2C_SDA", "SPI_MOSI", "SPI_MISO", "SPI_SCK", "SPI_CS"];
  }

  async configure(cfg: UsbConfig): Promise<void> {
    this.config = cfg;
    // Always use 8-bit at 1 MHz to match the Pattern button.
    this._effectiveRate = 1_000_000;
    this._effectiveWidth = 8;
  }

  async start(): Promise<void> {
    if (this.running || !this.config) return;
    this.running = true;

    const rate = this._effectiveRate;
    const bps = 1; // always 8-bit
    const width = 8;

    // Generate one burst of protocol data (~700 samples of UART+I2C+SPI).
    const { samples: burstSamples, dataEndSample: burstLen } = generateLaTestPattern(rate, 1);
    const totalSamples = burstLen; // capture is only as long as the data
    const chunkSamples = Math.max(1, Math.min(50, totalSamples)); // 50 samples per chunk = 0.05ms

    let emitted = 0;

    this.timer = setInterval(() => {
      if (!this.running) return;
      const startSample = emitted;
      const endSample = Math.min(startSample + chunkSamples, totalSamples);
      if (startSample >= totalSamples) {
        this.stopInternal();
        return;
      }
      const nSamples = endSample - startSample;
      const data = new Uint8Array(nSamples * bps);
      data.set(burstSamples.subarray(startSample, endSample), 0);

      emitted = endSample;
      const chunk: UsbDataChunk = {
        mode: "la",
        ts: performance.now() / 1000,
        rate,
        width,
        samples: nSamples,
        b64: "",
        data,
      };
      this.dataHandlers.forEach(h => h(chunk));
      if (emitted >= totalSamples) {
        this.stopInternal();
      }
    }, 50);
  }

  async stop(): Promise<void> {
    this.stopInternal();
  }

  onData(handler: (chunk: UsbDataChunk) => void): () => void {
    this.dataHandlers.add(handler);
    return () => { this.dataHandlers.delete(handler); };
  }

  onStopped(handler: () => void): () => void {
    this.stopHandlers.add(handler);
    return () => { this.stopHandlers.delete(handler); };
  }

  private stopInternal(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopHandlers.forEach(h => h());
  }
}
