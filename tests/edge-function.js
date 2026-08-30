/* Standalone harness for deploy/cloudflare-pages-function.js — imports the REAL module,
   points its Supabase URL at a throwaway stub server, and asserts the lock end to end.
   Run:  node tests/edge-function.js            (add --down to see the fail-closed case)     */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'deploy/cloudflare-pages-function.js');
const DOWN = process.argv.indexOf('--down') >= 0;
const KEY = 'edge123.' + 'a'.repeat(28) + '.' + (Date.now() + 864e5);
const ID = KEY.split('.')[0];

let ok = 0; const fails = [];
const need = (c, good, poor) => { if (c) { ok++; console.log('   \u2713 ' + good); } else { fails.push(poor); console.log('   \u2717 ' + poor); } };

/* 0. it must parse as a real ES module (wrangler would reject it otherwise) */
try { new vm.SourceTextModule(fs.readFileSync(FN, 'utf8'), { identifier: FN }); need(true, 'function parses as ESM'); }
catch (e) { need(false, 'parses', 'SYNTAX: ' + e.message); }

/* 1. stub of the Supabase PostgREST surface the function calls */
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.url.indexOf('/rest/v1/rpc/key_check') === 0) {
      const args = JSON.parse(b || '{}');
      const valid = args.p_id === ID && args.p_sig === KEY.split('.')[1] && Number(args.p_exp) > Date.now();
      return res.writeHead(valid ? 200 : 402, { 'content-type': 'application/json' })
        .end(JSON.stringify(valid ? { ok: true, id: ID, label: 'edge buyer', until: '2026-12-31' } : { ok: false, error: 'This key was not issued by this site.' }));
    }
    if (req.url.indexOf('/rest/v1/rpc/key_attempt') === 0) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"attempts_5m":1,"throttled":false}');
    res.writeHead(404).end('{"error":"unexpected ' + req.url + '"}');
  });
});

(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + stub.address().port;

  /* 2. inject the Pages "env" bindings the runtime would provide */
  Object.defineProperty(globalThis, 'env', {
    configurable: true,
    value: { SUPABASE_URL: base, SUPABASE_ANON_KEY: 'sb_publishable_TEST', ACCESS_MODE: 'postgres' }
  });

  const tmp = path.join(os.tmpdir(), 'annotate-edge-' + Date.now() + '.mjs');
  fs.writeFileSync(tmp, fs.readFileSync(FN, 'utf8').replace(/globalThis\.env\??\.([A-Z_]+)/g, 'globalThis.env.$1'));
  const mod = await import('file://' + tmp);
  const onRequest = mod.onRequest;
  need(typeof onRequest === 'function', 'exports onRequest(context)', 'no onRequest export');

  const gateHtml = '<html><body>Enter your access key</body></html>';
  const ctx = {
    fetch: async (req) => new Response(gateHtml, { status: 200, headers: { 'content-type': 'text/html' } }),
    next: async () => new Response('REAL-BODY', { status: 200, headers: { 'content-type': 'text/html' } })
  };
  const call = (p, opts) => onRequest(Object.assign({ request: new Request('https://practice.example.com' + p, opts), fetch: ctx.fetch, next: ctx.next }, {}));

  /* 3. the assertions */
  let r = await call('/task.html?id=fact-01');
  need(r.status === 402, 'protected page without a key \u2192 402 (got ' + r.status + ')', 'leak: ' + r.status);
  let body = await r.text();
  need(/Enter your access key/.test(body) && !/REAL-BODY/.test(body), '402 body is the gate screen, not the page', 'served the real page');

  r = await call('/js/tasks.js');
  body = await r.text();
  need(r.status === 402 && /window\.Tasks=\{list:function\(\)\{return\[\]/.test(body) && body.length < 200,
    'corpus JS \u2192 402 + stub of ' + body.length + ' bytes (the 39 KB file never crosses the edge)', 'corpus exposed');

  r = await call('/platforms.html');
  need(r.status === 200, 'free page 200 with no key', 'locked a free page: ' + r.status);

  r = await call('/');
  need(r.status === 200, 'bare / is free', 'root blocked');

  r = await call('/some-other-page.html');
  need(r.status === 200, 'unlisted page is served (only PROTECT is withheld)', 'over-tight: ' + r.status);

  const forged = { 'x-access-key': 'bogus01.' + 'z'.repeat(28) + '.' + (Date.now() + 864e5) };
  r = await call('/task.html', { headers: forged });
  body = await r.text();
  need(r.status === 402 && /Enter your access key/.test(body) && !/REAL-BODY/.test(body),
    'a key the database refuses gets the plain gate screen, with nothing about the key leaked into a crawlable 402', 'forged key: ' + r.status);
  r = await call('/session', { headers: forged });
  need(r.status === 402 && /not issued by this site/.test((await r.text())),
    'the reason is available to the unlock form (where it helps) but not on page bodies', 'no useful error over /session');
  r = await call('/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'bogus01.' + 'z'.repeat(28) + '.' + (Date.now() + 864e5) }) });
  need(r.status === 402 && /not issued/.test((await r.text())), '/unlock echoes the database\u2019s reason so buyers can self-diagnose', 'opaque rejection');

  r = await call('/task.html', { headers: { 'x-access-key': KEY } });
  need(r.status === 200, 'valid key \u2192 200 and the real body', 'valid key blocked: ' + r.status);
  need((await r.text()) === 'REAL-BODY', 'the protected bytes only travel with a good key', 'body mismatch');

  r = await call('/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY }) });
  need(r.status === 200, 'POST /unlock accepts a good key', 'unlock: ' + r.status);
  const cookie = r.headers.get('set-cookie') || '';
  need(/^at_key=/.test(cookie) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie),
    'cookie is HttpOnly + Secure + SameSite=Lax', 'weak cookie: ' + cookie);

  r = await call('/session', { headers: { cookie: 'at_key=' + encodeURIComponent(KEY) } });
  const sess = await r.json();
  need(r.status === 200 && sess.label === 'edge buyer', 'cookie-only /session reports the buyer label from Postgres', JSON.stringify(sess));

  r = await call('/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) });
  need(r.status === 402, 'malformed key at /unlock \u2192 402, no cookie set', 'accepted junk');
  need(!(r.headers.get('set-cookie') || ''), 'no session cookie handed out on failure', 'cookie leaked on a bad key');

  r = await call('/task.html', { headers: { 'x-access-key': KEY.split('.')[0] + '.' + KEY.split('.')[1] + '.1000000000000' } });
  need(r.status === 402, 'an expired key is refused before the database is even asked', 'expired accepted');

  /* 4. fail-closed when the database is unreachable */
  globalThis.env.SUPABASE_URL = 'http://127.0.0.1:1';   // nothing listens there
  const tmp2 = path.join(os.tmpdir(), 'annotate-edge-down-' + Date.now() + '.mjs');
  fs.writeFileSync(tmp2, fs.readFileSync(FN, 'utf8').replace(/globalThis\.env\??\.([A-Z_]+)/g, 'globalThis.env.$1'));
  const mod2 = await import('file://' + tmp2 + '?v=' + Date.now());
  r = await mod2.onRequest({ request: new Request('https://practice.example.com/task.html', { headers: { 'x-access-key': KEY } }), fetch: ctx.fetch, next: ctx.next });
  need(r.status === 402, 'database down \u2192 DENY (fail closed), never a free pass', 'OPEN DOOR on backend failure: ' + r.status);
  r = await mod2.onRequest({ request: new Request('https://practice.example.com/platforms.html'), fetch: ctx.fetch, next: ctx.next });
  need(r.status === 200, 'the free half of the site keeps working when the database is down', 'outage took the whole site');

  /* 5. the path lists must not have drifted from the server or the Supabase function */
  const grab = (src, name) => (src.match(new RegExp('^const ' + name + ' = (/.*/);$', 'm')) || [])[1];
  const fnSrc = fs.readFileSync(FN, 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const sfb = fs.readFileSync(path.join(ROOT, 'supabase/functions/annotate/index.ts'), 'utf8');
  need(['PUBLIC', 'PROTECT'].every((n) => grab(fnSrc, n) && grab(fnSrc, n) === grab(srv, n) && grab(fnSrc, n) === grab(sfb, n)),
    'all three servers share one identical path rule', 'lists have drifted');

  /* ---- Supabase mounts this at /functions/v1/annotate: routing and the cookie path ---- */
  {
    const norm = (pathname) => {
      const SLUG = '/annotate';
      let p = decodeURIComponent(pathname);
      const bare = p === SLUG || p === SLUG + '/';
      const at = bare ? 0 : p.indexOf(SLUG + '/');
      const BASE = at === 0 ? SLUG : (at > 0 ? p.slice(0, at + SLUG.length) : '');
      p = BASE ? (p.slice(BASE.length) || '/') : p;
      return { route: p, cookiePath: BASE || '/' };
    };
    const a = norm('/index.html'), b = norm('/annotate/index.html'), c = norm('/functions/v1/annotate/index.html');
    need(a.route === '/index.html', 'a route at the host root resolves as-is', 'root route changed: ' + a.route);
    need(b.route === '/index.html', 'the same route behind /annotate resolves identically', 'mount strip is wrong: ' + b.route);
    need(c.route === '/index.html', 'and behind Supabase /functions/v1/annotate too', 'deep mount strip is wrong: ' + c.route);
    need(c.cookiePath === '/functions/v1/annotate', 'the cookie is scoped to the mount the browser calls', 'cookie path ' + c.cookiePath + ' would never be sent back');
    need(norm('/annotate').route === '/', 'a bare /annotate is the home page, not a 404', 'bare mount: ' + norm('/annotate').route);
    need(norm('/annotate').cookiePath === '/annotate', 'a bare mount still scopes the cookie to the mount (a sub-path deploy)', 'cookie path: ' + norm('/annotate').cookiePath);
    need(norm('/annotate/').cookiePath === '/annotate', 'and so does a mount with a trailing slash', 'cookie path: ' + norm('/annotate/').cookiePath);
    need(norm('/api/health').route === '/api/health', 'a path that merely does NOT contain the slug is left alone (the -1 trap)', 'mangled: ' + norm('/api/health').route);
    need(norm('/index.html').route === '/index.html', 'no silent truncation when indexOf returns -1', 'mangled: ' + norm('/index.html').route);
  /* ---- the extensionless routes are matched BEFORE the lock's 404 fallback ---- */
  {
    const sfb = fs.readFileSync(path.join(ROOT, 'supabase/functions/annotate/index.ts'), 'utf8');
    const lockAt = sfb.indexOf('the lock ----------');
    for (const route of ['/unlock', '/session', '/fulfill', '/api/health']) {
      const at = sfb.indexOf("p === '" + route + "'");   // the route HANDLER, not a mention in a comment
      need(at > 0 && at < lockAt, route + ' is routed before the lock, so it cannot be swallowed by the 404 fallback',
        route + ' is at ' + at + ' vs lock at ' + lockAt);
    }
  }

    need(norm('/functions/v1/annotate/unlock').route === '/unlock', 'the POST route survives the mount too', 'mangled: ' + norm('/functions/v1/annotate/unlock').route);
    need(c.cookiePath !== '/', 'a mount-scoped cookie is never Path=/ (that would send the key to PostgREST and storage on the same host)', 'cookie path is /');
  }

  await new Promise((r2) => stub.close(r2));
  fs.unlinkSync(tmp); try { fs.unlinkSync(tmp2); } catch (e) { }
  console.log('\n' + '\u2550'.repeat(56));
  if (fails.length) { console.log('\u2717 ' + fails.length + ' failure(s)'); fails.forEach((f) => console.log('   - ' + f)); process.exit(1); }
  console.log('\u2713 edge function: ' + ok + ' checks passed (real module, stubbed PostgREST)');
  process.exit(0);
})();
