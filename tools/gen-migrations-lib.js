/* Extraction half of the migration generator, exported so tests/sql-migration.js can verify
   "0003 covers every column 0001 declares" against the SAME reader that writes 0003. A test that
   re-parses SQL with its own regex disagrees with the generator instead of agreeing with the
   database, which is a worse failure mode than having no test. See gen-migrations.js for why
   these files exist at all.                                                   */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripComments, splitStatements, matchParen, splitTopInside } = require('./sql-tokenize.js');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
const SRC = path.join(MIG, '0001_paywall.sql');
const FUNCS = ['key_sig', 'key_fill', 'key_check', 'key_attempt', 'key_mint',
               'cfg', 'cache_get', 'cache_put', 'crypto_quote', 'crypto_get', 'crypto_probe', 'crypto_mark'];
const TABLE_NAMES = ['access_keys', 'app_config', 'unlock_attempts', 'crypto_payments'];
// Tables introduced after the first revision are created whole by 0001 on every install, so an
// existing database simply does not have them yet — there are no columns to backfill onto a table
// that is absent. Emitting ALTERs for them is how a repair file grows a column list that the
// CREATE it is repairing no longer matches.
const NEW_TABLES = ['crypto_payments'];

function sliceFunctions(text) {
  const out = {};
  let owner = null;
  for (const stmt of splitStatements(text)) {
    // A chunk's LEADING comments belong to whatever it announces, so they ride along; but a
    // chunk of pure prose (a section banner) owns nothing and ends the current run.
    const code = stripComments(stmt).replace(/\s+/g, ' ').trim();
    if (!code) { owner = null; continue; }
    const m = /^create or replace function public\.(\w+)\s*\(/i.exec(code);
    if (m) {
      if (!FUNCS.includes(m[1])) { owner = null; continue; }   // a foreign function ends the run
      owner = m[1];
      if (out[owner]) throw new Error(owner + ': defined twice in 0001 — 0002 cannot pick a winner');
      out[owner] = '';
    }
    if (!owner) continue;
    out[owner] += (out[owner] ? '\n\n' : '') + stmt.trimEnd() + ';';
  }
  const missing = FUNCS.filter((f) => !out[f]);
  if (missing.length) {
    throw new Error('not found in ' + path.basename(SRC) + ': ' + missing.join(', ') +
      '\n   parsed ' + splitStatements(text).length + ' statement(s)');
  }
  for (const f of FUNCS) {
    if (!/\$\$/.test(out[f])) throw new Error(f + ': body has no dollar-quoted end');
    if (!out[f].trimEnd().endsWith(';')) throw new Error(f + ': does not end in a complete statement');
  }
  return out;
}

/* ------------------------------------------------------------------ extract table columns */
function tableBlock(text, table) {
  const head = 'create table if not exists public.' + table;
  const at = text.indexOf(head);
  if (at < 0) throw new Error(table + ': `create table if not exists public.` block not found in 0001');
  const open = text.indexOf('(', at + head.length);
  if (open < 0) throw new Error(table + ': no opening parenthesis after `' + head + '`');
  return splitTopInside(text, open)
    .map((c) => ({ raw: c, sql: stripComments(c).replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.sql);
}
function tableColumns(text, table) {
  return tableBlock(text, table)
    .filter((c) => !/^(constraint|primary key|unique|check|foreign key)\b/i.test(c.sql))
    .map((c) => {
      const m = /^(\w+)\s+([\s\S]+)$/.exec(c.sql);
      return m ? { name: m[1], decl: m[2].trim() } : { name: c.sql, decl: '' };
    })
    .filter((c) => /^[a-z_]+$/i.test(c.name));
}
function tableConstraint(text, table) {
  const row = tableBlock(text, table).find((c) => /^constraint\s/i.test(c.sql));
  if (!row) return null;
  const m = /^constraint\s+(\w+)\s+check\s*\(([\s\S]*)\)\s*$/i.exec(row.sql);
  return m ? { name: m[1], expr: m[2].trim() } : null;
}


const DEFAULTS = { text: "''", bigint: '0', int: '0', smallint: '0', boolean: 'false', timestamptz: 'now()', timestamp: 'now()', numeric: '0', jsonb: "'{}'" };

/* Everything the two generated files are built from, in one call. */
function extract() {
  const src = fs.readFileSync(SRC, 'utf8');
  const fns = sliceFunctions(src);
  const colsByTable = Object.fromEntries(TABLE_NAMES.map((t) => [t, tableColumns(src, t).map((c) => c.name)]));
  const decls = Object.fromEntries(TABLE_NAMES.map((t) => [t, tableColumns(src, t)]));
  const generatedCols = Object.values(decls).flat().filter((c) => /generated always as/.test(c.decl) && /\bstored\b/.test(c.decl)).map((c) => c.name);
  if (!generatedCols.length) throw new Error('no STORED generated columns found - the extractor has drifted from 0001');
  const constraint = tableConstraint(src, 'access_keys');
  return { src, fns, decls, colsByTable, generatedCols, constraint, TABLE_NAMES, NEW_TABLES, FUNCS, DEFAULTS };
}

module.exports = { extract, sliceFunctions, tableColumns, tableBlock, tableConstraint, FUNCS, TABLE_NAMES, NEW_TABLES, SRC, MIG };
