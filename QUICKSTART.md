# Quick start — view it, then take it live

## It is live now (this project)

```
https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate/
```

That URL *is* the whole site — Supabase serves it from a private bucket and enforces the lock at
the edge; there is no other server to keep alive, and no Cloudflare project involved.

```bash
F=https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate
curl -s  $F/api/health          # {"ok":true,"gate":"on","backend":"postgres","build":"annotate-2026-08-30.2",…}
curl -sI $F/guide.html | head -1 # 200  free: the guide, catalogue, pricing, unlock page
curl -sI $F/task.html  | head -1 # 402  LOCKED — the bytes never leave without a key
curl -sI $F/js/tasks.js | head -1# 402  the 39 KB corpus, a 94-byte stub in its place
```

Open `$F/index.html` in a browser, go to **Unlock**, and paste a key from
`node tools/keygen.js new --label "test" --days 30`. That key is real: it is checked against the
`access_keys` table in your Supabase project, so it can be revoked from the database and stops
working on the buyer's next request.

Take Litecoin without a processor, an email account, or touching a terminal per sale:

```bash
# one row turns it on — the address is config, never code
#   insert into public.app_config (key, value) values ('LTC_ADDRESS','ltc1q…')
#     on conflict (key) do update set value = excluded.value;
curl -s $F/crypto/check        # address shape, mint secret, and a live price per plan
curl -s -X POST $F/crypto/quote -H 'content-type: application/json'   -d '{"plan":"season"}'      # → {id, token, amount:"0.24001733", address, pay:"litecoin:…"}
```

The odd last digits are the buyer's watermark: each open order gets a unique amount, so a transfer
identifies its owner without a reference number. `buy.html` shows the amount, watches the chain, and
unlocks itself at 2 confirmations — see `DEPLOY.md` § D for what that does and does not protect you from.

Mint straight over HTTP (this is what a payment webhook will call, once you wire one up):

```bash
curl -s -X POST $PROJECT_URL/rest/v1/rpc/key_mint \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d '{"p_mint_secret":"'$MINT_SECRET'","p_label":"Ada C. · Paystack ref 4412","p_days":90}'
# → {"key":"<id>.<sig>.<expMs>", "id":"…", "until":"…"}   paste that string into the receipt
```

Prove the whole thing again, end to end, any time:

```bash
SUPABASE_ACCESS_TOKEN=… node tools/verify-supabase.js      # 22 checks: schema, grants, signature parity, revoke
SUPABASE_ACCESS_TOKEN=… SUPABASE_SERVICE_KEY=… ANON_KEY=… \
  node tools/verify-buyer-flow.js --mint                   # 36 checks: stranger → gate → unlock → revoke
node tools/upload-site.js --check                          # the bucket equals this working tree
```

## Right now, inside this workspace

The server is already running on port 4173, so open the **live preview** in this app
(or, from a browser, `http://4173-i533abqrj03owf6uxr95w.e2b.app`, if that host resolves for you).
Nothing installs, nothing builds — it is plain HTML + vanilla JS.

| Page | State |
|---|---|
| `/platforms.html` `/platform.html?p=outlier` `/guide.html` | **free**, open to the world |
| `/buy.html` `/gate.html` | free — the paywall itself |
| `/task.html` `/queue.html` `/onboarding.html` `/detector.html` `/earnings.html` `/trust-safety.html` | **402 → gate screen** until a key is presented |

To get inside while testing: paste a key into `/gate.html`.
Mint one any time with
`node tools/keygen.js new --label "test" --days 30`.

Run the checks whenever you touch anything:
```bash
node tests/verify.js                 # 264 assertions: pages, grading, persistence, the gate,
                                      #   the Cloudflare function, and the SQL migrations
node --experimental-vm-modules tests/edge-function.js   # the Pages + Supabase functions, for real (33)
node tests/sql-migration.js          # the migration files, against the shapes Postgres rejects (54)
```

---

## Live in 3 minutes for a demo (temporary, no account, no domain)

A quick public URL so you can send it to one person, or see it on your phone.

```bash
# 1. serve it
cd annotation-trainer && PORT=4173 GATE=on node server.js

# 2. in a second terminal, tunnel it out (Cloudflare's free quick tunnel — no signup)
cloudflared tunnel --url http://127.0.0.1:4173
# prints: https://<random-words>.trycloudflare.com
```

That URL is a real public HTTPS address, the paywall works over it, and the whole thing
runs on your laptop. **But the moment you close the laptop, it dies** — so use it for
"demo me that", not for "customers".

## Live properly, free, forever (recommended)

Follow **`DEPLOY.md`**. There are two real options and the recommendation has changed now that
the Supabase project exists: **path A2 (Supabase only)** needs no second account and stores no
signing secret anywhere outside the database; **path A (Cloudflare Pages)** only buys you a
`pages.dev` subdomain or a custom domain you already own. Both are documented; the deployment
above is A2. Short version for A:

```bash
cd annotation-trainer
git init && git add -A && git commit -m "AnnotateTrainer"
gh repo create annotate-trainer --public --source=. --push        # or push on github.com manually
# Cloudflare dashboard → Workers & Pages → Create → Pages → connect the repo
#   Framework preset: None · Build command: (empty) · Output dir: /
#   Settings → Environment variables → SUPABASE_ANON_KEY = <publishable key>   (that is all)
#   Or skip Cloudflare entirely: supabase/SETUP.md serves the site from an Edge Function.
# Then point a domain at it: practice.yourdomain.com  (or free practice.<project>.pages.dev)
```

`deploy/cloudflare-pages-function.js` → copy to **`functions/[[path]].js`** in the repo before pushing.
That is what enforces the lock at the edge, for free, with no server for you to keep alive.

**Verify before you sell it:**
```bash
curl -sI https://practice.example.com/task.html    # must be 402
curl -s  https://practice.example.com/index.html | head -3     # must be your page
```
If `task.html` is 200 without a key, the secret didn't match — fix that before taking money.
(That exact class of bug — a path list that matched *everything* — is why the check at
`tests/verify.js` asserts the free list and the withheld list separately, and why
`server.js` and the edge function are asserted to share one identical rule.)

Then take money: Paystack/Flutterwave link for ₦, Stripe/Lemon Squeezy for USD.
`buy.html` has two constants to paste them into (`CHECKOUT.ngn`, `CHECKOUT.usd`).

## Or: hand someone the files

`annotation-trainer.zip` in the workspace root — everything but `data/` (your signing secret
and submission log stay out of it). Unzip, run `node server.js`, or drop it on any static host
(Neeraj/Netlify/Vercel/whogohost shared hosting). **On a static host with no function, the lock
is decoration** — visitors get a "Soft lock" banner instead of a real gate. That's the honest
labelling, not a bug to work around.
