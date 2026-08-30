# Quick start — view it, then take it live

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
node tests/verify.js                 # 262 assertions, incl. a live boot of server.js + the gate
node --experimental-vm-modules tests/edge-function.js   # the Cloudflare function, for real
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

Follow **`DEPLOY.md`**, path A. Short version:

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
