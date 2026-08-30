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
- **`buy.html` / `gate.html` / `js/access.js` / `server.js` / `deploy/`** — the paywall.
  `tools/keygen.js` mints signed keys (`id.signature.expiry`), the server withholds protected
  pages *and* the corpus JS (`/js/tasks.js` returns a 94-byte stub, not the tasks) until a
  valid key presents itself. See **`DEPLOY.md`** for publishing it and taking money.

## What this deliberately is not

1. **Not a clone of any real platform.** No Outlier/Handshake/RWS/Scale logos, marks,
   screenshots, or copy, and no attempt to pass as one. Brand-impersonating versions of
   this exact site are the standard prop in "AI trainer onboarding" fee-scam operations.
2. **No fake earnings, no fake payout screenshots, no fabricated trust badges.** Those
   exist here only as a labelled counter-example inside `guide.html`.
3. **No impersonation of a verifier.** You cannot use this site to prove to somebody that
   you were vetted by a real platform. Nothing on here is a credential.
4. **The detector must never be pointed at a person.** Use it on your own drafts.
   Detector output is heuristic, biased, and wrong often. See the warning on the page.

Using this to *learn* the work is exactly what it's for. Using it to make someone believe
they've been hired by a real company is not, and the app has no features that would help.

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
```

## Run the checks

```bash
npm i --prefix ~/.testdeps jsdom   # one-time, outside the repo (keeps this repo dependency-free)
node tests/verify.js               # 258 assertions; needs jsdom, resolved from that prefix
```

It loads every page headlessly, clicks through the real UI (answers the assessment, assigns
rankings, selects code lines, submits), and asserts that the rubric actually discriminates:
gold submissions score >=95-100, lazy submissions score <70, the hidden integrity probe only
passes when you flag it, storage persists across pages, and the boundary checks below hold
(no brand assets, no fabricated earnings, no ID collection; money only ever moves through a
hosted checkout link you wire up yourself).

The paywall gets the same treatment: the harness boots `server.js` on a random free port, mints
a key with `tools/keygen.js`, and asserts the real HTTP behaviour — 402 + gate screen for
protected pages, a 94-byte stub instead of `/js/tasks.js`, 200 with a valid key or cookie, a
forged signature refused, an expired key refused, and revocation taking effect on the next
request. Client-side, it loads `queue.html` with a key in storage and asserts the content only
appears for a server-verified session.

Last run: **258 assertions, 0 failures** (`node tests/verify.js`) — 8 task types, 13 pages,
the paywall (live server boot), and the boundary checks.

## Structure

```
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
