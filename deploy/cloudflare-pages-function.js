/**
 * AnnotateTrainer — Cloudflare Pages Function (free tier, no server to babysit).
 *
 * Put this file at  functions/[[path]].js  in your Pages project, set the Pages environment
 * variable ANNOTATE_SECRET (same secret your buyers' keys were signed with), and the lock is
 * enforced at the edge: protected HTML/JS is never sent without a valid key.
 *
 * Public by design: index, guide, platforms catalogue, platform profiles, gate, buy, css, assets.
 * Keys are signed strings (id.signature.expiryMs) — no database needed. Add a KV namespace only
 * if you want to revoke keys, see the note at the bottom.
 */
/* Pages/Workers inject bindings as the second argument; the server.js copy uses process.env. */
const SECRET = (env) => (env && env.ANNOTATE_SECRET) || (typeof process !== 'undefined' && process.env.ANNOTATE_SECRET) || '';

const enc = new TextEncoder();
let _secret = '';
async function hmac(msg) {
  if (!_secret) throw new Error('ANNOTATE_SECRET is not set on this Pages project — refusing to serve anything.');
  const k = await crypto.subtle.importKey('HMAC', { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'], ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 28);
}
const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function verify(key) {
  const m = String(key || '').trim().match(/^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/);
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  const [, id, sig, exp] = m;
  if (Number(exp) < Date.now()) return { ok: false, error: 'This key expired. Reply to your receipt to renew.' };
  if (b64url(await hmac(id + '.' + exp)) !== sig) return { ok: false, error: 'This key was not issued by this site.' };
  return { ok: true, id, label: id, until: new Date(Number(exp)).toISOString().slice(0, 10) };
}

/* Keep this list byte-identical to PUBLIC in server.js; PROTECT is checked first, so a page can
   never be both free and withheld. The bare `/` is matched by the trailing `|.` alternative. */
const PUBLIC = /^\/(?:(?:index|gate|buy|guide|platforms|platform)\.html|(?:css|assets|api|\.well-known)\/[^/]*(?:\/[^/]*)*|js\/(?:storage|access|app|platforms|mockups)\.js|robots\.txt|sitemap\.xml|favicon\.ico|(?:|$))$/;

const PROTECT = /^\/(?:task|queue|onboarding|detector|trust-safety|earnings)\.html$|^\/js\/(?:tasks|detector)\.js$|^\/data\//;

export async function onRequest(context) {
  const { request, next, env } = context;
  _secret = SECRET(env);
  const url = new URL(request.url);
  const p = url.pathname === '/' ? '/index.html' : url.pathname;

  /* the unlock endpoint lives right here — no origin server needed */
  if (p === '/unlock' && request.method === 'POST') {
    let body = {}; try { body = await request.json(); } catch (e) { }
    const v = await verify(body.key);
    if (!v.ok) return new Response(JSON.stringify({ error: v.error }), {
      status: 402, headers: { 'content-type': 'application/json' }
    });
    return new Response(JSON.stringify(v), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'at_key=' + encodeURIComponent(body.key) + '; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax'
      }
    });
  }

  const cookie = (request.headers.get('cookie') || '').split(';').map((s) => s.trim())
    .find((s) => s.indexOf('at_key=') === 0);
  const headerKey = request.headers.get('x-access-key');
  const v = await verify(cookie ? decodeURIComponent(cookie.slice(7)) : (headerKey || ''));
  const isHtml = /\.html$/.test(p) || p === '/';

  if (!v.ok && PROTECT.test(p)) {
    if (isHtml) {
      const gate = await context.fetch(new Request(new URL('/gate.html', url), request));
      return new Response(gate.body, { status: 402, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('locked', { status: 402, headers: { 'content-type': 'text/plain' } });
  }
  if (PUBLIC.test(p)) return next();
  return next();   /* unknown paths: 404 from static, never a silent leak of PROTECT files */
}

/*
 * Revocation, when you need it: create a KV namespace bound as KEYS, store revoked ids.
 *   if (env.KEYS && await env.KEYS.get('revoked:' + id)) return { ok:false, error:'revoked' }
 * Buyer-visible key issuance without a server: run `node tools/keygen.js new --label "X" --days 90`
 * locally with ANNOTATE_SECRET set to the same value as the Pages env var, and paste the result into
 * your fulfilment email / webhook handler.
 */
