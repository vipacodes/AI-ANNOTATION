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

// In --no-fallback mode the parent hands us a scratch tree to stand in for a bundled runtime, and ROOT
// must move with it: the handler resolves its files from here, and an un-redirected ROOT made the first
// version of that check delete the real deploy/gate-fallback.html from the working tree.
const ROOT = (function (av) {
  const i = av.indexOf('--no-fallback') >= 0 ? av.indexOf('--no-fallback') : -1;
  return i >= 0 ? (av[i + 1] || path.join(__dirname, '..')) : path.join(__dirname, '..');
})(process.argv);
// The child that tests the mirror needs to know which origin it was pointed at. Read from the env at
// each use, not a top-level const: the mirror/no-fallback blocks run before that const initialises, and
// a TDZ error is a terrible way to find out your test file has a control-flow assumption in it.
const mirrorTestEnv = () => process.env.ANNOTATE_MIRROR || '';
let pass = 0; const fails = [];
const need = (c, name, note) => { if (c) { pass++; console.log('   \u2713 ' + name); } else { fails.push(name + (note ? '  - ' + note : '')); console.log('   \u2717 ' + name + (note ? '  - ' + String(note).slice(0, 120) : '')); } };

const handler = require(path.join(ROOT, 'api/index.js'));
const server = http.createServer((req, res) => handler(req, res));

/* A second server whose ROOT is a throwaway copy of the repo with .vercelignore applied — i.e. what
   actually exists on Vercel's filesystem. Without this, every assertion below reads files from the
   working tree and reports a paywall that is really only a routing preference, which is precisely the
   thing Vercel documents it will NOT guarantee ("precedence is given to the filesystem prior to
   rewrites being applied"). This is the phase that would have caught my own vercel.json design. */
const fsx = require('fs');
const os = require('os');
function readIgnore() {
  const f = path.join(ROOT, '.vercelignore');
  if (!fsx.existsSync(f)) return [];
  return fsx.readFileSync(f, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
function buildDeployCopy() {
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'vercel-deploy-'));
  const ign = readIgnore();
  const walk = (rel) => {
    for (const e of fsx.readdirSync(path.join(ROOT, rel || '.'), { withFileTypes: true })) {
      const r = (rel ? rel + '/' : '') + e.name;
      if (ign.some((g) => g === r || (g.endsWith('/') && r.startsWith(g)) || r === g.replace(/\/$/, ''))) continue;
      if (e.isDirectory()) { if (['node_modules', '.git', 'data'].indexOf(e.name) < 0 || rel !== '') { try { walk(r); } catch (_) { } } continue; }
      if (!e.isFile()) continue;
      if (ign.indexOf(r) >= 0) continue;
      const dst = path.join(dir, r);
      fsx.mkdirSync(path.dirname(dst), { recursive: true });
      fsx.copyFileSync(path.join(ROOT, r), dst);
    }
  };
  walk('');
  return { dir, ign };
}

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


  // This file's whole reason to exist is catching what only a REAL deploy shows. The last such bug:
  // Vercel's function artifact is the traced import graph, so /var/task has no deploy/ directory and the
  // 402 body read threw ENOENT — a 500 to the one visitor who should have seen a lock screen and a buy
  // link. So: run the handler again over a copy with the fallback files deleted, which is the bundle's
  // actual shape, and assert the embedded copies answer instead.
  if (process.argv.indexOf('--no-fallback') >= 0) {
    // ROOT is redirected to the scratch copy the parent hands us: deleting inside the real working tree
    // to simulate a bundle would have been the second-worst way to find this bug. (The first attempt
    // did exactly that, and `git checkout` put the file back.)
    const BUNDLE = ROOT;
    const gone = [];
    for (const f of ['deploy/gate-fallback.html', '404.html', 'gate.html']) {
      const abs = path.join(BUNDLE, f);
      if (fs.existsSync(abs)) { fs.rmSync(abs); gone.push(f); }
    }
    need(gone.length >= 2, 'fixture: the fallback files really are absent from this copy', gone.join(','));
    let x = await get('/task.html');
    need(x.status === 402 && /placeholder=/i.test(x.body) && /Unlock/i.test(x.body) && /<form|<button/i.test(x.body),
      'PROTECTED page still renders the full lock screen with no deploy/gate-fallback.html on disk',
      x.status + ' ' + x.body.slice(0, 90));
    need(x.status === 402 && !/ENOENT/.test(x.body), 'no ENOENT leak from the missing file', x.body.slice(0, 90));
    x = await get('/nothing-at-all-here');
    need(x.status === 404 && /<!DOCTYPE html>/i.test(x.body) && x.body.length > 200,
      'unknown path still gets the styled 404 from the embedded copy, not "not found"',
      x.status + ' ' + x.body.length + 'B ' + x.body.slice(0, 40));
    server.close();
    console.log('\n' + '='.repeat(56));
    if (fails.length) { fails.forEach((f2) => console.log('   - ' + f2)); console.log('\u2717 no-fallback: ' + fails.length + ' failure(s)'); process.exit(1); }
    console.log('\u2713 no-fallback: the embedded bodies carry the lock screen and the 404 (3 checks)');
    return;
  }


  // The mirror path: .vercelignore removes the paid corpus from the deployment, so an AUTHENTICATED
  // Vercel visitor had nothing to be served and got the lock screen they had just paid past. This runs
  // the real handler with ANNOTATE_MIRROR set, against the live gated origin, using the owner key from
  // $HOME when it is present — the only way to know whether "ask the origin for the bytes" works, since
  // no local fixture holds a copy of the private bucket.
  if (process.argv.indexOf('--mirror') >= 0) {
    const KEY = (fs.existsSync('/home/user/.owner-key') ? fs.readFileSync('/home/user/.owner-key', 'utf8').trim() : '');
    need(!!KEY, 'fixture: owner key is available to test the authenticated path', 'no ~/.owner-key');
    need(mirrorTestEnv() && /^https?:\/\//.test(mirrorTestEnv()), 'the child is pointed at an explicit origin', mirrorTestEnv());
    let y = await get('/task.html');
    need(y.status === 402 && /Unlock/.test(y.body), 'anonymous visitor still gets the lock screen, mirror or no mirror',
      y.status + ' ' + y.body.slice(0, 60));
    need(y.status !== 200, 'the mirror cannot be used to read a protected page without a key', 'leak');
    y = await get('/task.html', { headers: { cookie: 'at_key=' + KEY } });
    need(y.status === 200 && /AnnotateTrainer|Practise|task/i.test(y.body) && y.body.length > 900,
      'a key-holder gets the REAL paid page through the mirror', y.status + ' ' + y.body.length + 'B ' + y.body.slice(0, 60));
    y = await get('/js/tasks.js', { headers: { cookie: 'at_key=' + KEY } });
    need(y.status === 200 && /window\.Tasks/.test(y.body) && y.body.length > 1000,
      'and the real corpus, not the empty stub', y.status + ' ' + y.body.length + 'B');
    // The asymmetry that bit production: .html paths consulted the mirror and .js paths returned the
    // stub unconditionally, so a subscriber got the graded workspace and an empty window.Tasks.
    const anonJs = await get('/js/tasks.js');
    need(anonJs.status === 402 && anonJs.body.length < 200,
      'a keyless visitor still gets the 94-byte stub even with a mirror configured', anonJs.status + ' ' + anonJs.body.length + 'B');
    y = await get('/index.html', { headers: { cookie: 'at_key=' + KEY } });
    need(y.status === 200, 'free pages are unaffected by the mirror branch', y.status);
    server.close();
    console.log('\n' + '='.repeat(56));
    if (fails.length) { fails.forEach((f2) => console.log('   - ' + f2)); console.log('\u2717 mirror: ' + fails.length + ' failure(s)'); process.exit(1); }
    console.log('\u2713 mirror: ' + pass + ' checks passed (authenticated content reaches a Vercel-only deploy)');
    return;
  }

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
  need(!Object.keys(cfg).some((k) => k.startsWith('_')), 'vercel.json carries no comment keys',
    'Vercel validates the file against a schema with additionalProperties:false, so a single "_comment" ' +
    'key fails the whole build ("should NOT have additional property"). Notes live in deploy/VERCEL.md.');
  {
    // The check that would have saved 14 minutes and a failed production deploy: validate against
    // Vercel's published schema, fetched, not remembered. Skips silently when offline.
    let schema = null;
    try {
      schema = JSON.parse(await (await fetch('https://openapi.vercel.sh/vercel.json', { signal: AbortSignal.timeout(8000) })).text());
    } catch (e) { }
    if (!schema) {
      console.log('   ~ schema fetch skipped (no network) — keys still checked against the local allowlist');
      schema = { properties: { $schema: 1, framework: 1, functions: 1, rewrites: 1, buildCommand: 1, headers: 1, redirects: 1, outputDirectory: 1, cleanUrls: 1, crons: 1, env: 1, regions: 1 } };
    }
    const allowed = new Set(Object.keys(schema.properties || {}));
    const offending = Object.keys(cfg).filter((k) => !allowed.has(k));
    need(offending.length === 0, 'every vercel.json key exists in Vercel’s schema (' + allowed.size + ' allowed)', 'offending: ' + offending.join(', '));
    const itemAllowed = new Set(Object.keys((((schema.properties || {}).rewrites || {}).items || {}).properties || { source: 1, destination: 1 }));
    const badItems = (cfg.rewrites || []).flatMap((r) => Object.keys(r).filter((k) => !itemAllowed.has(k)));
    need(badItems.length === 0, 'each rewrite entry uses only documented keys', badItems.join(', '));
    const beforeFiles = JSON.stringify(cfg).indexOf('beforeFiles') >= 0;
    need(!beforeFiles, 'no next.config.js key (beforeFiles) leaked into vercel.json, where it does not exist',
      'it is not a vercel.json option and the schema rejects it');
  }
  const src = (cfg.rewrites && cfg.rewrites[0] && cfg.rewrites[0].source) || '';
  // Asserted as "is it a catch-all, and does it exclude ONLY Vercel internals", rather than pinned to an
  // exact string. Excluding api/ here would be harmless but excluding anything else is not: this rewrite
  // is what lets the function see /css and /assets requests at all. It is NOT what protects the paid
  // files — Vercel's filesystem wins over rewrites, so that protection is .vercelignore, asserted below.
  const isCatchAll = src.startsWith('/(') && src.includes('.*)') && src.endsWith(')');
  need(isCatchAll && !src.includes('?!api') && !/\?\!(?!_vercel\/)/.test(src),
    'the rewrite is a catch-all excluding only Vercel internals', src);
  const cfgPath = '/((?!_vercel/).*)';
  need(src === cfgPath, 'and its exact form is stable (a stray exclusion silently drops a whole prefix)', src);
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

  const ign = readIgnore();
  if (!ign.length) { need(false, '.vercelignore exists and lists the paid files', 'no .vercelignore'); }
  const protectedPaths = ['task.html', 'queue.html', 'onboarding.html', 'detector.html', 'trust-safety.html',
    'earnings.html', 'js/tasks.js', 'js/detector.js', 'data/', '.gitignore', 'tools/'];
  const missingFromIgnore = protectedPaths.filter((p2) => ign.indexOf(p2) < 0);
  need(missingFromIgnore.length === 0, 'every PROTECT path (and the owner tooling) is in .vercelignore',
    'not excluded: ' + missingFromIgnore.join(', '));
  need(ign.indexOf('deploy/gate-fallback.html') < 0 && ign.some((g) => g === 'gate.html'),
    'gate.html is excluded while the fallback that replaces it is shipped', 'wrong halves');

  console.log('\n\u250c\u2500 a simulated Vercel filesystem (repo minus .vercelignore)');
  if (process.argv.indexOf('--deploy-copy') >= 0) { server.close(); return; }   // child: assertions only
  const dir2 = buildDeployCopy();
  const { dir } = dir2;
  const child = require('child_process').spawn(process.execPath, [__filename, '--deploy-copy', dir],
    { cwd: ROOT, env: Object.assign({}, process.env, { ANNOTATE_DEPLOY_ROOT: dir }), encoding: 'utf8', timeout: 90000 });
  let cout = ''; child.stdout.on('data', (d) => { cout += d; });
  const cerr = []; child.stderr.on('data', (d) => cerr.push(d));
  const code = await new Promise((r) => child.on('exit', r));
  const copied = require('child_process').execSync('find ' + JSON.stringify(dir) + ' -type f | wc -l').toString().trim();
  console.log('   \u2713 deployment copy built: ' + copied + ' files, ' + ign.length + ' ignore patterns');
  need(code === 0, 'the SAME handler, over the deployment copy, still passes every check (' +
    (cout.match(/\u2713/g) || []).length + ' green)', cout.split('\n').filter((l) => /\u2717|failure/.test(l)).slice(0, 3).join(' | ').slice(0, 220) || cerr.join('').slice(0, 160));
  need(!fsx.existsSync(path.join(dir, 'task.html')) && !fsx.existsSync(path.join(dir, 'js/tasks.js')),
    'the paid corpus is genuinely ABSENT from the deployment (this is the gate, not a rewrite)', 'still present');
  need(fsx.existsSync(path.join(dir, 'deploy/gate-fallback.html')),
    'the 402 body ships in deploy/, so it survives the exclusion of gate.html', 'fallback missing');
  // And the same handler over a copy stripped of the fallback files — the bundle's true shape.
  const dir3 = path.join(os.tmpdir(), 'vercel-bundle-' + Date.now().toString(36));
  require('child_process').execSync('cp -R ' + JSON.stringify(dir) + ' ' + JSON.stringify(dir3));
  const c3 = require('child_process').spawn(process.execPath, [__filename, '--no-fallback', dir3],
    { cwd: ROOT, env: Object.assign({}, process.env, { ANNOTATE_DEPLOY_ROOT: dir3 }), encoding: 'utf8', timeout: 90000 });
  let o3 = ''; c3.stdout.on('data', (d) => { o3 += d; }); const e3 = []; c3.stderr.on('data', (d) => e3.push(d));
  const code3 = await new Promise((rr) => c3.on('exit', rr));
  const gre3 = (o3.match(/\u2713/g) || []).length;
  need(code3 === 0, 'with NO fallback files on disk (bundled-runtime shape) the gate still answers 402 + 404',
    gre3 + ' green; ' + (o3.split('\n').filter((l) => /\u2717|failure/.test(l)).slice(0, 2).join(' | ') || e3.join('').slice(0, 160)).slice(0, 220));
  need(/no-fallback: the embedded bodies/.test(o3), 'that pass actually ran the three embedded-body checks', o3.slice(-80));
  require('fs').rmSync(dir3, { recursive: true, force: true });

  const emb = fs.readFileSync(path.join(ROOT, 'api/_gate.js'), 'utf8');
  const gsrc = fs.readFileSync(path.join(ROOT, 'deploy/gate-fallback.html'), 'utf8').replace(/\n$/, '');
  need(emb.indexOf('const EMBED_GATE = `' + gsrc + '`;') >= 0,
    'the embedded lock screen is byte-identical to deploy/gate-fallback.html (run tools/embed-fallbacks.js)');

  fsx.rmSync(dir, { recursive: true, force: true });




  // The mirror, exercised for real. Silent when there is no owner key to test with, because a test that
  // asserts "network worked" on a machine with no network is just a flaky test.
  const mirrorOrigin = 'https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate';
  // The gate refuses every key when it has neither a Postgres backend nor a secret — correctly, and the
  // reason this child needs the anon key: without it the mirror test measures a fail-closed gate
  // instead of the mirror. Same file the buyer-flow tool reads; absent means offline machine or fresh
  // clone, and the honest answer is to say so rather than assert a skip as a pass.
  const anonKey = fs.existsSync('/home/user/.anon-key') ? fs.readFileSync('/home/user/.anon-key', 'utf8').trim() : '';
  if (fs.existsSync('/home/user/.owner-key') && anonKey) {
    const c4 = require('child_process').spawn(process.execPath, [__filename, '--mirror'],
      { cwd: ROOT, env: Object.assign({}, process.env, { ANNOTATE_MIRROR: mirrorOrigin, SUPABASE_ANON_KEY: anonKey }), encoding: 'utf8', timeout: 120000 });
    let o4 = ''; c4.stdout.on('data', (d) => { o4 += d; }); const e4 = []; c4.stderr.on('data', (d) => e4.push(d));
    const code4 = await new Promise((rr) => c4.on('exit', rr));
    need(code4 === 0, 'Vercel-only deploy + mirror serves paid content to key-holders and nobody else',
      (o4.split('\n').filter((l) => /\u2717|failure/.test(l)).slice(0, 2).join(' | ') || e4.join('').slice(0, 200)).slice(0, 260));
    console.log(o4.split('\n').filter((l) => /\u2713/.test(l)).map((l) => '     ' + l.trim()).join('\n'));
  } else {
    console.log('   \u2013 mirror test skipped (needs ~/.owner-key and ~/.anon-key; set ANNOTATE_MIRROR to run it by hand)');
  }
  // The anti-recursion guard, asserted by ASKING the module rather than by reading its source: a mirror
  // that resolves back to this same deployment would make every paid request a self-inflicted loop.
  const probeOut = require('child_process').execSync(
    "for u in 'https://x.vercel.app' 'http://127.0.0.1:9' 'http://localhost:8765'; do " +
    "ANNOTATE_MIRROR=$u node -e \"const o=require('./api/_gate.js').MIRROR_ORIGIN;console.log(o?'ok':'refused')\"; done",
    { cwd: ROOT, encoding: 'utf8', timeout: 40000 }).trim().split('\n').join(' ');
  need(probeOut.split(' ').filter(Boolean).length === 3 && probeOut.indexOf('ok') < 0,
    'the mirror refuses .vercel.app, localhost and 127.0.0.1 origins (no self-referential loop)', probeOut.slice(0, 120));
  const defOut = require('child_process').execSync(
    "node -e \"console.log(require('./api/_gate.js').MIRROR_ORIGIN)\"",
    { cwd: ROOT, encoding: 'utf8', timeout: 40000 }).trim();
  need(/supabase\.co\/functions\/v1\/annotate$/.test(defOut),
    'with no override the mirror is the gated function, not the project root', defOut);

  // globalThis.env must be installed BEFORE the gate module is loaded, because the gate reads
  // SUPABASE_ANON_KEY at module top level and derives MODE from it. When that assignment lived inside
  // the eval fallback, the gate's mode silently depended on which loader route happened to work: on the
  // bundled path it came up in hmac mode with no secret and refused every key that exists.
  const gateSrc = fs.readFileSync(path.join(ROOT, 'api/_gate.js'), 'utf8');
  const iEnv = gateSrc.indexOf('globalThis.env = Object.assign');
  const iReq = gateSrc.search(/require\('\.\/gate-bundled\.js'\)/);
  need(iEnv >= 0 && iReq >= 0 && iEnv < iReq,
    'the env shim is installed before any route loads the gate module', 'env@' + iEnv + ' first-require@' + iReq);
  const childOut = require('child_process').execSync(
    "SUPABASE_ANON_KEY=x node -e \"require('./api/_gate.js').loadGate().then(() => " +
    "console.log(JSON.stringify({mode:(globalThis.env&&globalThis.env.SUPABASE_ANON_KEY)?'postgres-seen':'missing'})))\"",
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 }).trim();
  need(/postgres-seen/.test(childOut), 'with the anon key in process.env the gate sees it at load', childOut.slice(0, 120));

  // Static drift guard, and the actual cause of the failed production deploy this file exists to
  // prevent. Vercel emits a function artifact from api/index.js plus what it can TRACE through
  // require/import; a path handed to readFileSync is invisible to it, so the gate never loaded and
  // every request came back 500 FUNCTION_INVOCATION_FAILED. The fix is a literal, static re-export —
  // easy to delete as "an unused file" in a future tidy-up, which would re-break the paywall silently
  // (fail closed, so nobody gets paid content, but nobody can buy it either).
  const gb = fs.readFileSync(path.join(ROOT, 'api/gate-bundled.js'), 'utf8');
  need(/export\s*\{\s*onRequest\s*\}\s*from\s*'\.\.\/deploy\/cloudflare-pages-function\.js'/.test(gb),
    'api/gate-bundled.js holds the literal static edge a bundler can inline');
  need(/require\('\.\/gate-bundled\.js'\)/.test(fs.readFileSync(path.join(ROOT, 'api/_gate.js'), 'utf8')),
    'the loader tries that bundled edge before it reaches for the filesystem');
  need(!/\bgate-bundled\b/.test(fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8')),
    'the bundler entry is not excluded from the deploy');

  server.close();
  console.log('\n' + '='.repeat(56));
  if (fails.length) { fails.forEach((f) => console.log('   - ' + f)); console.log('\u2717 vercel-entry: ' + fails.length + ' failure(s)'); process.exit(1); }
  console.log('\u2713 vercel-entry: ' + pass + ' checks passed (real handler, real HTTP, real files)');
})().catch((e) => { console.log('\u2717 harness error: ' + (e.stack || e).split('\n').slice(0, 4).join(' | ')); try { server.close(); } catch (_) { } process.exit(1); });
