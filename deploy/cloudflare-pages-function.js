/**
 * AnnotateTrainer · Cloudflare Pages Function — zero secret stored on Cloudflare.
 *
 * Put this file at  functions/[[path]].js  in the Pages project. Nothing else to configure
 * except two *public* settings, because the key database lives in Supabase Postgres:
 *
 *   SUPABASE_URL     (optional) defaults to the project below
 *   SUPABASE_ANON_KEY(optional) publishable/anonymous key — safe in public code, it is not a
 *                   secret: RLS still decides what it can read, and it can only call key_check
 *
 * Why no ANNOTATE_SECRET on Cloudflare: the function asks Postgres "is this key live?" and
 * Postgres answers. Revocation, expiry and buyer labels are then true for every server at once,
 * and a leaked Pages config cannot sign a new key. Cloudflare holds no secret at all.
 *
 * If the database is unreachable the answer is DENY (fail closed) — never "let them in because
 * I could not ask". Set ACCESS_MODE=hmac only if you want the old offline behaviour, in which
 * case you DO need ANNOTATE_SECRET on Pages.
 *
 * Deploy:  npx wrangler pages deploy . --project-name annotate-trainer
 *          (or connect the GitHub repo and set the two vars under Settings → Environment variables)
 */

const SUPABASE_URL = (globalThis.env?.SUPABASE_URL || 'https://veecksfcnlpppzvplcyt.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = globalThis.env?.SUPABASE_ANON_KEY || globalThis.env?.SUPABASE_PUBLISHABLE_KEY || '';
const MODE = (globalThis.env?.ACCESS_MODE || (SUPABASE_KEY ? 'postgres' : 'hmac')).toLowerCase();
const FALLBACK_SECRET = globalThis.env?.ANNOTATE_SECRET || '';

const enc = new TextEncoder();
async function hmacSig(id, exp, secret) {
  const k = await crypto.subtle.importKey('HMAC', { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'], ['sign']);
  const raw = await crypto.subtle.sign('HMAC', k, enc.encode(id + '.' + exp));
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 28);
}
const KEY_RE = /^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/;

async function rpc(name, args, extraHeaders) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'content-type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify(args),
    // a hung database must not hang the request: deny instead
    signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch (e) { return { status: res.status, text: text }; }
}

async function verify(key, request) {
  const m = KEY_RE.exec(String(key || '').trim());
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  const [, id, sig, exp] = m;
  if (Number(exp) < Date.now()) return { ok: false, error: 'This key expired. Reply to your receipt to renew.' };

  if (MODE === 'postgres') {
    if (!SUPABASE_KEY) return { ok: false, error: 'SUPABASE_ANON_KEY is not set on this Pages project.' };
    const r = await rpc('key_check', { p_id: id, p_sig: sig, p_exp: Number(exp) },
      { 'x-prefer': 'no-cache' }).catch(() => null);
    rpc('key_attempt', {
      p_fp: (request.headers.get('cf-connecting-ip') || 'unknown'),
      p_key_id: id, p_ok: !!(r && r.json && r.json.ok)
    }).catch(() => { });
    if (!r) return { ok: false, error: 'Key database unreachable — access denied until it answers.' };
    const out = r.json || {};
    if (r.status !== 200 || !out.ok) return { ok: false, error: out.error || (r.text ? r.text.slice(0, 160) : 'Key rejected.') };
    return out;
  }

  if (!FALLBACK_SECRET) return { ok: false, error: 'Server has neither a Postgres backend nor ANNOTATE_SECRET.' };
  if (await hmacSig(id, exp, FALLBACK_SECRET) !== sig) return { ok: false, error: 'This key was not issued by this site.' };
  return { ok: true, id, label: id, until: new Date(Number(exp)).toISOString().slice(0, 10) };
}

/* Keep this list byte-identical to PUBLIC/PROTECT in server.js and
   supabase/functions/annotate/index.ts — the test suite asserts all three agree. */
/* BEGIN-LISTS */
const PUBLIC = /^\/(?:(?:index|gate|buy|guide|platforms|platform)\.html|(?:css|assets|api|\.well-known)\/[^/]*(?:\/[^/]*)*|js\/(?:storage|access|app|platforms|mockups|crypto)\.js|robots\.txt|sitemap\.xml|favicon\.ico|(?:|$))$/;
const PROTECT = /^\/(?:task|queue|onboarding|detector|trust-safety|earnings)\.html$|^\/js\/(?:tasks|detector)\.js$|^\/data\//;
/* END-LISTS */

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);

  /* ---- unlock: verify, then set the cookie. Same shape as server.js /unlock ---- */
  if (p === '/unlock' && request.method === 'POST') {
    let body = {}; try { body = await request.json(); } catch (e) { }
    const v = await verify(body.key, request);
    if (!v.ok) return new Response(JSON.stringify({ error: v.error }), {
      status: 402, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
    return new Response(JSON.stringify(v), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'at_key=' + encodeURIComponent(body.key) + '; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax'
      }
    });
  }
  if (p === '/session') {
    const k = keyFrom(request);
    const v = k ? await verify(k, request) : { ok: false, error: 'no key' };
    return new Response(JSON.stringify(v.ok ? { label: v.label, until: v.until, mode: MODE } : { error: v.error }), {
      status: v.ok ? 200 : 402, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
  if (p === '/api/health') {
    return new Response(JSON.stringify({ ok: true, gate: 'on', backend: MODE, bucketless: true, protected: 'server-side (402)' }),
      { headers: { 'content-type': 'application/json' } });
  }

  const presented = keyFrom(request);
  const allowed = presented ? await verify(presented, request) : { ok: false };

  if (!allowed.ok && PROTECT.test(p)) {
    if (/\.js$/.test(p)) {
      // the product is the corpus; without a key you get an empty stub, never the file
      const stub = p.indexOf('tasks.js') >= 0
        ? 'window.Tasks={list:function(){return[]},get:function(){return null},count:0};window.POLICY={};'
        : 'window.Detector={analyze:function(){return{index:null,locked:true,features:[],tips:[]}}};';
      return new Response(stub, { status: 402, headers: { 'content-type': 'application/javascript', 'cache-control': 'no-store' } });
    }
    if (/\.html$/.test(p)) {
      const gate = await context.fetch(new Request(new URL('/gate.html', url), request));
      return new Response(gate.body, { status: 402, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('locked', { status: 402, headers: { 'content-type': 'text/plain' } });
  }
  return next();
}

function keyFrom(request) {
  const c = (request.headers.get('cookie') || '').split(';').map((s) => s.trim())
    .find((s) => s.indexOf('at_key=') === 0);
  return c ? decodeURIComponent(c.slice(7)) : (request.headers.get('x-access-key') || '');
}

/*
  Notes
  -----
  · The 402 for protected *pages* is what makes the paywall real: the bytes never leave the edge.
    /js/tasks.js getting a 94-byte stub instead of the 39 KB corpus is the same idea for the data.
  · If the database is down, buyers cannot unlock and the site reads as "locked" — which is the
    right failure. A gate that opens on error is not a gate.
  · Revocation is live on every deployment:  update public.access_keys set revoked_at = now()
    where id = 'Ab3xK9';
*/
