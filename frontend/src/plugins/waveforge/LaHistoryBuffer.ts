/**
 * LaHistoryBuffer — chunked, persistent sample buffer for the LA Time Machine.
 *
 * Wraps LaHistoryStore (IndexedDB) with:
 * - Automatic chunking on ingest
 - LRU hot-cache for fast window reads
 * - Async window slicing (getWindow) that only touches IDB for missing chunks
 *
 * All APIs are async. Consumers (WaveformLaView, decoders) await windows.
 */

import { LaHistoryStore, type LaCaptureMeta } from "./laHistoryStore";
import type { LaCapture } from "./laDecoders";

const DEFAULT_CHUNK_SIZE = 1_000_000; // samples per chunk
const DEFAULT_MAX_CACHE = 20; // max chunks kept in hot cache

export { type LaCaptureMeta };

interface CacheEntry {
  data: Uint8Array;
  lastAccess: number;
}

export class LaHistoryBuffer {
  private store = new LaHistoryStore();
  private cache = new Map<string, CacheEntry>();
  private accessCounter = 0;
  private maxCache: number;
  private chunkSize: number;

  constructor(options?: { maxCache?: number; chunkSize?: number }) {
    this.maxCache = options?.maxCache ?? DEFAULT_MAX_CACHE;
    this.chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async close(): Promise<void> {
    this.cache.clear();
    await this.store.close();
  }

  /** Ingest a complete LaCapture, chunk it, and persist. Returns capture id. */
  async ingest(capture: LaCapture): Promise<string> {
    const bps = capture.width === 16 ? 2 : 1;
    const totalSamples = Math.floor(capture.samples.length / bps);
    const chunkCount = Math.ceil(totalSamples / this.chunkSize);

    const captureId = await this.store.createCapture({
      sampleRate: capture.sampleRate,
      width: capture.width,
      source: capture.source,
      importedAt: capture.importedAt,
      channelLabels: capture.channelLabels,
      chunkSize: this.chunkSize,
      bps,
    });

    const records = [];
    for (let i = 0; i < chunkCount; i++) {
      const startSample = i * this.chunkSize;
      const endSample = Math.min((i + 1) * this.chunkSize, totalSamples);
      const byteStart = startSample * bps;
      const byteEnd = endSample * bps;
      const chunkData = capture.samples.subarray(byteStart, byteEnd);
      // Store a copy — subarray is a view and may be invalidated
      records.push({
        captureId,
        chunkIdx: i,
        startSample,
        endSample,
        data: new Uint8Array(chunkData),
      });
    }
    await this.store.putChunks(records);

    // Finalize metadata
    await this.store.updateMeta({
      id: captureId,
      sampleRate: capture.sampleRate,
      width: capture.width,
      source: capture.source,
      importedAt: capture.importedAt,
      channelLabels: capture.channelLabels,
      totalSamples,
      chunkSize: this.chunkSize,
      chunkCount,
      bps,
    });

    return captureId;
  }

  /**
   * Load a contiguous window [startSample, startSample + sampleCount) from storage.
   * Optionally pads by `paddingFactor` × sampleCount on each side to create a
   * scroll buffer — panning within the padded region can be served synchronously.
   */
  async getWindow(
    captureId: string,
    startSample: number,
    sampleCount: number,
    paddingFactor = 0
  ): Promise<Uint8Array> {
    const meta = await this.store.getMeta(captureId);
    if (!meta) throw new Error(`Capture ${captureId} not found`);

    const bps = meta.bps;
    const totalSamples = meta.totalSamples;

    const padSamples = paddingFactor > 0 ? Math.floor(sampleCount * paddingFactor) : 0;
    const paddedStart = Math.max(0, startSample - padSamples);
    const paddedEnd = Math.min(startSample + sampleCount + padSamples, totalSamples);

    if (paddedStart >= paddedEnd || paddedStart < 0) {
      return new Uint8Array(0);
    }

    const requestedSamples = paddedEnd - paddedStart;
    const out = new Uint8Array(requestedSamples * bps);
    let outOffset = 0;

    const firstChunk = Math.floor(paddedStart / meta.chunkSize);
    const lastChunk = Math.floor((paddedEnd - 1) / meta.chunkSize);

    for (let chunkIdx = firstChunk; chunkIdx <= lastChunk; chunkIdx++) {
      const chunkStartSample = chunkIdx * meta.chunkSize;
      const chunkEndSample = Math.min((chunkIdx + 1) * meta.chunkSize, totalSamples);
      const chunk = await this._getChunk(captureId, chunkIdx);
      if (!chunk) continue;

      const overlapStart = Math.max(paddedStart, chunkStartSample);
      const overlapEnd = Math.min(paddedEnd, chunkEndSample);
      const srcByteStart = (overlapStart - chunkStartSample) * bps;
      const srcByteEnd = (overlapEnd - chunkStartSample) * bps;
      const slice = chunk.subarray(srcByteStart, srcByteEnd);
      out.set(slice, outOffset);
      outOffset += slice.length;
    }

    return out.subarray(0, outOffset);
  }

  /** Get a small probe window (first 2M samples) suitable for auto-detect. */
  async getProbe(captureId: string, maxSamples = 2_000_000): Promise<Uint8Array> {
    return this.getWindow(captureId, 0, maxSamples);
  }

  /** Get capture metadata. */
  async getMeta(captureId: string): Promise<LaCaptureMeta | null> {
    return this.store.getMeta(captureId);
  }

  /** List all captures, newest first. */
  async listCaptures(): Promise<LaCaptureMeta[]> {
    return this.store.listCaptures();
  }

  /** Delete a capture and evict its chunks from hot cache. */
  async deleteCapture(captureId: string): Promise<void> {
    this._evictCaptureFromCache(captureId);
    await this.store.deleteCapture(captureId);
  }

  /** Clear all history. */
  async clearAll(): Promise<void> {
    this.cache.clear();
    await this.store.deleteDatabase();
    await this.store.init();
  }

  // ── internal ──

  private async _getChunk(
    captureId: string,
    chunkIdx: number
  ): Promise<Uint8Array | null> {
    const key = `${captureId}:${chunkIdx}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.accessCounter++;
      cached.lastAccess = this.accessCounter;
      return cached.data;
    }

    const data = await this.store.getChunk(captureId, chunkIdx);
    if (!data) return null;

    this._putInCache(key, data);
    return data;
  }

  private _putInCache(key: string, data: Uint8Array): void {
    this.accessCounter++;
    this.cache.set(key, { data, lastAccess: this.accessCounter });

    if (this.cache.size > this.maxCache) {
      // Evict least-recently used
      let lruKey: string | null = null;
      let lruAccess = Infinity;
      for (const [k, v] of this.cache) {
        if (v.lastAccess < lruAccess) {
          lruAccess = v.lastAccess;
          lruKey = k;
        }
      }
      if (lruKey) this.cache.delete(lruKey);
    }
  }

  private _evictCaptureFromCache(captureId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${captureId}:`)) this.cache.delete(key);
    }
  }
}
