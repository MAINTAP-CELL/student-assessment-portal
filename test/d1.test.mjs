// Tests the D1 store (chunking + conditional writes) using an SQLite stand-in for D1.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { d1Db } from '../netlify/functions/lib/db-d1.mjs';
const sq = new DatabaseSync(':memory:');
sq.exec(fs.readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => sq.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: sq.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...args).changes) } }),
});
const D1 = { prepare: (s) => stmt(s), batch: async (l) => { for (const s of l) await s.run(); } };
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); };
const db = d1Db(D1);
ok('missing key reads null', (await db.read('a')).value === null);
ok('create', await db.write('a', { x: 1 }, null));
ok('create twice refused', !(await db.write('a', { x: 2 }, null)));
const r = await db.read('a'); ok('read back', r.value.x === 1);
ok('update with right tag', await db.write('a', { x: 3 }, r.etag));
ok('update with stale tag refused', !(await db.write('a', { x: 4 }, r.etag)));
ok('value kept', (await db.read('a')).value.x === 3);
const big = { photo: 'p'.repeat(3_200_000), n: 7 };
ok('3 MB value saved', await db.write('big', big, null));
const b = await db.read('big'); ok('3 MB value intact', b.value.photo.length === 3_200_000 && b.value.n === 7);
ok('shrinking leaves no old pieces', await db.write('big', { small: 1 }, b.etag) && sq.prepare("SELECT count(*) c FROM kv_part WHERE k='big'").get().c === 1);
await db.write('students/a%20b', [1], null); await db.write('students/c', [2], null);
ok('list by prefix', (await db.list('students/')).length === 2);
ok('list treats % and _ literally', (await db.list('students/a%')).length === 1 && (await db.list('students/_')).length === 0);
const t = (await db.read('a')).etag;
const res = await Promise.all([db.write('a', { w: 1 }, t), db.write('a', { w: 2 }, t), db.write('a', { w: 3 }, t)]);
ok('only one of three racing saves wins', res.filter(Boolean).length === 1);
ok('no orphan pieces after race', sq.prepare("SELECT count(*) c FROM kv_part WHERE k='a'").get().c === 1);
console.log('[]', 'total', pass + fail, 'pass', pass);
process.exit(fail ? 1 : 0);
