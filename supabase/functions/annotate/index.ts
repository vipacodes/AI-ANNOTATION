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
//     ACCESS_MODE=postgres       # or 'hmac' for the secret-only variant (no database)
//     SITE_BUCKET=site           # the PRIVATE bucket holding the repo files
//     PROJECT_URL=https://<ref>.supabase.co
//     SERVICE_ROLE_KEY=<the service key>   # server-only. never ship this to a browser
//     ANON_KEY=<the publishable/anon key>  # used for the key_check RPC
//   Names starting with SUPABASE_ are rejected by the CLI, hence PROJECT_URL / ANON_KEY.
//   No signing secret lives here: key_check() in the database decides, so a leaked function
//   environment cannot mint keys.
//
// Endpoints:  GET  /           index.html (free)
//             GET  /task.html  402 + gate screen without a key, page with a key
//             POST /unlock     {key} -> sets the at_key cookie
//             GET  /session    who you are, until when
// ============================================================================

const BUCKET = Deno.env.get('SITE_BUCKET') || 'site';
// The function's own slug, at module scope, because mountOf() and externalBase() are module
// functions: a const inside the handler would be out of their scope and every route would 500.
const SLUG = '/' + ((globalThis as any).FUNCTION_SLUG || 'annotate');
const MODE = (Deno.env.get('ACCESS_MODE') || 'postgres').toLowerCase();
const SECRET = Deno.env.get('ANNOTATE_SECRET') || '';
// The Supabase CLI refuses secret names beginning with SUPABASE_ ("Env name cannot start with
// SUPABASE_, skipping"), which silently leaves a function without the URL it needs. So the
// canonical names are PROJECT_URL / ANON_KEY, with the SUPABASE_* spellings kept as fallbacks
// for anyone who set them through the dashboard or the Management API instead of the CLI.
const env = (n) => Deno.env.get(n) || '';
const SUPABASE_URL = env('PROJECT_URL') || env('SUPABASE_URL');
const SERVICE_KEY = env('SERVICE_ROLE_KEY') || env('SERVICE_KEY');
const ANON_KEY = env('ANON_KEY') || env('SUPABASE_ANON_KEY') || env('PUBLISHABLE_KEY');

// Bump on deploy when debugging: GET /api/health reports it, so "is my code actually live?" is a
// curl, not a guess. (A stale deployment looked exactly like a broken bucket for one whole session.)
const BUILD = 'annotate-2026-08-30.2';

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

/* The path a browser must use to reach this function, i.e. what a cookie must be scoped to.
   Supabase forwards the original URL in x-forwarded-* (and Cloudflare in cf-connecting-*); when
   neither is present we are root-mounted and '/' is correct. */
function externalBase(req) {
  for (const h of ['x-forwarded-uri', 'x-forwarded-path', 'cf-visitor-uri']) {
    const v = req.headers.get(h);
    if (v) { try { return { path: mountOf(new URL(v, 'https://x').pathname) }; } catch (e) { } }
  }
  // Supabase does not forward the browser-visible path, and its own req.url has already had
  // /functions/v1 stripped, so a sub-path mount cannot be discovered from inside: declare it.
  const declared = env('SITE_BASE');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const seen = mountOf(new URL(req.url).pathname);
  const path = mountOf(req.headers.get('x-forwarded-uri') || '') || mountOf(req.headers.get('x-forwarded-path') || '')
    || (declared ? normaliseBase(declared) : (seen === SLUG ? '' : seen));
  return { path, origin: host ? proto + '://' + host : '' };
}
const normaliseBase = (b) => {
  const v = String(b || '').replace(/\/+$/, '');
  return v === '' || v === '/' ? '' : (v[0] === '/' ? v : '/' + v);
};
// The mount is the longest leading path that ends at our slug, whether the gateway stripped it
// or not: '/annotate/...', '/functions/v1/annotate/...', or '' for a root-mounted deploy.
function mountOf(pathname) {
  if (!pathname) return '';
  const i = pathname.indexOf(SLUG);
  if (i < 0) return '';
  const end = i + SLUG.length;
  if (pathname.length > end && pathname[end] !== '/') return '';   // '/annotatexyz' is not us
  return pathname.slice(0, end);
}

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
  // MOUNTING, in the form it actually arrives. Observed on this project: the browser calls
  //   https://<ref>.supabase.co/functions/v1/annotate/task.html
  // but the function's own req.url only carries the slug:
  //   /annotate/task.html
  // So the public base (/functions/v1/annotate) is NOT visible in req.url, and the two need
  // different treatment:
  //   · routing  -> strip a leading /<slug> here, whatever the host's gateway already did
  //   · cookies  -> scope to the path the BROWSER sees, derived from the forwarded request, or a
  //     cookie set at Path=/ on supabase.co would be shared with PostgREST and storage, and one
  //     set at Path=/annotate would never be returned on a /functions/v1/annotate request.
  if (p === SLUG || p === SLUG + '/') p = '/';
  else if (p.startsWith(SLUG + '/')) p = p.slice(SLUG.length) || '/';
  const external = externalBase(req);
  const COOKIE_PATH = external.path || '/';   // '' on a root-mounted deploy (custom domain)
  if (p === '/') p = '/index.html';
  // NB: the ".html" convenience is applied further down, AFTER the extensionless API routes are
  // matched. Appending it here rewrote /api/health to /api/health.html and every RPC 404'd.

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
        // Path is the mount, not the host root: on Supabase this function IS the site, but it is
        // mounted at /functions/v1/annotate, and a cookie scoped to "/" would also be sent to
        // anything else ever served from the project domain (PostgREST, storage). Scope it.
        'set-cookie': KEY_COOKIE + '=' + encodeURIComponent(body.key) + '; Path=' + COOKIE_PATH +
          '; Max-Age=7776000; HttpOnly; SameSite=Lax'
      }
    });
  }
  if (p === '/session') {
    const v = await verify(presented, req);
    return v.ok ? json(200, { label: v.label, until: v.until, mode: MODE }) : json(402, { error: v.error });
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
      return new Response(nf.body, { status: 404, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
    }
  }

  /* ---------- serve ---------- */
  if (p === '/api/health') {
    return json(200, {
      ok: true, gate: 'on', backend: MODE, protected: 'server-side (402)',
      bucket: BUCKET, build: BUILD, url: SUPABASE_URL ? 'configured' : 'MISSING',
      service: SERVICE_KEY ? 'configured' : 'MISSING', anon: ANON_KEY ? 'configured' : 'MISSING'
    });
  }
  // One diagnostic that answers "is the bucket reachable from in here?" from the inside, because
  // a bucket read that fails and a router that mis-paths both look identical from the outside.
  if (p === '/api/debug') {
    const probe = '/css/app.css';
    const target = SUPABASE_URL + '/storage/v1/object/authenticated/' + BUCKET + probe;
    let bucket = {};
    try {
      const r = await fetch(target, { headers: { Authorization: 'Bearer ' + SERVICE_KEY } });
      const t = await r.text();
      bucket = { status: r.status, bytes: t.length, head: t.slice(0, 24) };
    } catch (e) { bucket = { error: String(e && e.message || e) }; }
    return json(200, {
      pathname: new URL(req.url).pathname, probe: p, publicPath: isPublic(p), protectedPath: isProtected(p),
      siteBase: env('SITE_BASE') || '(unset)', cookiePath: COOKIE_PATH,
      baseWarning: !env('SITE_BASE') ? 'set the SITE_BASE secret to the browser-visible mount (e.g. /functions/v1/annotate) or unlock cookies will be scoped wrong on a sub-path deploy' : '',
      bucketTarget: target.replace(/https:\/\/[^/]+/, '(origin)'), bucket,
      types: { css: TYPES['.css'] || null }
    });
  }
  // /task -> /task.html, but only for paths that will be looked up as files
  if (!/\.[a-z0-9]+$/i.test(p) && p !== '/unlock' && p !== '/session' && !/^\/api(\/|$)/.test(p)) p += '.html';
  // An extensionless path that reached here is not a page and not an RPC: answer plainly,
  // without asking the bucket for a file that cannot exist.
  if (!/\.[a-z0-9]+$/i.test(p)) return json(404, { error: 'No such route. Pages end in .html.' });

  const up = await fromBucket(ctx, p);
  if (!up.ok) {
    // a missing asset stays a 404 with its own content type; only page paths get the styled page
    if (/\.html$/.test(p)) {
      const nf = await fromBucket(ctx, '/404.html');
      return new Response(nf.body, { status: 404, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
    }
    return new Response('not found', { status: up.status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });   // never cache a miss
  }
  // CACHING. This is a paywall decision, not a performance one, and getting it wrong is a leak:
  // the first draft here gave every file under /css|/js|/assets a 5-minute TTL. /js/tasks.js is
  // in /js AND is the paid corpus, so a buyer's authenticated 200 was cached by the CDN and then
  // served to the NEXT visitor with no key at all — a paid file, from the cache, for free, for
  // five minutes. The rule is therefore: anything PROTECT, and any page, is no-store; only a
  // PUBLIC asset may be cached, and briefly, so a stale 404 during an upload cannot stick.
  const cache = (!isProtected(p) && /^\/(?:css|js|assets)\//.test(p))
    ? 'public, max-age=300, stale-while-revalidate=60'
    : 'no-store';
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': TYPES[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream',
      'cache-control': cache, etag: 'W/"' + BUCKET + p.length + '-' + (up.headers.get('x-upstream') || '') + '"',
      'x-served-by': 'annotate-edge'
    }
  });
});
