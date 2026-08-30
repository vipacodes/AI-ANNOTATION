# Putting it online, and charging for it

Three setups, cheapest first. Take **A** unless you already know why you need B.

---

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

3. **Set the secret.** Dashboard → your Pages project → Settings → Environment variables →
   add `ANNOTATE_SECRET` = the value from `node tools/keygen.js secret`. In Cloudflare's
   Workers runtime `process.env` is not populated, so read it from the bound `env` object —
   the function already does `globalThis.env`. Set it in **Production and Preview**.

4. **Custom domain.** Pages → Custom domains → add e.g. `practice.yourdomain.com`. Free TLS.
   If you don't own a domain yet: Whogohost/Qservers/Namecheap, `.ng` or `.com`, ~₦4–9k/yr.

5. **Test the lock before you sell it.**
   ```bash
   curl -sI https://practice.example.com/task.html          # expect 402
   curl -sI https://practice.example.com/index.html         # expect 200
   curl -sI -H "x-access-key: $(node tools/keygen.js new --days 1 | sed -n 3p)" https://practice.example.com/task.html   # expect 200
   ```
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

## C · Payments → automatic key delivery

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
- [ ] `robots.txt` disallows `/task.html`, `/queue.html`, `/api/` so the paywall isn't indexed
