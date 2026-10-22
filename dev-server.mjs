// Run the portal on your own computer:  npm run dev   ->  http://localhost:8888
// Uses the same server code as Netlify, with a local folder (./.devdata) instead of Netlify storage.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handle } from './netlify/functions/lib/core.mjs';
import { fileDb } from './netlify/functions/lib/db-file.mjs';
import seedEmpty from './netlify/functions/lib/seed.mjs';
import { memoryDb } from './netlify/functions/lib/db-memory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createServer({ db, env = process.env, seed, fetchImpl = fetch } = {}) {
  const ctx = { db, env, secret: env.SESSION_SECRET, fetch: fetchImpl, seed };
  return http.createServer(async (req, res) => {
    try {
      if (req.url.split('?')[0] === '/api') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 5_000_000) break; chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8'); let body = null; try { body = JSON.parse(raw); } catch (e) {}
        const r = await handle(ctx, { method: req.method, body, ip: req.socket.remoteAddress || 'local', rawLength: size });
        res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS });
        return res.end(JSON.stringify(r.body));
      }
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index.html'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS });
        return res.end(fs.readFileSync(path.join(here, 'public', 'index.html')));
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) { res.writeHead(500); res.end('Server error'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = { ...process.env };
  if (!env.SESSION_SECRET) { env.SESSION_SECRET = crypto.randomBytes(32).toString('hex'); console.log('(Using a temporary SESSION_SECRET for this run.)'); }
  if (!env.ADMIN_PASSWORD) { env.ADMIN_PASSWORD = 'ChangeMe-Now-123'; console.log('(No ADMIN_PASSWORD set — using ChangeMe-Now-123 for local testing only.)'); }
  const seed = env.SEED_DEMO === 'true' ? JSON.parse(fs.readFileSync(path.join(here, 'data', 'seed-demo.json'), 'utf8'))
    : seedEmpty;
  const db = env.MEMORY === 'true' ? memoryDb() : fileDb(path.join(here, '.devdata'));
  const port = Number(env.PORT || 8888);
  createServer({ db, env, seed }).listen(port, () => console.log(`Portal running at http://localhost:${port}`));
}
