// Netlify Blobs store (production).
import { getStore } from '@netlify/blobs';
export function blobsDb(opts = {}) {
  const store = getStore({ name: 'portal-data', consistency: 'strong', ...opts });
  return {
    async read(key) {
      for (let i = 0; i < 6; i++) {
        const r = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
        if (!r) return { value: null, etag: null };
        if (r.etag) return { value: r.data, etag: r.etag };
        // Some environments omit the tag on reads: take it from the listing, and accept it only if the
        // data did not change in between (otherwise a stale copy could be saved over newer work).
        const { blobs } = await store.list({ prefix: key });
        const hit = blobs.find(x => x.key === key);
        const again = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
        if (hit && hit.etag && again && JSON.stringify(again.data) === JSON.stringify(r.data)) return { value: r.data, etag: hit.etag };
      }
      throw new Error('Storage did not return a stable version tag; refusing an unsafe write.');
    },
    async write(key, value, etag) {
      const opts = (etag === null || etag === undefined) ? { onlyIfNew: true } : { onlyIfMatch: etag };
      const r = await store.setJSON(key, value, opts);
      return r.modified !== false;
    },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map(b => b.key);
    },
  };
}
