#!/usr/bin/env node
/*
  AnnotateTrainer — key issuer.

    node tools/keygen.js new --label "Ada C." --days 90
    node tools/keygen.js list
    node tools/keygen.js revoke <id>
    node tools/keygen.js secret          # print/rotate the HMAC secret used by server.js

  Keys are "<id>.<signature>.<expiryMs>". The server verifies them with the secret only, so
  you do not need a database to issue them; data/revoked.txt is only for the ones you cancel early.
  Set the same ANNOTATE_SECRET in the server environment (see DEPLOY.md).
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const SECRET_FILE = path.join(DATA, '.secret');
const REVOKED = path.join(DATA, 'revoked.txt');
const ISSUED = path.join(DATA, 'issued.jsonl');

function secret() {
  if (process.env.ANNOTATE_SECRET) return process.env.ANNOTATE_SECRET;
  fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim();
}
function sign(id, exp) {
  return crypto.createHmac('sha256', secret()).update(id + '.' + exp).digest('base64url').slice(0, 28);
}
function revokedIds() {
  try { return new Set(fs.readFileSync(REVOKED, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)); }
  catch (e) { return new Set(); }
}
function verify(key) {
  const m = String(key || '').trim().match(/^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/);
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  const [, id, sig, exp] = m;
  if (Number(exp) < Date.now()) return { ok: false, error: 'This key expired. Renew it from the payment receipt.' };
  if (sign(id, exp) !== sig) return { ok: false, error: 'This key was not issued by this copy of AnnotateTrainer.' };
  if (revokedIds().has(id)) return { ok: false, error: 'This key has been revoked.' };
  let label = id, until = null;
  try {
    const rec = fs.readFileSync(ISSUED, 'utf8').trim().split('\n').reverse()
      .map((l) => JSON.parse(l)).find((r) => r.id === id);
    if (rec) { label = rec.label; until = rec.until; }
  } catch (e) { }
  return { ok: true, id, label, until: until || new Date(Number(exp)).toISOString().slice(0, 10) };
}

function main() {
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = argv[1] && argv[1].indexOf('--') === 0 ? null : argv[1];
const rest = argv.slice(arg === null && argv[1] ? 1 : 2);
const flags = {};
for (let i = 0; i + 1 < rest.length; i += 2) {
  if (rest[i].indexOf('--') === 0) flags[rest[i].replace(/^--/, '')] = rest[i + 1];
}

if (cmd === 'new') {
  if (arg) { flags.label = arg; }   /* keygen new "label" shorthand */
  const id = crypto.randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8);
  const days = Number(flags.days || 90);
  const exp = Date.now() + days * 864e5;
  const key = id + '.' + sign(id, exp) + '.' + exp;
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(ISSUED, JSON.stringify({
    id, label: flags.label || 'customer', days,
    until: new Date(exp).toISOString().slice(0, 10), at: new Date().toISOString()
  }) + '\n');
  console.log('\n  ' + key + '\n');
  console.log('  label: ' + (flags.label || 'customer') + '  ·  valid ' + days + ' days  ·  id ' + id);
  console.log('  revoke with: node tools/keygen.js revoke ' + id + '\n');
} else if (cmd === 'verify') {
  console.log(JSON.stringify(verify(arg), null, 2));
} else if (cmd === 'list') {
  try {
    fs.readFileSync(ISSUED, 'utf8').trim().split('\n').filter(Boolean).forEach((l) => {
      const r = JSON.parse(l);
      console.log((revokedIds().has(r.id) ? '✗ ' : '✓ ') + r.id.padEnd(10) + (r.label || '').padEnd(22) + r.until + '  ' + r.days + 'd');
    });
  } catch (e) { console.log('no keys issued yet'); }
} else if (cmd === 'revoke') {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(REVOKED, arg + '\n');
  console.log('revoked ' + arg);
} else if (cmd === 'secret') {
  console.log(secret());
} else {
  console.log(cmd ? 'unknown command: ' + cmd + '\n' : 'usage: node tools/keygen.js new [--label X --days N] | list | verify <key> | revoke <id> | secret');
  if (cmd) process.exitCode = 1;
}
}
if (require.main === module) main();

module.exports = { verify };
