import { describe, it, expect, vi } from "vitest";
import { UsbTransport } from "./UsbTransport";
import type { UsbDataChunk } from "./usbTypes";

function buildBinaryFrame(
  rate: number,
  nBytes: number,
  reserved: number,
  raw: Uint8Array
): ArrayBuffer {
  const buf = new ArrayBuffer(24 + raw.length);
  const dv = new DataView(buf);
  dv.setUint32(0, 24 + raw.length, true);
  dv.setUint32(4, rate, true);
  dv.setUint32(8, nBytes, true);
  dv.setBigUint64(12, 0n, true);
  dv.setUint32(20, reserved, true);
  new Uint8Array(buf, 24).set(raw);
  return buf;
}

describe("UsbTransport", () => {
  it("resolves the stop RPC even when its reply is also a stopped notification", () => {
    const transport = new UsbTransport();
    const resolve = vi.fn();
    const stopped = vi.fn();
    transport.onStopped(stopped);
    const internals = transport as unknown as {pending: Map<string, unknown>; _handleMessage: (raw: string) => void};
    internals.pending.set('stop1', {resolve, reject: vi.fn()});
    internals._handleMessage(JSON.stringify({type: 'usb_stopped', req_id: 'stop1'}));
    expect(resolve).toHaveBeenCalledOnce();
    expect(internals.pending.has('stop1')).toBe(false);
    expect(stopped).toHaveBeenCalledOnce();
  });
  it("falls back to JSON usb_data messages from old bridges", () => {
    const transport = new UsbTransport();
    let received: UsbDataChunk | null = null;
    const off = transport.onData((c) => { received = c; });

    (transport as unknown as { _handleMessage: (raw: string) => void })._handleMessage(
      JSON.stringify({
        type: "usb_data",
        mode: "la",
        ts: 1.23,
        rate: 12_000_000,
        width: 16,
        samples: 4,
        b64: "AQIDBA==",
      })
    );

    expect(received).not.toBeNull();
    expect(received!.mode).toBe("la");
    expect(received!.rate).toBe(12_000_000);
    expect(received!.width).toBe(16);
    expect(received!.samples).toBe(4);
    expect(received!.b64).toBe("AQIDBA==");
    expect(received!.data).toBeUndefined();
    off();
  });

  it("parses binary LA frames with width encoded in reserved[0] (16-bit)", () => {
    const transport = new UsbTransport();
    (transport as unknown as { _deviceInfo: { mode: "la" | "dso" } })._deviceInfo = { mode: "la" };

    const raw = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const buf = buildBinaryFrame(12_000_000, raw.length, 16, raw);

    let received: UsbDataChunk | null = null;
    const off = transport.onData((c) => { received = c; });
    (transport as unknown as { _handleBinary: (b: ArrayBuffer) => void })._handleBinary(buf);

    expect(received).not.toBeNull();
    expect(received!.mode).toBe("la");
    expect(received!.width).toBe(16);
    expect(received!.samples).toBe(4);
    expect(received!.data).toEqual(raw);
    expect(received!.b64).toBe("");
    off();
  });

  it("parses binary LA frames with width encoded in reserved[0] (8-bit)", () => {
    const transport = new UsbTransport();
    (transport as unknown as { _deviceInfo: { mode: "la" | "dso" } })._deviceInfo = { mode: "la" };

    const raw = new Uint8Array([10, 20, 30, 40]);
    const buf = buildBinaryFrame(24_000_000, raw.length, 8, raw);

    let received: UsbDataChunk | null = null;
    const off = transport.onData((c) => { received = c; });
    (transport as unknown as { _handleBinary: (b: ArrayBuffer) => void })._handleBinary(buf);

    expect(received).not.toBeNull();
    expect(received!.mode).toBe("la");
    expect(received!.width).toBe(8);
    expect(received!.samples).toBe(4);
    expect(received!.data).toEqual(raw);
    off();
  });

  it("parses binary DSO frames as mode dso with width 8", () => {
    const transport = new UsbTransport();
    (transport as unknown as { _deviceInfo: { mode: "la" | "dso" } })._deviceInfo = { mode: "dso" };

    const raw = new Uint8Array([10, 20, 30]);
    const buf = buildBinaryFrame(48_000_000, raw.length, 0, raw);

    let received: UsbDataChunk | null = null;
    const off = transport.onData((c) => { received = c; });
    (transport as unknown as { _handleBinary: (b: ArrayBuffer) => void })._handleBinary(buf);

    expect(received).not.toBeNull();
    expect(received!.mode).toBe("dso");
    expect(received!.width).toBe(8);
    expect(received!.samples).toBe(3);
    expect(received!.data).toEqual(raw);
    off();
  });

  it("defaults binary frames to DSO width 8 when no device is connected", () => {
    const transport = new UsbTransport();

    const raw = new Uint8Array([1, 2, 3]);
    const buf = buildBinaryFrame(12_000_000, raw.length, 16, raw);

    let received: UsbDataChunk | null = null;
    const off = transport.onData((c) => { received = c; });
    (transport as unknown as { _handleBinary: (b: ArrayBuffer) => void })._handleBinary(buf);

    expect(received).not.toBeNull();
    expect(received!.mode).toBe("dso");
    expect(received!.width).toBe(8);
    off();
  });

  it("sets supportsBinaryLa from usb_connected response", async () => {
    const transport = new UsbTransport();
    const OriginalWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      binaryType = "arraybuffer";
      readyState = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      sent: string[] = [];
      close() { this.readyState = 3; if (this.onclose) this.onclose({} as CloseEvent); }
      send(data: string | ArrayBuffer) { this.sent.push(data as string); }
    }

    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    try {
      transport.connect();
      const ws = (transport as unknown as { ws: WebSocket }).ws;
      expect(ws).toBeInstanceOf(MockWebSocket);
      (ws as unknown as MockWebSocket).readyState = 1; // WebSocket.OPEN
      ws.onopen!({} as Event);

      const connectPromise = transport.connectDevice({
        vid: 0x1d50,
        pid: 0x608d,
        name: "Test LA",
        mode: "la",
        needs_fw: false,
        fw: null,
      });

      const req = JSON.parse((ws as unknown as { sent: string[] }).sent[0]);
      expect(req.type).toBe("usb_connect");

      ws.onmessage!({
        data: JSON.stringify({
          type: "usb_connected",
          req_id: req.req_id,
          device: "Test LA",
          mode: "la",
          binary_la: true,
        }),
      } as MessageEvent);

      const deviceName = await connectPromise;
      expect(deviceName).toBe("Test LA");
      expect(transport.supportsBinaryLa).toBe(true);
    } finally {
      vi.stubGlobal("WebSocket", OriginalWebSocket);
    }
  });
});
