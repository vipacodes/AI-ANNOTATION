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
const { loadGate, nextHandler, makeFetch, GATE_BUILD } = require('./_gate.js');

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
    const reqUrl = req.url || '/';
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
      const r = await nextHandler({ url: path, headers: { 'x-invoke-path': path } }, request);
      // x-annotate-build is the "which artifact is this" header; it is deliberately on every reply from
      // nextHandler (the 402s and the mirrored 200s), which is exactly the set of paths I can only
      // observe from outside. No secret, no version of anything the owner has to keep private.
      const h = { 'content-type': r.type, 'cache-control': r.cache || 'no-store', 'x-annotate-build': GATE_BUILD };
      return new Response(r.body, { status: r.status, headers: h });
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

    // Stamped on EVERY reply the function produces, because the .html 402 is assembled inside the gate
    // (its context.fetch of gate.html) and therefore never passes through nextHandler — a header set
    // only there was missing from exactly the response I needed to identify.
    try { res.setHeader('x-annotate-build', GATE_BUILD); } catch (e) { /* headers already sent: nothing to do */ }
    // ONE render point. The lock screen can be assembled four ways — the gate's own inline copy, a
    // context.fetch of the deployed gate.html, the file read by nextHandler, or the shipped fallback — and
    // stamping inside each of them turned into a fight over which branch ran first, with an unstamped
    // screen winning locally (gate.html exists) and a different one winning on Vercel (it does not). So:
    // anything leaving this function that still carries the sentinel gets the refused path written into
    // it, no matter who built it. Buffered only for that one case, so a normal page streams untouched.
    // The lock screen is rendered in one place, for both shapes of it: a refusal of a paid page stamps
    // the path that was refused, and the gate page itself stamps the ?next= it was linked with. Both
    // need stamping because the file served for /gate.html is the bucket/disk copy, which carries the
    // sentinel and nothing else — and a screen that knows the path is the difference between "unlock and
    // you are back where you were" and "unlock and you are on the marketing page again".
    const htmlish = /text\/html/.test(response.headers.get('content-type') || '');
    const isLock = (response.status === 402 && path !== '/gate.html') ||
      (response.status === 200 && path === '/gate.html');
    // Buffer once, up front: `await response.text()` consumed the stream and every later
    // response.arrayBuffer() then threw "Body is unusable" — which the fail-closed catch turned into a
    // 500 on exactly the lock screen. Read the body a single time and hand out pieces of it.
    let outText = null;
    let outBuf = null;
    if (response.body) outBuf = Buffer.from(await response.arrayBuffer());
    if (htmlish && isLock && outBuf) {
      const text = outBuf.toString('utf8');
      if (text.indexOf('@@GATE_PATH@@') >= 0 || /var __GATE_TARGET\s*=/.test(text)) {
        let target = path;
        if (path === '/gate.html') {
          const q = (new URLSearchParams(reqUrl.slice(reqUrl.indexOf('?') + 1)).get('next') || '').trim();
          // Same rule gate.html applies client-side: single slash, no scheme, no protocol-relative
          // double slash, and no query of its own. Anything else becomes '' and the screen reloads.
          // one leading slash, never two, no scheme colon, no query/hash — `//evil.example` is
          // protocol-relative and would leave the site with the key in hand, and `/a/../../etc` is out
          // anyway because dots are only allowed inside a segment, never as a whole one.
          target = /^\/[\w.-]+(\/[\w.\/-]*)?$/.test(q) && q.indexOf(':') < 0 ? q : '';
          // ^ one leading slash, no second one, no scheme colon, no query: `//evil.example` is
          // protocol-relative and would leave the site with the key in hand. gate.html re-checks the
          // same shape client-side, so a stamp that slips through here is still refused there.
        }
        const lit = JSON.stringify(target);
        outText = text.indexOf('/*@@GATE_PATH@@*/') >= 0
          ? text.replace("/*@@GATE_PATH@@*/''", lit)
          : text.replace(/var __GATE_TARGET\s*=\s*[^;]*;/, 'var __GATE_TARGET = ' + lit + ';');
      }
    }

    // Content type is decided HERE, by the path, not inherited from the origin. The mirror's bytes come
    // from a Supabase Edge Function, and Supabase rewrites every GET that returns text/html into
    // text/plain (+ nosniff) unless you are on Pro with a custom domain — documented at
    // supabase.com/docs/guides/functions/limits. So a legitimately unlocked paid page arrived at the
    // browser as a plain-text listing of its own markup: "why is the page showing html codes". The
    // bytes were always fine; the label was not. Vercel has no such rule, so we own the label.
    const EXT_TYPE = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
    };
    const typedByExt = EXT_TYPE[(path.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()] || '';
    if (typedByExt) response.headers.set('content-type', typedByExt);

    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      // A stamped body is a different length from the one the gate measured. Rather than send a
      // content-length that does not match (truncated page, half a lock screen), drop it: node will
      // chunk-encode, and correctness of the page beats a byte-count optimisation.
      if (outText !== null && k.toLowerCase() === 'content-length') return;
      if (typedByExt && k.toLowerCase() === 'x-content-type-options') return;   // our type, our word
      res.setHeader(k, v);
    });
    if (outText !== null) return res.end(Buffer.from(outText, 'utf8'));
    if (outBuf) return res.end(outBuf);
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
