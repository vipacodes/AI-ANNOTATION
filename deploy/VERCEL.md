Vercel notes for this repository. Read the first section before you click Deploy.

   READ THIS FIRST — WHICH URL TO GIVE PEOPLE
   ==========================================

   Use the Vercel URL to be read. Use the Supabase URL as the backend.

   A Supabase Edge Function CANNOT serve a readable HTML page from its project domain. Their own docs,
   twice: "HTML content is not supported. GET requests that return text/html will be rewritten to
   text/plain" (supabase.com/docs/guides/functions/http-methods, /development-tips) and "Serving of HTML
   content is only supported with custom domains" (/guides/functions/limits). Storage does the same to
   .html objects (github.com/orgs/supabase/discussions/39110). A Pro plan with a custom domain is the only
   way out, and there is no config, header or Response option that beats it — verified here from the live
   function: `content-type: text/plain`, `x-content-type-options: nosniff`, on every path, with the
   module's own `x-served-by: annotate-edge` header still present, so the rewrite happens after the code
   returns. `nosniff` also removes the browser's option of guessing.

   Consequence: someone who opens the Supabase URL in a browser sees the site's MARKUP, not the site.
   That is the "why is the page showing html codes and not tasks" report, and it is not a rendering bug —
   the bytes were correct the whole time, the label was forced. A function reply with a
   `text/plain; charset=utf-8` body that starts `<!DOCTYPE html>` is this, and nothing else.

   What the two URLs are, now:
     · Vercel  — renders every page, free and paid, enforces the same gate against the same key database,
                 and pulls paid bytes from the function (see MIRROR below). This is the front door.
     · Supabase — the origin: the bucket that holds the paid corpus, the RPCs that check keys, the crypto
                 routes. Reach for it to buy (buy.html renders as text; the payment panel's own fetches are
                 JSON and work), and for anything you script rather than click.
   A browser pointed at the Supabase URL now also gets a one-line notice at the top of the raw document
   naming the URL that renders, so nobody has to decode what they are looking at.

   Details of that notice, because each one cost a production fix and all three are asserted in
   tests/edge-deno.js (BUILD annotate-2026-08-30.17):
     - it is a fixed overlay inserted INSIDE <body>. Written after <head> it lands in the head, which a
       browser still paints, so it looked fine while the markup was wrong.
     - it appears only for a browser navigation: Accept: text/html AND a browser User-Agent. A curl or
       the Vercel mirror must receive byte-exact content, or the mirror would serve our banner inside the
       lock screen it renders. `?notice=0` turns it off for a human who wants the raw source.
     - the link is the URL verbatim. encodeURIComponent over a whole URL percent-encodes the scheme and
       produces a dead link, on the one page whose job is "click here instead".
   Change where it points:  supabase functions secrets -r <ref> RENDER_URL=https://your-domain
   Confirm which build answered:  curl -s <fn-url>/api/health   ->  {"build":"annotate-..."}

   A Vercel deploy of this repo is only safe with `vercel.json` + `api/index.js` in place, which are
   committed. Everything below is what those two files are for, and what a Vercel project does without
   them, and what a naive deploy does.

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
    { "$schema": "https://openapi.vercel.sh/vercel.json", "framework": null,
      "functions": { "api/index.js": { "memory": 1024, "maxDuration": 30 } },
      "rewrites": [ { "source": "/((?!_vercel/).*)", "destination": "/api/index" } ] }

    Two hard lessons are encoded in those nine lines.

    1. There is no comment syntax in this file and NO extra keys are tolerated: the schema sets
       `additionalProperties: false`, so an explanatory `_comment` key does not annotate the config, it
       fails the build ("should NOT have additional property '_comment'"). Notes belong in this file and
       in code comments. Validate a change before pushing it:

           python3 - <<'PY'
           import json,urllib.request
           sc=json.load(urllib.request.urlopen('https://openapi.vercel.sh/vercel.json'))
           cfg=json.load(open('vercel.json'))
           print([k for k in cfg if k not in sc['properties']] or 'clean')
           PY

       (tests/vercel-entry.js does exactly this, fetched, and skips if you are offline.)

    2. `beforeFiles` is NOT a vercel.json key. It belongs to next.config.js. An earlier revision of this
       project asserted that its catch-all rewrite "runs before the filesystem" and leaned on that for
       the paywall. It does not, it cannot, and Vercel says so in the docs for `rewrites`:

           "The source property should NOT be a file because precedence is given to the filesystem
            prior to rewrites being applied."

       So a rewrite can never protect `task.html`: the file exists, the filesystem wins, the function is
       skipped, the paid corpus is public. Not a leak you can spot from a status code, because
       everything returns a healthy 200.

    The rewrite is still here, and still a catch-all excluding only `_vercel/` — it is how /unlock,
    /session and the asset requests reach the function at all. It is just not the security boundary.

.vercelignore — this is the security boundary
    The protected pages, `js/tasks.js`, `js/detector.js`, `gate.html`, and all of `data/`, `tools/`,
    `tests/`, `supabase/` are EXCLUDED FROM THE DEPLOYMENT. The paywall on Vercel works because the paid
    bytes are not on the server, which is a property of the filesystem rather than a race with routing
    precedence. `nextHandler` then synthesises the 402 itself, from `deploy/gate-fallback.html`, because
    `gate.html` is excluded too — a missing file must not turn a lock screen into a 404.

    The cost of that design was: a Vercel deployment could not serve the paid pages at all, even to a
    keyholder — the lock screen was the best answer it had, and a subscriber who unlocked and paid would
    read it as a broken product. (For one deploy that is exactly what happened: `/unlock` said
    `{"ok":true,"label":"Owner access · 90 days"}` while `/task.html` stayed 402.)

    It is fixed by the mirror, not by a cleverer rewrite: after the gate clears a request, `nextHandler`
    GETs that same path from the gated origin, forwarding the visitor's cookie, so the *origin's* gate
    decides again against the same key database. Both decisions fail closed and either can deny, so a
    regex drifting on one host cannot leak on the other. It needs `ANNOTATE_MIRROR` only if the origin is
    not the default one — set it under Project Settings → Environment Variables → Production, or

        POST /v10/projects/<project>/env  {"key":"ANNOTATE_MIRROR","value":"https://<ref>.supabase.co/functions/v1/annotate","type":"encrypted","target":["production"]}

    Without it the mirror falls back to `SUPABASE_URL` + `/functions/v1/annotate` (the project root
    would answer Supabase's own 404, which reads as "the origin declined"). It refuses to point at
    `.vercel.app`, `localhost` or `127.0.0.1`, because a mirror that resolves back to this deployment is
    a request loop. `tests/vercel-entry.js --mirror` exercises the whole path against the live origin and
    asserts both directions: a key-holder gets 200 and 23 KB of graded workspace, an anonymous visitor
    still gets the lock screen.

    The mirror also OWNS the content-type of what it proxies, by extension, in api/index.js. It has to:
    the origin's HTML arrives labelled `text/plain` with `nosniff` (the Supabase rule above), and Vercel
    passes inherited headers straight through — so a paid page reached by an unlocked, paying visitor was
    printed as source code on a host that would happily have rendered it. Two checks in
    `tests/vercel-entry.js` pin it: mirrored `.html` must come back `text/html`, and
    `x-content-type-options` must not ride along. Bump `GATE_BUILD` in api/_gate.js with any change to
    this plumbing; `x-annotate-build` is on every function reply and is the only way to tell a stale
    artifact from a live one that took a different branch.

    Add a page to PROTECT? Add it here in the same commit. `tests/vercel-entry.js` fails if the two
    lists drift, and a second phase of that test copies the repo minus .vercelignore into a temp
    directory and re-runs every assertion against the copy — so "the file is absent in production" is
    verified rather than assumed.

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

WHAT THE RUNTIME ACTUALLY LOOKS LIKE
====================================

Three facts, each of which cost a failed production deploy, that no amount of reading api/index.js
would have told you. If you change how the gate loads, all three apply.

1. A Vercel function is NOT the repository. @vercel/node emits an artifact from the entry point plus
   whatever it can TRACE through require/import. At runtime `__dirname` is `/var/task` and there is no
   `deploy/` directory beside it — so `fs.readFileSync(path.join(__dirname, '..', 'deploy', ...))`
   throws, and every path the rewrite routes through the function answers 500
   FUNCTION_INVOCATION_FAILED. That includes `/unlock` and every paid page, i.e. the site looks
   "half up" (static HTML serves) while nobody can buy or sign in.

   Two consequences, both now encoded in the code rather than in memory:
     - the gate is reached through `api/gate-bundled.js`, a literal
       `export { onRequest } from '../deploy/cloudflare-pages-function.js'` the builder inlines. An
       `await import()` of a path string is NOT visible to it, and a sibling file you added for the
       import to find is an input, not an output, so it is not there at runtime either.
     - the two bodies a reply needs (the 402 lock screen, the 404 page) are EMBEDDED in api/_gate.js,
       generated from `deploy/gate-fallback.html` and `404.html` by `tools/embed-fallbacks.js`. The
       files are still preferred when present, so dev and Cloudflare read them from disk. After editing
       either one: `node tools/embed-fallbacks.js` — the suite fails if they drift.

2. `readyState: ERROR` on a deployment and a 19 KB Vercel-branded page for EVERY path (including ones
   that do not exist) are the same event seen from the API and the browser. A deployment nobody has
   claimed shows that page, and a build that failed looks identical from curl. Check
   `GET /v13/deployments/<url>` before believing a routing bug: `builds[].readyState` can be READY
   while the deployment is ERROR.

3. `.vercelignore` prunes the static output, it does not hide repo files. Verified on a live deploy:
   `task.html`/`queue.html`/`gate.html` were absent and public pages served, while `js/tasks.js`,
   `vercel.json` and `*.md` returned 500 because they were never in the output and fell through to the
   (then broken) function. Absence plus a broken function is still closed — no paid bytes reached a
   browser — but it is a 500 where the visitor should have seen a lock screen, which is why fix 1
   matters more than the ignore file.

DIAGNOSING WITHOUT THE DASHBOARD
================================

`tools/vprobe.js` deploys three shapes into the project (no-op handler / the gate set / the repo minus
.vercelignore) so "does Vercel run my function at all" is answerable from the CLI. A project-scoped
`vcp_` token can read `GET /v9/projects`, `GET /v6/deployments`, `GET /v13/deployments/<id>`,
`POST /v10/projects/<id>/env` and `POST /v13/deployments`, and can PATCH project settings — enough to
remove `ssoProtection`, which had been making every request from a browser that was not logged into
that team redirect to `vercel.com/sso-api` and look like a dead deployment. It cannot read runtime logs
(`/{v2,v3}/deployments/<id>/{files,logs}` → 404), so behaviour is the only instrument:

    D=https://<your-production-domain>
    for p in "" index.html platforms.html task.html queue.html js/tasks.js data/tasks.json api/health; do
      printf '%-18s %s\n' "/$p" "$(curl -s -o /dev/null -w '%{http_code}' $D/$p)"
    done
    curl -s -X POST -H 'content-type: application/json' -d '{"key":"nope"}' $D/unlock

Expected: 200 for the free pages, 402 for every paid one (HTML = the lock screen, JS = a stub),
`{"ok":true,...}` or `{"error":"Key format not recognised."}` from /unlock, and `{"ok":true,"gate":"on"...}`
from /api/health. 500 with a JSON `Gate failed...` body means the gate did not load (fix 1); 200 on
`task.html` means `.vercelignore` regressed and the paid corpus is public.

`tests/edge-function.js` needs `node --experimental-vm-modules` when run on its own (verify.js passes
it); without the flag one check reports `vm.SourceTextModule is not a constructor` and nothing else
runs.
