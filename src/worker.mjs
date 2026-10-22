// Cloudflare Worker: POST /api (everything else is served from /public by Cloudflare)
import { handle, setScryptCost } from '../netlify/functions/lib/core.mjs';
import { d1Db } from '../netlify/functions/lib/db-d1.mjs';
import seed from '../netlify/functions/lib/seed.mjs';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export default {
  async fetch(req, env) {
    setScryptCost(env.SCRYPT_N);
    const raw = req.method === 'POST' ? await req.text() : '';
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) {}
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const ctx = { db: d1Db(env.DB), env, secret: env.SESSION_SECRET, fetch, seed };
    const r = await handle(ctx, { method: req.method, body, ip, rawLength: raw.length });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: HEADERS });
  },
};
