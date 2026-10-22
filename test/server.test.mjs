import { handle, hashPassword } from '../netlify/functions/lib/core.mjs';
import { memoryDb } from '../netlify/functions/lib/db-memory.mjs';
import fs from 'node:fs';
const seed = JSON.parse(fs.readFileSync(new URL('../data/seed-demo.json', import.meta.url)));
const results = []; const ck = (n, c, d) => results.push([c ? 'PASS' : 'FAIL', n, c ? '' : (d || '')]);
const mk = (env = {}, fetchImpl) => ({ db: memoryDb(), env: { ADMIN_PASSWORD: 'Adm1n-Pass-xyz', DEMO_PASSWORD: 'teacherpass1', ...env }, secret: 'x'.repeat(40), fetch: fetchImpl, seed });
const call0 = (ctx, body, ip = '1.1.1.1') => handle(ctx, { method: 'POST', body, ip, rawLength: JSON.stringify(body).length });
// like the browser: fetch settings, then each class's students
const call = async (ctx, body, ip) => {
  const r = await call0(ctx, body, ip);
  if (r.status === 200 && r.body.data && Array.isArray(r.body.data.shards) && r.body.data.shards.length) {
    const token = r.body.token; const students = [];
    for (const k of r.body.data.shards) { const x = await call0(ctx, { action: 'students', token, shards: [k] }, ip); students.push(...x.body.students); }
    r.body.data.students = students;
    const ph = await call0(ctx, { action: 'photos', token, ids: students.filter(s => s.hasPhoto).map(s => s.id) }, ip);
    students.forEach(s => { if (ph.body.photos && ph.body.photos[s.id]) s.photo = ph.body.photos[s.id]; });
  }
  return r;
};
const ctx = mk();

let r = await call(ctx, { action: 'login', username: '0051606', password: 'wrong' });
ck('admin wrong password rejected', r.status === 401, JSON.stringify(r));
r = await call(ctx, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' });
ck('admin correct password', r.status === 200 && r.body.user.role === 'admin');
const adm = r.body;
ck('admin gets all students', adm.data.students.length === 11, adm.data.students.length);
ck('no password hashes leak', !JSON.stringify(adm).includes('scrypt$'));
ck('invalid token rejected', (await call(ctx, { action: 'state', token: adm.token + 'x' })).status === 401);
ck('no token rejected', (await call(ctx, { action: 'state' })).status === 401);

// teacher
r = await call(ctx, { action: 'login', username: 'obed.akoto@epshs.edu.gh', password: 'any' });
ck('teacher wrong password rejected', r.status === 401);
r = await call(ctx, { action: 'login', username: 'obed.akoto@epshs.edu.gh', password: 'teacherpass1' });
ck('teacher correct password', r.status === 200 && r.body.user.role === 'teacher');
const tch = r.body;
ck('teacher sees only assigned classes', tch.data.students.every(s => ['ARTS 1', 'SCIENCE 1'].includes(s.class)) && tch.data.students.length > 0 && !tch.data.students.some(s => s.class === 'BUSINESS 1'), tch.data.students.map(s => s.class).join());
ck('teacher gets no login trace / no others contact', tch.data.loginTrace.length === 0 && tch.data.users.filter(u => u.id !== 'u2').every(u => !u.email));
const arts = tch.data.students.find(s => s.class === 'ARTS 1');
// teacher saves allowed score
r = await call(ctx, { action: 'save', token: tch.token, students: { upsert: [{ id: arts.id, sub: { scores: { Mathematics: { 'Year 1': { s1: 91 } } } } }] } });
ck('teacher can save own subject score', r.status === 200 && r.body.rejected.length === 0, JSON.stringify(r.body));
let st = await call(ctx, { action: 'state', token: adm.token });
ck('score persisted', st.body.data.students.find(s => s.id === arts.id).scores.Mathematics['Year 1'].s1 === 91);
// teacher tries other subject
r = await call(ctx, { action: 'save', token: tch.token, students: { upsert: [{ id: arts.id, sub: { scores: { 'English Language': { 'Year 1': { s1: 5 } } } } }] } });
st = await call(ctx, { action: 'state', token: adm.token });
ck('teacher blocked from other subject', r.body.rejected.length > 0 && (((st.body.data.students.find(s => s.id === arts.id).scores['English Language'] || {})['Year 1'] || {}).s1) !== 5);
// teacher tries editing bio, school, users, delete
r = await call(ctx, { action: 'save', token: tch.token, students: { upsert: [{ id: arts.id, set: { surname: 'HACKED' } }] }, config: { school: { name: 'HACKED' } }, users: [{ id: 'u2', designation: 'Admin' }] });
st = await call(ctx, { action: 'state', token: adm.token });
ck('teacher cannot change bio/school/role', st.body.data.students.find(s => s.id === arts.id).surname !== 'HACKED' && st.body.data.school.name !== 'HACKED' && st.body.data.users.find(u => u.id === 'u2').designation !== 'Admin', JSON.stringify(r.body));
r = await call(ctx, { action: 'save', token: tch.token, students: { delete: [arts.id] } });
st = await call(ctx, { action: 'state', token: adm.token });
ck('teacher cannot delete students', st.body.data.students.some(s => s.id === arts.id));
ck('teacher cannot create users', (await call(ctx, { action: 'createUser', token: tch.token, name: 'X', email: 'x@y.z', password: 'longenough1' })).status === 403);
ck('teacher cannot set passwords', (await call(ctx, { action: 'setPassword', token: tch.token, userId: 'u1', password: 'longenough1' })).status === 403);
ck('teacher cannot read trace', (await call(ctx, { action: 'trace', token: tch.token })).status === 403);
ck('teacher cannot send sms', (await call(ctx, { action: 'sendSms', token: tch.token, messages: [] })).status === 403);

// parent
const kid = adm.data.students.find(s => s.id === '2400710060D5');
r = await call(ctx, { action: 'login', username: kid.assRefId, password: '01/01/1999' });
ck('parent wrong DOB rejected', r.status === 401);
r = await call(ctx, { action: 'login', username: kid.assRefId, password: '06/02/2013' });
ck('parent correct DOB', r.status === 200 && r.body.user.role === 'parent');
const par = r.body;
ck('parent sees only own child', par.data.students.length === 1 && par.data.students[0].id === kid.id && par.data.users.length === 0);
ck('parent sees only own class', par.data.classes.length === 1 && par.data.classes[0].name === kid.class);
ck('parent cannot save', (await call(ctx, { action: 'save', token: par.token, students: { upsert: [{ id: kid.id, set: { surname: 'X' } }] } })).status === 403);
ck('parent cannot read trace', (await call(ctx, { action: 'trace', token: par.token })).status === 403);
// parent access disabled
await call(ctx, { action: 'save', token: adm.token, students: { upsert: [{ id: kid.id, set: { parentAccess: { enabled: false } } }] } });
ck('disabled parent access blocks login', (await call(ctx, { action: 'login', username: kid.assRefId, password: '06/02/2013' })).status === 401);
ck('disabled parent access kills old token', (await call(ctx, { action: 'state', token: par.token })).status === 401);

// lockout
const lk = mk();
for (let i = 0; i < 5; i++) await call(lk, { action: 'login', username: 'victim@x.com', password: 'bad' }, '9.9.9.' + i);
r = await call(lk, { action: 'login', username: 'victim@x.com', password: 'bad' }, '9.9.9.99');
ck('lockout after 5 failures', r.status === 429, JSON.stringify(r));
r = await call(lk, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' }, '9.9.9.77');
ck('other accounts unaffected by lockout', r.status === 200);
// locked even with correct password
const lk2 = mk();
for (let i = 0; i < 5; i++) await call(lk2, { action: 'login', username: '0051606', password: 'bad' }, '8.8.8.' + i);
r = await call(lk2, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' }, '8.8.8.50');
ck('locked account refuses even the right password', r.status === 429);

// admin user management
r = await call(ctx, { action: 'createUser', token: adm.token, name: 'New Teacher', email: 'new@t.com', phone: '0240000000', designation: 'Subject Teacher', password: 'short' });
ck('short password refused', r.status === 400);
r = await call(ctx, { action: 'createUser', token: adm.token, name: 'New Teacher', email: 'new@t.com', phone: '0240000000', designation: 'Subject Teacher', password: 'Longer-Pass-1' });
ck('admin creates user', r.status === 200 && !('passwordHash' in r.body.user));
ck('new user can sign in', (await call(ctx, { action: 'login', username: 'new@t.com', password: 'Longer-Pass-1' })).status === 200);
ck('duplicate email refused', (await call(ctx, { action: 'createUser', token: adm.token, name: 'Dup', email: 'NEW@t.com', password: 'Longer-Pass-1' })).status === 409);
const nu = r.body.user;
const oldTok = (await call(ctx, { action: 'login', username: 'new@t.com', password: 'Longer-Pass-1' })).body.token;
await call(ctx, { action: 'setPassword', token: adm.token, userId: nu.id, password: 'Another-Pass-2' });
ck('old password stops working', (await call(ctx, { action: 'login', username: 'new@t.com', password: 'Longer-Pass-1' })).status === 401);
ck('new password works', (await call(ctx, { action: 'login', username: 'new@t.com', password: 'Another-Pass-2' })).status === 200);
ck('old session invalidated by password reset', (await call(ctx, { action: 'state', token: oldTok })).status === 401);
await call(ctx, { action: 'save', token: adm.token, users: [{ id: nu.id, status: 'inactive' }] });
ck('deactivated user cannot sign in', (await call(ctx, { action: 'login', username: 'new@t.com', password: 'Another-Pass-2' })).status === 401);
// admin cannot deactivate self
await call(ctx, { action: 'save', token: adm.token, users: [{ id: 'admin', status: 'inactive', designation: 'Subject Teacher' }] });
ck('admin cannot lock themselves out', (await call(ctx, { action: 'state', token: adm.token })).status === 200);

// XSS cleaning + student create/move/delete
r = await call(ctx, { action: 'save', token: adm.token, students: { upsert: [{ id: 'NEW1', full: { id: 'NEW1', assRefId: 'NEW1', surname: '<img src=x onerror=alert(1)>EVIL', firstName: 'A', class: 'ARTS 1', scores: {}, photo: 'javascript:alert(1)', parentAccess: { enabled: true } } }] } });
st = await call(ctx, { action: 'state', token: adm.token });
const ns = st.body.data.students.find(s => s.id === 'NEW1');
ck('new student stored, tags stripped', ns && !/[<>]/.test(ns.surname), JSON.stringify(ns));
r = await call(ctx, { action: 'save', token: adm.token, students: { upsert: [{ id: 'NEW1', set: { class: 'SCIENCE 1' } }] } });
st = await call(ctx, { action: 'state', token: adm.token });
ck('student moved class', st.body.data.students.filter(s => s.id === 'NEW1').length === 1 && st.body.data.students.find(s => s.id === 'NEW1').class === 'SCIENCE 1');
r = await call(ctx, { action: 'save', token: adm.token, students: { delete: ['NEW1'] } });
st = await call(ctx, { action: 'state', token: adm.token });
ck('admin deletes student', !st.body.data.students.some(s => s.id === 'NEW1'));
// concurrent writes do not lose updates
const t2 = (await call(ctx, { action: 'login', username: 'charel@gf.com', password: 'teacherpass1' })).body;
await call(ctx, { action: 'save', token: adm.token, users: [{ id: 'u3', assigned: [{ subject: 'Geography', classes: ['ARTS 1'] }, { subject: 'History', classes: ['ARTS 1'] }] }] });
await Promise.all([
  call(ctx, { action: 'save', token: tch.token, students: { upsert: [{ id: arts.id, sub: { scores: { Mathematics: { 'Year 1': { s1: 70 } } } } }] } }),
  call(ctx, { action: 'save', token: t2.token, students: { upsert: [{ id: arts.id, sub: { scores: { Geography: { 'Year 1': { s1: 71 } } } } }] } }),
  call(ctx, { action: 'save', token: adm.token, students: { upsert: [{ id: arts.id, set: { house: 'HOUSE9' } }] } }),
]);
st = await call(ctx, { action: 'state', token: adm.token });
const cs = st.body.data.students.find(s => s.id === arts.id);
ck('concurrent saves all kept', cs.scores.Mathematics['Year 1'].s1 === 70 && cs.scores.Geography['Year 1'].s1 === 71 && cs.house === 'HOUSE9', JSON.stringify([cs.scores.Mathematics, cs.scores.Geography, cs.house]));
// trace
r = await call(ctx, { action: 'trace', token: adm.token });
ck('trace records failures and successes', r.body.loginTrace.some(t => /Failed/.test(t.status || '')) && r.body.loginTrace.some(t => t.status === 'Success'));
ck('logout recorded', (await call(ctx, { action: 'logout', token: adm.token })).status === 200 && (await call(ctx, { action: 'trace', token: adm.token })).body.loginTrace.some(t => t.status === 'Logged out'));
// sms
ck('sms without keys explains', (await call(ctx, { action: 'sendSms', token: adm.token, messages: [{ to: '233241234567', text: 'hi' }] })).status === 503);
const calls = [];
const sctx = mk({ ARKESEL_API_KEY: 'k', ARKESEL_SENDER: 'ASUOMSHS' }, async (url, opt) => { calls.push([url, JSON.parse(opt.body), opt.headers['api-key']]); return { ok: true, status: 200, json: async () => ({ status: 'success' }) }; });
const sadm = (await call(sctx, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' })).body;
r = await call(sctx, { action: 'sendSms', token: sadm.token, messages: [{ to: '233241234567', text: 'Hello A' }, { to: '233249999999', text: 'Hello B' }, { to: '0241', text: 'bad' }] });
ck('sms sends via provider', r.body.sent === 2 && r.body.failed.length === 1 && calls.length === 2 && calls[0][0].includes('arkesel') && calls[0][2] === 'k' && calls[0][1].sender === 'ASUOMSHS', JSON.stringify(r.body));
// config safety
ck('photos stripped from class lists, fetched separately', await (async () => { await call0(ctx, { action: 'save', token: adm.token, students: { upsert: [{ id: arts.id, set: { photo: 'data:image/png;base64,iVBORw0KGgo=' } }] } }); const a = await call0(ctx, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' }); const x = await call0(ctx, { action: 'students', token: a.body.token, shards: a.body.data.shards }); const row = x.body.students.find(s => s.id === arts.id); const p = await call0(ctx, { action: 'photos', token: a.body.token, ids: [arts.id] }); return row.photo === null && row.hasPhoto === true && p.body.photos[arts.id].startsWith('data:image/png'); })());
ck('teacher cannot request other classes\' students', await (async () => { const x = await call0(ctx, { action: 'students', token: tch.token, shards: ['students/BUSINESS%201'] }); return x.body.students.length === 0; })());
ck('missing secret refused', (await handle({ ...mk(), secret: '' }, { method: 'POST', body: { action: 'login' }, ip: '1', rawLength: 5 })).status === 500);
ck('GET refused', (await handle(mk(), { method: 'GET', body: null, ip: '1', rawLength: 0 })).status === 405);
ck('huge body refused', (await handle(mk(), { method: 'POST', body: { action: 'x' }, ip: '1', rawLength: 9e6 })).status === 413);
// admin password follows the ADMIN_PASSWORD setting
const shared = memoryDb();
const e1 = { ...mk(), db: shared }; await call(e1, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' });
const e2 = { ...e1, env: { ...e1.env, ADMIN_PASSWORD: 'Brand-New-Pass-9' } };
// simulate a restart: a fresh init pass over the same data
const { ensureInit } = await import('../netlify/functions/lib/core.mjs');
const fresh = { ...e2, db: Object.create(shared) };
await ensureInit(fresh);
ck('changing ADMIN_PASSWORD resets admin password', (await call(e2, { action: 'login', username: '0051606', password: 'Brand-New-Pass-9' })).status === 200 && (await call(e2, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' }, '5.5.5.5')).status === 401);
// ---- first sign-in: the administrator must choose their own password ----
{
  const fc = mk({ DEMO_PASSWORD: '' });            // production-like: no shared demo password
  let r = await call0(fc, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' });
  ck('first admin sign-in asks for a new password', r.status === 200 && r.body.user.mustChange === true && r.body.data === null, JSON.stringify(r.body).slice(0, 200));
  const tk = r.body.token;
  ck('no data before the password is changed', (await call0(fc, { action: 'state', token: tk })).body.data === null);
  for (const a of [{ action: 'students', shards: ['students/ARTS%201'] }, { action: 'trace' }, { action: 'save', students: { delete: ['x'] } }, { action: 'createUser', name: 'N', email: 'n@n.com', password: 'Longer-Pass-1' }, { action: 'sendSms', messages: [] }])
    ck('blocked until changed: ' + a.action, (await call0(fc, { ...a, token: tk })).body.code === 'must_change');
  ck('wrong current password refused', (await call0(fc, { action: 'changeOwnPassword', token: tk, oldPassword: 'nope', newPassword: 'Fresh-Pass-123' })).status === 400);
  ck('short / letters-only / numbers-only passwords refused', (await Promise.all(['Ab1', 'onlyletters', '1234567890'].map(p => call0(fc, { action: 'changeOwnPassword', token: tk, oldPassword: 'Adm1n-Pass-xyz', newPassword: p })))).every(x => x.status === 400));
  ck('same password refused', (await call0(fc, { action: 'changeOwnPassword', token: tk, oldPassword: 'Adm1n-Pass-xyz', newPassword: 'Adm1n-Pass-xyz' })).status === 400);
  r = await call0(fc, { action: 'changeOwnPassword', token: tk, oldPassword: 'Adm1n-Pass-xyz', newPassword: 'Fresh-Pass-123' });
  ck('admin sets own password', r.status === 200 && !!r.body.token);
  ck('old session ended by the change', (await call0(fc, { action: 'state', token: tk })).status === 401);
  ck('old (starting) password no longer works', (await call0(fc, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' }, '4.4.4.4')).status === 401);
  r = await call0(fc, { action: 'login', username: '0051606', password: 'Fresh-Pass-123' });
  ck('new password signs in with data and no second prompt', r.status === 200 && !r.body.user.mustChange && r.body.data && Array.isArray(r.body.data.shards));
  const admTok = r.body.token;
  // a restart with the same ADMIN_PASSWORD setting must not undo the admin's own password
  const { ensureInit } = await import('../netlify/functions/lib/core.mjs');
  await ensureInit({ ...fc, db: Object.create(fc.db) });
  ck('restart keeps the admin\'s chosen password', (await call0(fc, { action: 'login', username: '0051606', password: 'Fresh-Pass-123' }, '4.4.4.5')).status === 200 && (await call0(fc, { action: 'login', username: '0051606', password: 'Adm1n-Pass-xyz' }, '4.4.4.6')).status === 401);
  // changing the ADMIN_PASSWORD setting is the recovery route, and forces a new choice again
  const rec = { ...fc, env: { ...fc.env, ADMIN_PASSWORD: 'Recovery-Pass-9' } };
  await ensureInit({ ...rec, db: Object.create(fc.db) });
  r = await call0(rec, { action: 'login', username: '0051606', password: 'Recovery-Pass-9' }, '4.4.4.7');
  ck('recovery via ADMIN_PASSWORD works and forces a new password', r.status === 200 && r.body.user.mustChange === true);
  // new staff must change the password the admin gave them
  const adm2 = (await call0(fc, { action: 'login', username: '0051606', password: 'Recovery-Pass-9' }, '4.4.4.8')).body;
  await call0(fc, { action: 'changeOwnPassword', token: adm2.token, oldPassword: 'Recovery-Pass-9', newPassword: 'Admin-Again-456' });
  const adm3 = (await call0(fc, { action: 'login', username: '0051606', password: 'Admin-Again-456' }, '4.4.4.9')).body;
  r = await call0(fc, { action: 'createUser', token: adm3.token, name: 'Kofi T', email: 'kofi@t.com', phone: '0240000001', designation: 'Subject Teacher', password: 'Temp-Pass-123' });
  ck('weak initial password for staff refused', (await call0(fc, { action: 'createUser', token: adm3.token, name: 'X', email: 'x@t.com', password: 'abcdefgh' })).status === 400);
  const first = await call0(fc, { action: 'login', username: 'kofi@t.com', password: 'Temp-Pass-123' }, '4.4.4.10');
  ck('new teacher must change the temporary password', first.body.user.mustChange === true && first.body.data === null);
  await call0(fc, { action: 'changeOwnPassword', token: first.body.token, oldPassword: 'Temp-Pass-123', newPassword: 'Kofi-Own-789' });
  ck('teacher then signs in normally', (await call0(fc, { action: 'login', username: 'kofi@t.com', password: 'Kofi-Own-789' }, '4.4.4.11')).body.user.mustChange === false);
  await call0(fc, { action: 'setPassword', token: adm3.token, userId: r.body.user.id, password: 'Reset-By-Admin-1' });
  ck('admin reset forces the teacher to choose again', (await call0(fc, { action: 'login', username: 'kofi@t.com', password: 'Reset-By-Admin-1' }, '4.4.4.12')).body.user.mustChange === true);
  const me = adm3.user.userId;
  await call0(fc, { action: 'setPassword', token: adm3.token, userId: me, password: 'Admin-Self-Reset-1' });
  ck('admin resetting their own password is not forced again', (await call0(fc, { action: 'login', username: '0051606', password: 'Admin-Self-Reset-1' }, '4.4.4.13')).body.user.mustChange === false);
}
console.log(JSON.stringify(results.filter(r => r[0] === 'FAIL'), null, 1), 'total', results.length, 'pass', results.filter(r => r[0] === 'PASS').length);
