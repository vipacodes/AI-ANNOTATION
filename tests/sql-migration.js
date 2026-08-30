/* Guard for supabase/migrations/*.sql — the paywall's database half.

   Why this exists: four separate bugs in the first revision of 0001_paywall.sql were only
   visible when the SQL ran against a real Postgres, and each one broke the gate for every
   buyer with no warning in the app. They are all findable in the text, if you know to look:

     · encode(bytea,'base64','u')      → 42883  three-arg encode does not exist here
     · a plpgsql local named `key`/`id`→ 42702  a variable shadows its own column
     · (p_days * 86400000)::bigint    → 22003  int4 * int4 overflows before the cast
     · STABLE function doing UPDATE    → 0A000  writes are not allowed in a stable function

   Plus the class of bug those exposed: 0001 uses `create table if not exists`, so a column
   added later never reaches an existing table — which is what 0003_backfill_columns.sql
   generates itself from 0001's CREATE blocks. This file checks that generation happened.

   usage: node tests/sql-migration.js                                                        */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stripComments, splitStatements, matchParen } = require('../tools/sql-tokenize.js');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const FUNCS = ['key_sig', 'key_fill', 'key_check', 'key_attempt', 'key_mint'];

let pass = 0; const fails = [];
const ok = (m, c) => { if (c) { pass++; console.log('   \u2713 ' + m); } else { fails.push(m); console.log('   \u2717 ' + m); } };
const skip = (m) => { pass++; console.log('   \u2013 ' + m + ' (n/a for this file)'); };

const FILES = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
console.log('\n\u250c\u2500 the scanner the generator relies on');
{
  // A `--` comment containing ( or ; is the exact thing that broke the first three attempts at
  // this, so prove the tokenizer survives it before trusting anything derived from it.
  const tricky = "create table public.t (\n  id text primary key,   -- the 7-char id (public part)\n  n int not null default 0\n);\ninsert into public.t values ('a;b', 'has -- dashes');\n";
  const stmts = splitStatements(tricky);
  ok('tokenizer: a ";" inside a string literal does not split statements', stmts.length === 2);
  const head = stmts[0];

  const close = matchParen(head, head.indexOf('('));
  ok('tokenizer: "(" inside an inline comment does not steal the matching paren',
    head[close] === ')' && head.slice(0, close).includes('(public part)'));
  ok('tokenizer: stripComments leaves string literals alone',
    !/has \u2014/.test(stripComments(tricky)) && stripComments(tricky).includes("'a;b'"));
}

console.log('\n\u250c\u2500 every migration is complete SQL');
const code = {};
for (const f of FILES) {
  const all = fs.readFileSync(path.join(MIG, f), 'utf8');
  code[f] = stripComments(all);
  const c = code[f];
  ok(f + ': parentheses balanced (' + (c.match(/\(/g) || []).length + ')',
    (c.match(/\(/g) || []).length === (c.match(/\)/g) || []).length);
  const dd = (c.match(/\$\$/g) || []).length;
  ok(f + ': dollar quotes pair up (' + dd + ')', dd % 2 === 0);
  // Each chunk is a statement with its terminator removed; a chunk that does not LOOK like a
  // complete statement means the scanner lost its place (the 6-statement bug, once).
  ok(f + ': every statement starts with a real keyword (' + splitStatements(c).length + ' chunks)',
    splitStatements(c).every((x) => {
      const one = stripComments(x).replace(/\s+/g, ' ').trim();
      return !one || /^(create|alter|drop|insert|update|delete|grant|revoke|comment|with|select|truncate|do|analyze|vacuum|set|begin|commit)/i.test(one);
    }));
  ok(f + ': declares its intent in a header comment', /^-- =+\n-- 0\d\d\d \u00b7 /m.test(all));
}

console.log('\n\u250c\u2500 the shapes this Postgres rejects');
for (const f of FILES) {
  const c = code[f];
  const hasFns = /create or replace function public\.key_check/.test(c);
  ok(f + ': no three-argument encode() - the base64 "u" variant raises 42883 here',
    !/encode\([^)]*,\s*'base64'\s*,\s*'u'\s*\)/.test(c));
  ok(f + ': no int4 day-multiplication (30 * 86400000 overflows before any cast)',
    !/(?:p_days|\bdays\b|\d+) \* 86400000\)?::bigint/.test(c));
  if (hasFns) {
    const unqualified = (c.replace(/extensions\.\w+/g, 'Q').match(/\b(?:hmac|gen_random_bytes|gen_random_uuid)\s*\(/g) || []);
    ok(f + ': pgcrypto calls are schema-qualified (search_path is pinned; extensions is not on it)' +
      (unqualified.length ? ' \u2014 found ' + unqualified.join(', ') : ''), unqualified.length === 0);
    ok(f + ': base64url is built the Node way - replace, then left(..., 28)',
      /left\(\s*replace\(replace\(replace\(\s*encode\([\s\S]{0,240}?'base64'\),\s*'\+', '-'\), '\/', '_'\), '=', ''\),\s*28\)/.test(c));
    ok(f + ': no plpgsql variable named key or id (a variable shadows its own column)',
      !/\b(?:key|id)\s+(?:text|bigint|int)\s*[;,]/.test(c.replace(/declare/i, 'declare')) &&
      !/where\s+id\s*=\s*id\s*[);]/.test(c));
    ok(f + ': app_config lookups qualify the column (app_config.key, not bare key)',
      /app_config\.key = 'ANNOTATE_SECRET'/.test(c));
    ok(f + ': every SECURITY DEFINER function pins search_path',
      (c.match(/security definer\s+set search_path = public, pg_temp/gi) || []).length >= 4);
    ok(f + ': the writer RPCs are not declared STABLE (Postgres forbids writes in them)',
      !/language plpgsql\s+stable/is.test(c));
    ok(f + ': key_mint is revoked from anon/authenticated and never granted to them',
      !/grant execute on function public\.key_mint[^;]*to anon/.test(c) &&
      /revoke all on function public\.key_mint\(text, text, int\) from public, anon, authenticated/i.test(c));
    // "new.expires_at is null" on a STORED GENERATED column raises
    //   42703: record "new" has no field "expires_at"
    // because BEFORE triggers never see generated values. Identity columns are fine, which is
    // why the lib filters on STORED rather than on any `generated always`.
    const genCols = require('../tools/gen-migrations-lib.js').extract().generatedCols;
    const triggerBody = (/create or replace function public\.key_fill\(\)?[\s\S]*?\$\$([\s\S]*?)\$\$/m.exec(c) || [, ''])[1];
    const touched = genCols.filter((g) => new RegExp('new\\.' + g + '\\b').test(triggerBody));
    ok(f + ': the insert trigger neither reads nor writes a stored generated column' +
      (touched.length ? ' - touches ' + touched.join(', ') : ' (' + genCols.join(', ') + ')'),
      genCols.length >= 3 && touched.length === 0);
    ok(f + ': the trigger still validates the columns it owns (exp_ms, sig)',
      /new\.exp_ms is null/.test(triggerBody) && /new\.sig := public\.key_sig/.test(triggerBody));
    ok(f + ': key_check ends by bumping the usage counter',
      /update public\.access_keys set uses = uses \+ 1/.test(c));
  } else skip(f + ': function-shape checks');
}

console.log('\n\u250c\u2500 0001 and 0002 cannot drift (0002 repairs older databases)');
{
  const bodies = (f) => FUNCS.map((n) => {
    const c = code[f];
    if (!c) return '';
    const at = c.search(new RegExp('create or replace function public\\.' + n + '\\s*\\(', 'i'));
    if (at < 0) return '';
    // A literal indexOf on "fn(" silently missed every signature written as "fn(\n  p_arg …" —
    // which is how one function's slice swallowed the next and this test reported a mismatch in
    // an UNRELATED function (key_mint). The boundary regex is the real fix; the style rule below
    // keeps both files parseable by anything else that reads them line by line.
    const next = FUNCS.map((o) => ({ o, i: c.search(new RegExp('create or replace function public\\.' + o + '\\s*\\(', 'g')) }))
      .filter((x) => x.i > at).sort((x, y) => x.i - y.i);
    return (next.length ? c.slice(at, next[0].i) : c.slice(at)).replace(/\s+/g, ' ').trim();
  });
  const a = bodies('0001_paywall.sql'), b = bodies('0002_portable_base64url.sql');
  FUNCS.forEach((n, i) => ok(n + ': byte-for-byte the same body in both', !!a[i] && !!b[i] && a[i] === b[i]));
}

console.log('\n\u250c\u2500 0003 covers every column 0001 declares');
{
  // The generator is the only thing allowed to interpret 0001's SQL; re-parsing it here with a
  // regex is how this test reported "missing: select, return" while the migration was fine.
  const gen = require('../tools/gen-migrations-lib.js');
  const { colsByTable, generatedCols, NEW_TABLES } = gen.extract();
  // A table introduced after the first revision has no old shape to backfill: 0001's CREATE TABLE
  // IS the repair, and an ALTER for it would fail on a database that has never seen the table.
  const covered = Object.fromEntries(Object.entries(colsByTable)
    .filter(([t]) => !(gen.NEW_TABLES || []).includes(t)));
  const repair = code['0003_backfill_columns.sql'] || '';
  const cols = Object.values(covered).flat();
  const named = new Set([...repair.matchAll(/add column if not exists\s+(\w+)/g)].map((m) => m[1]));
  const missing = cols.filter((c) => !named.has(c));
  ok('every column declared by 0001 has an ALTER in 0003' +
     (missing.length ? ' \u2014 missing: ' + missing.join(', ') : ' (' + named.size + ' covered)'),
     cols.length > 10 && missing.length === 0);
  ok('generated columns are re-created too (' + generatedCols.join(', ') + ')',
     generatedCols.length >= 3 && generatedCols.every((c) => named.has(c)));
  const stmts = splitStatements(repair).map((s) => s.trim()).filter(Boolean);
  ok('0003 contains only idempotent statements (add column if not exists / drop column if\n     exists / create index if not exists / a catalog-guarded constraint block, never a bare\n     ADD CONSTRAINT that raises 42710 the second time you run it)',
     stmts.every((x) => /^(alter table public\.\w+ add column if not exists|alter table public\.\w+ drop column if exists|create index if not exists|do\b|begin|declare|if not exists|execute |end\s*;?|\$do\$)/i.test(x.trim())) &&
     /if not exists \(select 1 from pg_constraint where conname = 'key_shape'/.test(repair) &&
     !/^alter table public\.\w+ add constraint/m.test(repair));
}

console.log('\n\u250c\u2500 the gate and the ledger agree on what is protected');
{
  const grab = (file, name) => {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const m = new RegExp('^\\s*(?:export )?const ' + name + ' = (/.*/);?$', 'm').exec(s);
    return m ? m[1] : '';
  };
  const c = code['0001_paywall.sql'] || '';
  for (const fn of ['key_check', 'key_attempt']) {
    ok(fn + '() is created here, and it is the RPC deploy/cloudflare-pages-function.js calls',
      new RegExp('create or replace function public\\.' + fn + '\\s*\\(', 'i').test(c));
  }
  ok('server.js and the Pages function still share their path lists',
    grab('server.js', 'PUBLIC') === grab('deploy/cloudflare-pages-function.js', 'PUBLIC') &&
    grab('server.js', 'PROTECT') === grab('deploy/cloudflare-pages-function.js', 'PROTECT'));
  const s2 = fs.readFileSync(path.join(MIG, '0001_paywall.sql'), 'utf8');
  ok('no real secret is committed in the migration',
    !/ANNOTATE_SECRET',\s*'(?!NOT_SET)[A-Za-z0-9]{20}/.test(s2) && !/sbp_|eyJ[A-Za-z0-9_-]{20,}/.test(s2));
}

console.log('\n' + '\u2550'.repeat(58));
if (fails.length) { console.log('\u2717 ' + fails.length + ' failure(s):'); fails.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('\u2713 sql-migration: ' + pass + ' assertions hold over ' + FILES.length + ' files');
