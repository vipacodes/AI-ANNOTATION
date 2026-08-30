-- ============================================================================
-- 0003 · Bring a database created by an EARLIER 0001 up to today's columns.
--
-- You need this if a key check raises a 42703 naming a column that IS present in 0001's
-- CREATE TABLE — e.g. `ERROR 42703: column "uses" does not exist`.
--
-- Why: 0001 opens with `create table if not exists`, which is right for re-running and wrong
-- for upgrading — a column added to the CREATE later never reaches a table that already
-- exists. So the functions quietly reference columns that are not there, and every request
-- fails closed with "Paywall is unavailable". This file is the ALTER half of the contract.
--
-- It is GENERATED from 0001's CREATE TABLE blocks by tools/gen-migrations.js, so it cannot
-- forget a column again. Idempotent; run it any number of times, before or after 0001/0002.
-- ============================================================================

-- Two things ALTER cannot do that CREATE can, recorded so they are not a surprise:
--   · access_keys.id: primary key exists in 0001's CREATE but ALTER cannot add it to an existing table — old databases already have it, so this is not a gap.
--   · access_keys.exp_ms: NOT NULL without a DEFAULT — 0003 supplies DEFAULT 0 so the ALTER can run on a table that already has rows. Change 0001 if that default is wrong for you.
--   · app_config.key: primary key exists in 0001's CREATE but ALTER cannot add it to an existing table — old databases already have it, so this is not a gap.
--   · app_config.value: NOT NULL without a DEFAULT — 0003 supplies DEFAULT '' so the ALTER can run on a table that already has rows. Change 0001 if that default is wrong for you.
--   · unlock_attempts.id: primary key exists in 0001's CREATE but ALTER cannot add it to an existing table — old databases already have it, so this is not a gap.
--   · unlock_attempts.ok: NOT NULL without a DEFAULT — 0003 supplies DEFAULT false so the ALTER can run on a table that already has rows. Change 0001 if that default is wrong for you.

-- The shape constraint 0001 declares. ADD CONSTRAINT has no IF NOT EXISTS, so on a re-run
-- this raises 42710 "constraint already exists" and takes the whole migration down with it.
-- Guarded by catalog lookup, and NOT VALID first so a row from the older revision cannot block
-- it; validated immediately after (one scan).
do
$do$
declare
begin
  if not exists (select 1 from pg_constraint where conname = 'key_shape' and conrelid = 'public.access_keys'::regclass) then
    execute 'alter table public.access_keys add constraint key_shape check (id ~ ''^[A-Za-z0-9]{7}$'' and exp_ms > 0) not valid';
    execute 'alter table public.access_keys validate constraint key_shape';
  end if;
end
$do$;

-- --------------------------------------------------------------------------- access_keys
alter table public.access_keys add column if not exists id text;
alter table public.access_keys add column if not exists sig text;
alter table public.access_keys add column if not exists label text not null default 'customer';
alter table public.access_keys add column if not exists days int not null default 90;
alter table public.access_keys add column if not exists exp_ms bigint not null default 0;
alter table public.access_keys add column if not exists
  expires_at timestamptz generated always as (to_timestamp(exp_ms / 1000.0)) stored;
alter table public.access_keys add column if not exists revoked_at timestamptz;
alter table public.access_keys add column if not exists created_at timestamptz not null default now();
alter table public.access_keys add column if not exists note text;
alter table public.access_keys add column if not exists uses int not null default 0;
alter table public.access_keys add column if not exists last_used_at timestamptz;

-- --------------------------------------------------------------------------- app_config
alter table public.app_config add column if not exists key text;
alter table public.app_config add column if not exists value text not null default '';

-- --------------------------------------------------------------------------- unlock_attempts
alter table public.unlock_attempts add column if not exists id bigint generated always as identity;
alter table public.unlock_attempts add column if not exists at timestamptz not null default now();
alter table public.unlock_attempts add column if not exists fp text;
alter table public.unlock_attempts add column if not exists key_id text;
alter table public.unlock_attempts add column if not exists ok boolean not null default false;
alter table public.unlock_attempts add column if not exists ip text generated always as (split_part(fp, '|', 1)) stored;
alter table public.unlock_attempts add column if not exists country text;
alter table public.unlock_attempts add column if not exists
  ua text generated always as (nullif(split_part(fp, '|', 2), '')) stored;
-- An older revision also created access_keys.algo, which today's code never reads (the algorithm
-- is fixed inside key_sig). IF EXISTS makes this a no-op on a fresh install.
alter table public.access_keys drop column if exists algo;

-- The index 0001 declares, in case the table predates it.
create index if not exists unlock_recent on public.unlock_attempts (at desc, fp);
