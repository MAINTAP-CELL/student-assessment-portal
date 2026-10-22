import { handle } from '../netlify/functions/lib/core.mjs';
import { memoryDb } from '../netlify/functions/lib/db-memory.mjs';
const photo = 'data:image/jpeg;base64,' + 'A'.repeat(14000);           // ~14 KB photo
const subjects = ['English Language','Mathematics','Integrated Science','Social Studies','Government','History','Geography','Literature in English','Economics','Physics'];
const students = []; const classes = [];
for (let c = 0; c < 30; c++) {
  const name = `CLASS ${c}`; classes.push({ id: 'c' + c, year: 'Year ' + (1 + c % 3), learningArea: 'SCIENCE', name, subjects });
  for (let i = 0; i < 50; i++) {
    const scores = {}, components = {}, scoreMeta = {};
    for (const sj of subjects) { scores[sj] = {}; components[sj] = {}; scoreMeta[sj] = {}; for (const y of ['Year 1','Year 2','Year 3']) { scores[sj][y] = { s1: 70, s2: 65 }; components[sj][y] = { s1: { ica: 12, midterm: 11, project: 15, practical: 8, exams: 30 }, s2: { ica: 12, midterm: 11, project: 15, practical: 8, exams: 30 } }; scoreMeta[sj][y] = { s1: { by: 'x', at: '2026-01-01' }, s2: { by: 'x', at: '2026-01-01' } }; } }
    students.push({ id: `S${c}_${i}`, assRefId: `S${c}_${i}`, surname: 'SUR' + i, firstName: 'FIRST', class: name, learningArea: 'SCIENCE', status: 'active', dob: '2010-01-01', scores, components, scoreMeta, photo, parentAccess: { enabled: true } });
  }
}
const db = memoryDb(); const env = { ADMIN_PASSWORD: 'Scale-Admin-Pass-1' };
const ctx = { db, env, secret: 'q'.repeat(40), seed: { school: { name: 'S' }, classes, students }, fetch };
const call = (b) => handle(ctx, { method: 'POST', body: b, ip: '3.3.3.3', rawLength: 100 });
const t0 = Date.now();
const lr = await call({ action: 'login', username: '0051606', password: 'Scale-Admin-Pass-1' });
const size = (o) => Buffer.byteLength(JSON.stringify(o));
let max = 0, total = 0;
for (const k of lr.body.data.shards) { const r = await call({ action: 'students', token: lr.body.token, shards: [k] }); const n = size(r.body); max = Math.max(max, n); total += r.body.students.length; }
const need = total; let pmax = 0;
const ids = []; for (let i = 0; i < 1500; i++) ids.push(`S${Math.floor(i / 50)}_${i % 50}`);
for (let i = 0; i < ids.length; i += 40) { const r = await call({ action: 'photos', token: lr.body.token, ids: ids.slice(i, i + 40) }); pmax = Math.max(pmax, size(r.body)); }
console.log(JSON.stringify({ studentsLoaded: total, loginReplyKB: Math.round(size(lr.body) / 1024), biggestClassReplyKB: Math.round(max / 1024), biggestPhotoBatchKB: Math.round(pmax / 1024), limitKB: 6144, secondsToLoadAll: (Date.now() - t0) / 1000 }));
