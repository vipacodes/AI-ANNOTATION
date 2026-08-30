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

/** Evaluate the gate module and return its onRequest. */
function loadGate() {
  const src = fs.readFileSync(FN, 'utf8').replace(/^export\s+async\s+function\s+onRequest/m, 'async function onRequest');
  // The Cloudflare file reads config as `globalThis.env.X`; on Vercel's Node runtime that is
  // process.env. One assignment, and the gate's own precedence (env wins, else the live project URL)
  // is untouched — including its refusal to verify anything when it has neither a backend nor a secret.
  globalThis.env = Object.assign({}, process.env);
  const fn = new Function(src + '\nreturn { onRequest };');
  return fn().onRequest;
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
    const g = path.join(ROOT, 'deploy/gate-fallback.html');
    const body = fs.existsSync(g) ? fs.readFileSync(g) : Buffer.from('<!DOCTYPE html><title>Locked</title><p>Paid access required.</p>');
    return { status: 402, body, type: TYPES['.html'], cache: 'no-store' };
  }
  if (!file) {
    const nf = path.join(ROOT, '404.html');
    return { status: 404, body: fs.existsSync(nf) ? fs.readFileSync(nf) : Buffer.from('not found'), type: TYPES['.html'] };
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
        ? { status: 200, body: fs.readFileSync(path.join(ROOT, 'deploy/gate-fallback.html')), type: TYPES['.html'] }
        : r;
      return new Response(out.body, { status: out.status, headers: { 'content-type': out.type, 'cache-control': out.cache || 'no-store' } });
    }
    return fetch(req);
  };
}

module.exports = { loadGate, originalPath, nextHandler, makeFetch, TYPES, ROOT, PREFIX };
