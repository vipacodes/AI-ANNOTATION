# AnnotateTrainer — a practice sandbox for AI-training / data-annotation work

## What this is

A self-contained web app that **simulates the work** done on AI-trainer marketplaces
(model-response ranking, rubric writing, fact-checking, reasoning-trace review, code
review, red-teaming, search-quality rating) so someone can practise, get graded against
an explicit rubric, and see where they lose points.

It also includes:

- **`detector.html`** — a transparent, explainable *AI-tells detector*. It is NOT a
  classifier. It measures surface features (sentence-length burstiness, lexical
  diversity, first-person density, boilerplate transition count, AI-cliché hits) and
  shows you the maths. Purpose: teach people to write like themselves so they don't get
  falsely flagged.
- **`trust-safety.html`** — a demo of the real hazard in this industry: opaque account
  deactivations, held payments, unpaid onboarding. Includes the honeypot task and a
  evidence/logbook workflow.
- **`guide.html`** — honest, sourced notes on the actual platforms (rates, country
  eligibility, payout rails, red flags).
- **`platforms.html` → `platform.html?p=<id>`** — a picker over 12 real vendors (Outlier,
  Handshake AI, RWS TrainAI, Mercor, Alignerr, DataAnnotation, Mindrift, Appen, Toloka,
  Pareto, Prolific, TELUS). Pick one and you get *that* platform's funnel, its gate, its
  payout rail, its Nigeria/eligibility status, what gets contributors restricted, and a
  practice set assembled to resemble its task shapes.
- **`js/mockups.js` + `assets/`** — the "screens": four animated inline-SVG reconstructions
  of what those workspaces look like (squad board, fellowship scope, invitation pool,
  credential gate), labelled **"reconstruction · not a screenshot"**, plus PNG exports in
  `assets/` for sharing. They are drawn, not scraped: no vendor asset is embedded or
  hot-linked, and no video is faked.
- **`buy.html` / `gate.html` / `js/access.js` / `server.js` / `deploy/`** — the paywall, plus one-time payment in Litecoin to your own wallet (`js/crypto.js`, `/crypto/*`): a unique watermarked amount per order, detected on-chain, key minted with no webhook, no processor account and no email.
  `tools/keygen.js` mints signed keys (`id.signature.expiry`), the server withholds protected
  pages *and* the corpus JS (`/js/tasks.js` returns a 94-byte stub, not the tasks) until a
  valid key presents itself. See **`DEPLOY.md`** for publishing it and taking money.

- **`p.html` + `js/skins.js` + `js/clone.js` + `css/clones.css`** — the **platform clones**. One page,
  twelve skins: `p.html?p=outlier` draws the Outlier project dashboard (stat block, deliverable and
  assessment rate, assessment status, project list), its task workspace and its earnings ledger; the other
  eleven ids re-skin the same three views with that product's palette, wordmark, nav labels and payout
  wording. Chrome is *data* — a new platform is a row in `js/skins.js`, never a forked page — but the work
  inside it is the real thing: the clone mounts `js/workspace.js`, so grading, the rubric reveal, the
  paste/typing telemetry and the ledger write run from the same code the paid workspace runs. **The one
  functional difference: you cannot earn or withdraw.** Real rates and a running balance stay visible
  because they are the lesson; the payout control is rendered, greyed, and labelled *"Withdrawal
  disabled"*, because a clone that asked for a bank or PayPal handle would be a phishing page.


## What this deliberately is not

1. **Not a job, not a hiring channel, and not a way to pretend you were hired.** `p.html`
   reproduces a real product's chrome on the owner's explicit instruction, so the labels that
   make it a *practice copy* are load-bearing, not decoration: the `Practice account.` strip on
   every view, the disabled payout control, and the "would have earned" phrasing on the ledger.
   They must survive every future edit to a clone. Brand-impersonating versions of this kind of
   site are the standard prop in "AI trainer onboarding" fee-scam operations — this one never
   asks for a payment detail, a document, or an email.
2. **No fake earnings, no fake payout screenshots, no fabricated trust badges.** Those
   exist here only as a labelled counter-example inside `guide.html`.
3. **No impersonation of a verifier.** You cannot use this site to prove to somebody that
   you were vetted by a real platform. Nothing on here is a credential.
4. **The detector must never be pointed at a person.** Use it on your own drafts.
   Detector output is heuristic, biased, and wrong often. See the warning on the page.

Using this to *learn* the work is exactly what it's for. Using it to make someone believe
they've been hired by a real company is not, and the app has no features that would help.

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

## Two ways to run it

| | what you get |
|---|---|
| `node server.js` | everything works, **and the paywall is enforced** (402 + gate screen on protected files). `GATE=off` disables the lock for development. |
| opening `index.html` from disk | the catalogue, guide and platform pages render; protected pages show a **"Soft lock"** banner and let you in on an honour system. Fine for demoing, *not* something to sell. |

```bash
node server.js                       # http://localhost:4173  (gate ON)
node tools/keygen.js new --label "Ada C." --days 90     # mint a key
GATE=off node server.js              # local dev, no lock
```

## Run it

```bash
node server.js            # http://localhost:4173  (adds /api/* submission log)
```

Or just open `index.html` directly — the whole thing runs `file://` with `localStorage`
persistence. The server is only needed for the shared submissions log.

## See also

`QUICKSTART.md` (view it now / demo URL / real deploy), `DEPLOY.md` (hosting, keys,
payments, hardening, legal notes), and `supabase/SETUP.md` — an optional Postgres-backed
key store with an edge function that can serve the whole site. Keys, revocation, buyer
labels, a brute-force counter and payment-webhook minting then live in the database:

```
supabase/migrations/0001_paywall.sql      # key_check / key_mint / key_attempt RPCs + trigger
supabase/functions/annotate/index.ts      # serves the site from a private bucket, gates by key
supabase/SETUP.md                         # paste-ready dashboard steps
ACCESS.md                                 # the minimum tokens to hand an agent, and how to revoke them
```

`deploy/cloudflare-pages-function.js` can use that same database, in which case Cloudflare
stores **no secret at all** and `node --experimental-vm-modules tests/edge-function.js` proves the
lock (33 checks, including how the function behaves behind Supabase's `/functions/v1/<slug>`
mount) by importing the real function against a stubbed PostgREST.

Three things to know if you read or extend the SQL, because each one cost a real debugging loop:

- `supabase/migrations/0001_paywall.sql` is the source of truth. `0002` (function repair) and
  `0003` (column repair, because `create table if not exists` never upgrades an existing table)
  are **generated** from it: edit 0001, run `node tools/gen-migrations.js`, and
  `tests/sql-migration.js` fails if you forget.
- Two different env-var vocabularies are deliberate. The Supabase CLI rejects secret names
  beginning with `SUPABASE_`, so the *edge function* reads `PROJECT_URL` / `ANON_KEY`; Cloudflare
  Pages has no such rule, so the *Pages function* reads `SUPABASE_URL` / `SUPABASE_ANON_KEY`.
- `cache-control` is a paywall setting. Anything protected is `no-store`; caching a
  key-bearing `200` on `/js/tasks.js` would give the corpus away to the next stranger.

## Run the checks

```bash
npm i --prefix ~/.testdeps jsdom   # one-time, outside the repo (keeps this repo dependency-free)
node tests/verify.js               # 311 assertions (runs the clone suite as a child); jsdom from that prefix
node tests/clone-ui.js             # the platform clones alone: 60 checks of chrome, visibility, shared
                                   # grading and the disabled payout, driven in jsdom as a paid visitor
```

It loads every page headlessly, clicks through the real UI (answers the assessment, assigns
rankings, selects code lines, submits), and asserts that the rubric actually discriminates:
gold submissions score >=95-100, lazy submissions score <70, the hidden integrity probe only
passes when you flag it, storage persists across pages, and the boundary checks below hold
(no fabricated earnings, no ID collection, no credential that could be shown to an employer; money
only ever moves through a hosted checkout link you wire up yourself). The clone suite checks the
other side of the same line: that `p.html` paints the product's own chrome and still refuses to pay.

The paywall gets the same treatment: the harness boots `server.js` on a random free port, mints
a key with `tools/keygen.js`, and asserts the real HTTP behaviour — 402 + gate screen for
protected pages, a 94-byte stub instead of `/js/tasks.js`, 200 with a valid key or cookie, a
forged signature refused, an expired key refused, and revocation taking effect on the next
request. Client-side, it loads `queue.html` with a key in storage and asserts the content only
appears for a server-verified session.

Last run: **276 assertions, 0 failures** (`node tests/verify.js`) — 8 task types, 13 pages, the
paywall (live `server.js` boot), `tests/edge-function.js` (33 checks, importing the real Cloudflare
function against a stubbed PostgREST), `tests/sql-migration.js` (54 checks over the three
migration files) and the boundary checks. Against the deployed project, `tools/verify-supabase.js`
(22) and `tools/verify-buyer-flow.js` (36) re-run the same claims against real Postgres and the
live URL; they need a token in the environment and are not part of the offline suite.

## Structure

```
tools/keygen.js      mint / list / verify / revoke keys; --sql prints an INSERT for Postgres
tools/gen-migrations.js  regenerates 0002 + 0003 from 0001 (0001 is the only file you edit)
tools/verify-supabase.js  live proof that the database half is really installed
tools/verify-buyer-flow.js  live proof of the lock, through the deployed URL
tools/upload-site.js  pushes the site into the private bucket and proves the bucket is private
server.js          zero-dependency node http server + /api submissions
index.html         landing
onboarding.html    timed qualification assessment (the unpaid 3 hours)
queue.html         task board -> task.html
task.html          the actual annotation UI + rubric grading
detector.html      AI-tells detector
trust-safety.html  flags, honeypots, logbook
earnings.html      time ledger incl. unpaid time
guide.html         real-platform notes
css/app.css        shared design system
js/storage.js      profile / attempts / earnings / flags ledger
js/detector.js     feature extraction + authenticity index
js/tasks.js        task corpus + grading rubrics (source of truth for scoring)
js/app.js          app shell (sidebar, banner, timers)
```

All scoring lives in `js/tasks.js` and is intentionally readable — the point is that
learners can see *how* they're being judged.

## Data & privacy

No network calls. `localStorage` only (key `annotatetrainer:v1`). If you run the server,
submissions append to `data/submissions.jsonl` inside the workspace. Delete that file to
clear it.
