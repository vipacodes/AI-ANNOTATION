-- ============================================================================
-- 0002 · Repair for a database that already ran an EARLIER copy of 0001.
--
-- Read this first: 0001 is correct and idempotent, so a FRESH install only needs 0001.
-- Skip this file unless your project was created from an older revision.
--
-- The block below is generated VERBATIM from 0001_paywall.sql by tools/gen-migrations.js.
-- Do not hand-edit it — edit 0001 and run `node tools/gen-migrations.js`.
--
-- It exists because the first revision of 0001 carried four bugs that only a real Postgres
-- can find, and every one of them failed silently from the buyer's side of the fence:
--
--   1. encode(bytea,'base64','u') — the three-argument form does not exist on the
--      Postgres 17 Supabase ships. ERROR 42883, so key_check died instead of answering and
--      the INSERT trigger rejected every key. public.key_sig() now builds base64url with
--      replace() and truncates in Node's order, byte-identical to
--      crypto.createHmac(...).digest('base64url').slice(0, 28).
--   2. A plpgsql local named `key` inside a function that queries app_config (whose column
--      is key) → ERROR 42702 ambiguous column. `where id = id` in key_mint had the same
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

-- The three RPCs are the entire public surface. key_mint is deliberately NOT granted:
-- revocation and minting stay behind the service role.

-- ===== functions ==============================================================
-- These five definitions are the ones tests/ and the live project both exercise.
-- Three bugs were only findable by running them against a real Postgres; they are
-- commented at the point they bite so the next reader does not re-invent them.

-- public.key_sig(id, expiry_ms, secret) -> 28-char base64url HMAC-SHA256.
-- The single place the signature is derived, so the insert trigger and the verifier
-- cannot disagree. Postgres has no encode(bytea,'base64','u') (that is the 42883 this
-- migration used to raise), so the URL-safe alphabet is built by hand and truncated in
-- exactly Node's order: convert, then replace, then slice.
create or replace function public.key_sig(p_id text, p_exp bigint, p_secret text)
returns text
language sql
immutable
as $$
  select left(
      replace(replace(replace(
        encode(extensions.hmac(convert_to(p_id || '.' || p_exp, 'UTF8'),
                               convert_to(p_secret, 'UTF8'), 'sha256'), 'base64'),
      '+', '-'), '/', '_'), '=', ''),
      28);
$$;

comment on function public.key_sig(text, bigint, text) is
  'HMAC-SHA256 -> base64url, 28 chars. Byte-identical to tools/keygen.js signature().';

-- Every key row must carry the signature its buyers will present. Deriving it in a
-- trigger means "store the key" and "hand out the key" can never disagree: insert with
-- sig NULL and it fills itself in from ANNOTATE_SECRET.
create or replace function public.key_fill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s text;
begin
  if new.exp_ms is null or new.exp_ms < 0 then
    raise exception 'access_keys.exp_ms must be a millisecond epoch (got %)', new.exp_ms;
  end if;
  if new.sig is null or new.sig = '' then
    select value into s from public.app_config where app_config.key = 'ANNOTATE_SECRET';
    if s is null or s in ('', 'NOT_SET') then
      raise exception 'ANNOTATE_SECRET is not configured — see supabase/SETUP.md step 2';
    end if;
    new.sig := public.key_sig(new.id, new.exp_ms, s);
  end if;
  -- NB: expires_at is GENERATED ALWAYS, and a BEFORE trigger can neither read nor write
  -- generated columns ("record \"new\" has no field \"expires_at\""). Postgres computes it
  -- from exp_ms itself, right after this trigger runs. Do not "help" it here.
  return new;
end
$$;

drop trigger if exists key_fill on public.access_keys;

create trigger key_fill before insert on public.access_keys
  for each row execute function public.key_fill();

-- key_check is the ONLY thing a caller holding the anon key can reach that touches the
-- ledger, and it never returns a row unless the HMAC matches, so it cannot be used to
-- enumerate other people's keys: a guessed id without the right signature is refused before
-- the table is even read, and the error text does not distinguish "wrong signature" from
-- "no such row".
-- Volatility matters: this function ENDS WITH A WRITE (the usage counter), and Postgres
-- refuses UPDATE inside a STABLE function outright —
--   ERROR 0A000: UPDATE is not allowed in a non-volatile function
-- — which arrives as a 400 from RPC, i.e. every key is refused. So: no STABLE here.
create or replace function public.key_check(
  p_id text, p_sig text, p_exp bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s text;
  sig text;
  r record;
begin
  if p_id is null or p_sig is null or p_exp is null then
    return jsonb_build_object('ok', false, 'error', 'Malformed key.');
  end if;
  select value into s from public.app_config where app_config.key = 'ANNOTATE_SECRET';
  if s is null or s in ('', 'NOT_SET') then
    return jsonb_build_object('ok', false, 'error', 'Paywall is not configured on this server.');
  end if;
  -- Expiry first. It costs nothing: p_exp is part of the string the buyer is already holding, so
  -- reading it leaks no secret, and it skips an HMAC on every long-dead key. The MESSAGE is the
  -- reason — checking the signature first told an expired customer "this key was not issued by
  -- this site", which sends them to the wrong conclusion (and the wrong inbox) instead of
  -- "your key expired, reply to your receipt to renew".
  if p_exp < (extract(epoch from now()) * 1000)::bigint then
    return jsonb_build_object('ok', false, 'error', 'This key expired. Reply to your receipt to renew.');
  end if;
  sig := public.key_sig(p_id, p_exp, s);
  if sig is distinct from p_sig then
    return jsonb_build_object('ok', false, 'error', 'This key was not issued by this site.');
  end if;
  select * into r from public.access_keys where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'This key was not issued by this site.');
  end if;
  if r.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'This key has been revoked. Reply to your receipt.');
  end if;
  update public.access_keys set uses = uses + 1, last_used_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'label', r.label, 'until', to_char(r.expires_at, 'YYYY-MM-DD'));
end
$$;

-- EVERY function is revoked from PUBLIC first, then granted back one at a time. Postgres grants
-- EXECUTE on new functions to PUBLIC by default, so without this the list of callable RPCs is
-- "whatever exists" instead of "key_check and key_attempt". That mostly costs you a confusing
-- /rpc/ surface, but a SECURITY DEFINER trigger function like key_fill() being callable directly
-- is exactly the kind of thing that turns a small mistake into a real one.
revoke execute on function public.key_sig(text, bigint, text) from public, anon, authenticated;

revoke execute on function public.key_fill() from public, anon, authenticated;

revoke execute on function public.key_mint(text, text, int) from public, anon, authenticated;

revoke execute on function public.key_check(text, text, bigint) from public, anon, authenticated;

revoke execute on function public.key_attempt(text, text, boolean) from public, anon, authenticated;

comment on function public.key_check(text, text, bigint) is
  'Verify an access key against the ledger. Returns {ok,label,until} or {ok:false,error}.';

grant execute on function public.key_check(text, text, bigint) to anon, authenticated;

-- The hit counter is a side effect, so key_attempt is VOLATILE by necessity — do not
-- "optimise" it to STABLE; promising the planner a stable function does not write rows
-- is a lie that will bite you on a cached plan.
create or replace function public.key_attempt(p_fp text, p_key_id text, p_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n int;
begin
  insert into public.unlock_attempts (fp, key_id, ok) values (p_fp, left(p_key_id, 40), p_ok);
  select count(*) into n from public.unlock_attempts
    where fp = p_fp and at > now() - interval '5 minutes';
  return jsonb_build_object('attempts_5m', n, 'throttled', n > 20);
end
$$;

grant execute on function public.key_attempt(text, text, boolean) to anon, authenticated;

-- Minting is an HTTP call: insert the row, read the key back. SECURITY DEFINER, and
-- NEVER granted to anon or authenticated, or the paywall is a suggestion.
-- Two traps, both found live: the day arithmetic must happen in bigint
-- (30 * 86400000 overflows int4 before any cast), and no local variable may be named
-- `key` or `id` — a plpgsql variable shadows the column of the same name, so
-- `where id = id` compares a column to itself and is always true.
create or replace function public.key_mint(
  p_mint_secret text, p_label text default 'customer', p_days int default 90
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s text;
  ms text;
  new_id text;
  exp bigint;
  sig text;
  full_key text;
begin
  select value into ms from public.app_config where app_config.key = 'MINT_SECRET';
  if ms is null or ms = 'NOT_SET' or p_mint_secret is distinct from ms then
    raise exception 'not authorised to mint keys';
  end if;
  select value into s from public.app_config where app_config.key = 'ANNOTATE_SECRET';
  if s is null or s in ('', 'NOT_SET') then
    raise exception 'ANNOTATE_SECRET is not configured';
  end if;
  exp := (extract(epoch from now()) * 1000)::bigint + (p_days::bigint * 86400000);
  loop
    new_id := rpad(regexp_replace(
                   translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/_', 'xxx'),
                   '[^A-Za-z0-9]', '', 'g'), 7, 'x');
    exit when new_id ~ '^[A-Za-z0-9]{7}$'
          and not exists (select 1 from public.access_keys ak where ak.id = new_id);
  end loop;
  sig := public.key_sig(new_id, exp, s);
  full_key := new_id || '.' || sig || '.' || exp;
  insert into public.access_keys (id, label, sig, exp_ms, days)
    values (new_id, coalesce(nullif(p_label, ''), 'customer'), sig, exp, p_days);
  return jsonb_build_object('key', full_key, 'id', new_id, 'label', p_label, 'days', p_days,
    'until', to_char(to_timestamp(exp / 1000.0), 'YYYY-MM-DD'));
end
$$;

revoke all on function public.key_mint(text, text, int) from public, anon, authenticated;

comment on function public.key_mint(text, text, int) is 'Mint a key. Service-role only, guarded by MINT_SECRET.';

-- --------------------------------------------------------------------------- crypto orders
-- One-time crypto payment, verified on-chain, no provider account and no webhook endpoint.
--
-- The whole design rests on one idea: the AMOUNT is the order id. A quote returns a price with a
-- few litoshi (1e-9 LTC) of unique "dust" added, so ₦6,000 is never 0.12200000 LTC but
-- 0.12200417 LTC. Nobody else's payment looks like it, and nobody can pay a rounded figure and
-- claim it covers their own quote. That single property is what lets access be granted with no
-- human in the loop and no email in the chain — see crypto_probe.
create table if not exists public.crypto_payments (
  id            text primary key,                    -- short public id, for your own bookkeeping
  quote_token   text not null unique,                -- 128-bit capability: the ONLY way to read this order back
  plan          text not null,
  currency      text not null,
  price_minor   bigint not null,                     -- what the plan costs, in kobo/cents
  amount_lt     numeric(20,8) not null,              -- exact amount to send, including the dust watermark
  dust          bigint not null,                     -- the watermark itself, in litoshi
  address       text not null,                       -- YOUR deposit address, as supplied at quote time
  buyer_email   text,                                -- optional, only to label the receipt
  status        text not null default 'pending',     -- pending | detected | paid | expired
  txid          text,
  tx_amount     bigint,                              -- matched output, litoshi
  tx_height     bigint,
  confirmations int not null default 0,
  key_id        text,                                -- access_keys.id, once minted
  full_key      text,                                -- the deliverable, kept so a buyer can always get it back
  receipt       jsonb,                               -- rendered receipt, what an email would have carried
  mint_secret   text not null,                       -- must match on the paid transition; proof the caller is the server
  expires_at    timestamptz not null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists crypto_payments_addr_idx on public.crypto_payments (address, created_at desc);

create index if not exists crypto_payments_open_idx on public.crypto_payments (status, expires_at);

-- Config is read through one helper so every caller shares the empty-vs-unset rules that bit this
-- project already: NULLIF of '' and the 'NOT_SET' placeholder, plus a cast for numeric values.
create or replace function public.cfg(p_key text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(nullif(value, ''), 'NOT_SET') from public.app_config where app_config.key = p_key
$$;

-- A short cache of the block-explorer answer, kept IN the database because the edge runtime has
-- nothing else shared: N buyers polling one address is N requests per poll against an explorer
-- that rate-limits per IP (BlockCypher allows ~2/s), and one request getting 429 must not turn
-- into "payment not found" for everyone else.
--
-- The age lives INSIDE the stored value, not in a column: app_config is exactly (key, value), and
-- adding an updated_at to it for a cache would mean every reader of app_config inherits a column
-- whose only purpose is someone else's expiry. A caller that forgets to embed `t` gets NULL, i.e.
-- a cache miss, which is the failure mode you want.
create or replace function public.cache_get(p_key text, p_ttl int)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select value from public.app_config
   where app_config.key = p_key
     and (value::jsonb ->> 't')::bigint >
         (extract(epoch from now()) * 1000)::bigint - (greatest(coalesce(p_ttl, 15), 1) * 1000)
$$;

-- p_value must be a JSON object carrying {"t": <epoch ms>}; see cache_get.
create or replace function public.cache_put(p_key text, p_value text)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  insert into public.app_config (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value
$$;

-- Open an order. Returns the quote token, which the caller must keep: it is the only credential
-- that can read this order back or claim a payment against it.
create or replace function public.crypto_quote(
  p_plan text, p_currency text, p_price_minor bigint, p_amount numeric,
  p_address text, p_email text, p_mint_secret text, p_ttl int
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text;
  v_tok text;
  v_try int;
begin
  if public.cfg('MINT_SECRET') is null then
    raise exception 'MINT_SECRET is not configured';
  end if;
  if coalesce(p_mint_secret, '') <> public.cfg('MINT_SECRET') then
    raise exception 'not allowed';
  end if;
  if p_plan not in ('week', 'season', 'usd') then
    raise exception 'unknown plan';
  end if;
  if p_amount is null or p_amount < 0.00010000 then
    raise exception 'amount too small to watermark';
  end if;
  if p_address is null or p_address !~ '^(ltc1[a-z0-9]{20,90}|[LM][a-km-zA-HJ-NP-Z1-9]{26,34})$' then
    raise exception 'that does not look like a Litecoin address';
  end if;
  -- 6 random bytes base64 to 8 characters (2 of them padding), which is what makes a 7-character
  -- id reachable at all; gen_random_bytes(4) yields 6 characters, so `length(v_id) = 7` never
  -- became true and this loop spun until the statement timeout killed it 126 seconds later — a
  -- hanging buyer request, from the outside, indistinguishable from a slow explorer. The counter
  -- is the real fix: an unreachable exit condition must fail loudly, not occupy the database.
  v_try := 0;
  loop
    v_try := v_try + 1;
    -- p_amount is fixed for the whole call, so a collision cannot be resolved by re-rolling the
    -- watermark here; the caller (the edge function) re-prices and retries. Failing loudly beats
    -- silently inserting an order that shares an amount with another one.
    if v_try > 40 then raise exception 'could not allocate an order id, or its amount is already reserved'; end if;
    v_id  := left(regexp_replace(
               translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/_', 'xxx'),
               '[^A-Za-z0-9]', '', 'g'), 7);
    v_tok := encode(extensions.gen_random_bytes(16), 'hex');
    exit when length(v_id) = 7 and not exists (select 1 from public.crypto_payments c where c.id = v_id)
          -- the watermark is only a claim if it is not already somebody else's. Two open orders
          -- for the same plan at the same amount are indistinguishable on-chain, and the FIRST
          -- buyer to poll would be paid for the SECOND one's transfer. Asserting uniqueness here
          -- is the difference between "identified by amount" and "guessed by amount".
          and not exists (select 1 from public.crypto_payments d
                           where d.amount_lt = p_amount
                             and d.status in ('pending', 'detected', 'paying'));
  end loop;
  insert into public.crypto_payments
    (id, quote_token, plan, currency, price_minor, amount_lt, dust, address, buyer_email,
     mint_secret, expires_at)
  values
    (v_id, v_tok, p_plan, upper(p_currency), coalesce(p_price_minor, 0), p_amount,
     (p_amount * 100000000)::bigint % 1000000, coalesce(nullif(p_address, ''), ''),
     left(nullif(p_email, ''), 160), p_mint_secret,
     now() + make_interval(secs => greatest(coalesce(p_ttl, 1200), 300)));
  return jsonb_build_object('id', v_id, 'token', v_tok);
end
$$;

-- Read an order. The token is the whole authorisation: a paid order reveals its key to the holder
-- of that token and to nobody else, which is why no email is needed to deliver anything.
create or replace function public.crypto_get(p_id text, p_token text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select to_jsonb(c) - 'mint_secret' - 'quote_token'
  from public.crypto_payments c
  where c.id = p_id and c.quote_token = p_token
$$;

-- The detector. One RPC answers "has the money arrived?" without the caller having to hand over a
-- txid, and it refuses a payment that is older than the quote — the rule that stops someone else's
-- receipt from being re-pointed at a fresh order.
create or replace function public.crypto_probe(
  p_id text, p_token text, p_txid text, p_amount bigint, p_height bigint, p_confs int, p_min_confs int
) returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  q public.crypto_payments;
  v_ready boolean;
begin
  select * into q from public.crypto_payments c where c.id = p_id and c.quote_token = p_token;
  if not found then return jsonb_build_object('error', 'quote not found'); end if;
  if q.status = 'paid' then return jsonb_build_object('status', 'paid', 'key', q.full_key); end if;

  if p_amount is null or p_amount <> (q.amount_lt * 100000000)::bigint then
    return jsonb_build_object('status', q.status, 'matched', false);
  end if;
  if p_txid is not null and q.created_at > now() - interval '2 minutes' then
    return jsonb_build_object('status', q.status, 'matched', false,
                              'reason', 'this order is too young to have a payment yet');
  end if;

  update public.crypto_payments c
     set txid = coalesce(nullif(p_txid, ''), c.txid),
         tx_amount = p_amount,
         tx_height = coalesce(p_height, c.tx_height),
         confirmations = greatest(coalesce(p_confs, 0), c.confirmations),
         status = 'detected',
         expires_at = greatest(c.expires_at, now() + interval '30 minutes')
   where c.id = q.id
  returning * into q;

  v_ready := coalesce(q.confirmations, 0) >= greatest(coalesce(p_min_confs, 2), 1);
  return jsonb_build_object(
    'status', q.status, 'matched', true, 'ready', v_ready,
    'confirmations', q.confirmations, 'txid', q.txid, 'amount', q.tx_amount,
    'address', q.address, 'expires_at', q.expires_at);
end
$$;

-- The state machine, in one place, because the race is the buyer's own polling: two /status calls
-- five seconds apart can both decide "confirmed" and mint two keys for one payment. 'claim' moves
-- pending|detected → paying and only its winner is allowed to mint; 'paid' writes the deliverable
-- (key + receipt) and closes the row; 'revert' releases a claim when the mint itself failed, so a
-- transient RPC error costs a retry, not a paid-for order stuck in 'paying' forever.
create or replace function public.crypto_mark(
  p_action text, p_id text, p_token text, p_mint_secret text,
  p_key_id text, p_full_key text, p_receipt jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  q public.crypto_payments;
  v_ok boolean := false;
begin
  if public.cfg('MINT_SECRET') is null or coalesce(p_mint_secret, '') <> public.cfg('MINT_SECRET') then
    raise exception 'not allowed';
  end if;

  if p_action = 'claim' then
    update public.crypto_payments c
       set status = 'paying'
     where c.id = p_id and c.quote_token = p_token
       and c.status in ('pending', 'detected')
    returning * into q;
    v_ok := found;
  elsif p_action = 'paid' then
    update public.crypto_payments c
       set status = 'paid', key_id = p_key_id, full_key = p_full_key,
           receipt = coalesce(p_receipt, c.receipt), paid_at = now()
     where c.id = p_id and c.quote_token = p_token and c.mint_secret = p_mint_secret
       and c.status in ('paying', 'detected', 'pending')
    returning * into q;
    v_ok := found;
  elsif p_action = 'revert' then
    update public.crypto_payments c
       set status = 'detected'
     where c.id = p_id and c.quote_token = p_token and c.mint_secret = p_mint_secret
       and c.status = 'paying'
    returning * into q;
    v_ok := found;
  else
    raise exception 'unknown action';
  end if;

  if not v_ok then
    select * into q from public.crypto_payments c where c.id = p_id and c.quote_token = p_token;
    return jsonb_build_object('ok', false, 'status', coalesce(q.status, 'gone'),
      'key', case when q.status = 'paid' then q.full_key else null end);
  end if;
  return jsonb_build_object('ok', true, 'status', q.status, 'key', q.full_key,
    'paid_at', q.paid_at, 'txid', q.txid);
end
$$;

revoke all on function public.cfg(text) from public, anon, authenticated;

revoke all on function public.cache_get(text, int) from public, anon, authenticated;

revoke all on function public.cache_put(text, text) from public, anon, authenticated;

revoke all on function public.crypto_quote(text, text, bigint, numeric, text, text, text, int) from public, anon, authenticated;

revoke all on function public.crypto_get(text, text) from public, anon, authenticated;

revoke all on function public.crypto_probe(text, text, text, bigint, bigint, int, int) from public, anon, authenticated;

revoke all on function public.crypto_mark(text, text, text, text, text, text, jsonb) from public, anon, authenticated;

comment on function public.crypto_mark(text, text, text, text, text, text, jsonb) is 'claim/paid/revert for a crypto order; needs MINT_SECRET, and a claim is single-winner';

comment on table public.crypto_payments is 'One-time crypto orders; quote_token is the capability that reads them back';

comment on column public.crypto_payments.dust is 'litoshi watermark making this order''s amount unique';

comment on column public.crypto_payments.mint_secret is 'copied at quote time; every state change re-checks it, so a stolen quote token alone cannot close an order';