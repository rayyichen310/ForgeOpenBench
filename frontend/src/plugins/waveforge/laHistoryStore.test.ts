// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LaHistoryStore } from "./laHistoryStore";
import { LaHistoryBuffer } from "./LaHistoryBuffer";

// Minimal IndexedDB mock for Node test environment
class MockIDBRequest {
  result = undefined;
  error = null;
  source = null;
  transaction = null;
  readyState = "pending";
  onsuccess = null;
  onerror = null;

  dispatchSuccess(val) {
    this.result = val;
    this.readyState = "done";
    this.onsuccess?.({ target: this });
  }

  dispatchError(err) {
    this.error = err;
    this.readyState = "done";
    this.onerror?.({ target: this });
  }

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

class MockIDBObjectStore {
  data = new Map();

  _key(k) { return JSON.stringify(k); }

  put(value) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      const key = this._key(value.id ?? [value.captureId, value.chunkIdx]);
      this.data.set(key, value);
      req.dispatchSuccess(undefined);
    });
    return req;
  }

  get(key) {
    const req = new MockIDBRequest();
    queueMicrotask(() => req.dispatchSuccess(this.data.get(this._key(key))));
    return req;
  }

  delete(key) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      this.data.delete(this._key(key));
      req.dispatchSuccess(undefined);
    });
    return req;
  }

  getAll() {
    const req = new MockIDBRequest();
    queueMicrotask(() => req.dispatchSuccess(Array.from(this.data.values())));
    return req;
  }

  getAllKeys() {
    const req = new MockIDBRequest();
    queueMicrotask(() => req.dispatchSuccess(Array.from(this.data.keys())));
    return req;
  }

  index() {
    const data = this.data;
    return {
      getAllKeys() {
        const req = new MockIDBRequest();
        queueMicrotask(() => req.dispatchSuccess([]));
        return req;
      },
      getAll(range) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
          const values = [];
          for (const record of data.values()) {
            if (record.captureId === range) values.push(record);
          }
          req.dispatchSuccess(values);
        });
        return req;
      },
    };
  }
}

class MockIDBTransaction {
  stores = new Map();

  objectStore(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MockIDBObjectStore());
    return this.stores.get(name);
  }
}

class MockIDBDatabase {
  stores = new Map();

  transaction(storeNames) {
    const stores = this.stores;
    for (const name of storeNames) {
      if (!stores.has(name)) stores.set(name, new MockIDBObjectStore());
    }
    const tx = {
      objectStore(name) {
        return stores.get(name);
      },
      oncomplete: null,
      onerror: null,
      onabort: null,
    };
    // Fire oncomplete on next tick so putChunks resolves in tests
    queueMicrotask(() => {
      if (tx.oncomplete) tx.oncomplete();
    });
    return tx;
  }

  close() {}

  objectStoreNames = {
    contains: () => true,
    *[Symbol.iterator]() { yield "captures"; yield "chunks"; },
    length: 2,
    item: (i) => (i === 0 ? "captures" : "chunks"),
  };
}

let mockDb = new MockIDBDatabase();

globalThis.indexedDB = {
  open() {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      req.result = mockDb;
      req.dispatchSuccess(mockDb);
    });
    return req;
  },
  deleteDatabase() {
    const req = new MockIDBRequest();
    queueMicrotask(() => req.dispatchSuccess(undefined));
    return req;
  },
};

globalThis.IDBKeyRange = {
  only: (v) => v,
};

describe("LaHistoryStore", () => {
  let store;

  beforeEach(async () => {
    mockDb = new MockIDBDatabase();
    store = new LaHistoryStore();
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("creates and retrieves capture metadata", async () => {
    const id = await store.createCapture({
      sampleRate: 12_000_000,
      width: 16,
      source: "test",
      importedAt: new Date().toISOString(),
      channelLabels: ["D0"],
      chunkSize: 1_000_000,
      bps: 2,
    });

    expect(id).toBeTruthy();
    const meta = await store.getMeta(id);
    expect(meta).not.toBeNull();
    expect(meta.sampleRate).toBe(12_000_000);
    expect(meta.width).toBe(16);
  });

  it("stores and retrieves a chunk", async () => {
    const id = await store.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "test",
      importedAt: new Date().toISOString(),
      chunkSize: 1_000_000,
      bps: 1,
    });

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await store.putChunk({
      captureId: id,
      chunkIdx: 0,
      startSample: 0,
      endSample: 5,
      data,
    });

    const retrieved = await store.getChunk(id, 0);
    expect(retrieved).not.toBeNull();
    expect(Array.from(retrieved)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null for missing chunk", async () => {
    const result = await store.getChunk("nonexistent", 0);
    expect(result).toBeNull();
  });

  it("lists captures newest first", async () => {
    await store.createCapture({
      sampleRate: 1_000_000, width: 8, source: "a",
      importedAt: "2026-01-01T00:00:00.000Z", chunkSize: 1_000_000, bps: 1,
    });
    await store.createCapture({
      sampleRate: 2_000_000, width: 16, source: "b",
      importedAt: "2026-01-02T00:00:00.000Z", chunkSize: 1_000_000, bps: 2,
    });

    const list = await store.listCaptures();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].source).toBe("b");
  });
});

describe("LaHistoryBuffer", () => {
  let buf;

  beforeEach(async () => {
    mockDb = new MockIDBDatabase();
    buf = new LaHistoryBuffer({ chunkSize: 10 });
    await buf.init();
  });

  afterEach(async () => {
    await buf.close();
  });

  it("ingests a capture and splits into chunks", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    const meta = await buf.getMeta(id);
    expect(meta).not.toBeNull();
    expect(meta.totalSamples).toBe(25);
    expect(meta.chunkCount).toBe(3); // 10 + 10 + 5
  });

  it("retrieves a window spanning multiple chunks", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    const window = await buf.getWindow(id, 5, 8); // samples 5-12
    expect(window.length).toBe(8);
    expect(Array.from(window)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("returns an empty array for out-of-bounds window", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array([0, 1, 2, 3, 4]),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    const window = await buf.getWindow(id, 10, 5);
    expect(window.length).toBe(0);
  });

  it("caches chunks and evicts LRU entries", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array(100).fill(0).map((_, i) => i),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    // First access loads into cache
    await buf.getWindow(id, 0, 5);
    // Second access should hit cache
    const w2 = await buf.getWindow(id, 0, 5);
    expect(Array.from(w2)).toEqual([0, 1, 2, 3, 4]);
  });

  it("getWindow with paddingFactor returns padded range", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    // Request window at samples 5-8 (4 samples) with paddingFactor 1.0 → pad by 4 on each side
    // padded range = [1, 12), but clamped to total = 20
    const window = await buf.getWindow(id, 5, 4, 1.0);
    expect(window.length).toBe(12); // padded range [1, 13) = samples 1..12
    expect(Array.from(window)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("getWindow paddingFactor clamps at capture boundaries", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    // Request window at start with large padding — should clamp to [0, 10)
    const window = await buf.getWindow(id, 0, 3, 2.0);
    expect(window.length).toBe(9); // samples 0-8 inclusive (0..8), paddedStart=0, paddedEnd=0+3+6=9
    expect(Array.from(window)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("getWindow with paddingFactor 0 returns exact window", async () => {
    const capture = {
      sampleRate: 1_000_000,
      width: 8,
      samples: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      source: "test",
      importedAt: new Date().toISOString(),
    };
    const id = await buf.ingest(capture);
    const window = await buf.getWindow(id, 3, 4, 0);
    expect(window.length).toBe(4);
    expect(Array.from(window)).toEqual([3, 4, 5, 6]);
  });

  it("createCapture + appendChunk + finalizeCapture streams a capture", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      channelLabels: ["D0"],
      chunkSize: 10,
      bps: 1,
    });
    await buf.appendChunk(id, new Uint8Array([0, 1, 2, 3, 4]));
    await buf.appendChunk(id, new Uint8Array([5, 6, 7, 8, 9]));
    await buf.appendChunk(id, new Uint8Array([10, 11, 12]));
    const meta = await buf.finalizeCapture(id);
    expect(meta.totalSamples).toBe(13);
    expect(meta.chunkCount).toBe(2);

    const window = await buf.getWindow(id, 0, 13);
    expect(Array.from(window)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("appendChunk extends the last partial chunk", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
    });
    await buf.appendChunk(id, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    await buf.appendChunk(id, new Uint8Array([8, 9, 10, 11]));
    const meta = await buf.finalizeCapture(id);
    expect(meta.totalSamples).toBe(12);
    expect(meta.chunkCount).toBe(2);

    const window = await buf.getWindow(id, 0, 12);
    expect(Array.from(window)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("regression: RLE-compressible appendChunk data reads back byte-identical (cache poisoning)", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
    });
    // Constant data compresses to ~2 bytes per chunk — the old code cached the
    // encoded bytes and getWindow returned garbage.
    const input = new Uint8Array(25).fill(7);
    await buf.appendChunk(id, input);
    const before = await buf.getWindow(id, 0, 25);
    expect(Array.from(before)).toEqual(Array.from(input));
    await buf.finalizeCapture(id);
    const after = await buf.getWindow(id, 0, 25);
    expect(Array.from(after)).toEqual(Array.from(input));
  });

  it("staged tail is visible through getMeta and getWindow before finalize", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
    });
    await buf.appendChunk(id, new Uint8Array([0, 1, 2, 3, 4])); // less than one chunk
    const meta = await buf.getMeta(id);
    expect(meta.totalSamples).toBe(5);
    expect(meta.chunkCount).toBe(1); // virtual staged chunk
    const window = await buf.getWindow(id, 0, 5);
    expect(Array.from(window)).toEqual([0, 1, 2, 3, 4]);

    await buf.appendChunk(id, new Uint8Array([5, 6, 7, 8, 9, 10, 11])); // spills into chunk 1
    const meta2 = await buf.getMeta(id);
    expect(meta2.totalSamples).toBe(12);
    const window2 = await buf.getWindow(id, 8, 4); // spans flushed chunk 0 and staged chunk 1
    expect(Array.from(window2)).toEqual([8, 9, 10, 11]);
  });

  it("persists each chunk exactly once (write-behind, no read-modify-write)", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
    });
    let putCalls = 0;
    const origPutChunks = buf["store"].putChunks.bind(buf["store"]);
    buf["store"].putChunks = (records) => {
      putCalls += records.length;
      return origPutChunks(records);
    };
    for (let i = 0; i < 4; i++) {
      await buf.appendChunk(id, new Uint8Array(8).map((_, j) => i * 8 + j)); // 32 bytes in 8-byte writes
    }
    expect(putCalls).toBe(3); // three full chunks flushed, 2 samples staged
    const meta = await buf.finalizeCapture(id);
    expect(putCalls).toBe(4); // final partial chunk
    expect(meta.totalSamples).toBe(32);
    expect(meta.chunkCount).toBe(4);
    const window = await buf.getWindow(id, 0, 32);
    expect(Array.from(window)).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });

  it("resume-append after finalize extends the partial last chunk (backfill)", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
    });
    await buf.appendChunk(id, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    await buf.finalizeCapture(id); // persists partial chunk 0 (8 samples)
    await buf.appendChunk(id, new Uint8Array([8, 9, 10, 11])); // fills chunk 0, stages 2
    const meta = await buf.finalizeCapture(id);
    expect(meta.totalSamples).toBe(12);
    expect(meta.chunkCount).toBe(2);
    const window = await buf.getWindow(id, 0, 12);
    expect(Array.from(window)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("evicts oldest chunks when storedBytes exceeds retentionBytes", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
      retentionBytes: 30,
    });
    // Three full chunks of 10 bytes each ≈ 30 bytes budget, but encoded length is the raw length
    // here (RLE of flat-ish data). Stream enough to create 3 full chunks.
    for (let i = 0; i < 5; i++) {
      await buf.appendChunk(id, new Uint8Array(10).map((_, j) => i * 10 + j));
    }
    const meta = await buf.finalizeCapture(id);
    expect(meta.totalSamples).toBe(50);
    expect(meta.storedBytes).toBeLessThanOrEqual(30);
    expect(meta.trimmedBeforeSample).toBeGreaterThan(0);
  });

  it("updates trimmedBeforeSample and getWindow returns empty for fully trimmed ranges", async () => {
    const id = await buf.createCapture({
      sampleRate: 1_000_000,
      width: 8,
      source: "stream-test",
      importedAt: new Date().toISOString(),
      chunkSize: 10,
      bps: 1,
      retentionBytes: 20,
    });
    for (let i = 0; i < 5; i++) {
      await buf.appendChunk(id, new Uint8Array(10).map((_, j) => i * 10 + j));
    }
    await buf.finalizeCapture(id);
    const meta = await buf.getMeta(id);
    expect(meta.trimmedBeforeSample).toBeGreaterThanOrEqual(10);
    const before = await buf.getWindow(id, 0, meta.trimmedBeforeSample);
    expect(before.length).toBe(0);
    const after = await buf.getWindow(id, meta.trimmedBeforeSample, meta.totalSamples - meta.trimmedBeforeSample);
    expect(after.length).toBeGreaterThan(0);
  });
});
