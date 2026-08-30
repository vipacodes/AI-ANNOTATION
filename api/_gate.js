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

const ROOT = path.join(__dirname, '..');            // the repo root == the Vercel deployment root
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

/** The `next()` a Pages function expects: serve from disk, or 404 — never hand back an ungated page. */
async function nextHandler(request) {
  const p = originalPath(request);
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(ROOT, rel);
  if (abs !== ROOT && abs.indexOf(ROOT + path.sep) !== 0) return { status: 400, body: Buffer.from('bad path'), type: 'text/plain; charset=utf-8' };
  const cands = fs.existsSync(abs) ? [abs] : (/\.[a-z0-9]+$/i.test(abs) ? [] : [abs + '.html']);
  const file = cands.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
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
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.type, 'cache-control': r.cache || 'no-store' } });
    }
    return fetch(req);
  };
}

module.exports = { loadGate, originalPath, nextHandler, makeFetch, TYPES, ROOT, PREFIX };
