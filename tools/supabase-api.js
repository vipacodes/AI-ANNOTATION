/* Shared plumbing for the live-verification tools (tools/verify-*.js, tools/upload-site.js).

   Deliberately not a dependency: no SDK, no install step, just the two HTTP surfaces the deploy
   actually uses — the Management API (run SQL, deploy functions, set secrets) and the project's
   own REST/storage endpoints. Keeping it in one file is also what lets the tools assert things in
   plain SQL instead of me eyeballing a JSON blob in chat.

     SUPABASE_ACCESS_TOKEN=<token>  required for .query() (a personal access token, not the key)
     SUPABASE_REF=<project ref>     required; defaults to this project so the docs can show output
     SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY  required for .rest()/.storage() against the project

   No value is ever printed by this module, and no value is read from a file that git tracks.   */
'use strict';
const https = require('https');

const REF = process.env.SUPABASE_REF || 'veecksfcnlpppzvplcyt';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const SERVICE = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const ANON = process.env.ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const PROJECT_URL = process.env.PROJECT_URL || ('https://' + REF + '.supabase.co');

function request(opts, body, raw) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      if (raw) {
        // Binary fidelity: a PNG read back as a utf8 string is NOT the file, and comparing that to a
        // hash of the file would report a corrupt upload as correct. Collect the chunks instead.
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, buffer, body: buffer.toString('utf8'), headers: res.headers });
        });
        return;
      }
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => s += d);
      res.on('end', () => resolve({ status: res.statusCode, body: s, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* Run SQL through the Management API. Returns parsed rows; throws with Postgres' own message,
   because "HTTP 400" would hide the one line (42883, 42702, 22003, 0A000 …) that names the bug. */
async function query(sql) {
  if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN is not set, so this tool cannot reach the database');
  const body = JSON.stringify({ query: sql });
  const r = await request({
    hostname: 'api.supabase.com', port: 443, method: 'POST',
    path: '/v1/projects/' + REF + '/database/query',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
  }, body);
  if (r.status >= 400) {
    let msg = r.body;
    try { msg = JSON.parse(r.body).message || r.body; } catch (e) { }
    throw new Error('SQL ' + r.status + ': ' + String(msg).replace(/^Failed to run sql query:\s*/, '').slice(0, 400));
  }
  try { return JSON.parse(r.body || '[]'); } catch (e) { return r.body; }
}

/* Call a PostgREST RPC as anon or as the service role. Used to prove the grants are the ones the
   gate relies on — key_check must be reachable with the public key, key_mint must not be. */
async function rpc(fn, args, asService) {
  const key = asService ? SERVICE : ANON;
  if (!key) throw new Error(asService ? 'SERVICE_ROLE_KEY is not set' : 'ANON_KEY is not set');
  const body = JSON.stringify(args || {});
  const r = await request({
    hostname: new URL(PROJECT_URL).hostname, port: 443, method: 'POST',
    path: '/rest/v1/rpc/' + fn,
    headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
  }, body);
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (e) { }
  return { status: r.status, json: parsed, text: r.body };
}

/* Raw call to the project (storage object GET/POST, /api/health of a function, …). */
async function project(path, opts) {
  const o = Object.assign({ method: 'GET' }, opts || {});
  const headers = Object.assign({ apikey: SERVICE || ANON }, o.headers || {});
  // an explicit authorization in opts means "use this, not the default key" — including the empty
  // string, which is how a tool asks "is this reachable with no credentials at all?". Silently
  // overwriting that makes a security probe read as a failure of the server.
  if (SERVICE && o.headers && o.headers.authorization === '') delete headers.apikey;
  else if (SERVICE && !(o.headers && 'authorization' in o.headers)) headers.authorization = 'Bearer ' + SERVICE;
  const body = o.body;
  const r = await request({
    hostname: new URL(PROJECT_URL).hostname, port: 443, method: o.method, path,
    headers: Object.assign({}, headers, body ? { 'content-length': Buffer.byteLength(body) } : {})
  }, body, !!o.raw);
  return r;
}

/* A tiny assertion runner, so each tool prints the same ✓/✗ shape as tests/verify.js. */
function harness(title) {
  let pass = 0; const fails = [];
  console.log('\n\u2550'.repeat(58));
  console.log(' ' + title + '  ·  project ' + REF);
  console.log('\u2550'.repeat(58));
  return {
    section: (t) => console.log('\n\u250c\u2500 ' + t),
    ok: (m, c) => { if (c) { pass++; console.log('   \u2713 ' + m); } else { fails.push(m); console.log('   \u2717 ' + m); } },
    done: (extra) => {
      console.log('\n' + '\u2550'.repeat(58));
      if (fails.length) { console.log('\u2717 ' + fails.length + ' failure(s)'); fails.forEach((f) => console.log('   - ' + f)); return 1; }
      console.log('\u2713 ' + title + ': ' + pass + ' checks passed' + (extra ? ' \u2014 ' + extra : ''));
      return 0;
    },
    get fails() { return fails; }
  };
}

module.exports = { query, rpc, project, harness, REF, PROJECT_URL, hasToken: !!TOKEN, hasService: !!SERVICE, hasAnon: !!ANON };

if (module === require.main) {
  (async () => {
    console.log('checking reachability of project ' + REF + ' …');
    if (!TOKEN) { console.log('  Management API : no token (set SUPABASE_ACCESS_TOKEN)'); }
    else { const r = await query('select current_setting(\'server_version\') as v, (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=\'public\' and relkind=\'r\')::int as tables;'); console.log('  Postgres       :', JSON.stringify(r[0])); }
    console.log('  service key    :', SERVICE ? 'present' : 'absent (storage/function probes will skip)');
    console.log('  anon key       :', ANON ? 'present' : 'absent');
  })().catch((e) => { console.error('  \u2717 ' + e.message); process.exit(1); });
}
