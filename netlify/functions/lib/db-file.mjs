// Simple file store for running the portal on your own computer (npm run dev). Not used on Netlify.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
export function fileDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (key) => path.join(dir, encodeURIComponent(key) + '.json');
  const tag = (txt) => crypto.createHash('sha1').update(txt).digest('hex');
  let chain = Promise.resolve();
  const lock = (fn) => (chain = chain.then(fn, fn));
  return {
    read: (key) => lock(async () => { try { const t = fs.readFileSync(f(key), 'utf8'); return { value: JSON.parse(t), etag: tag(t) }; } catch (e) { return { value: null, etag: null }; } }),
    write: (key, value, etag) => lock(async () => {
      let cur = null; try { cur = fs.readFileSync(f(key), 'utf8'); } catch (e) {}
      if (etag === null || etag === undefined) { if (cur !== null) return false; } else if (cur === null || tag(cur) !== etag) return false;
      fs.writeFileSync(f(key), JSON.stringify(value)); return true;
    }),
    list: (prefix) => lock(async () => fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => decodeURIComponent(n.slice(0, -5))).filter(k => k.startsWith(prefix))),
  };
}
