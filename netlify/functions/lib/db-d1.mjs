// Cloudflare D1 store (production on Cloudflare).
// Same contract as the other stores: read(key) -> {value, etag}; write(key, value, etag) is conditional
// (etag null = only if new); list(prefix). D1 rows are limited to ~2 MB, so each value is cut into
// 500 KB pieces. A save first writes the new pieces under a fresh random version, then flips the
// version on the main row ONLY if the version it read is still current. Losing writers leave harmless
// orphan pieces that are cleaned up afterwards.
const PIECE = 500_000;
const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
const esc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function d1Db(D1) {
  return {
    async read(key) {
      for (let i = 0; i < 6; i++) {
        const row = await D1.prepare('SELECT etag, n FROM kv WHERE k = ?').bind(key).first();
        if (!row) return { value: null, etag: null };
        const { results } = await D1.prepare('SELECT d FROM kv_part WHERE k = ? AND v = ? ORDER BY i').bind(key, row.etag).all();
        if (results.length === row.n) return { value: JSON.parse(results.map(r => r.d).join('')), etag: row.etag };
        // a newer save replaced the pieces between the two reads: try again
      }
      throw new Error('Storage busy; please retry.');
    },
    async write(key, value, etag) {
      const json = JSON.stringify(value), v = rid(), parts = [];
      for (let i = 0; i * PIECE < json.length || i === 0; i++) parts.push(json.slice(i * PIECE, (i + 1) * PIECE));
      const ins = D1.prepare('INSERT INTO kv_part (k, v, i, d) VALUES (?, ?, ?, ?)');
      for (let a = 0; a < parts.length; a += 50)
        await D1.batch(parts.slice(a, a + 50).map((d, j) => ins.bind(key, v, a + j, d)));
      let won;
      if (etag === null || etag === undefined)
        won = (await D1.prepare('INSERT INTO kv (k, etag, n) VALUES (?, ?, ?) ON CONFLICT(k) DO NOTHING').bind(key, v, parts.length).run()).meta.changes === 1;
      else
        won = (await D1.prepare('UPDATE kv SET etag = ?, n = ? WHERE k = ? AND etag = ?').bind(v, parts.length, key, etag).run()).meta.changes === 1;
      // clean up: our pieces if we lost, everyone else's old pieces if we won
      if (won) await D1.prepare('DELETE FROM kv_part WHERE k = ? AND v <> ?').bind(key, v).run();
      else await D1.prepare('DELETE FROM kv_part WHERE k = ? AND v = ?').bind(key, v).run();
      return won;
    },
    async list(prefix) {
      const { results } = await D1.prepare("SELECT k FROM kv WHERE k LIKE ? ESCAPE '\\' ORDER BY k").bind(esc(prefix) + '%').all();
      return results.map(r => r.k);
    },
  };
}
