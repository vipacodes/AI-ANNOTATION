-- ============================================================================
-- AnnotateTrainer · Supabase (Postgres) backend for the paywall
-- Project ref: veecksfcnlpppzvplcyt   ·   Run in SQL Editor → New query
--
-- What this gives you that a .jsonl file does not: revocation that is
-- instantly visible to every server, a per-key rate limit, an audit trail of
-- failed unlocks, and key minting from SQL so your Paystack/Flutterwave
-- webhook can be one HTTP call.
--
-- SECURITY: run the ALTER ROLE line first. The API roles must not be able to
-- read access_secret or mint keys without the mint secret.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- 1. Lock down the API roles (do this in the same transaction as the tables).
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
-- the two functions below are SECURITY DEFINER and are the ONLY public surface.

-- 2. Tables ------------------------------------------------------------------
create table if not exists public.access_keys (
  id         text primary key check (id ~ '^[A-Za-z0-9]{6,10}$'),
  label      text    not null default '',
  sig        text,                       -- derived by the key_fill trigger when omitted
  algo       text    not null default 'hmac-sha256-b64url-28',
  exp_ms     bigint  not null,
  days       int     not null default 90,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  note       text
);
create index if not exists access_keys_sig_idx on public.access_keys (sig);

create table if not exists public.unlock_attempts (
  id         bigserial primary key,
  fp         text,
  key_id     text,
  ok         boolean not null,
  ip         inet,
  at         timestamptz not null default now()
);

-- 3. The signing secret. Set this before issuing any key:
--    update public.app_config set value = 'paste output of: node tools/keygen.js secret'
--    where key = 'ANNOTATE_SECRET';
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
insert into public.app_config (key, value) values ('ANNOTATE_SECRET', 'NOT_SET')
  on conflict (key) do nothing;
insert into public.app_config (key, value) values ('MINT_SECRET', 'NOT_SET')
  on conflict (key) do nothing;

-- Keys are inserted with the SAME derivation the Node tool uses, enforced here so a
-- hand-written row can never sign an algorithm nobody agreed on.
create or replace function public.key_fill() returns trigger
language plpgsql as $$
declare s text;
begin
  if new.algo is null or new.algo = '' then new.algo := 'hmac-sha256-b64url-28'; end if;
  if new.sig is not null then return new; end if;          -- only derive when not supplied
  select value into s from public.app_config where key = 'ANNOTATE_SECRET';
  if s is null or s in ('', 'NOT_SET') then
    raise exception 'ANNOTATE_SECRET must be set in public.app_config before inserting keys';
  end if;
  -- base64url, unpadded: byte-identical to Node's digest('base64url') in tools/keygen.js
  new.sig := substring(encode(extensions.hmac(convert_to(new.id || '.' || new.exp_ms, 'UTF8'),
               convert_to(s, 'UTF8'), 'sha256'), 'base64', 'u') from 1 for 28);
end $$;
drop trigger if exists key_fill on public.access_keys;
create trigger key_fill before insert on public.access_keys
  for each row execute function public.key_fill();
revoke all on table public.app_config from anon, authenticated;

-- 4. Verify a key. Takes the id + signature only (never the secret), so it is
--    safe to call from an edge function or over PostgREST.
create or replace function public.key_check(p_id text, p_sig text, p_exp bigint)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare r record; s text; sig text;
begin
  if p_id is null or p_exp is null then
    return jsonb_build_object('ok', false, 'error', 'Missing key parts.');
  end if;
  if p_exp < (extract(epoch from now()) * 1000)::bigint then
    return jsonb_build_object('ok', false, 'error', 'This key expired. Reply to your receipt to renew.');
  end if;
  select value into s from public.app_config where key = 'ANNOTATE_SECRET';
  if s is null or s in ('', 'NOT_SET') then
    return jsonb_build_object('ok', false, 'error', 'Server has no ANNOTATE_SECRET configured.');
  end if;
  -- signature derivation must match tools/keygen.js exactly: HMAC-SHA256 over
  -- "<id>.<expMs>", base64url, first 28 chars, no padding.
  sig := substring(encode(extensions.hmac(convert_to((p_id || '.' || p_exp), 'UTF8'),
               convert_to(s, 'UTF8'), 'sha256'), 'base64', 'u') from 1 for 28);
  if sig is distinct from p_sig then
    return jsonb_build_object('ok', false, 'error', 'This key was not issued by this site.');
  end if;
  select * into r from public.access_keys where id = p_id;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown key.');
  end if;
  if r.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'This key has been revoked.');
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'label', r.label,
                            'until', to_char(to_timestamp(r.exp_ms / 1000.0), 'YYYY-MM-DD'));
end $$;
grant execute on function public.key_check(text, text, bigint) to anon, authenticated;

-- 5. Mint a key (call this from your payment webhook). Needs the mint secret.
create or replace function public.key_mint(
  p_mint_secret text, p_label text default 'customer', p_days int default 90
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare s text; ms text; id text; exp bigint; sig text; key text;
begin
  select value into ms from public.app_config where key = 'MINT_SECRET';
  if ms is null or ms = 'NOT_SET' or p_mint_secret is distinct from ms then
    raise exception 'not authorised to mint keys';
  end if;
  select value into s from public.app_config where key = 'ANNOTATE_SECRET';
  if s is null or s in ('', 'NOT_SET') then
    raise exception 'ANNOTATE_SECRET is not configured';
  end if;
  exp := (extract(epoch from now()) * 1000)::bigint + (p_days * 86400000)::bigint;
  loop
    id := rpad(regexp_replace(translate(encode(gen_random_bytes(6), 'base64'), '+/_', 'xxx'),
                   '[^A-Za-z0-9]', '', 'g'), 7, 'x');
    exit when id ~ '^[A-Za-z0-9]{7}$' and not exists (select 1 from public.access_keys where id = id);
  end loop;
  sig := substring(encode(extensions.hmac(convert_to((id || '.' || exp), 'UTF8'),
               convert_to(s, 'UTF8'), 'sha256'), 'base64', 'u') from 1 for 28);
  key := id || '.' || sig || '.' || exp;
  insert into public.access_keys (id, label, sig, exp_ms, days)
    values (id, coalesce(nullif(p_label, ''), 'customer'), sig, exp, p_days);
  return jsonb_build_object('key', key, 'id', id, 'label', p_label, 'days', p_days,
    'until', to_char(to_timestamp(exp / 1000.0), 'YYYY-MM-DD'));
end $$;
revoke all on function public.key_mint(text, text, int) from public, anon, authenticated;

-- 6. Log an unlock attempt + rate-limit brute forcing, in one call.
create or replace function public.key_attempt(p_fp text, p_key_id text, p_ok boolean)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  insert into public.unlock_attempts (fp, key_id, ok) values (p_fp, left(p_key_id, 40), p_ok);
  select count(*) into n from public.unlock_attempts
    where fp = p_fp and at > now() - interval '5 minutes';
  return jsonb_build_object('attempts_5m', n, 'throttled', n > 20);
end $$;
grant execute on function public.key_attempt(text, text, boolean) to anon, authenticated;

-- 7. Operator helpers (run as postgres, not via the API):
--    revoke keys:  update public.access_keys set revoked_at = now() where id = 'Ab3xK9';
--    buyers:       select id, label, to_char(to_timestamp(exp_ms/1000.0),'YYYY-MM-DD') until,
--                         coalesce(revoked_at is not null, false) as revoked
--                  from public.access_keys order by created_at desc limit 50;
--    abuse:        select key_id, count(*) from public.unlock_attempts
--                  where ok = false and at > now() - interval '1 day' group by 1 order by 2 desc;
