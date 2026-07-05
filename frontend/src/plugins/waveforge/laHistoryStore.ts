/**
 * IndexedDB-backed persistent storage for Logic-Analyzer captures.
 *
 * Design:
 * - Two object stores: "captures" (metadata) and "chunks" (binary data).
 * - Each capture is split into fixed-size sample chunks (default 1M samples).
 * - Chunk keys are composite [captureId, chunkIdx] for fast range scans.
 * - All APIs are async; callers (WaveformLaView, decoders) await windows.
 *
 * Invariants: local-first, zero-telemetry, no third-party deps.
 */

import { rleDecode, type RleFormat } from "./laRle";

const DB_NAME = "forge-la-history";
const DB_VERSION = 1;
const META_STORE = "captures";
const CHUNK_STORE = "chunks";

export interface LaChunkRecord {
  captureId: string;
  chunkIdx: number;
  startSample: number;
  endSample: number;
  data: Uint8Array;
  format?: "rle" | "raw";
}

export interface LaCaptureMeta {
  id: string;
  sampleRate: number;
  width: 8 | 16;
  source: string;
  importedAt: string;
  channelLabels?: string[];
  totalSamples: number;
  chunkSize: number;
  chunkCount: number;
  bps: number; // bytes per sample
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisifyVoid(req: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export class LaHistoryStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: ["captureId", "chunkIdx"] });
          chunkStore.createIndex("byCapture", "captureId", { unique: false });
        }
      };
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Create a new capture metadata record and return its generated id. */
  async createCapture(
    meta: Omit<LaCaptureMeta, "id" | "chunkCount" | "totalSamples">
  ): Promise<string> {
    const db = this._db();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const record: LaCaptureMeta = {
      ...meta,
      id,
      chunkCount: 0,
      totalSamples: 0,
    };
    const tx = db.transaction([META_STORE], "readwrite");
    const store = tx.objectStore(META_STORE);
    await promisifyVoid(store.put(record));
    return id;
  }

  /** Store a single chunk. */
  async putChunk(record: LaChunkRecord): Promise<void> {
    const db = this._db();
    const tx = db.transaction([CHUNK_STORE], "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    await promisifyVoid(store.put(record));
  }

  /** Store multiple chunks in a single transaction (much faster for bulk ingest). */
  async putChunks(records: LaChunkRecord[]): Promise<void> {
    const db = this._db();
    const tx = db.transaction([CHUNK_STORE], "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    for (const record of records) {
      store.put(record);
    }
    // Wait for transaction completion — all puts are fire-and-forget within the tx
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error("Transaction aborted"));
    });
  }

  /** Retrieve a single chunk record by composite key (caller must decompress). */
  async getChunkRecord(captureId: string, chunkIdx: number): Promise<LaChunkRecord | null> {
    const db = this._db();
    const tx = db.transaction([CHUNK_STORE], "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    const result = await promisify<LaChunkRecord | undefined>(store.get([captureId, chunkIdx]));
    return result ?? null;
  }

  /** Retrieve multiple chunk records in a single transaction (caller must decompress). */
  async getChunkRecords(captureId: string, chunkIdxs: number[]): Promise<LaChunkRecord[]> {
    if (chunkIdxs.length === 0) return [];
    const db = this._db();
    const tx = db.transaction([CHUNK_STORE], "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    const results = await Promise.all(
      chunkIdxs.map(idx => promisify<LaChunkRecord | undefined>(store.get([captureId, idx])))
    );
    return results.filter((r): r is LaChunkRecord => r !== undefined);
  }

  /** Retrieve a single chunk by composite key (returns decompressed bytes). */
  async getChunk(captureId: string, chunkIdx: number): Promise<Uint8Array | null> {
    const db = this._db();
    const tx = db.transaction([META_STORE, CHUNK_STORE], "readonly");
    const metaStore = tx.objectStore(META_STORE);
    const chunkStore = tx.objectStore(CHUNK_STORE);
    const [record, meta] = await Promise.all([
      promisify<LaChunkRecord | undefined>(chunkStore.get([captureId, chunkIdx])),
      promisify<LaCaptureMeta | undefined>(metaStore.get(captureId)),
    ]);
    if (!record || !meta) return null;
    const byteLength = (record.endSample - record.startSample) * meta.bps;
    return rleDecode(record.data, meta.bps as 1 | 2, (record.format ?? "raw") as RleFormat, byteLength);
  }

  /** Update capture metadata (e.g., after chunking is complete). */
  async updateMeta(meta: LaCaptureMeta): Promise<void> {
    const db = this._db();
    const tx = db.transaction([META_STORE], "readwrite");
    const store = tx.objectStore(META_STORE);
    await promisifyVoid(store.put(meta));
  }

  /** Get capture metadata. */
  async getMeta(captureId: string): Promise<LaCaptureMeta | null> {
    const db = this._db();
    const tx = db.transaction([META_STORE], "readonly");
    const store = tx.objectStore(META_STORE);
    const result = await promisify<LaCaptureMeta | undefined>(store.get(captureId));
    return result ?? null;
  }

  /** List all capture metadata, newest first. */
  async listCaptures(): Promise<LaCaptureMeta[]> {
    const db = this._db();
    const tx = db.transaction([META_STORE], "readonly");
    const store = tx.objectStore(META_STORE);
    const result = await promisify<LaCaptureMeta[]>(store.getAll());
    return result.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  /** Delete a capture and all its chunks. */
  async deleteCapture(captureId: string): Promise<void> {
    const db = this._db();
    const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
    const metaStore = tx.objectStore(META_STORE);
    const chunkStore = tx.objectStore(CHUNK_STORE);
    const idx = chunkStore.index("byCapture");

    // Delete all chunks for this capture
    const range = IDBKeyRange.only(captureId);
    const keysReq = idx.getAllKeys(range);
    const keys = (await promisify<IDBValidKey[]>(keysReq)) as Array<[string, number]>;
    for (const key of keys) {
      await promisifyVoid(chunkStore.delete(key));
    }

    await promisifyVoid(metaStore.delete(captureId));
  }

  /** Delete the entire database (nuclear option for testing / user clear). */
  async deleteDatabase(): Promise<void> {
    await this.close();
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private _db(): IDBDatabase {
    if (!this.db) throw new Error("LaHistoryStore not initialized. Call init() first.");
    return this.db;
  }
}
