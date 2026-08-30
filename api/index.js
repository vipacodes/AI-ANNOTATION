/* Vercel entry point: one serverless function behind a catch-all rewrite, holding the same lock the
   Cloudflare and Supabase deployments hold. See api/_gate.js for why this shape exists.

   THIS IS THE ONLY SAFE WAY TO PUT THIS REPO ON VERCEL. Vercel will happily deploy it as a static
   site and serve every file in the repository at a public URL, gate-free — task.html, js/tasks.js, the
   whole paid corpus, and it would look like a success. Rewriting everything to this function means a
   request only reaches a file through nextHandler, which the gate has already decided about.

   Config it reads (Settings → Environment Variables; none required for the live backend, which is
   the function's own default):
     SUPABASE_URL        defaults to the project the site was built for
     SUPABASE_ANON_KEY   required for the gate to verify keys at all — without it the site answers
                         503/402 rather than opening, which is the correct failure
     SITE_BASE           leave unset at a Vercel root mount */
'use strict';
const { loadGate, nextHandler, makeFetch } = require('./_gate.js');

// loadGate is async: it may resolve the gate through a dynamic import (the only route a bundler can
// follow), and awaiting it once at module load keeps the request path synchronous.
let onRequest = null;
const ready = loadGate().then((fn) => { onRequest = fn; return fn; }, (e) => {
  // Never let a rejected import take the process down: the handler below turns this into a 500 with
  // the reason, which is diagnosable, where an unhandled rejection is just "FUNCTION_INVOCATION_FAILED".
  console.error('[gate] load failed:', e && e.stack || e);
  return null;
});

module.exports = async function vercelHandler(req, res) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'vercel';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const path = require('./_gate.js').originalPath(req);
    const url = proto + '://' + host + path + (req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : '');

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, { method: req.method || 'GET', headers, body });

    // `return next()` in the gate is unawaited, so it must be handed a real Response and not the plain
    // object nextHandler returns for internal use; an awaited undefined is how every free page turned
    // into a 500 the first time this ran.
    const next = async () => {
      const r = await nextHandler({ url: path, headers: { 'x-invoke-path': path } });
      return new Response(r.body, {
        status: r.status, headers: { 'content-type': r.type, 'cache-control': r.cache || 'no-store' }
      });
    };
    if (!onRequest) await ready;
    if (!onRequest) {
      res.statusCode = 503; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store');
      return res.end(JSON.stringify({ error: 'Gate failed to load on this runtime; nothing served.' }));
    }
    const response = await onRequest({ request, env: process.env, next, fetch: makeFetch(proto + '://' + host) });
    if (!response || typeof response.status !== 'number') {
      // Never fall open. If the gate returns something unrecognised, answer 500 rather than letting
      // Vercel's static serving take over the request — that is precisely the gate-free deploy.
      res.statusCode = 500; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store');
      return res.end(JSON.stringify({ error: 'Gate returned no response; nothing served.' }));
    }

    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      return res.end(buf);
    }
    return res.end();
  } catch (e) {
    // A throw here is what the "no handler exported" deploy turned into a Vercel-branded 500 page.
    // Keep the failure visible but attributable, and never fall open: on error we serve nothing.
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    return res.end(JSON.stringify({ error: 'Gate failed closed: ' + String((e && e.message) || e).slice(0, 200) }));
  }
};
