/* Derives supabase/migrations/0002_portable_base64url.sql and 0003_backfill_columns.sql
   from 0001_paywall.sql, which is the one file you edit.

   Why this exists: 0001 is a `create table if not exists` + `create or replace function`
   migration — exactly right for re-running, exactly wrong for a database created by an OLDER
   revision. A new column added to the CREATE never reaches a table that already exists, and
   the functions then fail at runtime on every key check. A paywall that fails at runtime
   fails closed: buyers see "Paywall is unavailable" and you get no clue why. 0002 (function
   bodies) and 0003 (the ALTERs) are the repair path, and hand-maintaining three copies of the
   same SQL is what let four separate bugs ship. So there is one copy, and this writes the two.

   Every bug guarded against here was found by running the SQL against a live Postgres:
     · encode(bytea,'base64','u')        → 42883  (three-arg encode does not exist)
     · a plpgsql variable named `key`/`id` → 42702 / a where-clause that was always true
     · (p_days * 86400000)::bigint       → 22003  (int4*int4 overflows before the cast)
     · STABLE function doing an UPDATE   → 0A000  (writes are not allowed in a stable fn)
   tests/sql-migration.js re-checks all four statically.

   usage: node tools/gen-migrations.js          # rewrite 0002 + 0003
          node tools/gen-migrations.js --check   # fail if they are stale (run by the test suite) */
'use strict';
const fs = require('fs');
const path = require('path');

const { stripComments } = require('./sql-tokenize.js');
const { extract, FUNCS, TABLE_NAMES, SRC } = require('./gen-migrations-lib.js');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
const checkOnly = process.argv.includes('--check');

/* All parsing lives in gen-migrations-lib.js, which tests/sql-migration.js also loads, so the
   test verifies what this tool actually read rather than a second opinion of the same SQL. */
const { src, fns, decls: TABLES, generatedCols, constraint: keyShape, DEFAULTS } = extract();


/* ------------------------------------------------------------------ 0002 · function repair */
const HEADER2 = `-- ============================================================================
-- 0002 · Repair for a database that already ran an EARLIER copy of 0001.
--
-- Read this first: 0001 is correct and idempotent, so a FRESH install only needs 0001.
-- Skip this file unless your project was created from an older revision.
--
-- The block below is generated VERBATIM from 0001_paywall.sql by tools/gen-migrations.js.
-- Do not hand-edit it — edit 0001 and run \`node tools/gen-migrations.js\`.
--
-- It exists because the first revision of 0001 carried four bugs that only a real Postgres
-- can find, and every one of them failed silently from the buyer's side of the fence:
--
--   1. encode(bytea,'base64','u') — the three-argument form does not exist on the
--      Postgres 17 Supabase ships. ERROR 42883, so key_check died instead of answering and
--      the INSERT trigger rejected every key. public.key_sig() now builds base64url with
--      replace() and truncates in Node's order, byte-identical to
--      crypto.createHmac(...).digest('base64url').slice(0, 28).
--   2. A plpgsql local named \`key\` inside a function that queries app_config (whose column
--      is key) → ERROR 42702 ambiguous column. \`where id = id\` in key_mint had the same
--      disease: a column compared with itself is always true, so the collision check never
--      ran. Variables are now full_key / new_id and lookups say app_config.key.
--   3. (p_days * 86400000)::bigint → ERROR 22003: int4 * int4 overflows BEFORE the cast can
--      help. Now p_days::bigint * 86400000.
--   4. key_check declared STABLE while ending in an UPDATE →
--      ERROR 0A000 "UPDATE is not allowed in a non-volatile function". It is VOLATILE now.
--
-- Apply (Dashboard → SQL editor → paste → Run, or POST /v1/projects/<ref>/database/query),
-- then prove it took — a JSON verdict, not an error, is the pass:
--   select public.key_check('abcdefg','x',4102444800000);
--     → {"ok": false, "error": "This key was not issued by this site."}
--   select public.key_sig('abcdefg',4102444800000,'x');
--     → a 28-character base64url string
-- ============================================================================
`;
const out2 = HEADER2 + '\n' + FUNCS.map((n) => fns[n]).join('\n\n');

/* ------------------------------------------------------------------ 0003 · column repair */
const notes = [];
const lines = [];
for (const t of TABLE_NAMES) {
  const rows = [];
  for (const c of TABLES[t]) {
    let decl = c.decl;
    // `add column if not exists id text primary key` throws on an existing table: a primary
    // key cannot be bolted on afterwards. It is already there (0001 created it), so drop it.
    const stripped = decl.match(/\b(primary key|unique)\b/gi);
    decl = decl.replace(/\s+primary key\b/gi, '').replace(/\s+unique\b/gi, '');
    if (stripped) notes.push(`${t}.${c.name}: ${stripped.join('/')} exists in 0001's CREATE but ALTER cannot add it to an existing table — old databases already have it, so this is not a gap.`);
    // NOT NULL on a populated table needs a DEFAULT or the ALTER fails outright.
    if (/\bnot null\b/i.test(decl) && !/\bdefault\b/i.test(decl)) {
      const ty = decl.match(/\b(text|bigint|int|smallint|boolean|timestamptz|timestamp)\b/i);
      const dv = ty ? DEFAULTS[ty[1].toLowerCase()] : null;
      if (!dv) throw new Error(`${t}.${c.name}: NOT NULL, no default, no known type — cannot repair automatically`);
      notes.push(`${t}.${c.name}: NOT NULL without a DEFAULT — 0003 supplies DEFAULT ${dv} so the ALTER can run on a table that already has rows. Change 0001 if that default is wrong for you.`);
      decl += ' default ' + dv;
    }
    rows.push(decl.length + c.name.length > 58
      ? `alter table public.${t} add column if not exists\n  ${c.name} ${decl};`
      : `alter table public.${t} add column if not exists ${c.name} ${decl};`);
  }
  if (rows.length) {
    lines.push('-- --------------------------------------------------------------------------- ' + t);
    lines.push(...rows, '');
  }
}
const HEADER3 = `-- ============================================================================
-- 0003 · Bring a database created by an EARLIER 0001 up to today's columns.
--
-- You need this if a key check raises a 42703 naming a column that IS present in 0001's
-- CREATE TABLE — e.g. \`ERROR 42703: column "uses" does not exist\`.
--
-- Why: 0001 opens with \`create table if not exists\`, which is right for re-running and wrong
-- for upgrading — a column added to the CREATE later never reaches a table that already
-- exists. So the functions quietly reference columns that are not there, and every request
-- fails closed with "Paywall is unavailable". This file is the ALTER half of the contract.
--
-- It is GENERATED from 0001's CREATE TABLE blocks by tools/gen-migrations.js, so it cannot
-- forget a column again. Idempotent; run it any number of times, before or after 0001/0002.
-- ============================================================================
`;
const out3 = HEADER3 + '\n'
  + (notes.length ? '-- Two things ALTER cannot do that CREATE can, recorded so they are not a surprise:\n'
    + notes.map((n) => '--   · ' + n).join('\n') + '\n\n' : '\n')
  + (keyShape ? `-- The shape constraint 0001 declares. ADD CONSTRAINT has no IF NOT EXISTS, so on a re-run\n-- this raises 42710 "constraint already exists" and takes the whole migration down with it.\n-- Guarded by catalog lookup, and NOT VALID first so a row from the older revision cannot block\n-- it; validated immediately after (one scan).\ndo\n$do$\ndeclare\nbegin\n  if not exists (select 1 from pg_constraint where conname = '${keyShape.name}' and conrelid = 'public.access_keys'::regclass) then\n    execute 'alter table public.access_keys add constraint ${keyShape.name} check (${keyShape.expr.replace(/'/g, "''")}) not valid';\n    execute 'alter table public.access_keys validate constraint ${keyShape.name}';\n  end if;\nend\n$do$;\n\n` : '')
  + lines.join('\n')
  + `-- An older revision also created access_keys.algo, which today's code never reads (the algorithm
-- is fixed inside key_sig). IF EXISTS makes this a no-op on a fresh install.
alter table public.access_keys drop column if exists algo;

-- The index 0001 declares, in case the table predates it.
create index if not exists unlock_recent on public.unlock_attempts (at desc, fp);
`;

/* ------------------------------------------------------------------ write or check */
const targets = { '0002_portable_base64url.sql': out2, '0003_backfill_columns.sql': out3 };
let stale = 0;
for (const [f, text] of Object.entries(targets)) {
  const p = path.join(MIG, f);
  const norm = (s) => stripComments(s).replace(/\s+/g, ' ').trim();
  if (checkOnly) {
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const same = norm(cur) === norm(text);
    if (!same) stale++;
    console.log((same ? '   in sync  ' : '   STALE    ') + f + (same ? '' : '  →  run: node tools/gen-migrations.js'));
    continue;
  }
  fs.writeFileSync(p, text);
  console.log('wrote ' + f + ' (' + text.length + ' bytes)');
}
if (checkOnly) { if (stale) { console.log('\u2717 ' + stale + ' generated migration(s) are out of date with 0001_paywall.sql'); process.exit(1); } console.log('\u2713 generated migrations match 0001'); process.exit(0); }
console.log('0001_paywall.sql stays hand-written (' + src.length + ' bytes) and is the source of truth.');
console.log('functions carried: ' + FUNCS.join(', ') + ' | generated columns: ' + generatedCols.join(', '));
