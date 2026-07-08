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
import { rleEncode, rleDecode, type RleFormat } from "./laRle";
import { LaStreamWriter, type LaChunkSink } from "./laStreamWriter";

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
  private writers = new Map<string, Promise<LaStreamWriter>>();

  constructor(options?: { maxCache?: number; chunkSize?: number }) {
    this.maxCache = options?.maxCache ?? DEFAULT_MAX_CACHE;
    this.chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async close(): Promise<void> {
    this.writers.clear();
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
    let storedBytes = 0;
    for (let i = 0; i < chunkCount; i++) {
      const startSample = i * this.chunkSize;
      const endSample = Math.min((i + 1) * this.chunkSize, totalSamples);
      const byteStart = startSample * bps;
      const byteEnd = endSample * bps;
      const chunkData = capture.samples.subarray(byteStart, byteEnd);
      // Store a copy — subarray is a view and may be invalidated
      const encoded = rleEncode(new Uint8Array(chunkData), bps as 1 | 2);
      storedBytes += encoded.data.length;
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
      storedBytes,
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
    const writer = await this._activeWriter(captureId);

    const bps = meta.bps;
    const totalSamples = writer ? Math.max(meta.totalSamples, writer.totalSamples) : meta.totalSamples;
    const trimmedBefore = meta.trimmedBeforeSample ?? 0;

    const padSamples = paddingFactor > 0 ? Math.floor(sampleCount * paddingFactor) : 0;
    const rawStart = Math.max(0, startSample - padSamples);
    const rawEnd = Math.min(startSample + sampleCount + padSamples, totalSamples);
    const paddedStart = Math.max(rawStart, trimmedBefore);
    const paddedEnd = Math.max(rawEnd, trimmedBefore);

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
      // The staged tail of an active stream is served as a virtual last chunk.
      const chunk = writer && chunkIdx === writer.chunkCount && writer.stagedSamples > 0
        ? writer.stagedTail()
        : await this._getChunk(captureId, chunkIdx, meta);
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

  /** Get capture metadata. Includes staged (not yet persisted) samples of an active stream. */
  async getMeta(captureId: string): Promise<LaCaptureMeta | null> {
    const meta = await this.store.getMeta(captureId);
    if (!meta) return null;
    const writer = await this._activeWriter(captureId);
    if (!writer) return meta;
    return {
      ...meta,
      totalSamples: Math.max(meta.totalSamples, writer.totalSamples),
      chunkCount: Math.max(meta.chunkCount, writer.chunkCount + (writer.stagedSamples > 0 ? 1 : 0)),
    };
  }

  /** List all captures, newest first. */
  async listCaptures(): Promise<LaCaptureMeta[]> {
    return this.store.listCaptures();
  }

  /** Delete a capture and evict its chunks from hot cache. */
  async deleteCapture(captureId: string): Promise<void> {
    this.writers.delete(captureId);
    this._evictCaptureFromCache(captureId);
    await this.store.deleteCapture(captureId);
  }

  /** Clear all history. */
  async clearAll(): Promise<void> {
    this.writers.clear();
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
   * Append raw sample bytes to an existing capture via its stream writer.
   * Whole chunks are persisted as staging fills; the staged tail stays readable
   * through getWindow/getMeta before it is flushed by finalizeCapture.
   */
  async appendChunk(captureId: string, data: Uint8Array): Promise<void> {
    if (data.length === 0) return;
    const writer = await this.getStreamWriter(captureId);
    await writer.write(data);
  }

  /**
   * Get (or create) the stream writer for a capture. Exposed so live capture
   * can register an onChunkFlushed hook (e.g., pyramid tile generation).
   */
  async getStreamWriter(captureId: string): Promise<LaStreamWriter> {
    let pending = this.writers.get(captureId);
    if (!pending) {
      pending = this._createWriter(captureId);
      this.writers.set(captureId, pending);
      pending.catch(() => this.writers.delete(captureId));
    }
    return pending;
  }

  /** Finalize a streaming capture: flush the staged tail and return the metadata. */
  async finalizeCapture(captureId: string): Promise<LaCaptureMeta> {
    const pending = this.writers.get(captureId);
    if (pending) {
      const writer = await pending;
      await writer.flush();
      this.writers.delete(captureId);
    }
    const meta = await this.store.getMeta(captureId);
    if (!meta) throw new Error(`Capture ${captureId} not found`);
    return meta;
  }

  // ── internal ──

  /** Enforce retention budget by deleting oldest chunks until storedBytes <= budget. */
  private async _enforceRetention(
    captureId: string,
    liveMeta: { storedBytes: number; totalSamples: number; chunkCount: number; trimmedBeforeSample: number; retentionBytes?: number; chunkSize: number }
  ): Promise<void> {
    const budget = liveMeta.retentionBytes;
    if (!budget || budget <= 0) return;
    if (liveMeta.storedBytes <= budget) return;

    const records = await this.store.getChunkRecordsForCapture(captureId);
    records.sort((a, b) => a.chunkIdx - b.chunkIdx);

    let storedBytes = liveMeta.storedBytes;
    const toDelete: number[] = [];
    let lastDeletedIdx = -1;
    for (const record of records) {
      if (storedBytes <= budget) break;
      toDelete.push(record.chunkIdx);
      storedBytes -= record.data.length;
      lastDeletedIdx = record.chunkIdx;
    }
    if (toDelete.length === 0) return;

    await this.store.deleteChunks(captureId, toDelete);
    for (const idx of toDelete) {
      this.cache.delete(`${captureId}:${idx}`);
    }
    const chunkSize = liveMeta.chunkSize;
    const trimmedBeforeSample = Math.min(
      (lastDeletedIdx + 1) * chunkSize,
      liveMeta.totalSamples
    );
    liveMeta.storedBytes = storedBytes;
    liveMeta.trimmedBeforeSample = Math.max(liveMeta.trimmedBeforeSample, trimmedBeforeSample);
    const base = await this.store.getMeta(captureId);
    if (base) {
      await this.store.updateMeta({
        ...base,
        storedBytes,
        trimmedBeforeSample: liveMeta.trimmedBeforeSample,
      });
    }
  }

  private async _activeWriter(captureId: string): Promise<LaStreamWriter | null> {
    const pending = this.writers.get(captureId);
    return pending ? pending : null;
  }

  private async _createWriter(captureId: string): Promise<LaStreamWriter> {
    const meta = await this.store.getMeta(captureId);
    if (!meta) throw new Error(`Capture ${captureId} not found`);
    const bps = meta.bps;

    // Track mutable state in closure to avoid redundant IDB reads on every flush.
    const liveMeta = {
      storedBytes: meta.storedBytes ?? 0,
      totalSamples: meta.totalSamples,
      chunkCount: meta.chunkCount,
      trimmedBeforeSample: meta.trimmedBeforeSample ?? 0,
      retentionBytes: meta.retentionBytes,
      chunkSize: meta.chunkSize,
    };

    const sink: LaChunkSink = {
      flushChunk: async (chunkIdx, raw, startSample) => {
        const samples = Math.floor(raw.length / bps);
        const encoded = rleEncode(raw, bps as 1 | 2);
        await this.store.putChunks([{
          captureId,
          chunkIdx,
          startSample,
          endSample: startSample + samples,
          data: encoded.data,
          format: encoded.format,
        }]);
        liveMeta.storedBytes += encoded.data.length;
        liveMeta.totalSamples = Math.max(liveMeta.totalSamples, startSample + samples);
        liveMeta.chunkCount = Math.max(liveMeta.chunkCount, chunkIdx + 1);
        await this.store.updateMeta({
          ...meta,
          totalSamples: liveMeta.totalSamples,
          chunkCount: liveMeta.chunkCount,
          storedBytes: liveMeta.storedBytes,
          trimmedBeforeSample: liveMeta.trimmedBeforeSample,
        });
        // Cache the decoded raw bytes — consumers expect decoded samples.
        this._putInCache(`${captureId}:${chunkIdx}`, raw);
        await this._enforceRetention(captureId, liveMeta);
      },
    };

    // Resume-append: if the last persisted chunk is partial, load it into staging
    // so it is extended in place and chunk boundaries stay aligned to chunkSize.
    let start = { chunkCount: meta.chunkCount, totalSamples: meta.totalSamples };
    let backfill: Uint8Array | null = null;
    if (meta.chunkCount > 0) {
      const lastIdx = meta.chunkCount - 1;
      const lastChunk = await this._getChunk(captureId, lastIdx, meta);
      if (lastChunk && Math.floor(lastChunk.length / bps) < meta.chunkSize) {
        start = { chunkCount: lastIdx, totalSamples: lastIdx * meta.chunkSize };
        backfill = lastChunk;
      }
    }

    const writer = new LaStreamWriter(sink, bps, meta.chunkSize, start);
    if (backfill) writer.backfill(backfill);
    return writer;
  }

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
