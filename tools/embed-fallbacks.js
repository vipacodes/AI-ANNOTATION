#!/usr/bin/env node
/* Regenerate the EMBED_GATE / EMBED_404 constants in api/_gate.js from the files they mirror.
   Run this after editing deploy/gate-fallback.html or 404.html, then `node tools/embed-fallbacks.js
   --check` to prove it took. Vercel's runtime has no copy of those files, so an un-embedded edit is a
   lock screen that 500s in production while passing every local test. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\n$/, '');
const [gate, nf] = [src('deploy/gate-fallback.html'), src('404.html')];
for (const [name, body] of [['gate-fallback', gate], ['404', nf]]) {
  if (/`|\$\{/.test(body)) { console.error(`${name}: contains a backtick or \${ — cannot embed in a template literal`); process.exit(1); }
}
const p = path.join(ROOT, 'api/_gate.js');
const cur = fs.readFileSync(p, 'utf8');
const want = (v) => 'const EMBED_GATE = `' + gate + '`;\nconst EMBED_404 = `' + nf + '`;';
const re = /const EMBED_GATE = `[\s\S]*?`;\nconst EMBED_404 = `[\s\S]*?`;/;
const hit = cur.match(re);
if (!hit) { console.error('markers not found in api/_gate.js — restore them before running this'); process.exit(1); }
if (hit[0] === want()) { console.log('✓ api/_gate.js embeds the current deploy/gate-fallback.html and 404.html'); process.exit(0); }
if (process.argv.indexOf('--check') >= 0) { console.error('✗ embedded copies are stale — run: node tools/embed-fallbacks.js'); process.exit(1); }
fs.writeFileSync(p, cur.replace(re, want()));
console.log('✓ re-embedded both bodies (' + gate.length + ' + ' + nf.length + ' bytes)');
