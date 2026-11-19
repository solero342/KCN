import { clean, applyOp, cleanConfig } from '../lib/state.js';

// Server side of "Koffie op kantoor": one shared password, data in a D1 database.
// Needs a secret SITE_PASSWORD on the Worker; the D1 binding DB comes from wrangler.jsonc.
const te = new TextEncoder();
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function sign(pw, exp) {
  const key = await crypto.subtle.importKey('raw', te.encode(await sha('kcn-session|' + pw)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, te.encode(String(exp))));
}
async function authed(request, env) {
  const m = /(?:^|;\s*)kcn=(\d{10,16})\.([0-9a-f]{64})(?:;|$)/.exec(request.headers.get('Cookie') || '');
  if (!m || +m[1] < Date.now()) return false;
  return safeEq(m[2], await sign(env.SITE_PASSWORD, m[1]));
}
const cookie = (val, maxAge) => 'kcn=' + val + '; Path=/; HttpOnly; Secure; SameSite=Strict' + (maxAge != null ? '; Max-Age=' + maxAge : '');

let ready = false;
async function init(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS docs (k TEXT PRIMARY KEY, v TEXT NOT NULL, n INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, c INTEGER NOT NULL, t INTEGER NOT NULL)'),
  ]);
}
async function getDoc(db, k) { const r = await db.prepare('SELECT v, n FROM docs WHERE k = ?').bind(k).first(); return r ? { val: JSON.parse(r.v), n: r.n } : { val: null, n: 0 }; }
// write only if nobody else wrote since we read version n
async function putDoc(db, k, val, n) {
  const s = JSON.stringify(val);
  const r = n === 0
    ? await db.prepare('INSERT OR IGNORE INTO docs (k, v, n) VALUES (?, ?, 1)').bind(k, s).run()
    : await db.prepare('UPDATE docs SET v = ?, n = n + 1 WHERE k = ? AND n = ?').bind(s, k, n).run();
  return r.meta.changes === 1;
}
async function readBody(request, max) {
  const t = await request.text();
  if (t.length > max) throw Object.assign(new Error('te groot'), { status: 413 });
  try { return JSON.parse(t); } catch (e) { throw Object.assign(new Error('geen geldige JSON'), { status: 400 }); }
}

const LOCK_AFTER = 8, LOCK_MS = 15 * 60 * 1000;
async function login(request, env) {
  const db = env.DB, ip = request.headers.get('CF-Connecting-IP') || 'local', now = Date.now();
  const f = await db.prepare('SELECT c, t FROM fails WHERE ip = ?').bind(ip).first();
  if (f && f.c >= LOCK_AFTER && now - f.t < LOCK_MS) return json({ error: 'locked', message: 'Te vaak een verkeerd wachtwoord. Probeer het over een kwartier opnieuw.' }, 429);
  const body = await readBody(request, 2000);
  const ok = safeEq(await sha('pw|' + String(body.password || '')), await sha('pw|' + env.SITE_PASSWORD));
  if (!ok) {
    const c = f && now - f.t < LOCK_MS ? f.c + 1 : 1;
    await db.prepare('INSERT INTO fails (ip, c, t) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET c = excluded.c, t = excluded.t').bind(ip, c, now).run();
    return json({ error: 'wrong' }, 401);
  }
  if (f) await db.prepare('DELETE FROM fails WHERE ip = ?').bind(ip).run();
  const days = body.remember ? 30 : 0.5, exp = now + Math.round(days * 86400000);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(exp + '.' + await sign(env.SITE_PASSWORD, exp), body.remember ? 30 * 86400 : null) });
}

async function handleApi(request, env, route) {
  const method = request.method;
  if (!env.SITE_PASSWORD || !env.DB) {
    const miss = [!env.SITE_PASSWORD && 'het geheim SITE_PASSWORD', !env.DB && 'de D1-koppeling DB'].filter(Boolean).join(' en ');
    return json({ error: 'setup', message: 'De site is nog niet klaar: in Cloudflare ontbreekt ' + miss + '. Voeg dat toe bij Settings > Variables and Secrets van deze Worker.' }, 503);
  }
  try {
    if (method !== 'GET') {
      const origin = request.headers.get('Origin');
      if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'origin' }, 403);
    }
    if (!ready) { await init(env.DB); ready = true; }
    if (route === 'login' && method === 'POST') return await login(request, env);
    if (route === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    if (!await authed(request, env)) return json({ error: 'auth' }, 401);

    if (route === 'state' && method === 'GET') {
      const q = new URL(request.url).searchParams, d = await getDoc(env.DB, 'data'), c = await getDoc(env.DB, 'config'), out = { v: d.n, cv: c.n };
      if (String(d.n) !== q.get('v')) out.data = clean(d.val && d.val.state);
      if (String(c.n) !== q.get('cv')) out.config = cleanConfig(c.val);
      return json(out);
    }
    if (route === 'ops' && method === 'POST') {
      const body = await readBody(request, 900000), ops = Array.isArray(body.ops) ? body.ops.slice(0, 300) : null;
      if (!ops) return json({ error: 'bad' }, 400);
      for (let tries = 0; tries < 8; tries++) {
        const cur = await getDoc(env.DB, 'data');
        let st = clean(cur.val && cur.val.state), seen = cur.val && Array.isArray(cur.val.seen) ? cur.val.seen.slice() : [];
        for (const op of ops) {
          const id = op && typeof op.i === 'string' ? op.i.slice(0, 40) : '';
          if (id && seen.includes(id)) continue;      // a retried request must not count twice
          st = applyOp(st, op); if (id) seen.push(id);
        }
        st = clean(st); seen = seen.slice(-400);
        if (await putDoc(env.DB, 'data', { state: st, seen }, cur.n)) return json({ v: cur.n + 1, data: st });
      }
      return json({ error: 'busy' }, 409);
    }
    if (route === 'config' && method === 'POST') {
      const body = await readBody(request, 900000);
      for (let tries = 0; tries < 8; tries++) {
        const cur = await getDoc(env.DB, 'config'), old = cleanConfig(cur.val);
        const next = cleanConfig({ people: body.people, guests: body.guests, logo: typeof body.logo === 'string' ? body.logo : old.logo });
        if (typeof body.logo === 'string' && body.logo && !next.logo) return json({ error: 'logo', message: 'Dit logo is te groot of geen afbeelding. Kies een PNG of JPG van maximaal 400 kB.' }, 400);
        if (await putDoc(env.DB, 'config', next, cur.n)) return json({ cv: cur.n + 1, config: next });
      }
      return json({ error: 'busy' }, 409);
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, (e && e.status) || 500);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) return handleApi(request, env, path.slice(5).replace(/\/+$/, ''));
    return env.ASSETS.fetch(request);
  },
};
