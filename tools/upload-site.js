/* Push the site files into the PRIVATE Supabase Storage bucket the edge function reads from,
   then prove the privacy claim, because "it 404s" and "it is private" are not the same fact.

     SUPABASE_REF=<ref> SERVICE_ROLE_KEY=<service key> node tools/upload-site.js
     … --dry      list what would be uploaded
     … --check    compare against the bucket and upload only what differs

   Why the bucket is private at all: the function is the only thing allowed to read a protected
   file, so a path you forget to add to PROTECT is still unreachable by URL. If this bucket were
   public, one forgotten line would leak the whole corpus.
   Writes go to /storage/v1/object/<bucket>/<path>; /object/authenticated/... is READ-only.      */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { project, harness } = require('./supabase-api.js');

const ROOT = path.join(__dirname, '..');
const BUCKET = process.env.SITE_BUCKET || 'site';
const dry = process.argv.includes('--dry');
const onlyDiff = process.argv.includes('--check');
const A = harness('site upload');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8'
};

const ROOT_EXTRA = ['robots.txt', 'sitemap.xml', 'favicon.ico', 'site.webmanifest'];

function collect() {
  const out = [];
  // Pages plus the site-root files a crawler or browser asks for by name. This used to be
  // ".html only", which silently skipped robots.txt: it sat in the repo, was never uploaded, and every
  // crawler got a 404 for it — while the manifest check below passed, because it only counted the files
  // this function chose to look at. A deployer's checklist must not be able to grade its own blind spot.
  for (const f of fs.readdirSync(ROOT).sort()) {
    // .md too: buy.html links DEPLOY.md, and a link in a buyer-facing page that 404s is a defect even
    // when the file is sitting in the repo. Only the four root docs and deploy/*.md, never tests or tools.
    if (f.endsWith('.html') || ROOT_EXTRA.indexOf(f) >= 0 || /^[A-Z][A-Za-z]*\.md$/.test(f)) out.push({ abs: path.join(ROOT, f), rel: f });
  }
  for (const d of ['css', 'js', 'assets', 'deploy']) {
    // deploy/ ships because deploy/gate-fallback.html and deploy/VERCEL.md are both needed by something
    // that runs in a browser or is linked from a page; nothing else in it is public.

    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const skip = (d === 'deploy' && !/\.(md|html)$/.test(e.name));
      if (e.isFile() && !e.name.startsWith('.') && !skip) out.push({ abs: path.join(dir, e.name), rel: d + '/' + e.name });
    }
  }
  return out;
}

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

(async () => {
  const files = collect();
  A.section(files.length + ' files are what a buyer needs');
  A.ok('every page in PROTECT and PUBLIC is present', (() => {
    const names = new Set(files.map((f) => f.rel));
    const need = ['index.html', 'task.html', 'queue.html', 'guide.html', 'gate.html', 'buy.html', 'js/tasks.js', 'css/app.css',
      'js/crypto.js', ...ROOT_EXTRA.filter((n) => fs.existsSync(path.join(ROOT, n)))];
    const missing = need.filter((n) => !names.has(n));
    if (missing.length) console.log('   - missing from the collected set: ' + missing.join(', '));
    return missing.length === 0;
  })());
  A.ok('no private material is in the list (' + files.length + ' files, none under data/ or .git)',
    files.every((f) => !/(^|\/)(data|\.git|node_modules)\//.test(f.rel) && !/\.secret$|issued\.jsonl$|\.env$/.test(f.rel)));
  if (dry) { files.forEach((f) => console.log('   ', f.rel)); process.exit(0); }

  A.section('upload to the private "' + BUCKET + '" bucket');
  let up = 0, same = 0, bad = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    if (onlyDiff) {
      // BYTE comparison, not length. This used to compare sizes and call that "--check", which is how
      // the mangled-encoding bug below survived: a re-encoded file is LONGER, so a length test would
      // have re-uploaded it forever and never once reported the live site as wrong.
      const got = await project('/storage/v1/object/authenticated/' + BUCKET + '/' + f.rel, { method: 'GET', raw: true });
      if (got.status === 200 && got.buffer && got.buffer.length === buf.length && crypto.createHash('md5').update(got.buffer).digest('hex') === md5(buf)) { same++; continue; }
    }
    // Send the Buffer, never a decoded string. `buf.toString('binary')` — which was here for the whole
    // life of this project — turns each UTF-8 byte into a CHARACTER, and fetch then encodes those
    // characters back to UTF-8: '—' (3 bytes) became 'â' (6 bytes). Every em-dash, middot and arrow
    // on the live site was mojibake while every status code said 200 and every local test stayed green,
    // because local serving reads from disk. ASCII files (css, svg) were unaffected, which is exactly why
    // nothing noticed: the pages LOOKED fine to a checker that only asks "did it answer 200".
    const r = await project('/storage/v1/object/' + BUCKET + '/' + f.rel, {
      method: 'POST',
      body: buf,
      headers: { 'content-type': TYPES[path.extname(f.rel)] || 'application/octet-stream', 'x-upsert': 'true' }
    });
    if (r.status >= 400) { bad++; A.ok('upload ' + f.rel + ' → HTTP ' + r.status + ' ' + String(r.body).slice(0, 100), false); }
    else {
      // Read it back: the bucket is the only copy a buyer ever sees, so "the POST returned 200" is not
      // the assertion — "the bytes there are my bytes" is. Retried, because an object replaced under its
      // own key can briefly serve the PREVIOUS one from storage's cache: the first time this ran it
      // reported six false failures on files that were in fact correct 400 ms later. A verification that
      // cries wolf is worse than none, since the response is to ignore it.
      const want = md5(buf);
      let okBack = false, seen = null;
      for (let t = 0; t < 4 && !okBack; t++) {
        const back = await project('/storage/v1/object/authenticated/' + BUCKET + '/' + f.rel, { method: 'GET', raw: true });
        seen = back.buffer ? back.buffer.length + ' bytes, ' + md5(back.buffer) : 'status ' + back.status;
        okBack = back.status === 200 && !!back.buffer && md5(back.buffer) === want;
        if (!okBack) await new Promise((r) => setTimeout(r, 300));
      }
      if (!okBack) { bad++; A.ok(f.rel + ' uploaded but the bucket never served my bytes (' + seen + ' vs ' + want + ')', false); }
      else up++;
    }
  }
  A.ok(up + ' uploaded, ' + same + ' already identical, ' + bad + ' failed', bad === 0 && (up + same) === files.length);

  A.section('the privacy claim, measured');
  {
    const gated = await project('/storage/v1/object/public/' + BUCKET + '/task.html');
    A.ok('the PAID page is not readable through the public URL: HTTP ' + gated.status, gated.status >= 400);
    const free = await project('/storage/v1/object/public/' + BUCKET + '/index.html');
    A.ok('nor is the free one, and that is the point: the bucket is not a web root (HTTP ' + free.status + ')', free.status >= 400);
    const auth = await project('/storage/v1/object/authenticated/' + BUCKET + '/task.html');
    A.ok('with the service key the same bytes are readable (' + auth.body.length + ' bytes) — which is exactly one hop: the function',
      auth.status === 200 && auth.body.length > 5000);
    const noKey = await project('/storage/v1/object/authenticated/' + BUCKET + '/task.html', { headers: { authorization: '' } });
    A.ok('and without it, no', noKey.status >= 400 || !/<!DOCTYPE/.test(noKey.body));
  }
  console.log('\n   next: node tools/verify-buyer-flow.js --mint   (that is the end-to-end proof)');
  process.exit(A.done(BUCKET + ' @ ' + (process.env.SUPABASE_REF || 'veecksfcnlpppzvplcyt')));
})().catch((e) => { console.error('\n   \u2717 ' + (e && e.message || e)); process.exit(1); });
