# Granting me access — the short version

I don't need passwords, and please don't send them. Everything I can do from the sandbox is
through an API, so what I need is a **scoped token you can revoke the moment I'm done.**

Two options. Pick one, paste only the string, and say "go".

---

## Option 1 — Supabase only (recommended; that's genuinely ALL I need)

I'll deploy the site as a Supabase Edge Function serving a **private** bucket, run the
migration, set the secrets, and hand you the live URL. One credential, one place to revoke.

**What you do** (~2 minutes):

1. <https://supabase.com/dashboard/account/tokens> → **Generate new token**
   - name it `agent-deploy`, no expiry needed — you're deleting it in 10 minutes
2. Paste it here as a single line: `SUPABASE_ACCESS_TOKEN=<the string>`
3. Say "go"

**What I do after that:** `POST` the SQL migration to your project, create the `site` bucket
(private), upload the build, deploy `supabase/functions/annotate`, set its secrets, mint a test
key, and prove the lock with `curl -I .../task.html` (402) and `.../index.html` (200).

**Revoke:** same tokens page → delete. The URL and the keys stay valid; only my access dies.

⚠️ A Supabase access token can touch **every project on your account**, not just this one. That's
why you revoke it right after. If you'd rather not, use Option 2 and I'll do less.

---

## Option 2 — GitHub + Cloudflare Pages (keeps Supabase out of my hands)

I push to your repo (already done) and Cloudflare Pages builds it. Cloudflare needs:

1. **API Token**: <https://dash.cloudflare.com/profile/api-tokens> → Create Token →
   template **Edit Cloudflare Workers** (gives *Account · Cloudflare Pages: Edit*), scope it to
   your account only.
2. Your **Account ID** (shown on the same page, or in the right-hand "API" panel).
3. Paste both:
   ```
   CLOUDFLARE_API_TOKEN=<token>
   CLOUDFLARE_ACCOUNT_ID=<32-char id>
   ```
4. Say "go". I run `npx wrangler pages deploy` plus `pages secret put ANNOTATE_SECRET`.
   You still run the one SQL paste in Supabase (or skip Postgres entirely — this path uses
   the local HMAC key file, which works fine, it just means revocation is a file edit
   instead of a query).

---

## What I will never ask for

Your account password · a `service_role` key in a *public* place · your Paystack/Flutterwave
secret key · anything that can move money. For payments, you create the hosted checkout link and
paste the **public** link into `buy.html`; the webhook calls `key_mint` with the mint secret,
which I'd keep in function secrets, never in the repo.

---

## What this project already has (so the setup steps above can be skipped)

Supabase project `veecksfcnlpppzvplcyt` (`eu-west-1`) has the paywall installed and verified:
`access_keys` / `app_config` / `unlock_attempts`, the `key_check` / `key_mint` / `key_attempt`
RPCs, `ANNOTATE_SECRET` + `MINT_SECRET` in `app_config`, a **private** `site` bucket holding the
30 site files, and the `annotate` edge function serving the whole gated site.

    https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate/

Function secrets: `ACCESS_MODE`, `SITE_BUCKET`, `PROJECT_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`SITE_BASE`. (Not named `SUPABASE_*` — the Supabase CLI refuses that prefix and would have
deployed the function with no URL at all.) No Cloudflare project exists or is needed.

Re-prove it any time, from the repo root:

```bash
SUPABASE_ACCESS_TOKEN=… node tools/verify-supabase.js                     # 22 checks: schema, grants, parity
SUPABASE_ACCESS_TOKEN=… SUPABASE_SERVICE_KEY=… ANON_KEY=… \
  node tools/verify-buyer-flow.js --mint                                  # 36 checks: stranger → unlock → revoke
node tools/upload-site.js --check                                         # bucket equals this working tree
```

`MINT_SECRET` lives in the database and is not written into any tracked file. If you lose it, set
a new one: `update public.app_config set value = '<new>' where key = 'MINT_SECRET';`

## Taking Litecoin (one row to turn on)

    insert into public.app_config (key, value) values
      ('LTC_ADDRESS','ltc1q-your-own-address')
    on conflict (key) do update set value = excluded.value;

Everything else about it is in `DEPLOY.md` § D. Three things worth knowing before you advertise it:

- **Your ledger now has orders, not just keys.** `select id, plan, amount_lt, status, txid, buyer_email from
  public.crypto_payments order by created_at desc;` — `status` goes `pending → detected → paying → paid`.
  Anything stuck in `paying` means the key mint failed after a payment was seen: `update … set status='detected'`
  and the next poll finishes it. Nothing is ever lost, because the amount is recorded on the row.
- **A buyer who loses the page is not lost** as long as they kept the URL (the order token lives in `#ltc=…`)
  or can produce their txid. If they have neither, find the row and mint by hand — the key is already on the
  row (`full_key`) once paid, so read it out rather than re-issuing.
- **The address is public, so rotate it** if a campaign makes you nervous: change `LTC_ADDRESS` and old open
  orders keep their old address (each order stores the address it quoted), so nobody is stranded mid-payment.

, once, whatever you choose

- **Rotate the Supabase access token you pasted in this chat** at
  <https://supabase.com/dashboard/account/tokens>. It is the one that ran the migrations, set the
  secrets, deployed the function and uploaded to your bucket — so it is a real, powerful token, and
  it is readable in the conversation history. I kept it in `/home/user/.sb-token` (mode 600) and
  never wrote it into the repo, but "pasted in chat" means "assume leaked". Revoking it does not
  touch the deployment: the site does not use it.
- **Rotate the pasted `ghp_…` GitHub token** too, and treat the `sb_secret_…` from earlier the same
  way. Then, if you want me to change the site again, mint a fresh scoped token and paste that.

- **Rotate the GitHub token you already pasted** (`ghp_…`) at
  <https://github.com/settings/tokens>. It worked, I used it for exactly two pushes and never
  wrote it to disk (there is no copy in the repo, `.git/config`, or any file here) — but it had
  full `repo` + `admin:org` scope and it lived in this chat, so it should die.
- Same for the Supabase `sb_secret_…` you pasted: **rotate it** in
  Dashboard → Settings → API keys. I used only the publishable key to probe whether the
  migration had been run; the secret key was never needed and never used.
- A cleaner pattern for next time: a **fine-grained** GitHub PAT scoped to *just*
  `vipacodes/AI-ANNOTATION`, Contents: Read & Write, 1-hour expiry. Paste → I push → expired by
  itself, nothing to remember to revoke.

## How I'll behave with any token you give me

- Read it from the environment for one command; never `echo` it, never write it into a file in
  the workspace, never put it in a commit, a remote URL, or `.git/config`.
- I'll show you every `curl`/CLI call I make with the secret replaced by `$TOKEN`, so you can
  check what actually got sent.
- When I'm done I'll print the revoke link for whatever you gave me, unprompted.
