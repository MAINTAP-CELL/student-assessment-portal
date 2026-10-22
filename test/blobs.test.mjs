// Checks the Netlify Blobs adapter against the library's own local blob server.
import { BlobsServer } from '@netlify/blobs/server';
import { blobsDb } from '../netlify/functions/lib/db-blobs.mjs';
import { handle } from '../netlify/functions/lib/core.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-'));
const server = new BlobsServer({ directory: dir, token: 'tok' });
const { port } = await server.start();
const db = blobsDb({ edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, token: 'tok', siteID: 'site' });
const res = []; const ck = (n, c, d) => res.push([c ? 'PASS' : 'FAIL', n, c ? '' : (d || '')]);
ck('missing key reads null', (await db.read('a')).value === null);
ck('create-only write works', await db.write('a', { n: 1 }, null));
ck('second create-only refused', !(await db.write('a', { n: 2 }, null)));
const r = await db.read('a'); ck('read back', r.value.n === 1 && !!r.etag);
ck('write with right etag', await db.write('a', { n: 3 }, r.etag));
ck('stale etag refused', !(await db.write('a', { n: 4 }, r.etag)));
await db.write('zz/ARTS1', [1], null); await db.write('zz/SCI', [2], null);
ck('list by prefix', (await db.list('zz/')).sort().join() === 'zz/ARTS1,zz/SCI', (await db.list('zz/')).join());
const seed = JSON.parse(fs.readFileSync(new URL('../data/seed-demo.json', import.meta.url)));
const ctx = { db, env: { ADMIN_PASSWORD: 'Blobs-Admin-Pass-1', DEMO_PASSWORD: 'teacherpass1' }, secret: 'z'.repeat(40), seed, fetch };
const call0 = (b) => handle(ctx, { method: 'POST', body: b, ip: '2.2.2.2', rawLength: 100 });
const call = async (b) => { const r = await call0(b); if (r.status === 200 && r.body.data && r.body.data.shards && r.body.data.shards.length) { const st = []; for (const k of r.body.data.shards) st.push(...(await call0({ action: 'students', token: r.body.token, shards: [k] })).body.students); r.body.data.students = st; } return r; };
const db2 = blobsDb({ edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, token: 'tok', siteID: 'site' });
// fresh keys for the app flow
const adm = await call({ action: 'login', username: '0051606', password: 'Blobs-Admin-Pass-1' });
ck('login on Blobs', adm.status === 200 && adm.body.data.students.length === 11, JSON.stringify(adm).slice(0, 300));
if (adm.status === 200) {
  const t = (await call({ action: 'login', username: 'obed.akoto@epshs.edu.gh', password: 'teacherpass1' })).body;
  const sid = t.data.students.find(s => s.class === 'ARTS 1').id;
  // NOTE: Netlify's local emulator is not atomic under simultaneous writes (the real service is), so run these one after another here.
  const outs = [];
  outs.push(await call({ action: 'save', token: t.token, students: { upsert: [{ id: sid, sub: { scores: { Mathematics: { 'Year 1': { s1: 61 } } } } }] } }));
  outs.push(await call({ action: 'save', token: adm.body.token, students: { upsert: [{ id: sid, set: { house: 'H7' } }] } }));
  outs.push(await call({ action: 'save', token: adm.body.token, students: { upsert: [{ id: sid, set: { address: 'ADDR' } }] } }));
  console.log('save results', JSON.stringify(outs.map(o => [o.status, o.body.error || o.body.rejected])));
  const st = (await call({ action: 'state', token: adm.body.token })).body.data.students.find(s => s.id === sid);
  ck('saves on Blobs all kept', st.scores.Mathematics['Year 1'].s1 === 61 && st.house === 'H7' && st.address === 'ADDR', JSON.stringify([st.scores.Mathematics, st.house, st.address]));
}
console.log(JSON.stringify(res.filter(x => x[0] === 'FAIL'), null, 1), 'total', res.length, 'pass', res.filter(x => x[0] === 'PASS').length);
await server.stop(); process.exit(0);
