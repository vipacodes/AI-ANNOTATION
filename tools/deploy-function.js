#!/usr/bin/env node
/* Deploy supabase/functions/annotate/index.ts through the Supabase Management API, for the case where
   nobody has the CLI: pass an access token as SUPABASE_ACCESS_TOKEN (or keep it in ~/.sb-token) and this
   does what `supabase functions deploy annotate --no-verify-jwt` would do.

     SUPABASE_ACCESS_TOKEN=… node tools/deploy-function.js            # deploy
     SUPABASE_ACCESS_TOKEN=… node tools/deploy-function.js --dry-run  # report what WOULD change

   WHY THE REQUEST LOOKS LIKE THIS. The obvious shapes all fail, each with a message that sends you the
   wrong way:
     POST /v1/projects/<ref>/deploy-functions        → 404 (no such route)
     POST …/functions/deploy with a JSON body        → 400 "Invalid multipart boundary"
     multipart with the source part NAMED by its path → 400 "Entrypoint path does not exist"
     multipart with the source part named `file`      → 201
   So: multipart, `metadata` (a JSON blob naming entrypoint_path/name/verify_jwt) plus ONE part literally
   called `file` whose *filename* is the repo-relative path. entrypoint_path is not a content field, it
   is where the server unpacks the file — which is why a wrong name produces "path does not exist" rather
   than a validation error.

   Nothing here prints the token. The version number in the output is the proof of deployment;
   `tools/verify-supabase.js` then checks the deployed BUILD string against the file. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REF = process.env.SUPABASE_REF || 'veecksfcnlpppzvplcyt';
const SLUG = process.env.SUPABASE_SLUG || 'annotate';
const REL = 'supabase/functions/' + SLUG + '/index.ts';
const LOCAL = path.join(ROOT, REL);

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  for (const f of [path.join(process.env.HOME || '/home/user', '.sb-token')]) {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  }
  throw new Error('no token: export SUPABASE_ACCESS_TOKEN or write it to ~/.sb-token (chmod 600)');
}

const buildOf = (src) => {
  const m = /const BUILD = '([^']+)'/.exec(src);
  return m ? m[1] : null;
};

(async () => {
  if (!fs.existsSync(LOCAL)) { console.error('✗ ' + REL + ' not found from ' + ROOT); process.exit(1); }
  const src = fs.readFileSync(LOCAL);
  const build = buildOf(src.toString('utf8'));
  if (!build) { console.error('✗ no `const BUILD = \'…\'` in the entry point — the deployed build is unverifiable without it'); process.exit(1); }

  const health = async () => {
    const r = await fetch('https://' + REF + '.supabase.co/functions/v1/' + SLUG + '/api/health');
    return r.ok ? await r.json() : { error: 'HTTP ' + r.status };
  };
  const before = await health().catch((e) => ({ error: String(e.message || e) }));
  console.log('  local   : ' + REL + ' (' + src.length + ' B), BUILD ' + build);
  console.log('  deployed: build ' + (before.build || '?') + ', version ' + (before.version || '?') +
    ', gate ' + (before.gate || '?') + ', ' + (before.backend || '?'));
  if (before.build === build && process.argv.indexOf('--dry-run') < 0) {
    console.log('  same BUILD string as what is live — deploying anyway, since the constant is only bumped\n  on purpose and a forgotten bump is exactly how a stale function keeps serving an old gate.');
  }
  if (process.argv.indexOf('--dry-run') >= 0) { console.log('✓ dry run, nothing sent'); return; }

  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify({ entrypoint_path: REL, name: SLUG, verify_jwt: false })],
    { type: 'application/json' }), 'metadata');
  fd.append('file', new Blob([src], { type: 'application/typescript' }), REL);

  const url = 'https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?project_ref=' + REF +
    '&slug=' + SLUG + '&check_cache=false';
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token() }, body: fd });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* fall through with the raw body */ }
  if (!res.ok) {
    console.error('✗ deploy failed: HTTP ' + res.status + ' ' + text.slice(0, 400));
    if (res.status === 400 && /Invalid multipart/.test(text)) console.error('  (this endpoint only accepts multipart; a JSON body is rejected on purpose)');
    process.exit(1);
  }
  console.log('  deployed: version ' + (j && j.version) + ', status ' + (j && j.status));

  // An edge function restart is asynchronous; polling on the BUILD string is the only honest wait, since
  // a 201 with an unchanged build is precisely the "deployed but still serving the old one" state.
  for (let t = 0; t < 30; t++) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await health().catch(() => ({}));
    if (now.build === build) {
      console.log('✓ live: build ' + now.build + ' · gate ' + now.gate + ' · ' + now.backend +
        (now.crypto ? ' · crypto ' + (now.crypto.status || now.crypto) : ''));
      process.exit(0);
    }
  }
  console.error('✗ deployed (201) but /api/health still reports the previous build after 30 s — re-check by hand:');
  console.error('   curl -s https://' + REF + '.supabase.co/functions/v1/' + SLUG + '/api/health');
  process.exit(1);
})();
