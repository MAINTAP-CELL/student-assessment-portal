// Netlify Function: POST /api
import { handle } from './lib/core.mjs';
import { blobsDb } from './lib/db-blobs.mjs';
import seed from './lib/seed.mjs';

let db;

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export default async (req, context) => {
  const raw = req.method === 'POST' ? await req.text() : '';
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) {}
  db ||= blobsDb();
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const ctx = { db, env: process.env, secret: process.env.SESSION_SECRET, fetch, seed };
  const r = await handle(ctx, { method: req.method, body, ip, rawLength: raw.length });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: HEADERS });
};

export const config = { path: '/api' };
