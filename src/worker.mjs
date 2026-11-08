// Cloudflare Worker: POST /api (everything else is served from /public by Cloudflare)
import { handle, setScryptCost, autoBackup } from '../netlify/functions/lib/core.mjs';
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
    try {
      const r = await handle(ctx, { method: req.method, body, ip, rawLength: raw.length });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: HEADERS });
    } catch (e) {
      // never leave the browser with a bare error page: say what happened so it can be reported
      console.error('api error', e && e.message);
      return new Response(JSON.stringify({ error: 'The server could not finish this request (' + String((e && e.message) || e).slice(0, 120) + '). Please try again; if it keeps happening, tell the administrator.' }), { status: 500, headers: HEADERS });
    }
  },
  // Nightly backup (see [triggers] in wrangler.toml)
  async scheduled(event, env, ctx) {
    setScryptCost(env.SCRYPT_N);
    ctx.waitUntil(autoBackup({ db: d1Db(env.DB), env, secret: env.SESSION_SECRET, fetch, seed }));
  },
};
