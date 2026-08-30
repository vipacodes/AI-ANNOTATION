// ============================================================================
// AnnotateTrainer · Supabase Edge Function = the whole site, gated by Postgres.
//
// This is the "I only want Supabase" deployment: no VPS, no Cloudflare project,
// one URL, and the paywall is enforced *server side* (protected files are never
// sent without a valid key). Site files live in a PRIVATE storage bucket; this
// function is the only thing the browser talks to.
//
//   supabase functions deploy annotate --no-verify-jwt
//   supabase secrets set \
//     ANNOTATE_SECRET=...                # node tools/keygen.js secret (optional: DB mode covers it)
//     SITE_BUCKET=site                   # private bucket holding the repo files
//     SUPABASE_URL=https://<ref>.supabase.co
//     SERVICE_ROLE_KEY=<service_role>     # server-only. never ship this to the browser
//     ACCESS_MODE=postgres                 # or 'hmac' for the secret-only variant
//     SUPABASE_ANON_KEY=<publishable>        # used for the PostgREST call in postgres mode
//
// Endpoints:  GET  /           index.html (free)
//             GET  /task.html  402 + gate screen without a key, page with a key
//             POST /unlock     {key} -> sets the at_key cookie
//             GET  /session    who you are, until when
// ============================================================================

const BUCKET = Deno.env.get('SITE_BUCKET') || 'site';
const MODE = (Deno.env.get('ACCESS_MODE') || 'postgres').toLowerCase();
const SECRET = Deno.env.get('ANNOTATE_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SERVICE_ROLE_KEY') || '';

const KEY_RE = /^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/;
const KEY_COOKIE = 'at_key';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm'
};

// Keep IDENTICAL to PUBLIC/PROTECT in server.js — the tests assert that.
/* BEGIN-LISTS */
const PUBLIC = /^\/(?:(?:index|gate|buy|guide|platforms|platform)\.html|(?:css|assets|api|\.well-known)\/[^/]*(?:\/[^/]*)*|js\/(?:storage|access|app|platforms|mockups)\.js|robots\.txt|sitemap\.xml|favicon\.ico|(?:|$))$/;
const PROTECT = /^\/(?:task|queue|onboarding|detector|trust-safety|earnings)\.html$|^\/js\/(?:tasks|detector)\.js$|^\/data\//;
/* END-LISTS */

const isPublic = (p) => PUBLIC.test(p);
const isProtected = (p) => PROTECT.test(p);

const enc = new TextEncoder();
async function hmacSig(id, exp) {
  const k = await crypto.subtle.importKey('HMAC', { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'], ['sign']);
  const raw = await crypto.subtle.sign('HMAC', k, enc.encode(id + '.' + exp));
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 28);
}

/* ---- postgres mode: revocation + labels + rate limiting come from the DB ---- */
async function rpc(fn, args, bearer) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: bearer, Authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch (e) { return { status: res.status, text: text }; }
}

async function verify(key, req) {
  const m = KEY_RE.exec(String(key || '').trim());
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  const [, id, sig, exp] = m;
  if (Number(exp) < Date.now()) return { ok: false, error: 'This key expired. Reply to your receipt to renew.' };

  if (MODE === 'postgres' && SUPABASE_URL && SERVICE_KEY) {
    const r = await rpc('key_check', { p_id: id, p_sig: sig, p_exp: Number(exp) }, SERVICE_KEY);
    const out = r.json || {};
    // fire-and-forget the audit/rate-limit row
    rpc('key_attempt', {
      p_fp: (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim(),
      p_key_id: id, p_ok: !!out.ok
    }, SERVICE_KEY).catch(() => { });
    if (r.status !== 200 || !out.ok) return { ok: false, error: out.error || 'Key rejected.' };
    return out;
  }

  if (!SECRET) return { ok: false, error: 'Server has no ANNOTATE_SECRET configured.' };
  if (await hmacSig(id, exp) !== sig) return { ok: false, error: 'This key was not issued by this site.' };
  return { ok: true, id, label: id, until: new Date(Number(exp)).toISOString().slice(0, 10) };
}

/* ---- serving from the private bucket ---- */
async function fromBucket(ctx, path) {
  const url = SUPABASE_URL + '/storage/v1/object/authenticated/' + BUCKET + path;
  return fetch(url, { headers: { Authorization: 'Bearer ' + SERVICE_KEY } });
}

const GATE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Locked · AnnotateTrainer</title>
<style>body{background:#0b0d12;color:#e7ecf3;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.card{max-width:520px;background:#141922;border:1px solid #232b39;border-radius:14px;padding:28px}
.up{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6d7c92;font-weight:700}
input{width:100%;box-sizing:border-box;background:#0e131c;border:1px solid #2e3848;color:#e7ecf3;border-radius:9px;padding:11px 13px;font-family:ui-monospace,monospace;font-size:13px}
button{background:#6a5bf0;border:1px solid #7f70ff;color:#fff;border-radius:9px;padding:11px 17px;font-weight:700;cursor:pointer}
a{color:#8b7cff}</style></head><body><div class="card">
<div class="up">Locked</div><h1 style="font-size:21px;margin:8px 0">This practice platform is paid-access</h1>
<p style="color:#93a0b4;font-size:13.5px">Paste the key from your receipt. The platform catalogue and the guide stay free.</p>
<div style="display:flex;gap:8px"><input id="k" placeholder="Ab3xK9.7W7KqRmYs0dYbE6fLrT1cPp0.1790000000000"><button id="go">Unlock</button></div>
<p id="m" style="font-size:12px;min-height:18px;color:#6d7c92"></p>
<p style="font-size:12.5px;color:#93a0b4"><a href="/gate.html">Full unlock page</a> · <a href="/buy.html">Pricing</a></p>
</div><script>
var go=function(){var k=document.getElementById('k').value.trim();var m=document.getElementById('m');m.textContent='checking\\u2026';
fetch('/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})}).then(function(r){return r.json().then(function(j){return{c:r.status,j:j}})}).then(function(r){
m.style.color=r.c===200?'#57d38b':'#ff6b6b';m.textContent=r.c===200?('Accepted - '+(r.j.label||'')+(', valid until '+(r.j.until||''))):(r.j.error||'Key rejected.');
if(r.c===200)setTimeout(function(){location.reload()},700);});};
document.getElementById('go').onclick=go;document.getElementById('k').addEventListener('keydown',function(e){if(e.key==='Enter')go()});
</script></body></html>`;

const json = (code, obj, extra) => new Response(JSON.stringify(obj), {
  status: code,
  headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {})
});

Deno.serve(async (req) => {
  const ctx = {};
  const url = new URL(req.url);
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (!/\.[a-z0-9]+$/i.test(p)) p += '.html';

  const cookieKey = (req.headers.get('cookie') || '').split(';').map((s) => s.trim())
    .filter((s) => s.indexOf(KEY_COOKIE + '=') === 0).map((s) => decodeURIComponent(s.slice(KEY_COOKIE.length + 1)))[0];
  const headerKey = req.headers.get('x-access-key');
  const presented = cookieKey || headerKey || '';

  /* ---------- unlock ---------- */
  if (p === '/unlock' && req.method === 'POST') {
    let body = {}; try { body = await req.json(); } catch (e) { }
    const v = await verify(body.key, req);
    if (!v.ok) return json(402, { error: v.error });
    return new Response(JSON.stringify(v), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': KEY_COOKIE + '=' + encodeURIComponent(body.key) + '; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax'
      }
    });
  }
  if (p === '/session') {
    const v = await verify(presented, req);
    return v.ok ? json(200, { label: v.label, until: v.until, mode: MODE }) : json(402, { error: v.error });
  }
  if (p === '/api/health') {
    return json(200, { ok: true, gate: 'on', backend: MODE, protected: 'server-side (402)', bucket: BUCKET });
  }

  /* ---------- the lock ---------- */
  if (!presented || !(await verify(presented, req)).ok) {
    if (isProtected(p)) {
      if (/\.js$/.test(p)) {
        // the product is the corpus; without a key you get an empty stub, not the file
        const stub = p.indexOf('tasks.js') >= 0
          ? 'window.Tasks={list:function(){return[]},get:function(){return null},count:0};window.POLICY={};'
          : 'window.Detector={analyze:function(){return{index:null,locked:true,features:[],tips:[]}}};';
        return new Response(stub, { status: 402, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' } });
      }
      if (/\.html$/.test(p)) {
        return new Response(GATE_HTML, { status: 402, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
      }
      return new Response('locked', { status: 402, headers: { 'content-type': 'text/plain' } });
    }
    if (!isPublic(p)) {
      const nf = await fromBucket(ctx, '/404.html');
      return new Response(nf.body, { status: 404, headers: { 'content-type': TYPES['.html'] } });
    }
  }

  /* ---------- serve ---------- */
  const up = await fromBucket(ctx, p);
  if (!up.ok) {
    const nf = await fromBucket(ctx, '/404.html');
    return new Response(nf.body, { status: 404, headers: { 'content-type': TYPES['.html'] } });
  }
  return new Response(up.body, {
    status: 200,
    headers: { 'content-type': TYPES[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': 'no-store' }
  });
});
