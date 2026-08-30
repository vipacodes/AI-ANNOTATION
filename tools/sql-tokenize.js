/* A tiny SQL text scanner, shared by tools/gen-migrations.js and tests/sql-migration.js.

   It is not a parser. It answers three questions reliably, which is all the migration tooling
   needs, and each one has a way to get it wrong that we actually hit:

     splitStatements  — a `;` inside 'a;b' or inside $$ ... $$ is not a separator, and an inline
                        `-- note` may contain one (it also may contain parentheses).
     matchParen       — a `(` inside a comment or a string must not open a group. Scanning a
                        CREATE TABLE without comment awareness finds the wrong close and the
                        error is "unbalanced parentheses", which points nowhere near the cause.
     stripComments    — full-line comments may describe bugs that have been FIXED, so pattern
                        checks must look at code only, or they fire on the prose.

   usage (from another module):
     const { splitStatements, matchParen, stripComments } = require('./sql-tokenize.js');      */
'use strict';

const isWordEnd = (ch) => ch === undefined || !/[A-Za-z0-9_]/.test(ch);

/* Skip one token starting at i (quotes, dollar-quoted bodies, line comments). Returns the index
   just after it, or -1 when text[i] does not start a token. */
function skipToken(text, i, { comments = true } = {}) {
  const ch = text[i];
  if (comments && ch === '-' && text[i + 1] === '-') {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : nl;                      // stop BEFORE the newline so it stays a separator
  }
  if (ch === "'" || ch === '"') {
    const close = ch;
    i++;                                                     // past the opening quote
    while (i < text.length) {
      if (text[i] === close) {
        if (text[i + 1] === close) { i += 2; continue; }     // '' or "" is an escaped quote
        return i + 1;
      }
      i++;
    }
    return text.length;                                      // unterminated: consume the rest, do not hang
  }
  if (ch === '$') {
    const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i));
    if (m) {
      const end = text.indexOf(m[0], i + m[0].length);
      return end < 0 ? text.length : end + m[0].length;
    }
  }
  return -1;
}

/* Full-line `-- ...` comments only. Trailing inline comments are left in place, because a naive
   regex would eat apostrophes inside string literals — which is exactly how "record \"new\" has
   no field" ended up being generated once already. */
function stripComments(text) {
  return text.replace(/^[ \t]*--.*$/gm, '');
}

function splitStatements(text) {
  const out = [];
  let i = 0, start = 0;
  const push = (end) => { const raw = text.slice(start, end); if (raw.trim()) out.push(raw.trim()); };
  while (i < text.length) {
    const jump = skipToken(text, i);
    if (jump >= 0) { i = jump; continue; }
    if (text[i] === ';') { push(i); i++; start = i; continue; }
    i++;
  }
  push(text.length);
  return out;
}

/* text[from] must be '('. Returns the index of its matching ')'. */
function matchParen(text, from) {
  if (text[from] !== '(') throw new Error('matchParen: no "(" at ' + from + ' (found ' + JSON.stringify(text[from]) + ')');
  let depth = 0, i = from;
  while (i < text.length) {
    const jump = skipToken(text, i);
    if (jump >= 0) { i = jump; continue; }
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new Error('matchParen: "(" at ' + from + ' is never closed');
}

/* The top-level comma-separated items inside the parentheses that start at `from`. */
function splitTopInside(text, from) {
  const close = matchParen(text, from);
  const inner = text.slice(from + 1, close);
  const out = [];
  let i = 0, d = 0, start = 0;
  const push = (end) => { const raw = inner.slice(start, end).trim(); if (raw) out.push(raw); };
  while (i < inner.length) {
    const jump = skipToken(inner, i);
    if (jump >= 0) { i = jump; continue; }
    if (inner[i] === '(') d++;
    else if (inner[i] === ')') d--;
    else if (inner[i] === ',' && d === 0) { push(i); i++; start = i; continue; }
    i++;
  }
  push(inner.length);
  return out;
}

module.exports = { skipToken, stripComments, splitStatements, matchParen, splitTopInside, isWordEnd };
