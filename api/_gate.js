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
// The gate module reads its whole configuration at LOAD time, as top-level consts
// (`globalThis.env?.SUPABASE_ANON_KEY`, and MODE derived from it). Vercel's Node runtime has no such
// global — on Cloudflare Pages it is injected, on Vercel it is process.env — so this shim is what makes
// the two hosts agree. It has to be installed here, before anything imports the gate: the previous
// placement, inside the readFileSync-and-eval fallback, meant the mode depended on WHICH ROUTE loaded
// the module. Bundled in, the gate came up in hmac mode with no secret and every key on earth was
// refused ("Server has neither a Postgres backend nor ANNOTATE_SECRET"); eval'd in, it was postgres.
// A paywall whose behaviour depends on module-loading trivia is not a paywall.
globalThis.env = Object.assign({}, process.env);

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
    return new Function(src + '\nreturn { onRequest };')().onRequest;
  });
  for (const t of tries) {
    try { const f = await t(); if (typeof f === 'function') return f; storeErr('route produced no handler'); }
    catch (e) { storeErr(e && (e.code || '') + ' ' + String(e.message).slice(0, 120)); }
  }
  throw new Error('no gate route worked [' + LOAD_ERRORS.join(' | ') + ']');
}

/* Where a Vercel-only deployment gets PAID content from, once the key has been accepted.
 *
 * .vercelignore keeps the paid corpus out of this deployment — that is what makes the paywall
 * un-bypassable by rewrite precedence — so `nextHandler` has no file to return even for a legitimate
 * subscriber, and a paid customer used to get the lock screen back. The bytes do exist, in the private
 * bucket the Supabase function reads. So a Vercel request that the gate has ALREADY cleared is
 * re-checked against that function: the mirror forwards the visitor's cookie and the origin's own gate
 * decides again. Two independent decisions, both fail-closed; if either regex drifts, the visitor gets a
 * 402 with the lock screen rather than a leaked file.
 *
 * ANNOTATE_MIRROR is the override used by the test (point it at a stub origin) and by anyone who
 * re-hosts the origin; it defaults to the same SUPABASE_URL the gate's key verification already uses,
 * and it is refused when it points back at this deployment, which would recurse forever. */
const MIRROR_ORIGIN = (function () {
  let u = process.env.ANNOTATE_MIRROR || process.env.SUPABASE_URL || 'https://veecksfcnlpppzvplcyt.supabase.co';
  u = String(u).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) return '';
  if (u.indexOf('.vercel.app') >= 0 || u.indexOf('localhost') >= 0 || u.indexOf('127.0.0.1') >= 0) return '';
  // SUPABASE_URL names the PROJECT (it is what key verification uses), but the site is served by the
  // function mounted under it. Handing the project root to a GET /task.html returns Supabase's own
  // 404 page, which the caller would read as "the mirror declined" forever. An explicit
  // ANNOTATE_MIRROR is taken verbatim, because whoever set it knows what is behind it.
  if (!process.env.ANNOTATE_MIRROR && u.indexOf('/functions/') < 0 && /supabase(\.co|\.in)/.test(u)) {
    u = u + '/functions/v1/annotate';
  }
  return u;
})();

const PREFIX = '/api/index';
/** One GET to the gated origin for an asset this deployment refuses to carry. Any error is "no
 *  answer", not "serve nothing anyway": the caller falls back to the lock screen. */
async function fromMirror(rel, srcReq) {
  try {
    const h = { accept: '*/*' };
    const ck = srcReq && srcReq.headers && srcReq.headers.get && srcReq.headers.get('cookie');
    if (ck) h.cookie = ck;                        // the origin's gate decides with the same cookie
    const res = await fetch(MIRROR_ORIGIN + rel, {
      method: 'GET', headers: h, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    });
    if (!res.ok) return null;                      // 402 / 404 / 5xx all mean: do not serve
    const type = res.headers.get('content-type') || 'application/octet-stream';
    if (/^text\/html/i.test(type) && /Locked · AnnotateTrainer/.test(await res.clone().text())) return null;
    return { status: 200, body: Buffer.from(await res.arrayBuffer()), type, cache: 'no-store' };
  } catch (e) { storeErr('mirror ' + rel + ': ' + String(e.message).slice(0, 80)); return null; }
}

/**
 * The lock screen, from whichever copy this runtime actually has, in the order the two callers used to
 * disagree about. gate.html first: it is the real screen, with the ?next= return-to and the ?k= prefill
 * the front page uses, and on the Vercel mirror it is never deployed — so this falls to the shipped
 * fallback and then to the embedded copy. Three sources, one answer, and the SAME answer for the 402
 * body and for the gate's own context.fetch('/gate.html'), which had each picked a different file.
 */
function gateScreen(refused) {
  const render = (txt) => String(txt).indexOf('/*@@GATE_PATH@@*/') >= 0
    ? String(txt).replace("/*@@GATE_PATH@@*/''", JSON.stringify(String(refused)))
    : String(txt).replace(/var __GATE_TARGET = [^;]*;/, 'var __GATE_TARGET = ' + JSON.stringify(String(refused)) + ';');
  // Order matters, and production proved it: deploy/gate-fallback.html IS present in the Vercel
  // artifact (only gate.html is ignored), so any branch that consults it first wins — and it is the
  // dumber of the two screens, a self-contained page that just reloads. Put the rendered one ahead of
  // it and the return-to dies quietly: same 402, same lock, no path. gate.html itself is only worth
  // reading from disk when there is a path to stamp into it.
  const p = path.join(ROOT, 'gate.html');
  if (refused && fs.existsSync(p) && fs.statSync(p).isFile()) return Buffer.from(render(fs.readFileSync(p)));
  if (refused) return Buffer.from(render(EMBED_SCREEN));
  const g = path.join(ROOT, 'deploy/gate-fallback.html');
  if (fs.existsSync(g)) return fs.readFileSync(g);
  return Buffer.from(EMBED_GATE);
}

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

/* The two bodies a Vercel request needs but the deployment does not carry, embedded verbatim.
   deploy/gate-fallback.html and 404.html exist in the repo, yet Vercel's function artifact is the traced
   import graph — __dirname is /var/task and there is no deploy/ beside it, so reading either file at
   runtime throws ENOENT inside the handler. That is how a working paywall ended up answering
   `500 {"error":"Gate failed closed: ENOENT …gate-fallback.html"}` to the very visitor who should be
   shown the lock screen and a buy link.

   The file remains the source of truth (dev and Cloudflare read it from disk, preferring it when it
   exists, so an edit there is live locally); tools/embed-fallbacks.js regenerates these two constants
   from it, and tests/vercel-entry.js fails if they drift. */
const EMBED_GATE = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Locked · AnnotateTrainer</title>\n<style>\n:root{color-scheme:dark}\nbody{background:#0b0d12;color:#e7ecf3;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;\ndisplay:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}\n.card{max-width:520px;background:#141922;border:1px solid #232b39;border-radius:14px;padding:28px}\n.up{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6d7c92;font-weight:700}\nh1{font-size:21px;margin:8px 0}\np{color:#93a0b4;font-size:13.5px}\ninput{width:100%;box-sizing:border-box;background:#0e131c;border:1px solid #2e3848;color:#e7ecf3;border-radius:9px;padding:11px 13px;font-family:ui-monospace,monospace;font-size:13px}\nbutton{background:#6a5bf0;border:1px solid #7f70ff;color:#fff;border-radius:9px;padding:11px 17px;font-weight:700;cursor:pointer}\n.row{display:flex;gap:8px;margin-top:12px}\na{color:#8b7cff}\n#m{font-size:12px;min-height:18px;color:#6d7c92}\n<\/style>\n</head>\n<body>\n<div class=\"card\">\n  <div class=\"up\">Locked</div>\n  <h1>This practice platform is paid-access</h1>\n  <p>Paste the key from your receipt. The platform catalogue and the guide stay free.</p>\n  <div class=\"row\"><input id=\"k\" placeholder=\"Ab3xK9.7W7KqRmYs0dYbE6fLrT1cPp0.1790000000000\"><button id=\"go\">Unlock</button></div>\n  <p id=\"m\"></p>\n  <p><a href=\"/buy.html\">Pricing</a> · pay by transfer or one-time Litecoin</p>\n</div>\n<script>\nvar go=function(){var k=document.getElementById('k').value.trim();var m=document.getElementById('m');\nm.textContent='checking\\u2026';\nfetch('/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})})\n.then(function(r){return r.json().then(function(j){return{c:r.status,j:j}})})\n.then(function(r){m.style.color=r.c===200?'#57d38b':'#ff6b6b';\nm.textContent=r.c===200?('Accepted - '+(r.j.label||'')+', valid until '+(r.j.until||'')):(r.j.error||'Key rejected.');\nif(r.c===200)setTimeout(function(){location.reload()},700);});};\ndocument.getElementById('go').onclick=go;\ndocument.getElementById('k').addEventListener('keydown',function(e){if(e.key==='Enter')go();});\n<\/script>\n</body>\n</html>";
const EMBED_404 = "<!DOCTYPE html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>Not found — AnnotateTrainer</title><link rel=\"stylesheet\" href=\"css/app.css\"></head>\n<body><div id=\"app-banner\"></div>\n<div class=\"wrap\" style=\"padding-top:90px;text-align:center\">\n  <div class=\"mono\" style=\"font-size:60px;color:var(--violet)\">404</div>\n  <h1>That task was released from the queue.</h1>\n  <p class=\"dim\">Nothing at that path. Which is, coincidentally, the exact experience of a platform going quiet.</p>\n  <div class=\"row\" style=\"justify-content:center\"><a class=\"btn\" href=\"index.html\">Home</a><a class=\"btn ghost\" href=\"queue.html\">Task queue</a></div>\n</div>\n<script src=\"js/storage.js\"><\/script><script src=\"js/app.js\"><\/script><script>App.banner();<\/script>\n</body></html>";
const EMBED_SCREEN = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Unlock AnnotateTrainer</title>\n<link rel=\"stylesheet\" href=\"css/app.css\">\n</head>\n<body>\n<div class=\"wrap\" style=\"padding-top:60px;max-width:560px\">\n  <div class=\"card\" style=\"padding:30px\">\n    <div class=\"row\" style=\"gap:10px;margin-bottom:16px\">\n      <span class=\"logo\" style=\"width:30px;height:30px;border-radius:8px;background:conic-gradient(from 200deg,#8b7cff,#4cc9f0,#8b7cff);display:grid;place-items:center;color:#0b0d12;font-weight:900\">A</span>\n      <b>AnnotateTrainer</b>\n    </div>\n    <h1 style=\"font-size:24px\">Enter your access key</h1>\n    <p class=\"sm dim\">Keys are issued right after payment and look like\n    <code>Ab3xK9.7W7KqRmYs0dYbE6fLrT1cPp0.1790000000000</code> — an id, a signature, an expiry.\n    One key per person, valid for the period you bought. Paste it here once and the site remembers you for\n    that long.</p>\n    <div class=\"row\" style=\"margin:18px 0 8px\">\n      <input id=\"k\" placeholder=\"paste key\" style=\"flex:1;font-family:var(--mono);font-size:13px\">\n      <button class=\"btn\" id=\"go\">Unlock</button>\n    </div>\n    <div id=\"m\" class=\"xs\" style=\"min-height:20px;color:var(--dim)\"></div>\n    <div class=\"hr\"></div>\n    <p class=\"xs dim mb0\">Lost the key? Reply to your purchase receipt — the key is tied to the label on it, so I can\n    reissue it. If you were told you need to \"verify your identity\" or pay an activation fee to get a key, that is not\n    me: no legitimate seller in this industry asks for ID documents or extra fees at the gate.</p>\n  </div>\n  <div class=\"row\" style=\"gap:14px;margin-top:14px;justify-content:center\">\n    <a href=\"buy.html\" class=\"sm\" style=\"color:#8b7cff\">No key yet? See pricing →</a>\n    <a href=\"platforms.html\" class=\"sm dim\">Platform catalogue is free</a>\n    <a href=\"guide.html\" class=\"sm dim\">Free guide</a>\n  </div>\n</div>\n<script src=\"js/access.js\"><\/script>\n<script>\n/* Where to send them once the key works. Unlocking from the 402 screen and landing on the home page is\n   the worst possible follow-through on a payment, so the page that refused the path renders it in here.\n   The token is unmistakable rather than a bare __GATE_TARGET identifier, because the first version used\n   that and String.replace found the mention of it in THIS comment and substituted into the prose. The\n   file also carries no backticks on purpose: tools/embed-fallbacks.js embeds it in api/_gate.js for\n   Vercel, and a backtick there is a syntax error in the paywall. Keep it that way.\n   Anything that is not a same-site relative path is then discarded: an open redirect on the page whose\n   whole job is \"hand me your key\" is not a theoretical problem. */\nvar __GATE_TARGET = /*@@GATE_PATH@@*/'';\nfunction safeTarget(u) {\n  u = String(u || '');\n  if (!u || u.charAt(0) !== '/' || u.charAt(1) === '/') return '';\n  if (/[\\/:?#\\s]/.test(u)) return '';\n  if (!/^[a-z0-9._\\/-]{1,64}\\.(html|json)$/i.test(u)) return '';\n  return u;\n}\nfunction target() {\n  var t = safeTarget(typeof __GATE_TARGET === 'string' ? __GATE_TARGET : '');\n  if (t) return t;\n  var q = (location.search || '').match(/[?&]next=([^&]+)/);\n  if (q) { try { t = safeTarget(decodeURIComponent(q[1])); } catch (e) { t = ''; } }\n  // No target means we are being looked at directly, not rendered as somebody's refusal: reloading the\n  // current URL is then the honest answer (it IS the paid page on a 402 render), and only a cold visit\n  // to gate.html itself falls through to the workspace. Landing on the home page after paying for\n  // access was the defect that made this function necessary.\n  return t || (location.pathname.indexOf('gate.html') >= 0 ? 'queue.html' : '');\n}\nvar go = function () {\n  var m = document.getElementById('m'); m.textContent = 'checking…'; m.style.color = 'var(--dim)';\n  Access.unlock(document.getElementById('k').value, function (ok, msg) {\n    m.textContent = msg; m.style.color = ok ? 'var(--ok)' : 'var(--bad)';\n    if (ok) { var t = target(); setTimeout(function () { if (t) location.href = t; else location.reload(); }, 800); }\n  });\n};\n/* The front page posts a key here as ?k= so a visitor with one on their clipboard does not have to\n   retype 60 characters. Keys in URLs land in history and in any log that records full paths, so it is\n   filled into the field and then scrubbed from the address bar before anything else runs — the key lives\n   in the input, not in the location. */\n(function () {\n  var m = (location.search || '').match(/[?&]k=([^&]+)/); if (!m) return;\n  var v = ''; try { v = decodeURIComponent(m[1]); } catch (e) { v = m[1]; }\n  var f = document.getElementById('k'); if (f && !f.value) f.value = v.trim();\n  if (history && history.replaceState) { try { history.replaceState(null, '', location.pathname); } catch (e) { } }\n})();\ndocument.getElementById('go').onclick = go;\ndocument.getElementById('k').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });\n<\/script>\n</body>\n</html>";

// The paid corpus, served as an empty stub instead of the real file — the same choice the Supabase and
// Cloudflare variants make. Kept inline because the real file is NOT DEPLOYED (see .vercelignore), so
// there is nothing on disk to withhold here.
const STUB_JS = {
  '/js/tasks.js': 'window.Tasks={list:function(){return[]},get:function(){return null},count:0};window.POLICY={};',
  '/js/detector.js': 'window.Detector={analyze:function(){return{index:null,locked:true,features:[],tips:[]}}};'
};

/** The `next()` a Pages function expects: serve from disk, or the mirror, or 404 — never ungated. */
async function nextHandler(request, srcReq) {
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
      // Reaching here means the gate ALREADY accepted this request (the stub-for-no-key branch lives in
      // the Cloudflare module), so a mirror may answer. Without this, /js/tasks.js stayed 402 with the
      // empty stub for a paid subscriber on Vercel while /task.html served fine one line later — the
      // corpus is the product, so a key-holder with a shell and no data has bought nothing.
      if (MIRROR_ORIGIN) {
        const m = await fromMirror(rel, srcReq);
        if (m) return m;
      }
      return { status: 402, body: Buffer.from(STUB_JS[rel] || 'window.__locked=true;'), type: TYPES['.js'], cache: 'no-store' };
    }
    // Prefer the deployed copy (dev, Cloudflare); on Vercel it is not in the artifact, hence EMBED_GATE.
    // Nothing on disk, but this path is the product: if the gate let it through, ask the origin that
    // actually holds the bytes. It re-applies its own 402 to the same cookie, so this cannot serve a
    // file to a visitor the Vercel copy merely failed to classify.
    if (MIRROR_ORIGIN) {
      const m = await fromMirror(rel, srcReq);
      if (m) return m;
    }
    return { status: 402, body: gateScreen(rel), type: TYPES['.html'], cache: 'no-store' };
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
      const out = (u.pathname === '/gate.html' && r.status !== 200)
        ? { status: 200, body: gateScreen(), type: TYPES['.html'] }
        : r;
      return new Response(out.body, { status: out.status, headers: { 'content-type': out.type, 'cache-control': out.cache || 'no-store' } });
    }
    return fetch(req);
  };
}

const LOAD_ERRORS = [];
function storeErr(m) { LOAD_ERRORS.push(m); }

module.exports = { EMBED_GATE, EMBED_404, EMBED_SCREEN, gateScreen, loadGate, originalPath, nextHandler, fromMirror, MIRROR_ORIGIN, makeFetch, TYPES, ROOT, PREFIX, LOAD_ERRORS };
