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