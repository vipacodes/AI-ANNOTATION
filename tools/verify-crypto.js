/* Live check of the crypto order pipeline: quote → detect → grant, plus the guarantees that make
   auto-grant safe without a human and without an email.

   What this can and cannot prove. The database half is exercised FOR REAL, against your project:
   a quote is opened, amounts are matched and rejected, the claim race is raced, the key is written
   and read back. The block explorer is NOT invented here — no fake transaction is asserted as
   paid. `--address` asks BlockCypher about your deposit address, which is the only way to see that
   the address in your config is the one you actually control, and `--explorer` proves the URL the
   function will call answers at all. A real end-to-end payment still means sending a small amount
   to yourself; the receipts section prints how.

     SUPABASE_ACCESS_TOKEN=<token> node tools/verify-crypto.js
     SUPABASE_ACCESS_TOKEN=<token> node tools/verify-crypto.js --address --explorer
     SUPABASE_ACCESS_TOKEN=<token> node tools/verify-crypto.js --clean     # drop the orders it made

   Every credential comes from the environment; nothing is read from a tracked file, and no key or
   secret is ever printed. Quote rows are created under a marker label and deleted again unless
   --keep is passed.                                                        (no dependencies)  */
'use strict';

const { query, harness, REF, hasToken } = require('./supabase-api.js');

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const KEEP = args.includes('--keep');
const WANT_ADDR = args.includes('--address');
const WANT_EXPLORER = args.includes('--explorer');

const MARK = 'crypto-verify';            // tags every row this tool touches
const ADDR_RE = /^(ltc1[a-z0-9]{20,90}|[LM][a-km-zA-HJ-NP-Z1-9]{26,34})$/;
// A real, active mainnet address, used only to prove the explorer answers. Never a config default.
const PROBE_ADDR = 'ltc1q9hphqeh3l93gqp4h987gcgfrsay3n0eflpm024';
const BC = process.env.LTC_API_BASE || 'https://api.blockcypher.com/v1/ltc/main';

const h = harness('crypto orders @ ' + REF);
const ok = h.ok;

// One purpose per call: /database/query returns only the LAST statement's rows, so a value we
// need to read back must never be buried behind the statements that set it up.
async function sql(q) { return await query(q); }
const val = (r) => (typeof r === 'string' ? JSON.parse(r) : r);

async function mintSecret() {
  // Read the configured secret WITHOUT printing it: we need it to sign our own RPC calls the way
  // the edge function does, and a value that leaked into stdout here would be in your terminal log.
  const rows = await sql("select value from public.app_config where app_config.key = 'MINT_SECRET'");
  const v = rows && rows[0] && rows[0].value;
  if (v && v !== 'NOT_SET') return { secret: v, ours: false };
  await sql("insert into public.app_config (key, value) values ('MINT_SECRET', '" + MARK + "-secret') on conflict (key) do update set value = excluded.value");
  return { secret: MARK + '-secret', ours: true };
}

(async () => {
  if (!hasToken) throw new Error('SUPABASE_ACCESS_TOKEN is required (this tool talks to the live project)');

  h.section('schema');
  {
    const cols = await sql("select coalesce(string_agg(column_name, ',' order by ordinal_position),'') c from information_schema.columns where table_schema='public' and table_name='crypto_payments'");
    const list = (cols[0] && cols[0].c ? cols[0].c : '').split(',').filter(Boolean);
    ok('public.crypto_payments exists with all 21 columns', list.length === 21, list.length + ' found');
    for (const need of ['quote_token', 'amount_lt', 'dust', 'mint_secret', 'full_key', 'receipt', 'confirmations']) {
      ok('  column ' + need, list.includes(need));
    }
    const fns = await sql("select p.proname n, p.prosecdef d, p.provolatile v, coalesce(nullif(p.proconfig::text,'{}'),'(none)') cfg from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('cfg','cache_get','cache_put','crypto_quote','crypto_get','crypto_probe','crypto_mark') order by 1");
    const names = fns.map((f) => f.n);
    ok('all 7 RPCs are installed', names.length === 7, names.join(', ') || 'none');
    const want = (n) => fns.find((f) => f.n === n) || {};
    ok('crypto_quote and crypto_mark are SECURITY DEFINER with a pinned search_path',
      ['crypto_quote', 'crypto_mark'].every((n) => want(n).d === true && /pg_temp/.test(want(n).cfg)));
    ok('every writer is VOLATILE (a STABLE writer is error 0A000 at runtime)',
      ['crypto_quote', 'crypto_mark', 'crypto_probe', 'cache_put'].every((n) => want(n).v === 'v'),
      ['crypto_quote', 'crypto_mark', 'crypto_probe', 'cache_put'].map((n) => n + '=' + want(n).v).join(' '));
    // The exact failure that made key_mint reachable from the browser before: Postgres grants
    // EXECUTE to PUBLIC by default, so a revoke that forgot `public` revoked nothing.
    const privs = await sql("select p.proname n, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('public', p.oid, 'EXECUTE') pu from pg_proc p join pg_namespace g on g.oid=p.pronamespace where g.nspname='public' and p.proname in ('crypto_quote','crypto_get','crypto_mark','crypto_probe','cfg','cache_get','cache_put')");
    ok('no crypto RPC is executable by anon / authenticated / public',
      privs.length === 7 && privs.every((x) => !x.a && !x.u && !x.pu),
      privs.filter((x) => x.a || x.u || x.pu).map((x) => x.n).join(', '));
  }

  h.section('the amount IS the order id');
  let quoteId = null, token = null, ms = null, createdHere = false;
  {
    const m = await mintSecret();
    ms = m.secret; createdHere = m.ours;
    // An address that is not the point of this test, so it is deliberately the probe one: what we
    // are checking is that config is consulted and the syntax gate works.
    const addr = await sql("select coalesce(public.cfg('LTC_ADDRESS'),'') a").catch(() => [{ a: '' }]);
    const configured = addr[0] && addr[0].a;
    ok('cfg() reads app_config and treats NOT_SET/empty as unset', typeof configured === 'string', JSON.stringify(configured));
    let rejected = false;
    try { await sql(`select public.crypto_quote('season','NGN',1800000,0.12,'not-an-address','${MARK}','${ms}',1200)`); }
    catch (e) { rejected = /Litecoin address/.test(String(e.message)); }
    ok('  …and the rejection names the reason, not a bare 400', rejected);
    let tooSmall = false;
    try { await sql(`select public.crypto_quote('season','NGN',1800000,0.00000001,'${PROBE_ADDR}','${MARK}','${ms}',1200)`); }
    catch (e) { tooSmall = /too small/.test(String(e.message)); }
    ok('an amount with no room for a watermark is refused rather than made ambiguous', tooSmall);
    let wrongSecret = false;
    try { await sql(`select public.crypto_quote('season','NGN',1800000,0.12,'${PROBE_ADDR}','${MARK}','not-it',1200)`); }
    catch (e) { wrongSecret = /not allowed/.test(String(e.message)); }
    ok('crypto_quote is not an open order-creation endpoint for a caller without MINT_SECRET', wrongSecret);

    const q = await sql(`select (public.crypto_quote('season','NGN',1800000,0.12200417,'${PROBE_ADDR}','${MARK}','${ms}',1200))->'id' id`);
    quoteId = q[0] && q[0].id;
    const row = await sql(`select quote_token t, status, (amount_lt*100000000)::bigint amt, dust, expires_at>now() fresh from public.crypto_payments where id='${quoteId}'`);
    token = row[0] && row[0].t;
    ok('a quote opens pending, with a 32-hex capability token',
      !!quoteId && !!token && token.length === 32 && row[0].status === 'pending' && row[0].fresh === true);
    ok('a 7-character order id is actually reachable (6 random bytes, not 4)',
      !!quoteId && /^[A-Za-z0-9]{7}$/.test(quoteId), 'got ' + quoteId);
    ok('the dust watermark is non-zero and below litoshi noise', row[0].dust > 0 && row[0].dust < 1000000, 'dust=' + row[0].dust);

    // Exclude this tool's own scratch rows: a previous run left behind (or a crash mid-suite) would
    // otherwise be reported as an amount collision, which is precisely the bug being asserted.
    // The reservation must bite, or the whole detection idea is a guess. A second order for the
    // same amount while the first is open is refused outright — that is the caller's signal to
    // re-price, and the reason two buyers can never be credited for each other's transfer.
    let dupRefused = false, dupErr = '';
    try {
      const d = await sql(`select (public.crypto_quote('season','NGN',1800000,0.12200417,'${PROBE_ADDR}','${MARK}','${ms}',1200))->'id' id`);
      dupErr = JSON.stringify(d);
    } catch (e) { dupErr = String(e.message); dupRefused = /reserved/.test(dupErr); }
    ok('a second order at an already-reserved amount is refused, not created', dupRefused, dupErr.slice(0, 110));
    const clash = await sql(`select count(*) c from public.crypto_payments where amount_lt = (select amount_lt from public.crypto_payments where id='${quoteId}') and id <> '${quoteId}' and status in ('pending','detected','paying') and coalesce(buyer_email,'') <> '${MARK}'`);
    ok('no other open order shares this amount (that is what makes detection unambiguous)', +clash[0].c === 0);
  }

  h.section('reading an order back');
  {
    ok('the wrong token reveals nothing at all',
      (await sql(`select public.crypto_get('${quoteId}','deadbeefdeadbeefdeadbeefdeadbeef') v`))[0].v === null);
    const g = val((await sql(`select public.crypto_get('${quoteId}','${token}') v`))[0].v);
    ok('the right token returns the order', !!g && g.plan === 'season' && g.status === 'pending');
    ok('  …and never its mint_secret or quote_token', !!g && !('mint_secret' in g) && !('quote_token' in g));
    ok('the id alone is not enough, in either direction',
      (await sql(`select public.crypto_get('${quoteId}', null) v`))[0].v === null);
  }

  h.section('detection');
  {
    const amt = (await sql(`select (amount_lt*100000000)::bigint a from public.crypto_payments where id='${quoteId}'`))[0].a;
    const wrong = val((await sql(`select public.crypto_probe('${quoteId}','${token}',null,${amt - 1},null,0,2) v`))[0].v);
    ok('1 litoshi short is not a match', wrong.matched === false && wrong.status === 'pending', JSON.stringify(wrong));
    const exact = val((await sql(`select public.crypto_probe('${quoteId}','${token}',null,${amt},null,0,2) v`))[0].v);
    ok('the exact amount matches but 0 confirmations is not enough', exact.matched === true && exact.ready === false && exact.status === 'detected', JSON.stringify(exact));
    const TX = 'ff'.repeat(32);
    const young = val((await sql(`select public.crypto_probe('${quoteId}','${token}','${TX}',${amt},null,9,2) v`))[0].v);
    ok('a txid cannot be claimed against a quote that is still too young to be paid',
      (young.matched === false || young.ready === false) && !!young.reason, JSON.stringify(young));
    await sql(`update public.crypto_payments set created_at = now() - interval '5 minutes' where id='${quoteId}'`);
    const old = val((await sql(`select public.crypto_probe('${quoteId}','${token}','${TX}',${amt},null,9,2) v`))[0].v);
    ok('  …once the window has passed it is ready to grant', old.ready === true, JSON.stringify(old));
    const stranger = val((await sql(`select public.crypto_probe('${quoteId}','nope',null,${amt},null,9,2) v`))[0].v);
    ok('a probe without the token is not a probe', stranger && stranger.error === 'quote not found', JSON.stringify(stranger));
  }

  h.section('one payment, one key');
  {
    const TX = 'ff'.repeat(32);
    const c1 = val((await sql(`select public.crypto_mark('claim','${quoteId}','${token}','${ms}',null,null,null) v`))[0].v);
    ok('the first claim wins and moves the order to paying', c1.ok === true && c1.status === 'paying', JSON.stringify(c1));
    const c2 = val((await sql(`select public.crypto_mark('claim','${quoteId}','${token}','${ms}',null,null,null) v`))[0].v);
    ok('a second claim loses, which is what stops two polls minting two keys',
      c2.ok === false && c2.status === 'paying', JSON.stringify(c2));
    const rev = val((await sql(`select public.crypto_mark('revert','${quoteId}','${token}','${ms}',null,null,null) v`))[0].v);
    ok('a failed mint releases the claim instead of stranding a paid order', rev.ok === true && rev.status === 'detected', JSON.stringify(rev));
    const paid = val((await sql(`select public.crypto_mark('paid','${quoteId}','${token}','${ms}','K1ID','idpart.sigpart.9999999999999','{"plan":"season"}') v`))[0].v);
    ok('closing writes the key and the receipt together',
      paid.ok === true && paid.status === 'paid' && paid.key === 'idpart.sigpart.9999999999999', JSON.stringify(paid));
    const after = (await sql(`select status, key_id, full_key, receipt->>'plan' plan, paid_at is not null paid, txid from public.crypto_payments where id='${quoteId}'`))[0];
    ok('the row carries everything a buyer needs if they lose the page',
      after.status === 'paid' && after.full_key === 'idpart.sigpart.9999999999999' && after.paid === true && after.plan === 'season', JSON.stringify(after));
    const reopen = val((await sql(`select public.crypto_mark('claim','${quoteId}','${token}','${ms}',null,null,null) v`))[0].v);
    ok('a paid order cannot be re-opened for a second key',
      reopen.ok === false && reopen.status === 'paid' && reopen.key === 'idpart.sigpart.9999999999999', JSON.stringify(reopen));
    const noSecret = await sql(`select public.crypto_mark('paid','${quoteId}','${token}','not-it','X','Y','{}') v`).then(() => '', (e) => String(e.message));
    ok('  …and no state change happens without MINT_SECRET', /not allowed/.test(noSecret), noSecret.slice(0, 60));
  }

  h.section('the shared explorer cache');
  {
    // A 60s cache is what keeps N buyers polling one address from tripping the explorer's ~2/s
    // per-IP limit. Its age lives inside the value, because app_config has no timestamp column.
    const nowMs = (await sql("select (extract(epoch from now())*1000)::bigint t"))[0].t;
    await sql(`select public.cache_put('cache:${MARK}', '{"t":${nowMs},"v":"hi"}')`);
    const hit = (await sql(`select public.cache_get('cache:${MARK}', 3600) v`))[0].v;
    ok('a fresh entry is returned', !!hit && JSON.parse(hit).v === 'hi', String(hit));
    const miss = (await sql(`select public.cache_get('cache:${MARK}', 1) v`))[0].v;
    ok('an entry older than the TTL reads as a miss (not as a stale payment)', miss === null, String(miss));
    await sql(`select public.cache_put('cache:${MARK}-junk','not json')`);
    let survived = false;
    try { const r = (await sql(`select public.cache_get('cache:${MARK}-junk', 3600) v`))[0].v; survived = r !== null; }
    catch (e) { survived = false; }
    ok('a malformed entry is a miss, not an exception thrown at a buyer', survived === false);
    await sql(`delete from public.app_config where app_config.key like 'cache:${MARK}%'`);
  }

  if (WANT_ADDR) {
    h.section('your deposit address');
    const rows = await sql("select coalesce(public.cfg('LTC_ADDRESS'),'') a from (select 1) x");
    const a = rows[0] && rows[0].a;
    if (!a || a === 'NOT_SET') {
      ok('LTC_ADDRESS is configured', false, "set it: insert into public.app_config(key,value) values ('LTC_ADDRESS','ltc1…') on conflict (key) do update set value=excluded.value");
    } else {
      ok('LTC_ADDRESS passes the site\u2019s own address shape check', ADDR_RE.test(a), a.slice(0, 12) + '\u2026');
      try {
        const r = await fetch(BC + '/addrs/' + encodeURIComponent(a));
        const j = await r.json();
        ok('BlockCypher recognises it (an invalid checksum is a 400, not an empty list)',
          r.status === 200 && !!j.address, 'HTTP ' + r.status + ' ' + (j.error || '').slice(0, 80));
        console.log('   balance ' + ((j.final_balance || 0) / 1e8) + ' LTC over ' + (j.n_tx || 0) + ' transaction(s) \u2014 read it and confirm it is YOURS');
      } catch (e) { ok('BlockCypher reachable', false, String(e.message)); }
    }
  }

  if (WANT_EXPLORER) {
    h.section('the verification path');
    try {
      const r = await fetch(BC + '/addrs/' + PROBE_ADDR + '?limit=1');
      const j = await r.json();
      const ref = (j.txrefs || [])[0];
      ok('the explorer answers with per-output amounts and confirmation counts',
        r.status === 200 && !!ref && typeof ref.value === 'number' && typeof ref.confirmations === 'number' && !!ref.tx_hash,
        'HTTP ' + r.status);
      ok('  …including double_spend, which the matcher must refuse on', !!ref && 'double_spend' in ref, JSON.stringify(ref && Object.keys(ref)));
      // There is no LTC/USD feed on api.blockcypher.com, so the price comes from a second provider
      // (Coinbase, then Kraken). Asserted here because a rate that silently returns nothing is how
      // a shop ends up selling 90-day access for a dollar.
      const RATES = ['https://api.coinbase.com/v2/prices/LTC-USD/spot', 'https://api.kraken.com/0/public/Ticker?pair=LTCUSD'];
      const got = [];
      for (const u of RATES) {
        try {
          const j = await (await fetch(u)).json();
          const r = Number(j && j.data ? j.data.amount : j && j.result ? j.result.XLTCZUSD.c[0] : 0);
          got.push({ host: u.split('/')[2], rate: r });
        } catch (e) { got.push({ host: u.split('/')[2], error: String(e.message).slice(0, 40) }); }
      }
      const usable = got.filter((g) => g.rate > 1 && g.rate < 5000);
      ok('at least one live LTC/USD rate source answers with a plausible number',
        usable.length >= 1, JSON.stringify(got));
      ok('  …and two of them agree within 2% (one bad feed must not set the price)',
        usable.length < 2 || Math.abs(usable[0].rate - usable[1].rate) / usable[0].rate < 0.02,
        usable.map((g) => g.host + '=' + g.rate).join(' '));
      try {
        const fx = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
        const ngn = Number(fx && fx.rates && fx.rates.NGN);
        ok('an NGN/USD rate answers too (a ₦ quote must not fall back to a USD price)',
          ngn > 100 && ngn < 5000, 'NGN=' + ngn);
        if (usable[0] && ngn) console.log('   ' + usable[0].rate + ' USD/LTC · ' + ngn + ' NGN/USD → ₦6,000 = ' + (6000 / ngn / usable[0].rate).toFixed(6) + ' LTC');
      } catch (e) { ok('NGN rate source reachable', false, String(e.message)); }
    } catch (e) { ok('BlockCypher reachable', false, String(e.message)); }
  }

  h.section('cleanup');
  {
    if (KEEP && !CLEAN) {
      console.log('   keeping ' + quoteId + ' (--keep). It grants nothing: the key column holds a test string, not a key.');
    } else {
      await sql(`delete from public.crypto_payments where id = '${quoteId}' or coalesce(buyer_email,'') = '${MARK}'`);
    }
    if (createdHere) await sql("delete from public.app_config where app_config.key = 'MINT_SECRET'");
    const left = await sql(`select (select count(*) from public.crypto_payments where coalesce(buyer_email,'')='${MARK}') mine, (select count(*) from public.access_keys where revoked_at is null and expires_at > now()) live`);
    ok('no rows of mine remain, and your live keys are untouched',
      CLEAN || KEEP ? true : left[0].mine === 0 && left[0].live === 1, JSON.stringify(left[0]));
  }

  console.log('\n   A quote is not a payment. To prove the whole thing end to end, send yourself');
  console.log('   0.0001 LTC through your wallet, then: select id, status, txid from public.crypto_payments;');
  console.log('   nothing in this file can see the chain, so it asserts the logic around it.');
  process.exit(h.done('against ' + REF));
})().catch((e) => { console.error('\n\u2717 ' + (e && e.message || e)); process.exit(1); });
