#!/usr/bin/env node
/* Regenerate the EMBED_GATE / EMBED_404 / EMBED_SCREEN constants in api/_gate.js from the files they
   mirror, then `node tools/embed-fallbacks.js --check` to prove it took.

   WHY. Vercel's function artifact is the traced import graph, not the repository: at runtime __dirname is
   /var/task and there is no deploy/ directory beside it, so a gate that reads its own lock screen from
   disk answers the one visitor who should see "paste your key and buy" with
   `500 {"error":"Gate failed closed: ENOENT: …gate-fallback.html"}`. The bodies are embedded instead.

   WHY JSON.stringify AND NOT A TEMPLATE LITERAL. The template-literal version of this tool refused any
   file containing a backtick or ${, which turned a harmless comment in gate.html into a syntax error in
   the paywall, and needed a hand-rolled workaround for the one token that genuinely matters — a literal
   </script> inside a JS string still closes the tag when the string is inlined into HTML. JSON.stringify
   escapes the quotes and the newlines and leaves the forward slash alone, so the emitted literal carries
   `<\/script>`: identical as a JS string, inert to an HTML parser. One mechanism, no prose hazards.

   The files stay the source of truth (dev and Cloudflare read them from disk and prefer them), so this
   is required only after editing one — tests/verify.js and tests/vercel-entry.js both fail on drift. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILES = [['EMBED_GATE', 'deploy/gate-fallback.html'], ['EMBED_404', '404.html'], ['EMBED_SCREEN', 'gate.html']];

const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\n$/, '');
// A real <script> element inside an embedded page has to come back escaped or it terminates the outer
// tag the moment this constant is inlined; the regex is deliberately tolerant of attributes and spacing.
const lit = (body) => JSON.stringify(body).replace(/<\/(script|style)>/gi, '<\\/$1>');

const p = path.join(ROOT, 'api/_gate.js');
const cur = fs.readFileSync(p, 'utf8');
// Per-constant splicing rather than one giant regex: the previous generator's pattern was a hand-built
// match against its own output format, so changing that format made it unable to find what it had just
// written, and --check then reported "stale" forever.
const splice = (text, name, value) => {
  const key = 'const ' + name + ' = ';
  const i = text.indexOf(key);
  if (i < 0) return null;
  let j = text.indexOf(';\n', i);
  if (j < 0) return null;
  // A template-literal embed ends `...`;`; find the semicolon that closes the DECLARATION, i.e. the one
  // after the literal's final backtick, not the first semicolon inside the HTML.
  if (text[i + key.length] === '`') {
    const close = text.indexOf('`;', i + key.length);
    if (close < 0) return null;
    j = close + 1;
  }
  return { before: text.slice(0, i), old: text.slice(i, j + 1), after: text.slice(j + 1), cut: [i, j + 1] };
};
const parts = [];
let out = cur;
for (const [name, f] of FILES) {
  const found = splice(out, name, null);
  if (!found) { console.error('marker ' + name + ' not found in api/_gate.js — restore it before running this'); process.exit(1); }
  parts.push(found.old);
  out = out.slice(0, found.cut[0]) + 'const ' + name + ' = ' + lit(src(f)) + ';' + out.slice(found.cut[1]);
}
if (out === cur) {
  if (/<\/script>/i.test(out)) { console.error('\u2717 an embedded body still carries a raw </script> — the escape did not apply'); process.exit(1); }
  // --check is what CI and a human run after editing a page, so it must verify the live file, not just
  // that this script's own arithmetic agrees with itself.
  const mod = require(p);
  for (const [name, f] of FILES) {
    if (mod[name] !== src(f)) { console.error(`✗ ${name} in api/_gate.js is not ${f} as loaded (${String(mod[name]).length}B vs ${src(f).length}B)`); process.exit(1); }
  }
  console.log('✓ api/_gate.js embeds the current ' + FILES.map(([, f]) => f).join(', ') + ' (verified by require)');
  process.exit(0);
}
if (process.argv.indexOf('--check') >= 0) { console.error('✗ embedded copies are stale — run: node tools/embed-fallbacks.js'); process.exit(1); }
fs.writeFileSync(p, out);
// Prove the result by REQUIRING the patched file — the way its consumers load it — rather than splicing
// the declarations out and eval'ing them, which broke the first time a value contained a semicolon (HTML
// is full of them). A stale require cache would make this a lie, so the cache entry is dropped first.
delete require.cache[require.resolve(p)];
const mod = require(p);
for (const [name, f] of FILES) {
  if (mod[name] !== src(f)) {
    console.error(`✗ ${name} does not round-trip to ${f}: read ${String(mod[name]).length}B, wrote ${src(f).length}B`);
    process.exit(1);
  }
}
console.log('✓ re-embedded ' + FILES.length + ' bodies, each read back through require() identical to its file (' + FILES.map(([, f]) => src(f).length + 'B').join(', ') + ')');
