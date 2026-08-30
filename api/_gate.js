/* Shared by api/index.js (the Vercel handler) and tests/vercel-entry.js, so the test exercises the
   same code the deployment runs instead of a re-implementation of it.

   WHY THIS FILE EXISTS. deploy/cloudflare-pages-function.js is written for the Cloudflare Pages
   Functions convention (export async function onRequest({ request, env, next })). Vercel has no such
   convention, and Vercel's zero-config Node detection does the one thing a paywall must never meet:
   it imports server.js, whose module body calls server.listen() and exports no handler. That is
   precisely the FUNCTION_INVOCATION_FAILED 500 a browser got from a Vercel deploy of this repo — the
   process "crashed" because there was nothing to invoke.

   Rather than maintain a third gate implementation (the drift between the two that exist is already
   asserted against; a third would be a third way to get it wrong), this evaluates the Cloudflare source
   and adapts the plumbing around it: globalThis.env for its env reads, a `next()` that serves from the
   filesystem, and a path rebuilt from x-invoke-path — because a Vercel catch-all rewrite replaces
   req.url with the function's own path (/api/index). Skip that last part and every request looks like
   '/' to the gate: free forever, with the lock invisible. */
'use strict';
const fs = require('fs');
const path = require('path');

// The repo root IS the deployment root on Vercel (no build step, no outputDirectory) — except that
// whatever .vercelignore excludes is genuinely absent in production. tests/vercel-entry.js therefore
// runs this module a second time against a throwaway copy with those patterns applied, so "the paid
// file is not on the server" is verified rather than assumed. ANNOTATE_DEPLOY_ROOT is how it points
// there; nothing about the production path changes.
const ROOT = process.env.ANNOTATE_DEPLOY_ROOT || path.join(__dirname, '..');
const FN = path.join(ROOT, 'deploy/cloudflare-pages-function.js');

/**
 * Evaluate the gate module and return its onRequest.
 *
 * The naive version — readFileSync + new Function — is what 500'd every request on Vercel. Vercel's
 * Node builder BUNDLES a function (it emits .vercel/output/function/index.js containing api/index.js
 * and its statically-traceable requires, nothing else), so `__dirname/../deploy/…js` is simply not a
 * path that exists at runtime. Locally it always worked, because locally the repo is the filesystem.
 * Four routes, tried in order, because the shape of the artifact depends on whether a bundler ran:
 *   1. require of api/gate-bundled.js — a static, literal edge the builder inlines; when it is inlined,
 *      that is the only route that can work, and the one that carries the fix
 *   2. the gate file beside the function, if the builder emitted it there
 *   3. the repo tree (deploy/…js next to the function's own directory): no bundler, files verbatim
 *   4. read the source and eval it — dev, and any runtime where nothing is importable
 */
async function loadGate() {
  const tries = [];
  // 1. bundled: the import graph the builder could see
  tries.push(() => require('./gate-bundled.js'));
  // 2/3. unbundled: the real file, wherever the function landed relative to the tree
  for (const c of [path.join(__dirname, 'gate-entry.js'), path.join(__dirname, '..', 'deploy', 'gate-entry.js')]) {
    if (fs.existsSync(c)) { const f = c; tries.push(() => { const m = require(f); return m && (m.onRequest || m.default); }); }
  }
  // 4. last resort, and the one that used to be the only one: evaluate the source ourselves
  tries.push(() => {
    const src = fs.readFileSync(FN, 'utf8').replace(/^export\s+async\s+function\s+onRequest/m, 'async function onRequest');
    globalThis.env = Object.assign({}, process.env);   // the gate reads config as globalThis.env.X
    return new Function(src + '\nreturn { onRequest };')().onRequest;
  });
  for (const t of tries) {
    try { const f = await t(); if (typeof f === 'function') return f; storeErr('route produced no handler'); }
    catch (e) { storeErr(e && (e.code || '') + ' ' + String(e.message).slice(0, 120)); }
  }
  throw new Error('no gate route worked [' + LOAD_ERRORS.join(' | ') + ']');
}

const PREFIX = '/api/index';
function originalPath(req) {
  const raw = req.headers['x-invoke-path'] || req.headers['x-vercel-invoke-path'] || '';
  let p = raw ? decodeURIComponent(raw) : (req.url || '/');
  if (p.indexOf('?') >= 0) p = p.slice(0, p.indexOf('?'));
  if (!p.startsWith('/')) p = '/' + p;
  // Some project layouts keep the function's own prefix in the path; drop it, or '/api/index' becomes
  // a route the gate knows nothing about and it is answered as if it were '/'.
  if (p === PREFIX || p.indexOf(PREFIX + '.') === 0) p = '/';
  return p;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

// Kept identical in spirit to PROTECT in the gate: a cached paid file is a leak, so only what the gate
// itself would have answered 200-without-a-key may carry a TTL. Anything else is no-store.
const PUBLIC_ASSET = /^\/(?:css|js|assets)\/[^/]+$/;
const PROTECTED = /^\/(?:task|queue|onboarding|detector|trust-safety|earnings)\.html$|^\/js\/(?:tasks|detector)\.js$|^\/data\//;

// The paid corpus, served as an empty stub instead of the real file — the same choice the Supabase and
// Cloudflare variants make. Kept inline because the real file is NOT DEPLOYED (see .vercelignore), so
// there is nothing on disk to withhold here.
/* The two bodies a Vercel request needs but the deployment does not carry, embedded verbatim.
   deploy/gate-fallback.html and 404.html exist in the repo, yet Vercel's function artifact is the traced
   import graph — __dirname is /var/task and there is no deploy/ beside it, so reading either file at
   runtime throws ENOENT inside the handler. That is how a working paywall ended up answering
   `500 {"error":"Gate failed closed: ENOENT …gate-fallback.html"}` to the very visitor who should be
   shown the lock screen and a buy link.

   The file remains the source of truth (dev and Cloudflare read it from disk, preferring it when it
   exists, so an edit there is live locally); tools/embed-fallbacks.js regenerates these two constants
   from it, and tests/vercel-entry.js fails if they drift. */
const EMBED_GATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Locked · AnnotateTrainer</title>
<style>
:root{color-scheme:dark}
body{background:#0b0d12;color:#e7ecf3;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.card{max-width:520px;background:#141922;border:1px solid #232b39;border-radius:14px;padding:28px}
.up{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6d7c92;font-weight:700}
h1{font-size:21px;margin:8px 0}
p{color:#93a0b4;font-size:13.5px}
input{width:100%;box-sizing:border-box;background:#0e131c;border:1px solid #2e3848;color:#e7ecf3;border-radius:9px;padding:11px 13px;font-family:ui-monospace,monospace;font-size:13px}
button{background:#6a5bf0;border:1px solid #7f70ff;color:#fff;border-radius:9px;padding:11px 17px;font-weight:700;cursor:pointer}
.row{display:flex;gap:8px;margin-top:12px}
a{color:#8b7cff}
#m{font-size:12px;min-height:18px;color:#6d7c92}
</style>
</head>
<body>
<div class="card">
  <div class="up">Locked</div>
  <h1>This practice platform is paid-access</h1>
  <p>Paste the key from your receipt. The platform catalogue and the guide stay free.</p>
  <div class="row"><input id="k" placeholder="Ab3xK9.7W7KqRmYs0dYbE6fLrT1cPp0.1790000000000"><button id="go">Unlock</button></div>
  <p id="m"></p>
  <p><a href="/buy.html">Pricing</a> · pay by transfer or one-time Litecoin</p>
</div>
<script>
var go=function(){var k=document.getElementById('k').value.trim();var m=document.getElementById('m');
m.textContent='checking\u2026';
fetch('/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})})
.then(function(r){return r.json().then(function(j){return{c:r.status,j:j}})})
.then(function(r){m.style.color=r.c===200?'#57d38b':'#ff6b6b';
m.textContent=r.c===200?('Accepted - '+(r.j.label||'')+', valid until '+(r.j.until||'')):(r.j.error||'Key rejected.');
if(r.c===200)setTimeout(function(){location.reload()},700);});};
document.getElementById('go').onclick=go;
document.getElementById('k').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
</script>
</body>
</html>`;
const EMBED_404 = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found — AnnotateTrainer</title><link rel="stylesheet" href="css/app.css"></head>
<body><div id="app-banner"></div>
<div class="wrap" style="padding-top:90px;text-align:center">
  <div class="mono" style="font-size:60px;color:var(--violet)">404</div>
  <h1>That task was released from the queue.</h1>
  <p class="dim">Nothing at that path. Which is, coincidentally, the exact experience of a platform going quiet.</p>
  <div class="row" style="justify-content:center"><a class="btn" href="index.html">Home</a><a class="btn ghost" href="queue.html">Task queue</a></div>
</div>
<script src="js/storage.js"></script><script src="js/app.js"></script><script>App.banner();</script>
</body></html>`;

const STUB_JS = {
  '/js/tasks.js': 'window.Tasks={list:function(){return[]},get:function(){return null},count:0};window.POLICY={};',
  '/js/detector.js': 'window.Detector={analyze:function(){return{index:null,locked:true,features:[],tips:[]}}};'
};

/** The `next()` a Pages function expects: serve from disk, or 404 — never hand back an ungated page. */
async function nextHandler(request) {
  const p = originalPath(request);
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(ROOT, rel);
  if (abs !== ROOT && abs.indexOf(ROOT + path.sep) !== 0) return { status: 400, body: Buffer.from('bad path'), type: 'text/plain; charset=utf-8' };
  const cands = fs.existsSync(abs) ? [abs] : (/\.[a-z0-9]+$/i.test(abs) ? [] : [abs + '.html']);
  const file = cands.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file && PROTECTED.test(rel)) {
    // THIS is the actual paywall on Vercel, and it is deliberately not a rewrite.
    //
    // Vercel's own docs: "The source property should NOT be a file because precedence is given to the
    // filesystem prior to rewrites being applied." A catch-all rewrite therefore CANNOT gate
    // /task.html — the file exists, so Vercel serves it and onRequest never runs. The earlier shape of
    // this adapter relied on that rewrite, and vercel.json even documented beforeFiles as the fix;
    // beforeFiles is a next.config.js key, not a vercel.json one, so the comment was describing an
    // option that does not exist and the design was leaning on a guarantee Vercel explicitly refuses to
    // make. What actually holds: the paid bytes are excluded from the deployment by .vercelignore, so
    // there is nothing for the filesystem to prefer, and the 402 body is synthesised here from
    // deploy/gate-fallback.html. A paywall that works because a file is absent cannot be bypassed by
    // routing precedence.
    if (/\.js$/.test(rel)) {
      return { status: 402, body: Buffer.from(STUB_JS[rel] || 'window.__locked=true;'), type: TYPES['.js'], cache: 'no-store' };
    }
    // Prefer the deployed copy (dev, Cloudflare); on Vercel it is not in the artifact, hence EMBED_GATE.
    const g = path.join(ROOT, 'deploy/gate-fallback.html');
    const body = fs.existsSync(g) ? fs.readFileSync(g) : Buffer.from(EMBED_GATE);
    return { status: 402, body, type: TYPES['.html'], cache: 'no-store' };
  }
  if (!file) {
    const nf = path.join(ROOT, '404.html');
    return { status: 404, body: fs.existsSync(nf) ? fs.readFileSync(nf) : Buffer.from(EMBED_404), type: TYPES['.html'] };
  }
  const served = '/' + path.relative(ROOT, file).split(path.sep).join('/');
  // Deliberately the same rule as the Supabase function, which is deliberately narrow: the first draft
  // there cached "everything under /js" for five minutes, /js/tasks.js included, and the CDN handed the
  // paid corpus to the next visitor for free. A TTL therefore requires ALL THREE of: not protected, a
  // css|js|assets directory asset, and the gate itself classing it public.
  const cache = (!PROTECTED.test(served) && PUBLIC_ASSET.test(served))
    ? 'public, max-age=300, stale-while-revalidate=60' : 'no-store';
  return { status: 200, body: fs.readFileSync(file), type: TYPES[path.extname(served)] || 'application/octet-stream', cache };
}

/**
 * Cloudflare Pages Functions hand the code a `context.fetch` that re-enters the site (line 124 uses it
 * to render gate.html as the body of a 402). Vercel's runtime has no such thing, and a missing one is a
 * 500 on exactly the response a non-paying visitor should get. So it is implemented here rather than
 * stubbed: an absolute URL to this same host resolves from disk through nextHandler — which keeps the
 * gate in the loop, so the shim cannot be used to read a protected file — and anything else falls
 * through to the real fetch.
 */
function makeFetch(baseOrigin) {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    let u;
    try { u = new URL(req.url); } catch (e) { u = null; }
    const sameSite = u && (u.origin === baseOrigin || u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    if (sameSite) {
        const r = await nextHandler({ url: u.pathname, headers: { 'x-invoke-path': u.pathname } });
      // gate.html is itself excluded from the deployment (.vercelignore), because the lock screen is
      // exactly what a crawler should NOT index as a free page. So a missing one is expected, not an
      // error: fall back to the shipped copy instead of handing the caller a 404 body to wrap in a 402.
      const out = (u.pathname === '/gate.html' && r.status === 404)
        ? { status: 200, body: fs.existsSync(path.join(ROOT, 'deploy/gate-fallback.html')) ? fs.readFileSync(path.join(ROOT, 'deploy/gate-fallback.html')) : Buffer.from(EMBED_GATE), type: TYPES['.html'] }
        : r;
      return new Response(out.body, { status: out.status, headers: { 'content-type': out.type, 'cache-control': out.cache || 'no-store' } });
    }
    return fetch(req);
  };
}

const LOAD_ERRORS = [];
function storeErr(m) { LOAD_ERRORS.push(m); }

module.exports = { loadGate, originalPath, nextHandler, makeFetch, TYPES, ROOT, PREFIX, LOAD_ERRORS };
