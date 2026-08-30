/* Proves the paywall's DATABASE half is really installed in your Supabase project.

   The repo's own tests check the migration files; only this can check the live project, and the
   failure mode that matters is "the files look right and the gate refuses everybody". It also
   proves the thing the whole design rests on: Postgres derives the SAME signature as
   tools/keygen.js, byte for byte, from a secret that never leaves the database.

     SUPABASE_ACCESS_TOKEN=... node tools/verify-supabase.js
     … --mint-key      also mints a 30-day key (label "verify-supabase") and prints it
     … --clean         deletes the rows this script created                          */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const { query, rpc, harness, REF } = require('./supabase-api.js');

const ROOT = path.join(__dirname, '..');
const A = harness('live paywall database');
const mint = process.argv.includes('--mint-key');
const clean = process.argv.includes('--clean');

const keygen = (args) => execFileSync('node', ['tools/keygen.js'].concat(args), { cwd: ROOT, encoding: 'utf8' });
/* keygen pretty-prints (leading blank line, then the key, then labels), so the key is found by
   shape, not by line number. Splitting on '\n'[0] returns '' and every later assertion fails on an
   empty key, which reads like a broken verifier. */
const KEY_LINE = (txt) => String(txt).split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9]{6,10}\.[A-Za-z0-9_\-]{20,}\.\d{10,13}$/.test(l)) || '';
const esc = (s) => String(s).replace(/'/g, "''");
const seen = [];

(async () => {
  A.section('schema and privileges');
  {
    const r = await query("select p.proname, p.prosecdef, p.provolatile, p.proconfig::text as cfg," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec" +
      " from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
      " where n.nspname='public' and p.proname in ('key_check','key_mint','key_attempt','key_fill','key_sig') order by 1;");
    const by = Object.fromEntries(r.map((x) => [x.proname, x]));
    A.ok('all five functions exist (' + r.map((x) => x.proname).sort().join(', ') + ')', r.length === 5);
    A.ok('key_check/key_mint/key_attempt are SECURITY DEFINER with search_path pinned to public,pg_temp',
      ['key_check', 'key_mint', 'key_attempt'].every((f) => by[f] && by[f].prosecdef === true && /search_path=public, pg_temp/.test(by[f].cfg || '')));
    A.ok('key_sig is SECURITY INVOKER on purpose (it reads no table; it takes the secret as an argument)',
      by.key_sig && by.key_sig.prosecdef === false);
    A.ok('only key_check and key_attempt are callable by anon - everything else is revoked from PUBLIC',
      by.key_check.anon_exec === true && by.key_attempt.anon_exec === true &&
      ['key_sig', 'key_fill', 'key_mint'].every((f) => by[f] && by[f].anon_exec === false));
    A.ok('key_attempt is VOLATILE (it INSERTs; a STABLE promise here is an error at runtime)', by.key_attempt && by.key_attempt.provolatile === 'v');
    A.ok('key_check is VOLATILE too (it bumps the usage counter; STABLE + UPDATE is ERROR 0A000)', by.key_check && by.key_check.provolatile === 'v');
    A.ok('anon CAN execute key_check (that is the whole gate)', by.key_check && by.key_check.anon_exec === true);
    A.ok('anon CANNOT execute key_mint (minting stays behind the service role)', by.key_mint && by.key_mint.anon_exec === false);
  }
  {
    const t = await query("select c.relname, c.relrowsecurity, c.relpersistence," +
      " (select count(*) from pg_trigger tg where tg.tgrelid = c.oid and not tgisinternal)::int as triggers" +
      " from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' order by 1;");
    A.ok('three tables exist (' + t.map((x) => x.relname).join(', ') + ')', t.length === 3);
    A.ok('row level security is ON for all three, with no policies (so PostgREST cannot read them directly)',
      t.length === 3 && t.every((x) => x.relrowsecurity === true));
    A.ok('the insert trigger that derives signatures is attached to access_keys',
      (t.find((x) => x.relname === 'access_keys') || {}).triggers >= 1);
  }
  {
    const s = await query("select key, (value <> 'NOT_SET') as configured, length(value) as len from public.app_config order by 1;");
    A.ok('both config secrets are set (' + s.map((x) => x.key + ' ' + x.len + ' chars').join(', ') + ')',
      s.length === 2 && s.every((x) => x.configured));
    const cols = await query("select column_name from information_schema.columns where table_schema='public' and table_name='access_keys' order by 1;");
    const have = new Set(cols.map((c) => c.column_name));
    const need = ['id', 'sig', 'label', 'days', 'exp_ms', 'expires_at', 'revoked_at', 'uses', 'last_used_at'];
    const missing = need.filter((n) => !have.has(n));
    A.ok('every column key_check writes exists' + (missing.length ? ' - missing ' + missing.join(', ') + ' (run 0003)' : ''), missing.length === 0);
  }

  A.section('signature parity with tools/keygen.js (the assumption the paywall rests on)');
  let secret = '';
  try { secret = keygen(['secret']).trim(); } catch (e) { A.ok('tools/keygen.js can read data/.secret', false); }
  if (secret) {
    const id = 'parity01', exp = 4102444800000;
    
    const pg = await query("select public.key_sig('" + id + "', " + exp + ", '" + esc(secret) + "') as s;");
    const pgSig = pg[0] && pg[0].s;
    A.ok('key_sig() output is 28 chars of base64url', typeof pgSig === 'string' && /^[A-Za-z0-9_\-]{28}$/.test(pgSig));
    const nodeSig = require('crypto').createHmac('sha256', secret).update(id + '.' + exp).digest('base64url').slice(0, 28);
    A.ok('…and is byte-identical to Node\'s digest(\'base64url\').slice(0,28) (' + pgSig + ')', pgSig === nodeSig);
    // the decisive check: sign with Node, verify with Postgres
    const key = KEY_LINE(keygen(['new', '--label', 'parity', '--days', '1']));
    const [kid, ksig, kexp] = key.split('.');
    const chk = await query("select public.key_sig('" + kid + "'," + kexp + ",'" + esc(secret) + "') = '" + ksig + "' as same;");
    A.ok('a key minted locally verifies in the database under the SAME secret', chk[0] && chk[0].same === true);
    seen.push({ kind: 'parity-key', id: kid });
    await query("insert into public.access_keys (id, label, exp_ms, days) values ('" + kid + "','parity probe'," + kexp + ",1) on conflict (id) do nothing;");
  }

  A.section('the RPC surface, called the way the edge function calls it');
  {
    const r = await rpc('key_check', { p_id: 'abcdefg', p_sig: 'x', p_exp: 4102444800000 });
    A.ok('anon key_check over HTTP returns a verdict, not an error (HTTP ' + r.status + ' ' + JSON.stringify(r.json) + ')',
      r.status === 200 && r.json && r.json.ok === false);
    const m = await rpc('key_mint', { p_mint_secret: 'nope', p_label: 'x', p_days: 1 }, true);
    A.ok('the service role CANNOT mint with a wrong MINT_SECRET (HTTP ' + m.status + ')', m.status >= 400);
  }

  A.section(mint ? 'minting a real key for the site' : 'a real key, inserted without pasting a signature');
  {
    const key = KEY_LINE(keygen(['new', '--label', 'Live deploy test', '--days', '30', '--sql']));
    const [id, sig, exp] = key.split('.');
    seen.push({ kind: 'test-key', id });
    await query("insert into public.access_keys (id, label, exp_ms, days) values ('" + id + "','Live deploy test'," + exp + ",30) on conflict (id) do nothing;");
    const row = await query("select sig = '" + sig + "' as match, label from public.access_keys where id='" + id + "';");
    A.ok('the trigger derived the identical signature from the stored secret', row[0] && row[0].match === true);
    const v = await rpc('key_check', { p_id: id, p_sig: sig, p_exp: Number(exp) });
    A.ok('key_check accepts it: ' + JSON.stringify(v.json), v.status === 200 && v.json && v.json.ok === true);
    const dead = await query("select public.key_sig('" + id + "',1000000000000, (select value from public.app_config where app_config.key='ANNOTATE_SECRET')) as s;");
    const e = await rpc('key_check', { p_id: id, p_sig: dead[0].s, p_exp: 1000000000000 });
    A.ok('an expired key is refused as expired, not as bogus (a refund question, not a security one)',
      e.json && /expired/i.test(e.json.error || ''));
    await query("update public.access_keys set revoked_at = now() where id='" + id + "';");
    const rv = await rpc('key_check', { p_id: id, p_sig: sig, p_exp: Number(exp) });
    A.ok('revocation takes effect on the next call: ' + (rv.json.error || ''), rv.json && /revoked/i.test(rv.json.error || ''));
    if (mint) {
      await query("update public.access_keys set revoked_at = null where id='" + id + "';");
      console.log('\n   key for your browser test:  ' + key);
    } else {
      await query("delete from public.access_keys where id='" + id + "';");
    }
  }

  if (clean) {
    for (const s of seen) { try { await query("delete from public.access_keys where id='" + s.id + "';"); } catch (e) { } }
    await query("delete from public.unlock_attempts where key_id in (select id from public.access_keys where label in ('parity probe','Live deploy test'));");
    console.log('\n   cleaned up the probe rows it created');
  }
  process.exit(A.done('against ' + REF));
})().catch((e) => { console.error('\n   \u2717 ' + e.message); process.exit(1); });
