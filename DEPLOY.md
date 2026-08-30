# Putting it online, and charging for it

Three setups, cheapest first. Take **A** unless you already know why you need B.

---

## Which one, honestly

If your Supabase project already has the migration applied (it does — `key_check`, `key_mint`
and the key table are live), then **Option A2 below is the whole deployment**: the edge function
serves the files and enforces the lock, and the database decides who gets in. There is no second
account to open, no `_headers` file to get wrong, and no signing secret on a third-party host.

Cloudflare is *not* needed to make the paywall work. It was kept in the plan for two conveniences
only: a `pages.dev` subdomain you can hand people, and a custom domain you may already own. If
you want either, use A. If you do not, deploy A2 and skip A entirely — nothing in the repo
depends on Cloudflare at runtime.

## A · Cloudflare Pages + one function — free, no server to keep alive

This is the recommended path: the lock is enforced *at the edge*, so protected files are never
sent to someone without a key, and you pay nothing until you have real traffic.

1. **Get the code online**
   ```bash
   cd annotation-trainer
   git init && git add -A && git commit -m "AnnotateTrainer"
   gh repo create annotate-trainer --public --source=. --push   # if gh is installed; else push on github.com
   git remote add origin https://github.com/<you>/annotate-trainer.git && git push -u origin main
   ```
   (`data/` should not be committed: add `data/` and `assets/*.png` to `.gitignore`.)

2. **Add the function.** Copy `deploy/cloudflare-pages-function.js` to
   `functions/[[path]].js` in the repo. Framework preset: *None*. Build command: empty.
   Output directory: `/`. Build passes a `node --check`-clean tree; no install step needed.

3. **Set the two public variables** (Dashboard → your Pages project → Settings → Environment
   variables → Production *and* Preview):

   | Variable | Value | Secret? |
   |---|---|---|
   | `SUPABASE_URL` | `https://veecksfcnlpppzvplcyt.supabase.co` | no (already the default in the file) |
   | `SUPABASE_ANON_KEY` | your publishable key | no — public by design |

   The function now asks Postgres `key_check()` instead of holding a signing secret, so **there is
   nothing sensitive on Cloudflare to leak**: revocation and expiry live in the database and apply
   to every deployment instantly. If the database is unreachable the function **denies** (with a
   2.5 s timeout) — a gate that opens on error is not a gate.
   Keep `ANNOTATE_SECRET` instead (and set `ACCESS_MODE=hmac`) only if you skip Supabase entirely.
   `node tests/edge-function.js` imports the real function against a stubbed PostgREST and checks
   exactly this: 402 for protected HTML, a 94-byte stub for the corpus, valid key → 200, and
   "database down → locked". Set it in **Production and Preview**.

4. **Custom domain.** Pages → Custom domains → add e.g. `practice.yourdomain.com`. Free TLS.
   If you don't own a domain yet: Whogohost/Qservers/Namecheap, `.ng` or `.com`, ~₦4–9k/yr.

5. **Test the lock before you sell it.**
   ```bash
   curl -sI https://practice.example.com/task.html          # expect 402
   curl -sI https://practice.example.com/index.html         # expect 200
   curl -sI -H "x-access-key: $(node tools/keygen.js new --days 1 | sed -n 2p)" https://practice.example.com/task.html   # expect 200
   curl -s -X POST -H 'content-type: application/json' -d '{"key":"<that key>"}' https://practice.example.com/unlock -i | head -1  # expect 200 + Set-Cookie
   ```
   With `SUPABASE_ANON_KEY` set, that key must exist as a row in `public.access_keys` — mint it
   with `node tools/keygen.js new --label X --days 30 --sql` and paste the printed INSERT, or call
   the `key_mint` RPC.
   If `task.html` returns 200 without a key, **stop** — the secret mismatched or the function
   isn't deployed. Do not sell a lock you haven't watched refuse a request.

---

## B · Your own Node server — one small VPS or a free-ish PaaS

```bash
ANNOTATE_SECRET=$(node tools/keygen.js secret) PORT=4173 node server.js
```
- `server.js` already implements the same 402 behaviour plus `/unlock`, `/session`, `/api/submit`.
- Host: Railway / Render / Fly.io free-then-cheap tiers, or a ₦4–8k/month Nigerian VPS
  (Whogohost, Qservers, Clouvider) with `caddy reverse_proxy --tls` in front for automatic HTTPS.
- Put it under systemd or Docker; `restart: always`; keep `data/` on a persistent volume or you
  lose the submissions log and the secret on every deploy (rotating the secret invalidates all
  keys you issued — copy it somewhere durable).

---

## C · Paying by transfer (Paystack / Flutterwave) → automatic key delivery — already built, needs two secrets

The edge function serves `POST /fulfill`, which takes a payment reference and returns a key:

    curl -s -X POST $F/fulfill -H 'content-type: application/json' \
      -d '{"ref":"6789012345","plan":"season"}'
    # → {"key":"Ab3xK9….….1795…, "until":"2026-11-28","label":"ada@example.com · paystack 6789012345"}

It is safe to expose because the caller is not the trust boundary — the reference is re-verified
with the provider before anything is written:

| step | what fails without it |
|---|---|
| `PAY_PROVIDER` + `PAY_SECRET_KEY` | the endpoint answers 503 and mints nothing; it never trusts the browser |
| provider says `status = success` | a fake or unpaid reference cannot mint |
| amount ≥ plan **and** currency match | a ₦6,000 receipt cannot buy the ₦18,000 plan (amounts compared in kobo/cents) |
| `note = reference` uniqueness | the same receipt pasted twice returns 409, not a second key |
| `MINT_SECRET` in the function env | `key_mint` stays service-role-only; no secret ever reaches the client |

Plans and prices are in `PLANS` in `supabase/functions/annotate/index.ts`; they must agree with
`buy.html`. To take money, paste two links into `CHECKOUT` in `buy.html` and set the three secrets:

    supabase secrets set PAY_PROVIDER=paystack PAY_SECRET_KEY=sk_live_… MINT_SECRET=…

`buy.html` also has an "Already paid?" box: after Paystack returns the buyer, the reference in the
query string redeems itself, and a buyer who closes the tab can paste it later. Point the
provider's webhook at the same `/fulfill` route if you would rather keys arrive unattended —
`{ref, plan}` is the whole contract. Until `PAY_SECRET_KEY` is set, `node tools/keygen.js new
--sql` (or `key_mint` with `MINT_SECRET`) issues keys by hand; the gate itself is live either way.

## C2 · Choosing a fiat processor

**Take the money (Nigeria-first):**
| Want | Use | Why |
|---|---|---|
| ₦ local cards, bank transfer, USSD | **Paystack** payment link | local rails, invoices in naira, easy refunds |
| ₦ + pay-as-you-go, no monthly fee | **Flutterwave** | similar; pick whichever your customers already have |
| USD cards, and tax/VAT handled for you | **Lemon Squeezy** or **Paddle** | merchant-of-record; they remit sales tax so you don't |
| USD, cheapest fees, you have a foreign account | **Stripe** | needs a supported-country account + domiciliary for payout |
| Crypto as an option | **NOWPayments / Trias** | USDT is how many Nigerian freelancers already move money |

**Deliver the key.** Two options, both honest:

*Manual (fine under ~20 sales/week).* In Paystack → Settings → Webhooks, point the
`success` event at a tiny endpoint, or just watch the notification email and run:
```bash
node tools/keygen.js new --label "Ada C. (Paystack ref 123)" --days 90
```
Paste the printed key into the reply email. Zero infrastructure.

*Automatic.* One endpoint that does the same thing:
```js
// POST /fulfil — protect with your Paystack secret key header check
const { execFileSync } = require('child_process');
app.post('/fulfil', (req, res) => {
  if (req.headers['x-paystack-signature'] !== sig(req.body)) return res.sendStatus(401);
  const k = execFileSync('node', ['tools/keygen.js', 'new',
    '--label', req.body.data.metadata.reference, '--days', '90']).toString();
  mail(req.body.data.email, keyFrom(k));          // or store in KV for a "my keys" page
  res.sendStatus(200);
});
```
Then wire `buy.html`: set `CHECKOUT.ngn` / `CHECKOUT.usd` at the bottom of the file — the buttons
are already wired to read those two constants.

---

## D · Paying in Litecoin — no provider account, no email, no human in the loop

Buyers send LTC to **your own address**. The site notices the exact amount on-chain and mints the key.
`buy.html` has the panel; the edge function serves three routes and one readout:

    POST /crypto/quote   {"plan":"season","email":"optional"}   → {id, token, amount, address, pay, expires_in}
    POST /crypto/status  {"id":"q1","token":"…"}                → waiting | seen | paid(+key)
    POST /crypto/claim   {"id":"…","token":"…","txid":"…"}      → same, but driven by a pasted txid
    GET  /crypto/check                                           → is any of this usable right now?

**One setting turns it on** — the SQL editor, no redeploy:

    insert into public.app_config (key, value) values
      ('LTC_ADDRESS','ltc1q-your-own-address-here'),
      ('LTC_MIN_CONFS','2'),          -- confirmations before a key is minted
      ('LTC_QUOTE_TTL','1200')        -- seconds an amount is held for
    on conflict (key) do update set value = excluded.value;

Then `curl -s $F/crypto/check` should read `address_shape_ok: true`, `mint_secret: configured`, and a
price per plan. If a rate source is unreachable the quote **refuses** rather than guessing.

**Why the amount is the order.** A quote adds 0.000001–0.001 LTC of unique "dust" to the plan price and
the database refuses to open a second order at an amount that is already reserved. So ₦18,000 is not
`0.24000000` LTC but `0.24001733` — a transfer identifies its buyer with no reference numbers, no email,
and no "what's your txid?" in your DMs. The watermark is generated with BigInt on purpose: an `int32`
overflow (`1800 × 1e8`) silently zeroed it in the first version, which would have made two buyers of the
same plan indistinguishable. `tests/edge-deno.js` pins the exact arithmetic now.

**What is not true, said plainly:**
- `tools/verify-crypto-ui.js` is the one that catches a broken panel, and it is the reason the first
  live version of this page is not quietly broken: `/js/crypto.js` was 404 because the file was not in
  the `PUBLIC` whitelist, and a whitelist miss looks like a routing bug from curl. That run rendered
  the real page, clicked the real button, and fed it the real HTTP bodies.
- There is no email. The key is returned in the browser and stored on the order row, readable by
  whoever holds the quote token (the buyer, from `#ltc=id.token` in their URL, or `crypto_get` by hand).
  Want receipts in an inbox? Set `RECEIPT_WEBHOOK_URL` in `app_config` to any endpoint that can send
  mail (a 20-line Resend function, a Make/Zapier webhook, an Airtable form). On settlement the function
  POSTs the whole receipt object there once, fire-and-forget — no code change, and a dead webhook can
  never block a buyer from getting their key, because the key is returned before it is attempted.
- Your address is public, so anyone can watch it. Two defences exist: the watermark (a stranger's
  payment will not match your order's amount) and a 2-minute age guard (a transaction older than the
  quote cannot be claimed for it). The residual risk is a payment that matches exactly and lands inside
  the window — rare, but a shared address makes it possible. **Rotate `LTC_ADDRESS` per campaign** if
  volume ever makes you nervous, and expire old orders by leaving `LTC_QUOTE_TTL` short.
- Under/overpayment is refused, not reconciled. Right now `crypto_probe` requires an exact match; a
  buyer who sends `0.24` when asked for `0.24001733` gets nothing automatically. Refund by hand, or
  widen the tolerance in `crypto_probe` deliberately (`>= amount` is a one-line change that trades away
  the "amount is the order id" property, so it should be a decision, not a default).

Verify any of it with the live checker, which needs no payment:

    SUPABASE_ACCESS_TOKEN=… node tools/verify-crypto.js --address --explorer   # 48 checks incl. your address + BlockCypher
    node tests/edge-deno.js       # 70 checks, the real module under Deno, services stubbed, no network
    node tools/verify-crypto-ui.js  # 34 checks: renders buy.html in jsdom and CLICKS it, answering
                                    # the page's fetches with the LIVE function's real responses

## Vercel, if someone insists — and why the repo now refuses to be deployed badly there

Pushing this repo to Vercel without the committed `vercel.json` gives you one of two things, and both
report success: the Node auto-detect imports `server.js`, finds no exported handler, and shows
`500 FUNCTION_INVOCATION_FAILED`; or the static preset publishes every file in the repo at a public
URL, `js/tasks.js` (the paid corpus) included, with no error anywhere. The first is a broken site. The
second is a leaked one, which is worse precisely because nothing looks wrong.

`vercel.json` + `api/index.js` + `api/_gate.js` + `.vercelignore` (committed) make a Vercel deploy both
build and stay locked. Two facts, learned the hard way, that any future editor must keep:

- **Vercel validates `vercel.json` against a JSON schema with `additionalProperties: false`.** One
  extra key — even a `_comment` — fails the build outright. No comments in that file; notes go in
  `deploy/VERCEL.md`.
- **A rewrite cannot gate a file that exists.** Vercel applies the filesystem *before* rewrites, on
  purpose, and says so in its own docs. So the protection is not `vercel.json` at all: it is
  `.vercelignore` excluding every protected page and script from the deployment, so there is nothing for
  the filesystem to prefer. The function then synthesises the 402 from `deploy/gate-fallback.html`
  (because `gate.html` is excluded too), and `nextHandler` answers the paid `.js` files with the same
  empty stub the other two variants use.

Consequence worth stating: **the Vercel copy cannot serve the graded workspace to anyone**, keyholder
included — which is the second reason payments and the paid corpus live on the Supabase deployment.
`deploy/VERCEL.md` has the full note, including the env var that decides whether any key verifies at
all. Pinned by `node tests/vercel-entry.js` (32 checks over real HTTP against the real handler, plus a
second pass against a temp copy of the repo minus `.vercelignore`, run by `tests/verify.js`).

## A CDN in front of a paywall is a leak until you say otherwise

`cache-control` is not cosmetic here. An early version of the Supabase function gave every file
under `/css`, `/js`, `/assets` a five-minute public TTL. `/js/tasks.js` is the paid corpus *and*
lives under `/js`, so one buyer's authenticated `200` was cached at the edge and then handed to
the next stranger for free — and it also poisoned that URL for five minutes in the other
direction (a stale `402` on `/css/app.css` after the file existed).

The rule, enforced in `supabase/functions/annotate/index.ts` and asserted by the live test:

| response | cache-control |
|---|---|
| 200 on any `PROTECT` path | `no-store` |
| 200 on a `PUBLIC` asset (`/css`, `/js`, `/assets`) | `public, max-age=300, stale-while-revalidate=60` |
| 200 on a page | `no-store` |
| 402, 404, `/unlock`, `/session` | `no-store` |

Two minutes of stale CSS is an annoyance; five minutes of free corpus is a refund. If you touch
these headers, run the sequence: **fetch with a key → fetch the same URL without one → the second
must still be 402.**

## If the paywall serves everything anyway (read this before anything else)

Both locks in this repo are driven by one list — the `PUBLIC` / `PROTECT` regex pair, shared
verbatim between `server.js` and `deploy/cloudflare-pages-function.js` (a test asserts they are
byte-identical). Two shapes of mistake silently open the door, and both were actually hit while
building this:

```js
const PUBLIC = /^(\/|\/index\.html|...)/;      // matches EVERY path: `^(/` then anything
const PUBLIC = /^\/(?:index\.html|css\/)$/;    // anchored: /css/app.css never matches, lock is too tight
```

Symptoms: `curl -I https://yoursite/task.html` returns **200** with no key (open door), or your
pages render unstyled because `/css/app.css` got locked out (over-tight). `node tests/verify.js`
checks the classification of 28 specific paths; run it after any edit to either list.

## Option A2 · All-Supabase (one free tier, keys in Postgres) — **recommended**

Already deployed for this project, so these are the commands that ran, not a sketch:

```bash
# 1 · the schema, three idempotent files, any order
#     0001 fresh install · 0002 repairs an older 0001 · 0003 adds columns an old table lacks
# 2 · a private bucket called "site", with the 30 site files in it
# 3 · the function + six secrets, incl. SITE_BASE=/functions/v1/annotate
npx supabase@latest functions deploy annotate --no-verify-jwt

F=https://veecksfcnlpppzvplcyt.supabase.co/functions/v1/annotate
curl -s  $F/api/health          # {"ok":true,...,"build":"annotate-2026-08-30.2"}
curl -sI $F/guide.html | head -1 # 200  free
curl -sI $F/task.html  | head -1 # 402  LOCKED: the bytes never leave without a key
curl -sI $F/js/tasks.js | head -1# 402  the 39 KB corpus, 94-byte stub in its place
```

Full step-by-step, including the `curl` upload loop and why the secrets are not called
`SUPABASE_*`: `supabase/SETUP.md` §3a.

If you would rather not have a Cloudflare project either: `supabase/SETUP.md` runs the whole
site from an Edge Function that serves a **private** storage bucket, and validates keys against
`public.key_check` in Postgres. Same 402 rule, plus instant revocation, buyer labels, a
brute-force counter, and key minting straight from a payment webhook:

```bash
supabase functions deploy annotate --no-verify-jwt
curl -sI $FUNCTION_URL/task.html | head -1     # 402 = the lock works
```

`server.js` also speaks that backend with no code change — just
`SUPABASE_URL=… SERVICE_ROLE_KEY=… node server.js` (`/api/health` will say
`backend: supabase-postgres`). Set `ACCESS_MODE=local` to force the offline HMAC path.

## After changing any page: `node tools/upload-site.js`, and trust only a byte check

The site lives in a private bucket, so `git push` changes nothing a buyer can see. Uploading is the
deploy, and it now verifies itself in the strictest way available: it reads every object back from
storage and compares **hashes**, retrying briefly because an object replaced under its own key can
serve the previous copy for a few hundred milliseconds.

That read-back exists because of a bug that survived every check I had: the uploader sent
`buf.toString('binary')`, which turns each UTF-8 byte into a *character*, and the HTTP layer then
re-encoded those characters as UTF-8. Every em-dash, middot and arrow on the live pages became
`â`-style mojibake. Status codes were all 200, every local test passed (the local server reads
from disk), and the size-only `--check` I had been calling a verification couldn't see it either.
`tools/verify-crypto-ui.js`, which renders the served page, is the thing that finally caught it.

Two rules fall out of that, both encoded in the tool now:
- **Never send a decoded string where a file's bytes belong.** Pass the Buffer.
- **A deploy check must compare content, not shape.** Length, count and status code all lie; a hash
  does not. `--check` therefore re-fetches and hashes all 32 files rather than asking "did it answer?".

Also note what is *not* uploaded, deliberately: `server.js` and `package.json` are the local dev
server, `tools/` and `tests/` never reach the bucket, and `robots.txt` / `sitemap.xml` /
`favicon.ico` now are (they used to be skipped silently, so crawlers got a 404 for robots.txt while
the upload reported success — `collect()` only walked `.html` files plus three directories).

## Making the paywall actually hold

Ranked by how much they're worth. Do 1–3.

1. **Serve protected code only after auth.** Already true in A and B: without a valid key the
   server returns the gate page (402) and never sends `task.html`, `js/tasks.js`, etc.
2. **Keep the *content* off the client entirely.** The task corpus is the product. Split it:
   make `js/tasks.js` a stub that does `fetch('/api/tasks')`, and serve the real JSON only to
   authenticated requests. Now a leaked page can't be handed around; a leaked *key* can, and you
   can revoke keys. This is the single best upgrade you can make.
3. **Minify + light obfuscation** (`terser`, or `javascript-obfuscator`) for the shared JS.
   Raises effort, provides no security. Don't over-invest here.
4. **Per-user watermarking** (inject the key label into a corner of the app and into exported
   logs) — useful for tracing a leak, cheap to do once you have volume.
5. **Rate-limit `/api/submit`** and cap grading requests per key per hour, or one buyer with a
   script will quietly become your entire hosting bill.

---

## Legal + platform-relations notes, because you're naming real companies

- **Names are fine, impersonation is not.** Describing Outlier/Handshake/RWS and quoting their
  published rates is nominative fair use-ish and normal. Using their logos, copied UI screens,
  or anything that reads as "this is the official portal" is how you get a DMCA/UDRP headache
  and, worse, get mistaken for a scam ring. The build keeps to the line: no brand assets, an
  "illustrative reconstruction" watermark on every mockup, a non-affiliation line on every page.
  **Keep those.** Add a plain disclaimer in the footer and on `buy.html`.
- **Never promise outcomes.** "Practise here, get hired there" is fine. "Guaranteed approval",
  "we have the real questions" is a refund dispute waiting to happen — and if you ever sell
  actual leaked briefs, that's a contract problem for your customers, not just you.
- **Screenshot policy.** If you want real screenshots, take your own from your own contributor
  accounts, blur anything confidential, and expect that NDA-covered screens should stay out.
  Rehosting someone else's marketing images is the risky version.
- **Taxes.** This is business income, and if you use Paystack/Flutterwave your payout lands in a
  naira account; with Lemon Squeezy/Paddle the VAT is theirs. Register the trade name, keep the
  ledger, and put aside WHT/ Company Income Tax or CIT-adjacent obligations as applicable. Ask a
  Nigerian accountant once, early — it's cheaper than the clean-up.
- **Refunds.** State a policy on `buy.html`. One honest line ("refund if the lock fails on your
  side") pre-empts most disputes and costs you almost nothing.

---

## Checklist before you send anybody the link

- [ ] `curl -sI https://…/task.html` → **402** without a key
- [ ] Key issued from the *deployed* secret verifies → 200
- [ ] Expired key → 402 with the renewal message
- [ ] `node tests/verify.js` still green (it drives every page and grader)
- [ ] Buy button opens a real checkout, not the `PASTE_…` placeholder
- [ ] Footer + `buy.html` carry the non-affiliation line
- [ ] You have written down where `ANNOTATE_SECRET` lives (losing it invalidates every key)
- [ ] If using Supabase: the `ANNOTATE_SECRET` row in `public.app_config` is byte-identical to
      `node tools/keygen.js secret`, and `service_role` appears only in function secrets
- [ ] `robots.txt` disallows `/task.html`, `/queue.html`, `/api/` so the paywall isn't indexed
