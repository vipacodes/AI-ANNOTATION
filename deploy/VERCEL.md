Vercel notes for this repository. Read the first section before you click Deploy.

   A Vercel deploy of this repo is only safe with `vercel.json` + `api/index.js` in place, which are
   committed. Everything below is what those two files are for, and what a Vercel project does without
   them, and what a naive deploy does. The recommended deployment remains the Supabase function (DEPLOY.md § A2): it serves the site
   AND enforces the lock from one URL, and it is the only variant that takes payments.

WHAT YOU SAW
============

    500: INTERNAL_SERVER_ERROR   Code: FUNCTION_INVOCATION_FAILED
    ID: cdg1::fdw4c-...

That is not a bug in the site. It is Vercel's Node.js zero-config detection importing `server.js`,
which is a dev server: its module body calls `server.listen(...)` and exports no handler. Vercel
looks for an exported function to invoke, finds none, and the invocation fails. Nothing crashed at
build time; there was simply nothing to call.

The deeper problem with that route is what Vercel would do instead. Vercel's other zero-config mode
is "static site", and a static deploy of this repo publishes EVERY file in it at a public URL,
including `task.html`, `js/tasks.js`, `js/detector.js` and `data/` — the whole paid corpus, ungated,
with no error anywhere. A static Vercel deploy of this repository is not a broken site; it is a
leaked one that looks healthy.


WHY THE COMMITTED CONFIG IS SHAPED THE WAY IT IS
================================================

vercel.json
    framework: null, no buildCommand, no `public`/`outputDirectory`. The repo root IS the site.
    rewrites: [{ "source": "/((?!api/|_vercel/).*)", "destination": "/api/index" }]

    The rewrite matters more than it looks, and its POSITION within vercel.json matters most.
    Vercel evaluates route sources in a fixed order: a top-level `rewrites` entry is applied AFTER
    filesystem lookups, while `rewrites.beforeFiles` is applied BEFORE them. Under the first ordering
    `/task.html` is simply found on disk and served from the deployment, so the gate never sees the
    request. The site works and the paywall does not — the silent version of the leak above, and the
    one a generated config tends to produce, because "rewrite everything to a function" sounds like
    the safe instruction and is the unsafe one unless it runs before the filesystem.

    Vercel also evaluates `beforeFiles` rewrites first, which is the only ordering consistent with
    "no protected byte reaches a browser without a key". `vercel.json` here puts the catch-all where
    it is evaluated before any file lookup, and the test suite asserts the source pattern so a
    well-meaning simplification cannot move it. If you ever edit this file and `node
    tests/vercel-entry.js` goes green while your Vercel project shows a "Framework Override" or an
    auto-detected `public` directory, trust the test and fix the project settings.

api/index.js + api/_gate.js
    Vercel does not run Cloudflare Pages Functions (`export async function onRequest`). Rather than
    maintain a third copy of the gate — a third way to drift — the adapter evaluates
    `deploy/cloudflare-pages-function.js` and supplies the three things Cloudflare normally provides:

      globalThis.env    the Pages runtime exposes env as a global; Node keeps it in process.env
      context.fetch     used to render gate.html as the body of a 402; missing → 500 on the exact
                        response a non-paying visitor must get
      next()            must return a Response, and the gate calls it unawaited (`return next()`),
                        so an async-only adapter hands it undefined → 500 on every free page

    plus one that Vercel itself breaks: a catch-all rewrite replaces `req.url` with the function's
    own path (`/api/index`), so the gate would see `/` for every request and classify everything as
    free. `originalPath()` rebuilds it from `x-invoke-path`.

    If `next()` or `context.fetch` is ever missing, the handler answers 500 and serves nothing. It
    never serves the file. Fail closed is the only acceptable default for a function this thin.

tests/vercel-entry.js
    22 checks, run against the REAL exported handler over real HTTP on a loopback socket, reading the
    real files: free page 200, protected page 402-with-the-gate-screen, `js/tasks.js` the 94-byte
    stub, `/data` refused, unknown paths a styled 404, cache policy narrow, and the config assertions
    above. `node tests/vercel-entry.js`.


ENVIRONMENT VARIABLES
=====================

Settings → Environment Variables → your project. The function defaults `SUPABASE_URL` to the project
this site was built for, so in practice you set one:

    SUPABASE_ANON_KEY      the publishable/anon key. WITHOUT it the gate cannot verify any key at
                           all, and every unlock answers
                           "Server has neither a Postgres backend nor ANNOTATE_SECRET." — which is
                           correct: the files stay shut. Set it or accept a locked site.
    SUPABASE_URL           only if you are pointing at a different project
    SITE_BASE              leave unset at a Vercel root mount; set it if you ever mount under a path

Revocation, the buyer cookie and `access_keys` all live in Postgres, so a Vercel copy and the
Supabase copy share one key database: revoke once, both go dark. That is the one genuinely nice
property of this arrangement.

WHAT A VERCEL DEPLOY WILL NOT DO
================================

    POST /fulfill      the payment callback that turns a Paystack/Flutterwave reference into a key.
                       It exists only in supabase/functions/annotate/index.ts. The 404 is asserted
                       in tests/vercel-entry.js so it cannot be quietly half-implemented here.

    /crypto/*          the whole Litecoin path: quote, status, claim, check. Same reason — the SQL
                       helpers, the price feeds and the BlockCypher probes are written against the
                       Supabase runtime (Deno), and the amount-watermark logic depends on
                       `crypto_quote`/`crypto_probe`/`crypto_mark` being in the same project.

So: Vercel can HOST this site and lock it. It cannot SELL on it. If you want payments, deploy the
Supabase function (it serves everything, free tier, one URL) and use Vercel at most as a mirror of
the free pages.


IF YOU WANT VERCEL TO BE THE REAL DEPLOYMENT
============================================

Move the payment routes into `deploy/cloudflare-pages-function.js` (they are ~180 lines of the
Supabase module, and both run on a Fetch-API runtime), then delete the assertions that pin their
absence:

    tests/vercel-entry.js       'no /fulfill on this variant, and it does not mint anything'
    tests/edge-function.js      the route-list equality checks (they will pick up the drift for you)

Expect the crypto routes to need one change: `Deno.env` has no Vercel equivalent, which is why the
Supabase module reads config through `env()`/`globalThis.env` in the first place. Then verify with
`tools/verify-crypto.js` and `tools/verify-crypto-ui.js`, both of which are deployment-agnostic
apart from the base URL in `$F`.
