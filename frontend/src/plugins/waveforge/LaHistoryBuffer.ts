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

import { LaHistoryStore, type LaCaptureMeta, type LaChunkRecord } from "./laHistoryStore";
import type { LaCapture } from "./laDecoders";
import { rleEncode, rleDecode, type RleFormat } from "./laRle";

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
      const encoded = rleEncode(new Uint8Array(chunkData), bps as 1 | 2);
      records.push({
        captureId,
        chunkIdx: i,
        startSample,
        endSample,
        data: encoded.data,
        format: encoded.format,
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

    // Bulk fetch any missing chunks in a single IDB transaction instead of one per chunk.
    const missing: number[] = [];
    for (let chunkIdx = firstChunk; chunkIdx <= lastChunk; chunkIdx++) {
      const key = `${captureId}:${chunkIdx}`;
      if (!this.cache.has(key)) missing.push(chunkIdx);
    }
    if (missing.length > 0) {
      const records = await this.store.getChunkRecords(captureId, missing);
      for (const record of records) {
        const key = `${captureId}:${record.chunkIdx}`;
        if (this.cache.has(key)) continue;
        const byteLength = (record.endSample - record.startSample) * meta.bps;
        const data = rleDecode(record.data, meta.bps as 1 | 2, (record.format ?? "raw") as RleFormat, byteLength);
        this._putInCache(key, data);
      }
    }

    for (let chunkIdx = firstChunk; chunkIdx <= lastChunk; chunkIdx++) {
      const chunkStartSample = chunkIdx * meta.chunkSize;
      const chunkEndSample = Math.min((chunkIdx + 1) * meta.chunkSize, totalSamples);
      const chunk = await this._getChunk(captureId, chunkIdx, meta);
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

  /** Create an empty capture and return its id. */
  async createCapture(
    meta: Omit<LaCaptureMeta, "id" | "chunkCount" | "totalSamples">
  ): Promise<string> {
    return this.store.createCapture(meta);
  }

  /**
   * Append raw sample bytes to an existing capture. Data is split into chunks and
   * persisted incrementally so the capture becomes viewable before the full stream
   * is complete. Last chunk is read, extended, and rewritten to keep chunk boundaries
   * aligned with the configured chunkSize.
   */
  async appendChunk(captureId: string, data: Uint8Array): Promise<void> {
    const meta = await this.store.getMeta(captureId);
    if (!meta) throw new Error(`Capture ${captureId} not found`);

    const bps = meta.bps;
    const chunkSize = meta.chunkSize;
    const totalSamples = meta.totalSamples;

    if (data.length === 0) return;

    let records: LaChunkRecord[] = [];
    let nextSample = totalSamples;
    let chunkIdx = meta.chunkCount;
    let remaining = data;

    // Extend the last existing chunk if it is partial
    if (meta.chunkCount > 0) {
      const lastChunkIdx = meta.chunkCount - 1;
      const lastChunk = await this._getChunk(captureId, lastChunkIdx, meta);
      if (lastChunk) {
        const samplesInLast = Math.floor(lastChunk.length / bps);
        const room = chunkSize - samplesInLast;
        if (room > 0) {
          const takeBytes = Math.min(remaining.length, room * bps);
          const combined = new Uint8Array(lastChunk.length + takeBytes);
          combined.set(lastChunk);
          combined.set(remaining.subarray(0, takeBytes), lastChunk.length);
          const encoded = rleEncode(combined, bps as 1 | 2);
          records.push({
            captureId,
            chunkIdx: lastChunkIdx,
            startSample: lastChunkIdx * chunkSize,
            endSample: lastChunkIdx * chunkSize + Math.floor(combined.length / bps),
            data: encoded.data,
            format: encoded.format,
          });
          nextSample += Math.floor(takeBytes / bps);
          chunkIdx = meta.chunkCount;
          remaining = remaining.subarray(takeBytes);
        }
      }
    }

    // Add remaining data as full or partial new chunks
    let offset = 0;
    while (offset < remaining.length) {
      const remainingBytes = remaining.length - offset;
      const chunkBytes = Math.min(remainingBytes, chunkSize * bps);
      const chunkData = remaining.subarray(offset, offset + chunkBytes);
      const encoded = rleEncode(new Uint8Array(chunkData), bps as 1 | 2);
      records.push({
        captureId,
        chunkIdx,
        startSample: nextSample,
        endSample: nextSample + Math.floor(chunkData.length / bps),
        data: encoded.data,
        format: encoded.format,
      });
      offset += chunkBytes;
      nextSample += Math.floor(chunkBytes / bps);
      chunkIdx++;
    }

    await this.store.putChunks(records);

    const addedSamples = Math.floor(data.length / bps);
    const newTotalSamples = totalSamples + addedSamples;
    const newChunkCount = records.length > 0 ? records[records.length - 1].chunkIdx + 1 : meta.chunkCount;

    await this.store.updateMeta({
      ...meta,
      totalSamples: newTotalSamples,
      chunkCount: newChunkCount,
    });

    // Update hot cache
    for (const r of records) {
      const key = `${captureId}:${r.chunkIdx}`;
      this._putInCache(key, r.data);
    }
  }

  /** Finalize a streaming capture and return the updated metadata. */
  async finalizeCapture(captureId: string): Promise<LaCaptureMeta> {
    const meta = await this.store.getMeta(captureId);
    if (!meta) throw new Error(`Capture ${captureId} not found`);
    return meta;
  }

  // ── internal ──

  private async _getChunk(
    captureId: string,
    chunkIdx: number,
    meta?: LaCaptureMeta
  ): Promise<Uint8Array | null> {
    const key = `${captureId}:${chunkIdx}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.accessCounter++;
      cached.lastAccess = this.accessCounter;
      return cached.data;
    }

    const record = await this.store.getChunkRecord(captureId, chunkIdx);
    if (!record) return null;

    const m = meta ?? await this.store.getMeta(captureId);
    if (!m) return null;

    const byteLength = (record.endSample - record.startSample) * m.bps;
    const data = rleDecode(record.data, m.bps as 1 | 2, (record.format ?? "raw") as RleFormat, byteLength);
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
