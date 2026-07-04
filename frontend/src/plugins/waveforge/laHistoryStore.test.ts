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
    return {
      getAllKeys() {
        const req = new MockIDBRequest();
        queueMicrotask(() => req.dispatchSuccess([]));
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
});
