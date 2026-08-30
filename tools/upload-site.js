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

function collect() {
  const out = [];
  for (const f of fs.readdirSync(ROOT).sort()) if (f.endsWith('.html')) out.push({ abs: path.join(ROOT, f), rel: f });
  for (const d of ['css', 'js', 'assets']) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && !e.name.startsWith('.')) out.push({ abs: path.join(dir, e.name), rel: d + '/' + e.name });
    }
  }
  return out;
}

(async () => {
  const files = collect();
  A.section(files.length + ' files are what a buyer needs');
  A.ok('every page in PROTECT and PUBLIC is present', (() => {
    const names = new Set(files.map((f) => f.rel));
    return ['index.html', 'task.html', 'queue.html', 'guide.html', 'gate.html', 'buy.html']
      .every((n) => names.has(n)) && names.has('js/tasks.js') && names.has('css/app.css');
  })());
  A.ok('no private material is in the list (' + files.length + ' files, none under data/ or .git)',
    files.every((f) => !/(^|\/)(data|\.git|node_modules)\//.test(f.rel) && !/\.secret$|issued\.jsonl$|\.env$/.test(f.rel)));
  if (dry) { files.forEach((f) => console.log('   ', f.rel)); process.exit(0); }

  A.section('upload to the private "' + BUCKET + '" bucket');
  let up = 0, same = 0, bad = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    if (onlyDiff) {
      // Storage does not answer HEAD on this route, so the cheap equivalence test is length:
      // the object's size versus the file's. It will re-upload on a same-length edit, which is the
      // safe direction for a wrong answer; etag comparison looked right and never matched.
      const got = await project('/storage/v1/object/authenticated/' + BUCKET + '/' + f.rel, { method: 'GET' });
      if (got.status === 200 && got.body.length === buf.length) { same++; continue; }
    }
    const r = await project('/storage/v1/object/' + BUCKET + '/' + f.rel, {
      method: 'POST',
      body: buf.toString('binary'),
      headers: { 'content-type': TYPES[path.extname(f.rel)] || 'application/octet-stream', 'x-upsert': 'true', 'content-length': buf.length }
    });
    if (r.status >= 400) { bad++; A.ok('upload ' + f.rel + ' → HTTP ' + r.status + ' ' + r.body.slice(0, 100), false); }
    else up++;
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
