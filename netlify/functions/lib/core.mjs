// Student Assessment Portal — server core.
// All authentication, authorisation and data storage happens here. The browser never receives
// anything the signed-in person is not allowed to see, and every save is checked again on the server.
import crypto from 'node:crypto';

const MAX_FAILS = 5;                 // wrong passwords per username before lock
const IP_MAX_FAILS = 30;             // wrong passwords per network address before lock
const LOCK_MS = 15 * 60 * 1000;      // lock length
const TOKEN_TTL_S = 30 * 60;         // sign-in token life (renewed on every request)
const MIN_PASSWORD = 8;
const SCORE_CONTAINERS = ['scores', 'components', 'scoreMeta'];
const IMG_RE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const ALL_PRIVILEGES = ['Register Student', 'Capture Assessment Per Subject', 'Manage Students', 'Admin Panel', 'Transcript'];

/* ---------------------------------------------------------------- helpers */
export function clean(v, depth = 0) {
  if (depth > 14) return null;
  if (typeof v === 'string') {
    if (v.startsWith('data:')) return IMG_RE.test(v) ? v : '';
    return v.replace(/[<>]/g, '');
  }
  if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      o[k.replace(/[<>]/g, '')] = clean(x, depth + 1);
    }
    return o;
  }
  return v;
}
function passwordProblem(pw) {
  const p = String(pw || '');
  if (p.length < MIN_PASSWORD || !/[A-Za-z]/.test(p) || !/\d/.test(p)) return `Use at least ${MIN_PASSWORD} characters with both letters and numbers.`;
  return '';
}
const err = (status, message, extra) => ({ status, body: { error: message, ...(extra || {}) } });
const ok = (body) => ({ status: 200, body });
const lc = (s) => String(s || '').trim().toLowerCase();

// Password hashing cost. Default is strong (16384). The Cloudflare FREE plan allows only ~10 ms of
// processor time per request, so the Worker may lower it with SCRYPT_N (never below 1024).
let SCRYPT_N = 16384;
export function setScryptCost(n) { n = Number(n); if (n >= 1024 && (n & (n - 1)) === 0) SCRYPT_N = n; }
function scrypt(password, salt, N) {
  return new Promise((res, rej) => crypto.scrypt(password, salt, 64, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
}
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts[0] !== 'scrypt') return false;
    const [N, saltHex, keyHex] = parts.length === 4 ? [Number(parts[1]), parts[2], parts[3]] : [16384, parts[1], parts[2]]; // 3 parts = older hashes
    if (!(N >= 1024 && N <= 65536)) return false;
    const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), N);
    const want = Buffer.from(keyHex, 'hex');
    return want.length === key.length && crypto.timingSafeEqual(key, want);
  } catch (e) { return false; }
}
const dummyHash = () => `scrypt$${SCRYPT_N}$00000000000000000000000000000000$` + '00'.repeat(64);

const b64u = (b) => Buffer.from(b).toString('base64url');
export function signToken(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyToken(token, secret) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- storage helpers */
// db interface: read(key) -> {value, etag}; write(key, value, etag|null) -> boolean; list(prefix) -> [keys]
async function getJ(db, key, def) { const r = await db.read(key); return r.value ?? def; }
async function update(db, key, def, fn) {
  for (let i = 0; i < 12; i++) {
    const r = await db.read(key);
    const cur = r.value ?? JSON.parse(JSON.stringify(def));
    const next = await fn(cur);
    if (next === undefined) return cur;
    if (await db.write(key, next, r.etag ?? null)) return next;
    await new Promise(res => setTimeout(res, 15 + Math.random() * 40));
  }
  throw new Error('The server is busy. Please try again.');
}
const shardKey = (cls) => 'students/' + encodeURIComponent(String(cls || '_none')).slice(0, 120);

async function loadAllShards(db) {
  const keys = await db.list('students/');
  const out = await Promise.all(keys.map(async k => ({ key: k, list: await getJ(db, k, []) })));
  return out;
}
async function allStudents(db) { return (await loadAllShards(db)).flatMap(s => s.list); }

/* ---------------------------------------------------------------- bootstrap */
const inited = new WeakMap();
export function ensureInit(ctx) {
  if (!inited.has(ctx.db)) inited.set(ctx.db, init(ctx).catch(e => { inited.delete(ctx.db); throw e; }));
  return inited.get(ctx.db);
}
async function init(ctx) {
  const { db, env } = ctx;
  const adminUser = env.ADMIN_USERNAME || '0051606';
  const adminPass = env.ADMIN_PASSWORD || '';
  let users = await getJ(db, 'users', null);
  if (!users) {
    // first run
    const seed = ctx.seed || {};
    users = (seed.users || []).map(u => ({ ...clean(u) }));
    if (env.DEMO_PASSWORD) { const h = await hashPassword(env.DEMO_PASSWORD); users.forEach(u => { u.passwordHash = h; }); }
    if (!users.some(u => u.username === adminUser)) {
      users.unshift({ id: 'admin', username: adminUser, name: env.ADMIN_NAME || 'School Administrator', email: '', phone: '', designation: 'Admin', status: 'active', privileges: ALL_PRIVILEGES.slice(), assigned: [], mustChange: !env.DEMO_PASSWORD });
    }
    if (!(await db.write('users', users, null))) users = await getJ(db, 'users', users);
    const config = { school: clean(seed.school || { name: 'YOUR SCHOOL NAME', region: '', district: '', localGov: '', address: '', city: '', gps: '', phone: '', email: '', code: '' }),
      classes: clean(seed.classes || []), assessmentOveralls: clean(seed.assessmentOveralls || {}), classTermSettings: clean(seed.classTermSettings || {}) };
    await db.write('config', config, null);
    const byShard = {};
    for (const s of (seed.students || [])) (byShard[shardKey(s.class)] ||= []).push(clean(s));
    for (const [k, list] of Object.entries(byShard)) await db.write(k, list, null);
    await db.write('trace', (seed.loginTrace || []).map(t => clean(t)), null);
  }
  // ADMIN_PASSWORD is the *starting* password. It is applied on the very first run, and again only if the
  // setting itself is changed (recovery). The administrator must then choose their own password at first sign-in.
  const admin = users.find(u => u.username === adminUser);
  if (admin && adminPass) {
    const want = crypto.createHmac('sha256', ctx.secret || 'x').update('admin-env:' + adminPass).digest('hex');
    if (admin.pwFp !== want) {
      const h = await hashPassword(adminPass);
      await update(db, 'users', [], list => { const a = list.find(u => u.username === adminUser); if (a) { a.passwordHash = h; a.pwFp = want; a.tokenVersion = (a.tokenVersion || 0) + 1; a.mustChange = !env.DEMO_PASSWORD; } return list; });
    }
  }
  if (admin && !admin.passwordHash && !adminPass) throw new Error('ADMIN_PASSWORD is not set on the server.');
}

/* ---------------------------------------------------------------- trace + lockout */
function stamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
async function trace(ctx, user, role, status, device, ip) {
  try {
    const cfg = await getJ(ctx.db, 'config', {});
    const host = [String(device || '').replace(/[<>]/g, '').slice(0, 60), ip || ''].filter(Boolean).join(' · ');
    const entry = { branch: (cfg.school && cfg.school.name) || '', when: stamp(), user: String(user || '(blank)').replace(/[<>]/g, '').slice(0, 80), role, host, status };
    await update(ctx.db, 'trace', [], list => { list.push(entry); return list.slice(-2000); });
  } catch (e) { /* tracing must never break sign-in */ }
}
async function registerFail(ctx, keys) {
  const now = Date.now();
  return update(ctx.db, 'lock', {}, map => {
    for (const [k, max] of keys) {
      const r = map[k] || { n: 0, until: 0, first: now };
      if (r.until && r.until <= now) { r.n = 0; r.until = 0; }
      if (now - (r.first || now) > LOCK_MS) { r.n = 0; r.first = now; }
      r.n++; if (!r.first) r.first = now;
      if (r.n >= max) { r.until = now + LOCK_MS; r.n = 0; }
      map[k] = r;
    }
    for (const k of Object.keys(map)) if (map[k].until && map[k].until < now - LOCK_MS) delete map[k];
    return map;
  });
}
async function clearFails(ctx, key) {
  await update(ctx.db, 'lock', {}, map => { if (!map[key]) return undefined; delete map[key]; return map; });
}

/* ---------------------------------------------------------------- data views */
const publicUser = (u) => { const { passwordHash, tokenVersion, pwFp, ...rest } = u; return rest; };
const assignedSet = (u) => new Set((u.assigned || []).flatMap(a => (a.classes || []).map(c => `${c}||${a.subject}`)));
const assignedClasses = (u) => new Set((u.assigned || []).flatMap(a => a.classes || []));
const isPrivileged = (u) => (u.privileges || []).some(p => p === 'Register Student' || p === 'Manage Students');
const canDelete = (u) => (u.privileges || []).includes('Manage Students');

// Replies are sent in pieces so a whole school never has to fit in one response:
// the sign-in/state reply carries settings plus a list of "shards" (one per class); the browser then
// asks for each class's students separately, and photos are fetched last in the background.
const lite = (st) => { const { photo, ...rest } = st; return { ...rest, photo: null, hasPhoto: !!photo }; };
async function visibleShardKeys(ctx, principal) {
  const all = await ctx.db.list('students/');
  if (principal.role === 'admin') return all;
  if (principal.role === 'teacher') {
    if (isPrivileged(principal.user)) return all;
    const mine = new Set([...assignedClasses(principal.user)].map(shardKey));
    return all.filter(k => mine.has(k));
  }
  return [];
}
async function buildData(ctx, principal) {
  const { db } = ctx;
  const cfg = await getJ(db, 'config', { school: {}, classes: [], assessmentOveralls: {}, classTermSettings: {} });
  if (principal.role === 'admin') {
    const users = (await getJ(db, 'users', [])).map(publicUser);
    return { school: cfg.school, classes: cfg.classes, assessmentOveralls: cfg.assessmentOveralls, classTermSettings: cfg.classTermSettings,
      users, loginTrace: (await getJ(db, 'trace', [])).slice(-500), students: [], shards: await visibleShardKeys(ctx, principal) };
  }
  if (principal.role === 'teacher') {
    const me = principal.user;
    const users = (await getJ(db, 'users', [])).map(u => u.id === me.id ? publicUser(u)
      : { id: u.id, name: u.name, designation: u.designation, status: u.status, assigned: u.assigned || [], privileges: [], email: '', phone: '' });
    return { school: cfg.school, classes: cfg.classes, assessmentOveralls: cfg.assessmentOveralls, classTermSettings: cfg.classTermSettings, users, loginTrace: [], students: [], shards: await visibleShardKeys(ctx, principal) };
  }
  // parent: one child, sent inline (with photo)
  const st = principal.student;
  return { school: cfg.school, classes: cfg.classes.filter(c => c.name === st.class),
    assessmentOveralls: Object.fromEntries(Object.entries(cfg.assessmentOveralls || {}).filter(([k]) => k.startsWith(st.class + '||'))),
    classTermSettings: Object.fromEntries(Object.entries(cfg.classTermSettings || {}).filter(([k]) => k === st.class)),
    users: [], loginTrace: [], students: [st], shards: [] };
}
async function studentsForShards(ctx, principal, keys) {
  const allowed = new Set(await visibleShardKeys(ctx, principal));
  const out = [];
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 4)) {
    if (!allowed.has(k)) continue;
    (await getJ(ctx.db, k, [])).forEach(st => out.push(st));
  }
  return out;
}

/* ---------------------------------------------------------------- authentication */
function issue(ctx, principal) {
  const sub = principal.role === 'parent' ? principal.student.id : principal.user.id;
  const tv = principal.role === 'parent' ? 0 : (principal.user.tokenVersion || 0);
  return signToken({ sub, role: principal.role === 'parent' ? 'parent' : 'staff', tv, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }, ctx.secret);
}
async function authenticate(ctx, token) {
  const p = verifyToken(token, ctx.secret);
  if (!p) return null;
  if (p.role === 'parent') {
    const st = (await allStudents(ctx.db)).find(s => s.id === p.sub);
    if (!st || !(st.parentAccess && st.parentAccess.enabled)) return null;
    return { role: 'parent', student: st };
  }
  const u = (await getJ(ctx.db, 'users', [])).find(x => x.id === p.sub && x.status === 'active');
  if (!u || (u.tokenVersion || 0) !== (p.tv || 0)) return null;
  return { role: u.designation === 'Admin' ? 'admin' : 'teacher', user: u };
}
const sessionUser = (principal) => principal.role === 'parent'
  ? { name: principal.student.guardianName && principal.student.guardianName !== '—' ? principal.student.guardianName : 'Parent/Guardian', role: 'parent', studentId: principal.student.id }
  : { name: principal.user.name, role: principal.role, email: principal.user.email || principal.user.username, userId: principal.user.id, mustChange: !!principal.user.mustChange };

function dobMatches(input, iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return false;
  const [, y, mo, da] = m; const d = String(input || '').trim();
  return [`${da}/${mo}/${y}`, `${da}-${mo}-${y}`, `${da}.${mo}.${y}`, `${da}${mo}${y}`, `${y}-${mo}-${da}`, `${parseInt(da)}/${parseInt(mo)}/${y}`].includes(d);
}

async function login(ctx, body, ip) {
  const username = String(body.username || '').trim().slice(0, 120);
  const password = String(body.password || '').slice(0, 200);
  const device = body.device;
  if (!username) return err(400, 'Enter your username.');
  if (!password) return err(400, 'Enter your password.');
  const ukey = 'u:' + username.toLowerCase(), ikey = 'ip:' + ip;
  const lock = await getJ(ctx.db, 'lock', {});
  const now = Date.now();
  for (const k of [ukey, ikey]) {
    if (lock[k] && lock[k].until > now) {
      const mins = Math.ceil((lock[k].until - now) / 60000);
      await trace(ctx, username, 'Staff', 'Blocked — locked', device, ip);
      return err(429, `Too many failed attempts. Try again in ${mins} minute(s).`);
    }
  }
  const users = await getJ(ctx.db, 'users', []);
  const staff = users.find(u => u.status === 'active' && ((u.username && lc(u.username) === lc(username)) || (u.email && lc(u.email) === lc(username))));
  let principal = null, reason = 'Failed — unknown username';
  if (staff) {
    if (await verifyPassword(password, staff.passwordHash || dummyHash()) && staff.passwordHash) principal = { role: staff.designation === 'Admin' ? 'admin' : 'teacher', user: staff };
    else reason = 'Failed — wrong password';
  } else {
    const st = (await allStudents(ctx.db)).find(s => lc(s.assRefId) === lc(username));
    if (st) {
      if (!(st.parentAccess && st.parentAccess.enabled)) reason = 'Failed — parent access not enabled';
      else if (!dobMatches(password, st.dob)) reason = 'Failed — wrong date of birth';
      else principal = { role: 'parent', student: st };
    } else await verifyPassword(password, dummyHash()); // keep timing similar
  }
  const roleLabel = staff ? (staff.designation === 'Admin' ? 'Admin' : 'Teacher') : 'Parent';
  if (!principal) {
    const after = await registerFail(ctx, [[ukey, MAX_FAILS], [ikey, IP_MAX_FAILS]]);
    await trace(ctx, username, staff ? roleLabel : 'Staff', reason, device, ip);
    if (after[ukey] && after[ukey].until > Date.now()) return err(429, `Too many failed attempts. Try again in ${LOCK_MS / 60000} minutes.`);
    return err(401, 'Invalid username or password. If you are a parent, check that your child\'s access has been switched on.');
  }
  await clearFails(ctx, ukey);
  const label = principal.role === 'parent' ? `${principal.student.assRefId} (${sessionUser(principal).name})` : `${principal.user.name} (${principal.user.email || principal.user.username})`;
  await trace(ctx, label, principal.role === 'parent' ? 'Parent' : roleLabel, 'Success', device, ip);
  if (principal.role !== 'parent' && principal.user.mustChange) return ok({ token: issue(ctx, principal), user: sessionUser(principal), data: null });
  return ok({ token: issue(ctx, principal), user: sessionUser(principal), data: await buildData(ctx, principal) });
}

/* ---------------------------------------------------------------- saving */
const NEVER_SET = new Set(['id', 'hasPhoto', ...SCORE_CONTAINERS, '__proto__']);

function applyStudentOp(existing, op, principal) {
  // returns {student, rejected}
  const admin = principal.role === 'admin';
  const me = principal.user;
  if (!existing) {
    if (!(admin || isPrivileged(me))) return { rejected: 'not allowed to add students' };
    const full = clean(op.full || {}); delete full.hasPhoto;
    if (!full.id || typeof full.id !== 'string') return { rejected: 'invalid student' };
    if (!admin) for (const c of SCORE_CONTAINERS) if (full[c]) full[c] = {};
    return { student: full };
  }
  const s = JSON.parse(JSON.stringify(existing));
  const aset = admin ? null : assignedSet(me);
  const okSubject = (subj) => admin || aset.has(`${s.class}||${subj}`);
  let changed = false, denied = 0;
  for (const [k, v] of Object.entries(op.set || {})) {
    if (NEVER_SET.has(k)) continue;
    if (!(admin || isPrivileged(me))) { denied++; continue; }
    s[k] = clean(v); changed = true;
  }
  for (const c of SCORE_CONTAINERS) {
    for (const [subj, v] of Object.entries((op.sub && op.sub[c]) || {})) {
      if (subj === '__proto__') continue;
      if (!okSubject(subj)) { denied++; continue; }
      s[c] = s[c] || {};
      if (v === null) delete s[c][subj]; else s[c][subj] = clean(v);
      changed = true;
    }
  }
  if (denied && !changed) return { rejected: 'not allowed' };
  return { student: s, partial: denied > 0 };
}

async function saveStudents(ctx, principal, changes, rejected) {
  const db = ctx.db;
  const shards = await loadAllShards(db);
  const where = new Map(); // id -> shard key
  shards.forEach(sh => sh.list.forEach(s => where.set(s.id, sh.key)));
  for (const op of (changes.upsert || [])) {
    if (!op || typeof op.id !== 'string') continue;
    const oldKey = where.get(op.id);
    const existing = oldKey ? (shards.find(x => x.key === oldKey).list.find(s => s.id === op.id)) : null;
    // Re-read the live copy inside the write so concurrent saves are merged, not overwritten.
    let result = null, newKey = oldKey;
    if (oldKey) {
      await update(db, oldKey, [], list => {
        const i = list.findIndex(s => s.id === op.id);
        if (i < 0) return undefined;
        const r = applyStudentOp(list[i], op, principal);
        result = r;
        if (!r.student) return undefined;
        if (shardKey(r.student.class) === oldKey) { list[i] = r.student; return list; }
        newKey = shardKey(r.student.class); list.splice(i, 1); return list;
      });
      if (result && result.student && newKey !== oldKey) {
        await update(db, newKey, [], list => { const j = list.findIndex(s => s.id === op.id); if (j >= 0) list[j] = result.student; else list.push(result.student); return list; });
        where.set(op.id, newKey);
      }
    } else {
      const r = applyStudentOp(null, op, principal); result = r;
      if (r.student) { newKey = shardKey(r.student.class); await update(db, newKey, [], list => { if (list.some(s => s.id === r.student.id)) return undefined; list.push(r.student); return list; }); where.set(op.id, newKey); }
    }
    if (result && result.rejected) rejected.push({ id: op.id, reason: result.rejected });
    else if (result && result.partial) rejected.push({ id: op.id, reason: 'some changes were not allowed' });
  }
  for (const id of (changes.delete || [])) {
    if (!(principal.role === 'admin' || canDelete(principal.user))) { rejected.push({ id, reason: 'not allowed to delete students' }); continue; }
    const key = where.get(id); if (!key) continue;
    await update(db, key, [], list => { const i = list.findIndex(s => s.id === id); if (i < 0) return undefined; list.splice(i, 1); return list; });
  }
}

async function save(ctx, principal, body) {
  if (principal.role === 'parent') return err(403, 'Parents have view-only access.');
  const rejected = [];
  const admin = principal.role === 'admin';
  const cfgChanges = body.config || {};
  if (Object.keys(cfgChanges).length) {
    if (!admin) rejected.push({ id: 'config', reason: 'only the administrator can change school settings' });
    else {
      await update(ctx.db, 'config', {}, cfg => {
        if (cfgChanges.school && typeof cfgChanges.school === 'object') cfg.school = clean(cfgChanges.school);
        if (Array.isArray(cfgChanges.classes)) cfg.classes = clean(cfgChanges.classes);
        if (cfgChanges.classTermSettings && typeof cfgChanges.classTermSettings === 'object') cfg.classTermSettings = clean(cfgChanges.classTermSettings);
        return cfg;
      });
    }
  }
  if (body.overalls && typeof body.overalls === 'object' && Object.keys(body.overalls).length) {
    const aset = admin ? null : assignedSet(principal.user);
    await update(ctx.db, 'config', {}, cfg => {
      cfg.assessmentOveralls = cfg.assessmentOveralls || {};
      for (const [k, v] of Object.entries(body.overalls)) {
        const [cls, subj] = k.split('||');
        if (!admin && !aset.has(`${cls}||${subj}`)) { rejected.push({ id: k, reason: 'not your subject/class' }); continue; }
        if (v === null) delete cfg.assessmentOveralls[k]; else cfg.assessmentOveralls[k] = clean(v);
      }
      return cfg;
    });
  }
  if (Array.isArray(body.users)) {
    if (!admin) rejected.push({ id: 'users', reason: 'only the administrator can change staff' });
    else {
      const me = principal.user.id;
      await update(ctx.db, 'users', [], list => {
        const FIELDS = ['name', 'email', 'phone', 'designation', 'status', 'privileges', 'assigned'];
        for (const inc of body.users) {
          if (!inc || typeof inc.id !== 'string') continue;
          const cur = list.find(u => u.id === inc.id);
          if (cur) {
            for (const f of FIELDS) {
              if (inc[f] === undefined) continue;
              if (cur.id === me && (f === 'status' || f === 'designation')) continue; // cannot lock yourself out
              if (f === 'status' && inc.status !== cur.status) cur.tokenVersion = (cur.tokenVersion || 0) + 1;
              cur[f] = clean(inc[f]);
            }
          }
        }
        return list;
      });
    }
  }
  if (body.students && typeof body.students === 'object') await saveStudents(ctx, principal, body.students, rejected);
  return ok({ ok: true, rejected, token: issue(ctx, principal) });
}

/* ---------------------------------------------------------------- admin actions */
async function createUser(ctx, principal, b) {
  if (principal.role !== 'admin') return err(403, 'Only the administrator can add staff.');
  const name = clean(String(b.name || '')).trim(), email = clean(String(b.email || '')).trim();
  const designation = b.designation === 'Admin' ? 'Admin' : 'Subject Teacher';
  if (!name || !email) return err(400, 'Name and e-mail are required.');
  { const pr = passwordProblem(b.password); if (pr) return err(400, pr); }
  const hash = await hashPassword(b.password);
  let created = null, dup = false;
  await update(ctx.db, 'users', [], list => {
    if (list.some(u => lc(u.email) === lc(email) || lc(u.username) === lc(email))) { dup = true; return undefined; }
    created = { id: 'u' + Date.now() + crypto.randomBytes(2).toString('hex'), name, email, phone: clean(String(b.phone || '')), designation, status: 'active',
      privileges: Array.isArray(b.privileges) ? clean(b.privileges) : [], assigned: [], passwordHash: hash, mustChange: true };
    list.push(created); return list;
  });
  if (dup) return err(409, 'A user with that e-mail already exists.');
  return ok({ user: publicUser(created), token: issue(ctx, principal) });
}
async function setPassword(ctx, principal, b) {
  if (principal.role !== 'admin') return err(403, 'Only the administrator can reset passwords.');
  { const pr = passwordProblem(b.password); if (pr) return err(400, pr); }
  const hash = await hashPassword(b.password);
  let found = false;
  await update(ctx.db, 'users', [], list => { const u = list.find(x => x.id === b.userId); if (!u) return undefined; found = true; u.passwordHash = hash; u.tokenVersion = (u.tokenVersion || 0) + 1; u.mustChange = u.id !== principal.user.id; return list; });
  if (!found) return err(404, 'User not found.');
  // keep the acting admin signed in if they changed their own password
  const fresh = (await getJ(ctx.db, 'users', [])).find(u => u.id === principal.user.id);
  return ok({ ok: true, token: issue(ctx, { role: principal.role, user: fresh }) });
}
async function changeOwnPassword(ctx, principal, b) {
  if (principal.role === 'parent') return err(403, 'Parents sign in with the child\'s date of birth; there is no password to change.');
  const oldP = String(b.oldPassword || ''), np = String(b.newPassword || '');
  const key = 'chg:' + principal.user.id;
  const lock = await getJ(ctx.db, 'lock', {});
  if (lock[key] && lock[key].until > Date.now()) return err(429, `Too many wrong attempts. Try again in ${Math.ceil((lock[key].until - Date.now()) / 60000)} minute(s).`);
  { const pr = passwordProblem(np); if (pr) return err(400, 'New password: ' + pr); }
  if (np === oldP) return err(400, 'The new password must be different from the current one.');
  if (!(await verifyPassword(oldP, principal.user.passwordHash))) {
    await registerFail(ctx, [[key, MAX_FAILS]]);
    return err(400, 'The current password is not correct.');
  }
  const hash = await hashPassword(np);
  await update(ctx.db, 'users', [], list => { const u = list.find(x => x.id === principal.user.id); if (!u) return undefined; u.passwordHash = hash; u.mustChange = false; u.tokenVersion = (u.tokenVersion || 0) + 1; return list; });
  await clearFails(ctx, key);
  await trace(ctx, `${principal.user.name} (${principal.user.email || principal.user.username})`, principal.role === 'admin' ? 'Admin' : 'Teacher', 'Password changed', b.device, ctx.ip || '');
  const fresh = (await getJ(ctx.db, 'users', [])).find(u => u.id === principal.user.id);
  return ok({ ok: true, token: issue(ctx, { role: principal.role, user: fresh }) });
}
async function sendSms(ctx, principal, b) {
  if (principal.role !== 'admin') return err(403, 'Only the administrator can send messages.');
  const key = ctx.env.ARKESEL_API_KEY, sender = (ctx.env.ARKESEL_SENDER || '').slice(0, 11);
  if (!key || !sender) return err(503, 'SMS sending is not set up yet. Add ARKESEL_API_KEY and ARKESEL_SENDER in the server settings.');
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(0, 100);
  if (!msgs.length) return err(400, 'No messages to send.');
  const sent = []; const failed = [];
  const queue = msgs.slice();
  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      const to = String(m.to || '').replace(/\D/g, ''); const text = String(m.text || '').slice(0, 480);
      if (!/^233\d{9}$/.test(to) || !text) { failed.push({ to, error: 'invalid number or empty message' }); continue; }
      try {
        const r = await ctx.fetch('https://sms.arkesel.com/api/v2/sms/send', { method: 'POST', headers: { 'api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ sender, message: text, recipients: [to] }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && (j.status === 'success' || j.code === 'ok' || j.status === undefined)) sent.push(to); else failed.push({ to, error: String(j.message || r.status).slice(0, 120) });
      } catch (e) { failed.push({ to, error: 'network error' }); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  await trace(ctx, principal.user.name, 'Admin', `Bulk SMS: ${sent.length} sent, ${failed.length} failed`, '', '');
  return ok({ sent: sent.length, failed, token: issue(ctx, principal) });
}

/* ---------------------------------------------------------------- entry point */
export async function handle(ctx, req) {
  // req: { method, body (parsed JSON or null), ip, rawLength }
  if (req.method !== 'POST') return err(405, 'Method not allowed.');
  if (!ctx.secret || ctx.secret.length < 32) return err(500, 'Server is not configured: SESSION_SECRET (32+ characters) is missing.');
  if (req.rawLength > 4_500_000) return err(413, 'That request is too large.');
  const b = req.body;
  if (!b || typeof b !== 'object' || typeof b.action !== 'string') return err(400, 'Bad request.');
  try { await ensureInit(ctx); } catch (e) { return err(500, 'Server setup problem: ' + e.message); }
  try {
    if (b.action === 'login') return await login(ctx, b, req.ip || 'unknown');
    const principal = await authenticate(ctx, b.token);
    if (!principal) return err(401, 'Your session has ended. Please sign in again.');
    const mustChange = principal.role !== 'parent' && principal.user.mustChange;
    if (mustChange && !['changeOwnPassword', 'logout', 'state'].includes(b.action)) return err(403, 'You must set a new password before continuing.', { code: 'must_change' });
    switch (b.action) {
      case 'changeOwnPassword': return await changeOwnPassword(ctx, principal, b);
      case 'state': return ok({ user: sessionUser(principal), data: mustChange ? null : await buildData(ctx, principal), token: issue(ctx, principal) });
      case 'students': {
        if (principal.role === 'parent') return err(403, 'Not available.');
        return ok({ students: (await studentsForShards(ctx, principal, b.shards)).map(lite), token: issue(ctx, principal) });
      }
      case 'photos': {
        if (principal.role === 'parent') return err(403, 'Not available.');
        const want = new Set((Array.isArray(b.ids) ? b.ids : []).slice(0, 80).map(String));
        const keys = await visibleShardKeys(ctx, principal);
        const photos = {};
        for (const k of keys) for (const st of await getJ(ctx.db, k, [])) if (want.has(st.id) && st.photo) photos[st.id] = st.photo;
        return ok({ photos, token: issue(ctx, principal) });
      }
      case 'save': return await save(ctx, principal, b);
      case 'createUser': return await createUser(ctx, principal, b);
      case 'setPassword': return await setPassword(ctx, principal, b);
      case 'sendSms': return await sendSms(ctx, principal, b);
      case 'trace':
        if (principal.role !== 'admin') return err(403, 'Only the administrator can view the login trace.');
        return ok({ loginTrace: (await getJ(ctx.db, 'trace', [])).slice(-500), token: issue(ctx, principal) });
      case 'logout': {
        const who = principal.role === 'parent' ? `${principal.student.assRefId} (${sessionUser(principal).name})` : `${principal.user.name} (${principal.user.email || principal.user.username})`;
        await trace(ctx, who, principal.role === 'parent' ? 'Parent' : principal.role === 'admin' ? 'Admin' : 'Teacher', 'Logged out', b.device, req.ip);
        return ok({ ok: true });
      }
      default: return err(400, 'Unknown action.');
    }
  } catch (e) {
    return err(500, 'Something went wrong on the server. Please try again.');
  }
}
