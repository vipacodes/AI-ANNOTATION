/* Proves the LOCK on a deployed site, from the outside, the way a stranger and a buyer would
   arrive. It is deliberately blunt about the one thing that matters: a protected file must not be
   reachable without a key, and must not be reachable through a CDN cache after somebody else
   unlocked it.

     SUPABASE_ACCESS_TOKEN=... SITE_URL=https://<ref>.supabase.co/functions/v1/annotate \
       node tools/verify-buyer-flow.js
     … --mint   mints a 30-day key into the ledger first (needs the token)
     … --key=<key>   use a key you already sold
   Keys created here are left in the ledger labelled "Buyer flow test"; revoke them with
     update public.access_keys set revoked_at = now() where label = 'Buyer flow test';        */
'use strict';
const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const SLUG = process.env.FUNC_SLUG || 'annotate';
const BASE = SITE || ('https://' + (process.env.SUPABASE_REF || 'veecksfcnlpppzvplcyt') + '.supabase.co/functions/v1/' + SLUG);
const { query, harness } = require('./supabase-api.js');

const A = harness('live buyer flow');
const hit = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, body: await r.text(), cookie: r.headers.get('set-cookie') || '', headers: r.headers };
};
const jsonPost = (p, obj, headers) => hit(p, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(obj)
});

(async () => {
  A.section('what is deployed');
  {
    const h = await hit('/api/health');
    let j = {}; try { j = JSON.parse(h.body); } catch (e) { }
    A.ok('GET /api/health answers (' + JSON.stringify(j).slice(0, 120) + ')', h.status === 200 && j.ok === true);
    A.ok('the gate reports itself as ON with a Postgres backend', j.gate === 'on' && j.backend === 'postgres');
    A.ok('the function can see its own configuration (url/service/anon all "configured")',
      j.url === 'configured' && j.service === 'configured' && j.anon === 'configured');
    const d = await hit('/api/debug');
    let dj = {}; try { dj = JSON.parse(d.body); } catch (e) { }
    A.ok('the private bucket is readable from inside the function (HTTP ' + (dj.bucket && dj.bucket.status) + ', ' + (dj.bucket && dj.bucket.bytes) + ' bytes)',
      dj.bucket && dj.bucket.status === 200 && dj.bucket.bytes > 1000);
    A.ok('no route leaks the service key (debug output has no 30+ char token)', !/[A-Za-z0-9_\-]{30,}\.eyJ|eyJ[A-Za-z0-9_\-]{30,}/.test(d.body));
  }

  A.section('1 · a stranger, no key');
  {
    for (const [p, label] of [['/index.html', 'landing'], ['/platforms.html', 'platform catalogue'], ['/guide.html', 'guide'], ['/buy.html', 'pricing']]) {
      const r = await hit(p);
      A.ok('the free ' + label + ' loads: HTTP ' + r.status, r.status === 200 && r.body.length > 500);
    }
    const locked = await hit('/task.html');
    A.ok('a protected page is WITHHELD: HTTP ' + locked.status, locked.status === 402);
    A.ok('  …the body is the gate screen, and no part of the real page leaked into it',
      /paste the key/i.test(locked.body) && !/Tasks\.run|grader|rubric/i.test(locked.body));
    const corpus = await hit('/js/tasks.js');
    A.ok('the graded corpus is withheld as a ' + corpus.body.length + '-byte stub (HTTP ' + corpus.status + ')',
      corpus.status === 402 && corpus.body.length < 200);
    const det = await hit('/js/detector.js');
    A.ok('the detector module is withheld too: HTTP ' + det.status, det.status === 402);
    const css = await hit('/css/app.css');
    A.ok('the gate can still style itself (public css is served): HTTP ' + css.status + ' (' + css.body.length + ' bytes)', css.status === 200);
    const miss = await hit('/definitely-not-a-page.html');
    A.ok('an unlisted path 404s rather than 402s (no hint about what exists here)', miss.status === 404);
    const trav = await hit('/../etc/passwd');
    A.ok('path traversal cannot reach outside the bucket (HTTP ' + trav.status + ')', trav.status !== 200);
    A.ok('every withheld response says no-store, so a CDN cannot hand my refusal to the next person',
      /no-store/i.test((await hit('/task.html')).headers.get('cache-control') || ''));
  }

  A.section('2 · unlocking');
  let key = process.env.ACCESS_KEY || '';
  if (!key && process.argv.includes('--mint')) {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const out = execFileSync('node', [path.join(__dirname, 'keygen.js'), 'new', '--label', 'Buyer flow test', '--days', '30', '--sql'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    key = out.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9]{7}\.[A-Za-z0-9_\-]{28}\.\d{13}$/.test(l)) || '';
    const [id, , exp] = key.split('.');
    await query("insert into public.access_keys (id, label, exp_ms, days) values ('" + id + "','Buyer flow test'," + exp + ",30) on conflict (id) do nothing;");
  }
  if (!key) { A.ok('no ACCESS_KEY given and --mint not passed: skipping the authenticated half', false); }
  else {
    const [id, sig, exp] = key.split('.');
    const badId = await jsonPost('/unlock', { key: 'zz9zzzz.' + sig + '.' + exp });
    A.ok('a real signature under the wrong id is refused: HTTP ' + badId.status, badId.status === 402);
    const forged = await jsonPost('/unlock', { key: id + '.' + 'A'.repeat(28) + '.' + exp });
    A.ok('a forged signature is refused: HTTP ' + forged.status, forged.status === 402);
    const expired = await jsonPost('/unlock', { key: id + '.' + sig + '.1000000000000' });
    A.ok('an expired key is told "expired", not "bogus": ' + (JSON.parse(expired.body).error || '').slice(0, 44),
      expired.status === 402 && /expired/i.test(expired.body));
    A.ok('and the refusal never explains which half of the key failed',
      !/signature|row|ledger/.test(forged.body + badId.body));

    const good = await jsonPost('/unlock', { key });
    A.ok('the real key is accepted: ' + good.body.slice(0, 80), good.status === 200);
    const c = good.cookie;
    A.ok('the cookie is HttpOnly', /HttpOnly/i.test(c));
    A.ok('SameSite=Lax (returns from a payment page, is not sent by third-party embeds)', /SameSite=Lax/i.test(c));
    // On Supabase the function lives at /functions/v1/<slug>, so SITE_BASE must scope the cookie
    // there; a bare Path=/ would hand the key to every other path on *.supabase.co.
    const pathMatch = /Path=([^;]+)/i.exec(c);
    A.ok('its Path is the mount the browser calls (' + (pathMatch ? pathMatch[1] : 'none') + ')',
      !!pathMatch && pathMatch[1] !== '' && (/^\/functions\/v1\//.test(pathMatch[1]) || pathMatch[1] === '/'));
    A.ok('Max-Age is finite (a permanent cookie would outlive the refund window)', /Max-Age=\d{6,9}/.test(c));

    const cookie = 'at_key=' + encodeURIComponent(key);
    const withCookie = (p) => hit(p, { headers: { cookie } });
    const page = await withCookie('/task.html');
    A.ok('the protected page serves on the strength of the cookie alone: HTTP ' + page.status + ' (' + page.body.length + ' bytes)',
      page.status === 200 && page.body.length > 5000);
    const cor = await withCookie('/js/tasks.js');
    A.ok('the real corpus serves: HTTP ' + cor.status + ' (' + cor.body.length + ' bytes)', cor.status === 200 && cor.body.length > 20000);
    A.ok('  …and that authenticated 200 is NOT cacheable (this is the leak to watch for)',
      !/max-age=[1-9]/.test(cor.headers.get('cache-control') || ''), );
    const again = await hit('/js/tasks.js');
    A.ok('  …and the same URL still refuses a stranger afterwards: HTTP ' + again.status + ' (' + again.body.length + ' bytes)',
      again.status === 402 && again.body.length < 200);
    const sess = await withCookie('/session');
    A.ok('/session knows who you are: ' + sess.body.slice(0, 90), sess.status === 200 && /until/.test(sess.body));
    const hdr = await hit('/task.html', { headers: { 'x-access-key': key } });
    A.ok('the x-access-key header path works too (for scripts): HTTP ' + hdr.status, hdr.status === 200);
  }

  A.section('3 · revocation, live');
  if (key) {
    const [id] = key.split('.');
    // Present it two ways, because a browser uses the cookie and curl-with-a-token uses the
    // header, and a revoke has to stop BOTH. (Passing {at_key: key} as a *header* is not either of
    // those; the function reads only the cookie named at_key or x-access-key.)
    const cookie = 'at_key=' + encodeURIComponent(key);
    const hdr = { 'x-access-key': key };
    await query("update public.access_keys set revoked_at = now() where id='" + id + "';");
    const r = await hit('/task.html', { headers: hdr });
    A.ok('a page that was open is withheld on the next request the moment you revoke: HTTP ' + r.status, r.status === 402);
    const s = await hit('/session', { headers: hdr });
    A.ok('  …for a header client too, and /session says why: ' + (s.body || '').slice(0, 60), /revoked/i.test(s.body));
    const viaCookie = await hit('/task.html', { headers: { cookie } });
    A.ok('  …and the already-issued cookie stops working without the buyer doing anything: HTTP ' + viaCookie.status, viaCookie.status === 402);
    await query("update public.access_keys set revoked_at = null where id='" + id + "';");
    const back = await hit('/task.html', { headers: hdr });
    A.ok('and un-revoking restores it with nothing else touched: HTTP ' + back.status, back.status === 200);
  }
  process.exit(A.done(BASE));
})().catch((e) => { console.error('\n   \u2717 ' + (e && e.message || e)); process.exit(1); });
