/**
 * LaStreamWriter — write-behind staging layer for streaming LA captures.
 *
 * Accumulates raw sample bytes in a preallocated chunk-sized staging buffer and
 * flushes exactly one whole chunk to the sink when full. The staged tail is
 * exposed so readers (LaHistoryBuffer.getWindow/getMeta) can serve samples that
 * have not been persisted yet.
 *
 * Invariants:
 * - Chunks are flushed full-size only, so persisted chunk boundaries stay
 *   aligned to chunkSize during streaming. flush() persists the partial tail
 *   and must only be called when the stream ends (finalizeCapture).
 * - Each byte is encoded and persisted exactly once — no read-modify-write.
 */

export interface LaChunkSink {
  /** Persist one chunk of raw (decoded) sample bytes. */
  flushChunk(chunkIdx: number, raw: Uint8Array, startSample: number): Promise<void>;
}

export class LaStreamWriter {
  private staging: Uint8Array;
  private stagedBytes = 0;
  private flushedChunks: number;
  private flushedSamples: number;

  /** Hook for post-flush processing (e.g., rendering pyramid tiles). */
  onChunkFlushed?: (chunkIdx: number, raw: Uint8Array) => void;

  constructor(
    private sink: LaChunkSink,
    readonly bps: number,
    readonly chunkSize: number,
    start?: { chunkCount: number; totalSamples: number }
  ) {
    this.staging = new Uint8Array(chunkSize * bps);
    this.flushedChunks = start?.chunkCount ?? 0;
    this.flushedSamples = start?.totalSamples ?? 0;
  }

  /** Whole samples currently staged (not yet persisted). */
  get stagedSamples(): number { return Math.floor(this.stagedBytes / this.bps); }

  /** Total samples written through this writer, staged included. */
  get totalSamples(): number { return this.flushedSamples + this.stagedSamples; }

  /** Number of chunks flushed so far; the staged tail is virtual chunk `chunkCount`. */
  get chunkCount(): number { return this.flushedChunks; }

  /** Absolute sample index where the staged tail begins. */
  get stagedStartSample(): number { return this.flushedSamples; }

  /** View of the staged tail bytes (valid until the next write/flush). */
  stagedTail(): Uint8Array {
    const aligned = this.stagedBytes - (this.stagedBytes % this.bps);
    return this.staging.subarray(0, aligned);
  }

  /**
   * Preload an existing partial last chunk into staging (resume-append case).
   * Caller must construct the writer with `start` pointing at the chunk's
   * aligned start (chunkCount = lastIdx, totalSamples = lastIdx * chunkSize).
   */
  backfill(raw: Uint8Array): void {
    if (this.stagedBytes !== 0) throw new Error("backfill requires empty staging");
    if (raw.length > this.staging.length) throw new Error("backfill larger than chunk");
    this.staging.set(raw);
    this.stagedBytes = raw.length;
  }

  /** Append raw sample bytes; flushes whole chunks as staging fills. */
  async write(data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      const room = this.staging.length - this.stagedBytes;
      const take = Math.min(room, data.length - offset);
      this.staging.set(data.subarray(offset, offset + take), this.stagedBytes);
      this.stagedBytes += take;
      offset += take;
      if (this.stagedBytes === this.staging.length) {
        await this._flushRaw(this.staging.slice());
        this.stagedBytes = 0;
      }
    }
  }

  /** Persist the partial staged tail. Call only when the stream ends. */
  async flush(): Promise<void> {
    const aligned = this.stagedBytes - (this.stagedBytes % this.bps);
    if (aligned === 0) return;
    await this._flushRaw(this.staging.slice(0, aligned));
    const remainder = this.stagedBytes - aligned;
    if (remainder > 0) this.staging.copyWithin(0, aligned, this.stagedBytes);
    this.stagedBytes = remainder;
  }

  private async _flushRaw(raw: Uint8Array): Promise<void> {
    const chunkIdx = this.flushedChunks;
    const startSample = this.flushedSamples;
    await this.sink.flushChunk(chunkIdx, raw, startSample);
    this.flushedChunks += 1;
    this.flushedSamples += Math.floor(raw.length / this.bps);
    this.onChunkFlushed?.(chunkIdx, raw);
  }
}
