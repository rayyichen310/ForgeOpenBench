// Stored (uncompressed) ZIP, enough for unzipAll.
export function storedZip(files: Record<string, Uint8Array>): ArrayBuffer {
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = new TextEncoder().encode(name);
    const lh = new Uint8Array(30 + n.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true); lh.set(n, 30);
    const cd = new Uint8Array(46 + n.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true); cd.set(n, 46);
    local.push(lh, data); central.push(cd); offset += lh.length + data.length;
  }
  const size = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const parts = [...local, ...central, eocd];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out.buffer;
}
