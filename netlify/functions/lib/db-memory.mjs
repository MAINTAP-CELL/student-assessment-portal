// In-memory store (used by automated tests).
export function memoryDb() {
  const m = new Map(); let n = 0;
  return {
    async read(key) { const r = m.get(key); return r ? { value: JSON.parse(r.json), etag: r.etag } : { value: null, etag: null }; },
    async write(key, value, etag) {
      const r = m.get(key);
      if (etag === null || etag === undefined) { if (r) return false; }
      else if (!r || r.etag !== etag) return false;
      m.set(key, { json: JSON.stringify(value), etag: String(++n) }); return true;
    },
    async list(prefix) { return [...m.keys()].filter(k => k.startsWith(prefix)); },
  };
}
