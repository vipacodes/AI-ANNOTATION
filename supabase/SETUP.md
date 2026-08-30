# Supabase setup — the paywall, backed by Postgres

Your project: `veecksfcnlpppzvplcyt` → `https://veecksfcnlpppzvplcyt.supabase.co` (reachable,
already confirmed). Two ways to use it; **do 1 and 2 either way, then pick a server.**

I could not create the tables for you: SQL needs the database password or your Supabase CLI
session, and neither is in this sandbox. Everything below is paste-ready.

---

## 1 · Create the schema (once)

Supabase dashboard → **SQL Editor → New query** → paste all of
`supabase/migrations/0001_paywall.sql` → Run. Then, in the *same* editor:

```sql
-- the secret that signs keys. MUST equal the secret used by tools/keygen.js.
update public.app_config set value = 'PASTE-node tools/keygen.js secret OUTPUT' where key = 'ANNOTATE_SECRET';
-- a second secret so your payment webhook can mint keys over HTTP:
update public.app_config set value = 'pick-a-long-random-string' where key = 'MINT_SECRET';
```

This gives you four RPCs, and the two exposed to the API are only `key_check` and
`key_attempt`. `key_mint` needs the mint secret and `app_config` is not readable by `anon` —
so your signing secret cannot be pulled out of the database through the publishable key.

What the migration enforces:

- a `key_fill` trigger derives `sig` on insert, so a hand-written or webhook-written row can
  never use a different algorithm
- `id` must match `^[A-Za-z0-9]{6,10}$` (same as the client's key regex)
- `unlock_attempts` records every failed key with a caller fingerprint; `key_attempt` returns
  `{"throttled": true}` after 20 attempts in 5 minutes from one fingerprint

## 2 · Give the repo the same secret

```bash
cd annotation-trainer
node tools/keygen.js secret                 # this is what you pasted into app_config
```

If the two differ, **no key ever verifies**. Mint one and check it against Postgres:

```bash
node tools/keygen.js new --label "Ada (Supabase test)" --days 30 --sql
# → copies an INSERT for the SQL editor, sig included — or omit the sig column entirely,
#   the trigger derives it
```

Then from the dashboard:

```sql
select public.key_check('9LaKs9E', 'WeyY7L1BPzxxXDUnQLDCorGBz2LT', 1790657059621);
-- want: {"ok": true, "label": "Ada (Supabase test)", ...}
-- {"ok": false, "error": "Server has no ANNOTATE_SECRET configured."} → step 2 not done
-- {"ok": false, "error": "This key was not issued by this site."}     → the two secrets differ
-- {"ok": false, "error": "Unknown key."}                              → INSERT skipped (no row)
```

## 3 · Pick a server

### 3a · Supabase Edge Function hosts *everything* (no other hosting)

`supabase/functions/annotate/index.ts` serves the whole site from a **private** storage bucket,
so protected files only ever travel when a key checks out against Postgres.

```bash
npx supabase@latest link --project-ref veecksfcnlpppzvplcyt
npx supabase@latest functions deploy annotate --no-verify-jwt

# Six secrets. Note the names: the Supabase CLI REJECTS any secret beginning with SUPABASE_
# ("Env name cannot start with SUPABASE_, skipping"), which silently deploys a function with no
# URL and no key — it then answers every route with a 404 that looks like an empty bucket.
npx supabase@latest secrets set \
  ACCESS_MODE=postgres \
  SITE_BUCKET=site \
  PROJECT_URL=https://veecksfcnlpppzvplcyt.supabase.co \
  ANON_KEY=<the anon or publishable key> \
  SERVICE_ROLE_KEY=<the service_role or secret key> \
  SITE_BASE=/functions/v1/annotate

# the bucket must be PRIVATE (that is what makes withholding possible)
curl -s -X POST https://veecksfcnlpppzvplcyt.supabase.co/storage/v1/bucket \
  -H "Authorization: Bearer $SERVICE_KEY" -H 'content-type: application/json' \
  -d '{"name":"site","public":false,"file_size_limit":10485760}'

# upload the site files, keeping the folder structure. Writes go to /object/<bucket>/<path>;
# /object/authenticated/<bucket>/<path> is read-only (it is what the function itself calls).
(cd . && find *.html css js assets -type f | while read -r f; do
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SERVICE_KEY" -H "content-type: $(
         case $f in *.html) echo text/html;; *.css) echo text/css;; *.js) echo text/javascript;;
                        *.svg) echo image/svg+xml;; *.png) echo image/png;; *) echo text/plain;; esac)" \
    --data-binary "@$f" \
    "https://veecksfcnlpppzvplcyt.supabase.co/storage/v1/object/site/$f"
done)
```

`SITE_BASE` matters only for cookies: Supabase mounts a function at `/functions/v1/<slug>`, so
the browser-visible root is not `/`, and a cookie scoped to `/` on `*.supabase.co` would be sent
to PostgREST and storage as well. Set it to your mount, or `/` when you have a custom domain.

Then `https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate/` **is** the site. Check:

```bash
F=https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate
curl -sI $F/platforms.html | head -1     # 200 (free)
curl -sI $F/task.html     | head -1      # 402 (locked)  ← the whole point
curl -s  $F/api/health                   # {"ok":true,"build":"...","url":"configured",...}
curl -s  $F/api/debug                    # what the function can see: route, bucket read, base
curl -sI $F/js/tasks.js | head -1        # 402 (the corpus, withheld)
# and the cache question, which is a security question here:
curl -s -o /dev/null -D - $F/js/tasks.js | grep -i cache-control      # must be no-store
```

Custom domain instead of that URL: Cloudflare Pages with a redirect, or
`practice.yourdomain.com` on any host that proxies to the function.

### 3b · Cloudflare Pages (or your VPS) + Supabase only as the key database

Keep the free static hosting you already have and let Postgres answer "is this key live?".

- **Cloudflare:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` in Pages settings; the function already
  calls `key_check`. (In `deploy/cloudflare-pages-function.js`, switch the local-HMAC path to the
  same PostgREST call you can copy from the Supabase function — ~10 lines.)
- **This repo's `server.js`:** already supports it. Nothing to code, just environment:
  ```bash
  SUPABASE_URL=https://veecksfcnlpppzvplcyt.supabase.co \
  SERVICE_ROLE_KEY=<service_role> PORT=4173 node server.js
  curl -s localhost:4173/api/health
  # {"backend":"supabase-postgres (revocation + rate limit)",...}
  ```
  `ACCESS_MODE=local` forces the old offline path — that's what the test suite uses.

Revocation becomes one statement, live on every server at once:
```sql
update public.access_keys set revoked_at = now() where id = 'C4a4bnY';
```

## 4 · Payments → keys, one HTTP call

Paystack/Flutterwave webhook (or a button on your thank-you page):

```bash
curl -s -X POST https://veecksfcnlpppzvplcyt.supabase.co/rest/v1/rpc/key_mint \
  -H "apikey: <publishable-or-service key>" -H "Authorization: Bearer <same>" \
  -H 'content-type: application/json' \
  -d '{"p_mint_secret":"<MINT_SECRET>","p_label":"Paystack ref 4412 · Ada","p_days":30}'
# → {"key":"wgxbZ0o.LphKFkPObe4...1790657059621","until":"2026-09-29",...}
```

Put `key` in the buyer's email. No server of yours has to exist for that to work.

## 4b · Caching rules, because a CDN in front of a paywall is a leak

The edge function serves every file itself, so it also decides cacheability, and the wrong
header here gives away paid bytes:

  · a **protected** path (see `PROTECT` in the function) is always `cache-control: no-store`
  · a **public asset** (`/css`, `/js`, `/assets`) gets `public, max-age=300`
  · a **page or an error** is `no-store`, so a stale 404 during an upload cannot stick

An early draft cached everything under `/js` for five minutes. `/js/tasks.js` is the paid
corpus *and* lives under `/js`, so one buyer's authenticated 200 was cached and then handed to
the next stranger for free. If you change these rules, test the order: **fetch with a key, then
fetch the same URL without one, and the second request must still be a 402.**

If you deploy the Cloudflare Pages variant instead, the function returns `next()` for unlocked
requests and Pages' own CDN caches static assets by default. Ship a `_headers` file that pins the
protected paths to `no-store`:

    /task.html           no-store
    /queue.html          no-store
    /onboarding.html     no-store
    /detector.html        no-store
    /trust-safety.html   no-store
    /earnings.html       no-store
    /js/tasks.js         no-store
    /js/detector.js      no-store
    /data/*              no-store

## 5 · Housekeeping

```sql
select id, label, to_char(to_timestamp(exp_ms/1000.0),'YYYY-MM-DD') until,
       (revoked_at is not null) as revoked, created_at::date as bought
from public.access_keys order by created_at desc limit 50;

select key_id, count(*) fails from public.unlock_attempts
where not ok and at > now() - interval '1 day' group by 1 order by 2 desc limit 10;   -- brute forcers
```

## Security notes, since keys and tokens were pasted in chat

- The `service_role` key bypasses RLS entirely: **server-side only, never in a page, never in git.**
- Rotate the GitHub token you shared (`ghp_…`) at github.com/settings/tokens once the push is done.
  I did not write it to the repo, to `.git/config`, or to any file in the workspace.
- The publishable key is fine in public code; that is what it is for.
- Set `MINT_SECRET` to something long and random — anyone holding it can mint keys.
