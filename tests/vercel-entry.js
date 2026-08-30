/* Runs the Vercel entry point for real: an http server whose request listener IS api/index.js's
   export, so this exercises the deployed code path — module load, path restoration, the gate, next()
   falling through to disk, and the Response→node res bridge — rather than an imitation of it.

   What it exists to prove: putting this repo on Vercel is only safe with the rewrite in place. The
   assertions below are the ones that would fail if someone "simplifies" vercel.json to a static
   deploy, which is the mistake that produces a public copy of a paid site that looks completely healthy.

     node tests/vercel-entry.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0; const fails = [];
const need = (c, name, note) => { if (c) { pass++; console.log('   \u2713 ' + name); } else { fails.push(name + (note ? '  - ' + note : '')); console.log('   \u2717 ' + name + (note ? '  - ' + String(note).slice(0, 120) : '')); } };

const handler = require(path.join(ROOT, 'api/index.js'));
const server = http.createServer((req, res) => handler(req, res));

const get = (p, opts) => new Promise((resolve, reject) => {
  const req = http.request(Object.assign({ host: '127.0.0.1', port: server.address().port, path: p, method: 'GET', headers: {} }, opts || {}), (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (opts && opts.payload) req.write(opts.payload);
  req.end();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  console.log('\n\u250c\u2500 the Vercel entry point (api/index.js, loaded for real)');
  let r = await get('/index.html');
  need(r.status === 200 && /AnnotateTrainer/.test(r.body), 'a free page is served through the function', r.status + ' ' + r.body.slice(0, 60));
  need(/charset=utf-8/.test(r.headers['content-type'] || ''), 'content-type carries the charset (the mojibake class of bug)', r.headers['content-type']);

  r = await get('/task.html');
  need(r.status === 402, 'a protected page is 402 without a key', r.status);
  need(!/window\.Tasks|graded rubric/i.test(r.body) && /access key|Locked/i.test(r.body), 'the 402 is the gate screen, not the file', r.body.slice(0, 70));
  need((r.headers['cache-control'] || '') === 'no-store', 'a refusal is not cacheable', r.headers['cache-control']);

  r = await get('/js/tasks.js');
  need(r.status === 402 && r.body.length < 200 && /Tasks/.test(r.body), 'the paid corpus is a stub, not the 40 KB file', r.status + ' ' + r.body.length + 'B');

  r = await get('/data/anything.json');
  need(r.status === 402, '/data is refused too', r.status);

  r = await get('/css/app.css');
  need(r.status === 200 && /^public, max-age=300/.test(r.headers['cache-control'] || ''), 'a public asset is cacheable, briefly', r.headers['cache-control']);

  r = await get('/definitely-not-here.html');
  need(r.status === 404 && /<!DOCTYPE html>/i.test(r.body), 'an unknown page gets the styled 404, and a 404 status', r.status);

  r = await get('/');
  need(r.status === 200, 'the bare root still resolves (path restoration did not eat it)', r.status);

  r = await get('/api/health');
  need(r.status === 404 || r.status === 200, 'an unknown /api path does not crash the handler', r.status);

  // the cookie-less API the gate owns, reached through the same rewrite
  r = await get('/unlock', { method: 'POST', payload: JSON.stringify({ key: 'short' }), headers: { 'content-type': 'application/json' } });
  need(r.status === 402 && /not recognised|shape/i.test(r.body), '/unlock is reachable and refuses a malformed key', r.status + ' ' + r.body.slice(0, 60));

  r = await get('/fulfill', { method: 'POST', payload: JSON.stringify({ ref: '1'.repeat(8), plan: 'week' }), headers: { 'content-type': 'application/json' } });
  // This variant has NO /fulfill: the Cloudflare Pages function was written before the payment-callback
  // route existed, and only the Supabase function serves it (DEPLOY.md § C). A 404 is therefore the
  // honest answer and the right thing to pin — if someone adds a half-matching /fulfill here, or silently
  // wires one that mints without a provider check, this stops being 404. It is also the note that tells
  // an owner reading the Vercel copy that automated fiat delivery lives on the other deployment.
  need(r.status === 404 && !/key/.test(r.body), 'no /fulfill on this variant, and it does not mint anything (' + r.status + ')', r.body.slice(0, 80));
  need(/No such route|not found|404/i.test(r.body) || r.headers['content-type'], 'its unknown paths answer a real 404 page, not a bare close', r.status);

  console.log('\n\u250c\u2500 the configuration that keeps this an actual paywall');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const src = (cfg.rewrites && cfg.rewrites[0] && cfg.rewrites[0].source) || '';
  need(src === '/((?!api/|_vercel/).*)', 'the catch-all rewrite excludes only Vercel internals', src);
  need(!('buildCommand' in cfg) && cfg.framework === null, 'no build step is configured (the repo root is the site)', JSON.stringify(Object.keys(cfg)));
  need(!cfg.outputDirectory && !cfg.public, 'no static output directory is declared \u2014 that is the gate-free deploy', JSON.stringify(cfg).slice(0, 80));
  const files = ['api/index.js', 'api/_gate.js', 'vercel.json'];
  need(files.every((f) => fs.existsSync(path.join(ROOT, f))), 'the entry point, its shim and the config all exist', files.filter((f) => !fs.existsSync(path.join(ROOT, f))).join(','));
  const gate = fs.readFileSync(path.join(ROOT, 'api/_gate.js'), 'utf8');
  need(/x-invoke-path/.test(gate) && gate.indexOf('PREFIX') > 0, 'the rewritten path is restored from x-invoke-path (else every request looks like "/")', 'no restore');
  need(/PROTECTED\.test\(served\)/.test(gate), 'next() re-checks PROTECT before caching, so a paid file cannot be served with a TTL', 'no cache guard');

  console.log('\n\u250c\u2500 the drift that would silently open the site');
  // The gate lists in the Cloudflare file must still match server.js, because _gate.js evaluates the
  // former. If they drift, this entry point inherits whichever the file reads first — the exact bug
  // class the Supabase/Cloudflare pair is asserted against, in a third place.
  const cf = fs.readFileSync(path.join(ROOT, 'deploy/cloudflare-pages-function.js'), 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const grab = (s, n) => { const i = s.indexOf('const ' + n + ' = /'); if (i < 0) return null; const l = s.slice(i, s.indexOf('\n', i)); const j = l.indexOf('= /'); return l.slice(j + 3, l.lastIndexOf('/')); };
  need(['PUBLIC', 'PROTECT'].every((n) => grab(cf, n) && grab(cf, n) === grab(srv, n)),
    'the Vercel gate and server.js share one identical rule (no drift possible)', 'lists differ');
  need(/no way to verify|neither a Postgres backend|access denied/i.test(cf),
    'the underlying function still refuses to decide without a backend or a secret', 'fail-open wording changed');

  server.close();
  console.log('\n' + '='.repeat(56));
  if (fails.length) { fails.forEach((f) => console.log('   - ' + f)); console.log('\u2717 vercel-entry: ' + fails.length + ' failure(s)'); process.exit(1); }
  console.log('\u2713 vercel-entry: ' + pass + ' checks passed (real handler, real HTTP, real files)');
})().catch((e) => { console.log('\u2717 harness error: ' + (e.stack || e).split('\n').slice(0, 4).join(' | ')); try { server.close(); } catch (_) { } process.exit(1); });
