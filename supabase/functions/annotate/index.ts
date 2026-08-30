// ============================================================================
// AnnotateTrainer · Supabase Edge Function = the whole site, gated by Postgres.
//
// This is the "I only want Supabase" deployment: no VPS, no Cloudflare project,
// one URL, and the paywall is enforced *server side* (protected files are never
// sent without a valid key). Site files live in a PRIVATE storage bucket; this
// function is the only thing the browser talks to.
//
//   supabase functions deploy annotate --no-verify-jwt
//   supabase secrets set \
//     ACCESS_MODE=postgres       # or 'hmac' for the secret-only variant (no database)
//     SITE_BUCKET=site           # the PRIVATE bucket holding the repo files
//     PROJECT_URL=https://<ref>.supabase.co
//     SERVICE_ROLE_KEY=<the service key>   # server-only. never ship this to a browser
//     ANON_KEY=<the publishable/anon key>  # used for the key_check RPC
//   Names starting with SUPABASE_ are rejected by the CLI, hence PROJECT_URL / ANON_KEY.
//   No signing secret lives here: key_check() in the database decides, so a leaked function
//   environment cannot mint keys.
//
// Endpoints:  GET  /           index.html (free)
//             GET  /task.html  402 + gate screen without a key, page with a key
//             POST /unlock     {key} -> sets the at_key cookie
//             GET  /session    who you are, until when
// ============================================================================

const BUCKET = Deno.env.get('SITE_BUCKET') || 'site';
// The function's own slug, at module scope, because mountOf() and externalBase() are module
// functions: a const inside the handler would be out of their scope and every route would 500.
const SLUG = '/' + ((globalThis as any).FUNCTION_SLUG || 'annotate');
const MODE = (Deno.env.get('ACCESS_MODE') || 'postgres').toLowerCase();
const SECRET = Deno.env.get('ANNOTATE_SECRET') || '';
// The Supabase CLI refuses secret names beginning with SUPABASE_ ("Env name cannot start with
// SUPABASE_, skipping"), which silently leaves a function without the URL it needs. So the
// canonical names are PROJECT_URL / ANON_KEY, with the SUPABASE_* spellings kept as fallbacks
// for anyone who set them through the dashboard or the Management API instead of the CLI.
const env = (n) => Deno.env.get(n) || '';
const SUPABASE_URL = env('PROJECT_URL') || env('SUPABASE_URL');
const SERVICE_KEY = env('SERVICE_ROLE_KEY') || env('SERVICE_KEY');
const ANON_KEY = env('ANON_KEY') || env('SUPABASE_ANON_KEY') || env('PUBLISHABLE_KEY');

// Bump this on every deploy. GET /api/health reports it, which turns "is my code actually live?"
// into a curl. It earned its place: Supabase accepted two deploys in a row while the worker kept
// serving the previous build, so a route I had just added looked like it was missing from the code.
// Every "that cannot happen" debugging loop in this file started with a stale build marker.
const BUILD = 'annotate-2026-08-30.15';

const KEY_RE = /^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/;
const KEY_COOKIE = 'at_key';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm'
};

// Keep IDENTICAL to PUBLIC/PROTECT in server.js — the tests assert that.
/* BEGIN-LISTS */
// The free surface. Everything here is either marketing or an API route whose responses are already
// scoped by a capability (a quote token) or by nothing at all (health). It is a WHITELIST, so
// adding a route never makes anything reachable by accident — but note that it must be edited in
// the same commit as a new route: /crypto/* answering 404 for a whole session was this list not
// knowing about it, and the lock's fallback is a site 404 page, which looks like a routing bug.
const PUBLIC = /^\/(?:(?:index|gate|buy|guide|platforms|platform)\.html|(?:css|assets|api|\.well-known)\/[^/]*(?:\/[^/]*)*|js\/(?:storage|access|app|platforms|mockups|crypto)\.js|robots\.txt|sitemap\.xml|favicon\.ico|(?:|$))$/;
const FREE_API = /^\/(?:unlock|session|fulfill|api(?:\/|$)|crypto\/)/;
const PROTECT = /^\/(?:task|queue|onboarding|detector|trust-safety|earnings)\.html$|^\/js\/(?:tasks|detector)\.js$|^\/data\//;
/* END-LISTS */

/* The path a browser must use to reach this function, i.e. what a cookie must be scoped to.
   Supabase forwards the original URL in x-forwarded-* (and Cloudflare in cf-connecting-*); when
   neither is present we are root-mounted and '/' is correct. */
function externalBase(req) {
  for (const h of ['x-forwarded-uri', 'x-forwarded-path', 'cf-visitor-uri']) {
    const v = req.headers.get(h);
    if (v) { try { return { path: mountOf(new URL(v, 'https://x').pathname) }; } catch (e) { } }
  }
  // Supabase does not forward the browser-visible path, and its own req.url has already had
  // /functions/v1 stripped, so a sub-path mount cannot be discovered from inside: declare it.
  const declared = env('SITE_BASE');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const seen = mountOf(new URL(req.url).pathname);
  const path = mountOf(req.headers.get('x-forwarded-uri') || '') || mountOf(req.headers.get('x-forwarded-path') || '')
    || (declared ? normaliseBase(declared) : (seen === SLUG ? '' : seen));
  return { path, origin: host ? proto + '://' + host : '' };
}
const normaliseBase = (b) => {
  const v = String(b || '').replace(/\/+$/, '');
  return v === '' || v === '/' ? '' : (v[0] === '/' ? v : '/' + v);
};
// The mount is the longest leading path that ends at our slug, whether the gateway stripped it
// or not: '/annotate/...', '/functions/v1/annotate/...', or '' for a root-mounted deploy.
function mountOf(pathname) {
  if (!pathname) return '';
  const i = pathname.indexOf(SLUG);
  if (i < 0) return '';
  const end = i + SLUG.length;
  if (pathname.length > end && pathname[end] !== '/') return '';   // '/annotatexyz' is not us
  return pathname.slice(0, end);
}

const isPublic = (p) => PUBLIC.test(p) || FREE_API.test(p);
const isProtected = (p) => PROTECT.test(p);

const enc = new TextEncoder();
async function hmacSig(id, exp) {
  const k = await crypto.subtle.importKey('HMAC', { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'], ['sign']);
  const raw = await crypto.subtle.sign('HMAC', k, enc.encode(id + '.' + exp));
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 28);
}

/* ---- postgres mode: revocation + labels + rate limiting come from the DB ---- */
async function rpc(fn, args, bearer) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: bearer, Authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
  if (!text) return { status: res.status, json: null, text: '', value: null as any };   // 204/RETURNS VOID
  return { status: res.status, json: parsed, value: rpcValue(parsed) };
}

/**
 * PostgREST hands back a function's result in three different shapes depending on what the function
 * RETURNS, and guessing wrong reads as "that setting is empty" rather than as an error:
 *   a scalar (TEXT/BIGINT/…)   →  the bare value                    "ltc1q…"  /  49.25  /  null
 *   record / jsonb / json     →  that object, or an array of them    {"ok":true} / [{…}]
 *   RETURNS VOID               →  an empty body with 204            ''
 * Reading only `json.value` — a wrapper present in NONE of those — made every app_config lookup on
 * the live deployment answer "not configured", while every harness that imitated that wrong shape
 * stayed green. Normalising it here, in the one place all 12 RPC calls go through, is the fix.
 */
function rpcValue(json: any): any {
  if (json === null || json === undefined) return null;
  if (Array.isArray(json)) return json.length ? json[0] : null;
  if (typeof json === 'object') {
    const keys = Object.keys(json);
    if (keys.length === 1 && keys[0] === 'value') return (json as any).value;   // a real 1-column record
    return json;
  }
  return json;   // scalar: the body IS the value
}

async function verify(key, req) {
  const m = KEY_RE.exec(String(key || '').trim());
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  const [, id, sig, exp] = m;
  if (Number(exp) < Date.now()) return { ok: false, error: 'This key expired. Reply to your receipt to renew.' };

  if (MODE === 'postgres' && SUPABASE_URL && SERVICE_KEY) {
    const r = await rpc('key_check', { p_id: id, p_sig: sig, p_exp: Number(exp) }, SERVICE_KEY);
    const out = r.json || {};
    // fire-and-forget the audit/rate-limit row
    rpc('key_attempt', {
      p_fp: (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim(),
      p_key_id: id, p_ok: !!out.ok
    }, SERVICE_KEY).catch(() => { });
    if (r.status !== 200 || !out.ok) return { ok: false, error: out.error || 'Key rejected.' };
    return out;
  }

  if (!SECRET) return { ok: false, error: 'Server has no ANNOTATE_SECRET configured.' };
  if (await hmacSig(id, exp) !== sig) return { ok: false, error: 'This key was not issued by this site.' };
  return { ok: true, id, label: id, until: new Date(Number(exp)).toISOString().slice(0, 10) };
}

/* ---- fulfilment: verify a payment, then mint ---- */
const PLANS: Record<string, { label: string; amount: number; currency: string; days: number }> = {
  week: { label: '7-day access', amount: 6000, currency: 'NGN', days: 7 },
  season: { label: '90-day access', amount: 18000, currency: 'NGN', days: 90 },
  usd: { label: '90-day access (USD)', amount: 1800, currency: 'USD', days: 90 }
};

/* Provider verification. Paystack and Flutterwave both expose a GET-by-reference that returns the
   amount, currency and status, and both amounts are in minor units (kobo/cent) - comparing a
   formatted "18000" against 1800000 is how a ₦6,000 plan buys the ₦18,000 one. */
async function fulfil(ref: string, planKey: string) {
  // Validate the caller's input first: a wrong plan is the buyer's mistake and should read that
  // way even before we notice the server has no provider key configured.
  const plan = PLANS[planKey];
  if (!plan) return { ok: false, status: 400, error: 'Unknown plan. Use week, season or usd.' };
  const provider = (env('PAY_PROVIDER') || 'paystack').toLowerCase();
  const pk = (env('PAY_SECRET_KEY') || '').trim();
  if (!pk) return { ok: false, status: 503, error: 'Fulfilment is not configured on this server yet.' };

  let paid: { email: string; amount: number; currency: string; status: string; reference: string } | null = null;
  try {
    if (provider === 'flutterwave') {
      const r = await extFetch('https://api.flutterwave.com/v3/transactions/' + encodeURIComponent(ref) + '/verify', null, pk);
      const j: any = r.json;
      if (j && j.data) paid = {
        email: j.data.customer?.email || '', amount: Number(j.data.amount) || 0,
        currency: String(j.data.currency || '').toUpperCase(),
        status: String(j.data.status || '').toLowerCase(), reference: String(j.data.tx_ref || ref)
      };
    } else {
      const r = await extFetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(ref), null, pk);
      const j: any = r.json;
      if (j && j.data) paid = {
        email: j.data.customer?.email || '', amount: Number(j.data.amount) || 0,
        currency: String(j.data.currency || '').toUpperCase(),
        status: String(j.data.status || '').toLowerCase(), reference: String(j.data.reference || ref)
      };
    }
  } catch (e) {
    return { ok: false, status: 502, error: 'Could not reach the payment provider. Try again in a minute.' };
  }
  if (!paid) return { ok: false, status: 402, error: 'That reference was not found at the payment provider.' };
  if (paid.status !== 'success') return { ok: false, status: 402, error: 'That payment is not settled yet (status: ' + paid.status + ').' };
  if (paid.amount < plan.amount) return { ok: false, status: 402, error: 'That payment was ' + paid.amount + ' ' + paid.currency + '; this plan is ' + plan.amount + '.' };
  if (paid.currency !== plan.currency) return { ok: false, status: 402, error: 'That payment was made in ' + paid.currency + ', which does not match this plan.' };

  // one key per reference: a receipt is a one-time credential, and re-posting the same reference
  // to a webhook (providers retry) must never mint a second key
  const seen = await fetch(SUPABASE_URL + '/rest/v1/access_keys?select=id&note=eq.' + encodeURIComponent(ref) + '&limit=1',
    { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }).then((r) => r.json()).catch(() => []);
  if (Array.isArray(seen) && seen.length) return { ok: false, status: 409, error: 'That payment already received a key. Check your original receipt, or reply to it if it is lost.' };

  const label = (paid.email || 'buyer').slice(0, 120) + ' \u00b7 ' + provider + ' ' + ref;
  const mint = await rpc('key_mint', { p_mint_secret: env('MINT_SECRET'), p_label: label, p_days: plan.days }, SERVICE_KEY);
  if (mint.status !== 200 || !mint.json || !mint.json.key) {
    return { ok: false, status: 502, error: 'Payment verified, but key delivery failed. Reply to your receipt and it will be issued by hand.' };
  }
  await fetch(SUPABASE_URL + '/rest/v1/access_keys?id=eq.' + encodeURIComponent(mint.json.id), {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ note: ref })
  }).catch(() => { });
  // the key is also the receipt: return it to the browser and let the webhook caller relay it.
  return { ok: true, key: mint.json.key, until: mint.json.until, label, email: paid.email };
}

/* The URL that renders. Declared BEFORE the notice that reads it — the first cut sat next to `const
   notice, and `const` does not hoist: the browser-only path threw "RENDER_URL is not defined" and
   Supabase answered 500, which is also why the notice never appeared on free pages. Overridable,
   because it belongs to whoever deploys this. (A duplicate `const BUCKET` I briefly added next to it was
   a redeclaration error and the Deno suite rejected the file — that suite is the reason this shipped
   fixed rather than live-broken.) */
const RENDER_URL = String(Deno.env.get('RENDER_URL') || 'https://ai-annotation-tau.vercel.app').replace(/\/+$/, '');

/* Supabase rewrites every text/html GET from a project domain into text/plain + nosniff (their docs:
   /guides/functions/limits; Storage does the same to .html objects). So a browser opening this URL reads
   markup instead of the site, and there is nothing the function can do about the label. What it CAN do is
   say so, in the document, once, for a real navigation. Keyed on Accept + User-Agent so it never attaches
   to a programmatic pull — including the Vercel mirror's, which re-types the bytes itself. */
// An overlay rather than a div in <head>, for two reasons that only matter in this specific case: the
// document may be a 402 whose <head> is short and whose body is the lock form, and a block inserted at
// the top of a RAW-text view is invisible anyway. position:fixed means it sits over the source listing,
// which is the only place a browser visitor to this URL can be told anything. <noscript>-free and
// dismissible: a link to leave, and a query flag to stop the notice, so it cannot become a wall.
const NOTE = '<div id="sb-note" style="all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
  'box-sizing:border-box;display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:#171129;' +
  'border-bottom:1px solid #4b3f8f;color:#e9e4ff;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;' +
  'padding:10px 16px;box-shadow:0 2px 14px rgba(0,0,0,.4)">Supabase serves HTML from this URL as ' +
  '<b>plain text</b> (no custom domain), so you are reading markup. Same site, rendered, same keys: ' +
  '<a href="$HERE" style="color:#b6a8ff;text-decoration:underline">open it on $WHERE</a>' +
  '<a href="$HERE" style="background:#6a5bf0;border:1px solid #7f70ff;border-radius:7px;padding:5px 11px;' +
  'color:#fff;text-decoration:none;font-weight:700">Go there</a>' +
  '<a href="?notice=0" style="color:#8b93a6;margin-left:auto;text-decoration:none">hide this</a></div>';
function annotateNotice(doc, where) {
  // NOT encodeURIComponent: applied to a whole URL it percent-encodes the scheme too
  // ("https%3A%2F%2Fhost%2Ftask.html"), which renders a link that goes nowhere. The path reaching here
  // has already been through the route matcher and is one of the site's own .html names, so there is no
  // quote or angle bracket to escape; the guard below is belt-and-braces for anything that calls it later.
  const safe = String(where || '/').replace(/["'<>]/g, '');
  const note = NOTE.replace(/\$HERE/g, safe).replace(/\$WHERE/g, safe);
  // '<head>…</head>' with a [^>]* capture: the greedy .*</head> version of this matched the CLOSING tag
  // too, so "$1" swallowed the '>' that ended <head> and the first meta tag came out unclosed.
  const m = /<head[^>]*>/i.exec(doc);
  if (m) return doc.slice(0, m.index + m[0].length) + note + doc.slice(m.index + m[0].length);
  const b = /<body[^>]*>/i.exec(doc);
  if (b) return doc.slice(0, b.index) + note + doc.slice(b.index);
  return note + doc;
}

/* The lock screen is gate.html, and gate.html carries a render sentinel — which means the bucket copy
   must never be handed out raw, or a visitor reads the token instead of their return path. Render on the
   way out, at the one place bucket bytes become a response, so "did I remember to stamp this route" is
   not a question. */
function renderGate(text, next) {
  const lit = JSON.stringify(next || '');
  return text.indexOf('/*@@GATE_PATH@@*/') >= 0
    ? text.replace("/*@@GATE_PATH@@*/''", lit)
    : text.replace(/var __GATE_TARGET = [^;]*;/, 'var __GATE_TARGET = ' + lit + ';');
}

/* ---- serving from the private bucket ---- */
async function fromBucket(ctx, path) {
  const url = SUPABASE_URL + '/storage/v1/object/authenticated/' + BUCKET + path;
  return fetch(url, { headers: { Authorization: 'Bearer ' + SERVICE_KEY } });
}

const GATE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Locked · AnnotateTrainer</title>
<style>body{background:#0b0d12;color:#e7ecf3;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.card{max-width:520px;background:#141922;border:1px solid #232b39;border-radius:14px;padding:28px}
.up{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6d7c92;font-weight:700}
input{width:100%;box-sizing:border-box;background:#0e131c;border:1px solid #2e3848;color:#e7ecf3;border-radius:9px;padding:11px 13px;font-family:ui-monospace,monospace;font-size:13px}
button{background:#6a5bf0;border:1px solid #7f70ff;color:#fff;border-radius:9px;padding:11px 17px;font-weight:700;cursor:pointer}
a{color:#8b7cff}</style></head><body><div class="card">
<div class="up">Locked</div><h1 style="font-size:21px;margin:8px 0">This practice platform is paid-access</h1>
<p style="color:#93a0b4;font-size:13.5px">Paste the key from your receipt. The platform catalogue and the guide stay free.</p>
<div style="display:flex;gap:8px"><input id="k" placeholder="Ab3xK9.7W7KqRmYs0dYbE6fLrT1cPp0.1790000000000"><button id="go">Unlock</button></div>
<p id="m" style="font-size:12px;min-height:18px;color:#6d7c92"></p>
<p style="font-size:12.5px;color:#93a0b4"><a href="/gate.html">Full unlock page</a> · <a href="/buy.html">Pricing</a></p>
</div><script>
var __GATE_TARGET=/*@@GATE_PATH@@*/'';
var go=function(){var k=document.getElementById('k').value.trim();var m=document.getElementById('m');m.textContent='checking\\u2026';
fetch('/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})}).then(function(r){return r.json().then(function(j){return{c:r.status,j:j}})}).then(function(r){
m.style.color=r.c===200?'#57d38b':'#ff6b6b';m.textContent=r.c===200?('Accepted - '+(r.j.label||'')+(', valid until '+(r.j.until||''))):(r.j.error||'Key rejected.');
if(r.c===200)setTimeout(function(){if(__GATE_TARGET)location.href=__GATE_TARGET;else location.reload()},700);});};
document.getElementById('go').onclick=go;document.getElementById('k').addEventListener('keydown',function(e){if(e.key==='Enter')go()});
</script></body></html>`;

/* ============================ one-time crypto orders ============================
   No provider account, no webhook endpoint, no email: the buyer sends Litecoin to the owner's own
   address and access is granted by the site noticing, on its own, that the exact amount arrived.

   Three properties make that safe enough to automate, and each one is load-bearing:
     1. THE AMOUNT IS THE ORDER ID. A quote adds a few litoshi of unique "dust" to the plan price,
        and the database refuses to open a second order at an amount that is already reserved. So a
        transfer identifies its buyer without the buyer telling us anything.
     2. THE QUOTE TOKEN IS THE CAPABILITY. 128 random bits, held only by the browser that asked. It
        is what "no email needed" rests on: there is no address to verify, so the deliverable is
        released to whoever proves they opened the order — and to nobody else. It also means a buyer
        who closes the tab is not lost, provided they kept the URL; say so in the copy.
     3. THE EXPLORER IS THE WITNESS, NOT THE CALLER. We never accept "I paid" as input; we re-read
        the chain. A claimed amount that does not equal this order's amount to the litoshi is not a
        match, and a transaction older than the quote cannot belong to it. */
const LTC_ADDR_RE = /^(?:ltc1[a-z0-9]{20,90}|[LM][a-km-zA-HJ-NP-Z1-9]{26,34})$/;
const LTC_URLS = (env('LTC_RATE_URLS') || 'https://api.coinbase.com/v2/prices/LTC-USD/spot,https://api.kraken.com/0/public/Ticker?pair=LTCUSD').split(',').filter(Boolean);
const NGN_URLS = (env('NGN_RATE_URLS') || 'https://open.er-api.com/v6/latest/USD').split(',').filter(Boolean);
// There is no LTC/USD feed on api.blockcypher.com, hence a second provider for price. The bounds
// are the guard: a rate source that returns 49 cents or 4,900 dollars would otherwise price 90
// days of access at a hundredth of itself, or a hundred times itself. Both are fail-closed here.
const RATE_MIN = Number(env('LTC_RATE_MIN_USD') || 1), RATE_MAX = Number(env('LTC_RATE_MAX_USD') || 5000);
const EXPLORER = () => (env('LTC_API_BASE') || 'https://api.blockcypher.com/v1/ltc/main').replace(/\/+$/, '');
const EXPLORER_TX = () => env('LTC_EXPLORER_TX') || 'https://blockchair.com/litecoin/transaction/';
const fmtLtc = (lit) => (Number(lit) / 1e8).toFixed(8);
// String arithmetic, not floating point: 0.1 + 0.2 must never become the price of a subscription.
const fmtLtcB = (litoshi) => {
  const s = litoshi.toString().padStart(9, '0');
  return s.slice(0, s.length - 8) + '.' + s.slice(-8);
};

async function ltcRates() {
  const rateTtl = Number(env('LTC_RATE_TTL') || (await readCfg('LTC_RATE_TTL')) || '') || 120;
  // One key, holding the rate object ITSELF, with freshness judged on read by cache_get's ttl.
  //
  // Two mistakes were made here and both were invisible until a test read the value back. (1) The key
  // used to encode a two-minute bucket, so two quotes thirty seconds apart could straddle a boundary
  // and the second would miss its own cache — and the number a customer is charged would change
  // mid-conversation. (2) The value used to be a {t, v} envelope, which JSON.parse then handed back as
  // if it were the payload: on a cache HIT the rates arrived with no NGN in them, so every cached naira
  // quote failed while every uncached one worked. Store the thing, read back the thing.
  const key = 'cache:rates';
  const hit = await rpc('cache_get', { p_key: key, p_ttl: rateTtl }, SERVICE_KEY).catch(() => null);
  if (hit && hit.value) {
    try {
      const v = JSON.parse(String(hit.value));
      // Check the shape rather than trusting it: an entry written by an older build is a near-miss,
      // and "near-miss" is exactly what a silent pricing bug looks like from the outside.
      if (v && Number(v.ltc_usd) > 0 && !('v' in v)) {
        return { ok: true, json: true, v: { ltc_usd: Number(v.ltc_usd), ngn_usd: Number(v.ngn_usd) || 0, at: v.at || '' } };
      }
    } catch (e) { }
  }
  let ltcUsd = 0;
  for (const u of LTC_URLS) {
    const r = await extFetch(u, null, null).catch(() => null);
    const j = r && r.json;
    // each source has its own shape; the number that matters is a last-trade price either way
    const v = j && (j.data ? Number(j.data.amount)
      : j.result ? Number(Object.values(j.result)[0].c[0])
      : Number(j.price || j.price_usd || j.usd || 0));
    if (v > RATE_MIN && v < RATE_MAX) { ltcUsd = v; break; }
  }
  if (!ltcUsd) return { ok: false, status: 503, error: 'I cannot price Litecoin right now, so I will not take your money at a guess. Try again in a minute.' };
  let ngnUsd = 0;
  for (const u of NGN_URLS) {
    const r = await extFetch(u, null, null).catch(() => null);
    const v = r && r.json && r.json.rates ? Number(r.json.rates.NGN) : 0;
    if (v > 100 && v < 20000) { ngnUsd = v; break; }
  }
  const v = { ltc_usd: ltcUsd, ngn_usd: ngnUsd, at: new Date().toISOString() };
  // Only a COMPLETE reading is shared: the next buyer reads this value, not the conditions that
  // produced it, so a USD quote that never looked up NGN must not cache a zero for everyone after it.
  if (v.ngn_usd > 0) await rpc('cache_put', { p_key: key, p_value: JSON.stringify(v) }, SERVICE_KEY).catch(() => null);
  return { ok: true, json: false, v };
}

const MIN_LTC_LITOSHI = 200000n;   // 0.002 LTC: below this the dust watermark and the network fee
                                    // stop being meaningful, so refuse rather than sell access for
                                    // rounding error if a price feed ever returns an absurd number.
const dust = () => 1000n + BigInt(Math.floor(Math.random() * 999000));   // 0.00001 .. 0.999999 litoshi

async function cryptoQuote(planKey, email) {
  const plan = PLANS[planKey];
  if (!plan) return { ok: false, status: 400, error: 'Unknown plan. Use week, season or usd.' };
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, status: 503, error: 'The order store is not reachable from this server.' };
  const address = (await readCfg('LTC_ADDRESS')).trim();
  if (!address) return { ok: false, status: 503, error: 'This shop has no deposit address configured yet. Ask the owner to set LTC_ADDRESS.' };
  if (!LTC_ADDR_RE.test(address)) return { ok: false, status: 503, error: 'The configured deposit address is not shaped like a Litecoin address.' };
  const ttl = Number(await readCfg('LTC_QUOTE_TTL') || '') || 1200;
  const minConfs = Number(await readCfg('LTC_MIN_CONFS') || '') || 2;
  const rate = await ltcRates();
  if (!rate.ok) return rate;
  let usdPerUnit = plan.currency === 'NGN' ? rate.v.ltc_usd * (rate.v.ngn_usd || 0) : rate.v.ltc_usd;
  if (plan.currency === 'NGN' && !usdPerUnit) {
    return { ok: false, status: 503, error: 'No NGN exchange rate is available, and quoting ₦ at the USD price would be a guess.' };
  }
  // A price times 1e8 overflows int32 the moment a plan costs more than $21 (1800 * 1e8 =
  // 180,000,000,000), and JS then wraps the division: the "dust" I derive by subtracting came out
  // ZERO for every real price, which is exactly the case where two open orders share an amount and
  // the first buyer to poll gets paid for the second one's transfer. Litoshis are counted in BigInt
  // here, and the watermark is generated, never inferred.
  const priceLitoshi = Number(((BigInt(Math.round(plan.amount)) * 100000000n) / BigInt(Math.round(usdPerUnit * 1000))) * 1000n);
  const ms = env('MINT_SECRET') || await readCfg('MINT_SECRET');
  if (!ms) return { ok: false, status: 503, error: 'This shop cannot mint keys, so it should not be taking money.' };
  let last = null;
  // A collision is resolved by re-pricing, not by re-rolling inside the database: the amount the
  // buyer sees must be the amount the database reserved, and only the caller can change both.
  for (let attempt = 0; attempt < 6; attempt++) {
    // The watermark is always added, including on the first try: an un-watermarked amount is the
    // one amount guaranteed to collide with another buyer of the same plan.
    const d = dust();
    const totalLitoshi = BigInt(priceLitoshi) + d;
    if (totalLitoshi < MIN_LTC_LITOSHI) {
      return { ok: false, status: 503, error: 'Litecoin is priced so high right now that this plan would round to almost nothing. Try again in a minute.' };
    }
    const amount = fmtLtcB(totalLitoshi);
    const r = await rpc('crypto_quote', {
      p_plan: planKey, p_currency: plan.currency, p_price_minor: plan.amount, p_amount: amount,
      p_address: address, p_email: String(email || '').slice(0, 160), p_mint_secret: ms, p_ttl: ttl
    }, SERVICE_KEY);
    if (r.status === 200 && r.json && r.json.id) {
      return { ok: true, json: false, v: {
        id: r.json.id, token: r.json.token, plan: planKey, plan_label: plan.label,
        price: plan.amount / 100, currency: plan.currency, amount, address,
        dust_litoshi: Number(d),
        price_litoshi: priceLitoshi,
        pay: 'litecoin:' + address + '?amount=' + amount + '&label=' + encodeURIComponent('AnnotateTrainer ' + plan.label + ' ' + r.json.id),
        explorer: EXPLORER_TX(), min_confs: minConfs, expires_in: ttl,
        rates: { ltc_usd: rate.v.ltc_usd, ngn_usd: rate.v.ngn_usd || null, at: rate.v.at },
        quote_token: r.json.token
      } };
    }
    last = r;
    const msg = String((r && (r.json && r.json.message || r.text)) || '');
    if (!/reserved/.test(msg)) {
      return { ok: false, status: 502, error: 'Could not open an order: ' + (msg.slice(0, 160) || 'the order store said no') };
    }
  }
  return { ok: false, status: 503, error: 'Too many orders are open right now; try again in a minute.' };
}

/* The single settlement path. Both entry points (the poll and a pasted txid) converge here so the
   chain is checked once, the same way, and cannot be talked into a mint by the caller. */
async function cryptoStatus(id, token) {
  const got = await rpc('crypto_get', { p_id: id, p_token: token }, SERVICE_KEY);
  const q: any = (got && got.value) || null;
  if (!q) return { ok: false, status: 404, error: 'No such order from this browser.' };
  if (q.status === 'paid') return { ok: true, json: false, v: { status: 'paid', key: q.full_key, receipt: q.receipt, txid: q.txid } };
  if (q.status === 'paying') return { ok: false, status: 409, error: 'This order is mid-delivery. Keep the page open a few seconds.' };
  if (new Date(q.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 404, error: 'That quote expired. Prices move, so I do not hold an amount open indefinitely — request a new one.' };
  }
  const minConfs = Number(await readCfg('LTC_MIN_CONFS') || '') || 2;
  const expected = Math.round(Number(q.amount_lt) * 1e8);
  const probe = await rpc('crypto_probe', {
    p_id: id, p_token: token, p_txid: null, p_amount: null, p_height: null, p_confs: 0, p_min_confs: minConfs
  }, SERVICE_KEY).catch(() => null);
  const best = await blockcypherLook(q.address, expected, new Date(q.created_at).getTime(), minConfs);
  if (best.found && best.confs >= minConfs) return settle(id, token, best.txid, best.value, best.confs, q, minConfs);
  // Persist a match that is not yet confirmable. Skipping this is a real loss, not a cosmetic one:
  // a buyer who watched "seen, 1 of 2", then closed the tab, comes back to an order that remembers
  // nothing — and their txid is refused by the age guard, because the order still looks brand new.
  if (best.found && (q.status === 'pending' || q.status === 'detected')) {
    // 'detected' too, because confirmations only ever climb: re-polling a seen payment must refresh
    // its count, or a buyer watching "1 of 2" never sees it move without a page reload.
    await rpc('crypto_probe', {
      p_id: id, p_token: token, p_txid: best.txid || null, p_amount: best.value, p_height: best.height || null,
      p_confs: best.confs, p_min_confs: minConfs
    }, SERVICE_KEY).catch(() => null);
  }
  return { ok: true, json: false, v: {
    status: best.found ? 'seen' : 'waiting', confirmations: best.confs, min_confs: minConfs,
    // address + amount are repeated here for the reload case: a buyer who comes back with only the
    // fragment (#ltc=id.token) has no quote object to re-render from, and this is the one call that
    // runs on that page load.
    txid: best.txid || null, expected_litoshi: expected, address: q.address, amount: q.amount_lt,
    expires_at: q.expires_at, note: best.found ? 'seen on the chain, waiting for confirmations' : 'nothing at this amount yet'
  } };
}

async function blockcypherLook(address, expectedLitoshi, createdMs, minConfs) {
  const key = 'cache:bc:' + address;
  const hit = await rpc('cache_get', { p_key: key, p_ttl: 45 }, SERVICE_KEY).catch(() => null);
  let refs = null;
  if (hit && hit.value) { try { refs = JSON.parse(String(hit.value)).refs; } catch (e) { } }
  if (!refs) {
    const r = await extFetch(EXPLORER() + '/addrs/' + encodeURIComponent(address) + '?limit=50', null, null).catch(() => null);
    if (!r || r.status !== 200 || !r.json || !Array.isArray(r.json.txrefs)) {
      // Unreachable ≠ unpaid. Telling a buyer "we found nothing" when we could not look is how you
      // lose a paid-for order and gain an angry message.
      return { found: false, stalled: true, note: 'the block explorer is not answering right now' };
    }
    refs = r.json.txrefs;
    await rpc('cache_put', { p_key: key, p_value: JSON.stringify({ t: Date.now(), refs }) }, SERVICE_KEY).catch(() => null);
  }
  let best = { found: false, confs: 0 };
  for (const t of refs) {
    // An OUTPUT to your address, not merely a transaction that touched it: an input that happens
    // to spend a similar amount is not your buyer paying you.
    if (!t || Number(t.tx_input_n) >= 0) continue;
    if (Number(t.value) !== expectedLitoshi) continue;
    if (t.double_spend) continue;
    if (t.confirmations === 0 && new Date(t.confirmed || 0).getTime() < createdMs) continue;
    best = { found: true, txid: t.tx_hash, value: Number(t.value), confs: Number(t.confirmations) || 0, height: t.block_height };
    if (best.confs >= minConfs) break;
  }
  return best;
}

async function settle(id, token, txid, value, confs, q, minConfs) {
  const marked = await rpc('crypto_mark', {
    p_action: 'claim', p_id: id, p_token: token, p_mint_secret: env('MINT_SECRET') || await readCfg('MINT_SECRET'),
    p_key_id: null, p_full_key: null, p_receipt: null
  }, SERVICE_KEY);
  const mv: any = marked.value;
  if (!mv || mv.ok !== true) {
    // Someone else already delivered this order (double poll, or claim racing the poll). crypto_mark
    // returns the row's own receipt alongside the key, so the buyer is shown the same proof either
    // way — a paid answer that renders an empty receipt card reads like a scam, even with a working key.
    if (mv && mv.status === 'paid') return { ok: true, json: false, v: { status: 'paid', key: mv.key, receipt: mv.receipt || null, until: mv.until || null } };
    return { ok: false, status: 409, error: 'This order is being delivered right now; refresh in a second.' };
  }
  // record the match first, so the claim never becomes a paid order with nothing behind it
  await rpc('crypto_probe', {
    p_id: id, p_token: token, p_txid: txid || null, p_amount: Number(value), p_height: null,
    p_confs: Number(confs) || 0, p_min_confs: minConfs
  }, SERVICE_KEY).catch(() => null);
  const plan = PLANS[q.plan] || { days: 90 };
  const mint = await rpc('key_mint', {
    p_mint_secret: env('MINT_SECRET') || await readCfg('MINT_SECRET'),
    p_label: ((q.buyer_email || 'ltc buyer').slice(0, 60) + ' \u00b7 ltc ' + String(txid || '').slice(0, 16)).slice(0, 120),
    p_days: plan.days
  }, SERVICE_KEY);
  if (mint.status !== 200 || !mint.json || !mint.json.key) {
    await rpc('crypto_mark', { p_action: 'revert', p_id: id, p_token: token, p_mint_secret: env('MINT_SECRET') || await readCfg('MINT_SECRET'), p_key_id: null, p_full_key: null, p_receipt: null }, SERVICE_KEY).catch(() => null);
    return { ok: false, status: 502, error: 'Payment seen, delivery failed. Keep your txid: nothing is lost, this will resolve on the next poll or by hand.' };
  }
  const receipt = {
    plan: q.plan, amount_ltc: q.amount_lt, txid: txid || null, confirmations: confs,
    paid_at: new Date().toISOString(), key: mint.json.key, until: mint.json.until,
    label: q.buyer_email || null, receipt_ref: 'ltc ' + (txid ? String(txid).slice(0, 12) : id)
  };
  await rpc('crypto_mark', {
    p_action: 'paid', p_id: id, p_token: token, p_mint_secret: env('MINT_SECRET') || await readCfg('MINT_SECRET'),
    p_key_id: mint.json.id, p_full_key: mint.json.key, p_receipt: receipt
  }, SERVICE_KEY);
  await fetch(SUPABASE_URL + '/rest/v1/access_keys?id=eq.' + encodeURIComponent(mint.json.id), {
    method: 'PATCH', headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ note: 'ltc:' + (txid || id) })
  }).catch(() => { });
  const hook = await readCfg('RECEIPT_WEBHOOK_URL');
  if (hook) fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt) }).catch(() => { });
  return { ok: true, json: false, v: { status: 'paid', key: mint.json.key, receipt, until: mint.json.until } };
}

async function cryptoClaim(id, token, txid) {
  if (!/^[0-9a-fA-F]{40,80}$/.test(String(txid || ''))) return { ok: false, status: 400, error: 'That is not a Litecoin transaction id.' };
  const got = await rpc('crypto_get', { p_id: id, p_token: token }, SERVICE_KEY);
  const q: any = (got && got.value) || null;
  if (!q) return { ok: false, status: 404, error: 'No such order from this browser.' };
  if (q.status === 'paid') return { ok: true, json: false, v: { status: 'paid', key: q.full_key, receipt: q.receipt, until: q.until || null } };
  // Expiry is checked here too, not only in /status. A stale quote means a stale PRICE: without this
  // line a buyer who let an order lapse while LTC was cheap could settle it for less than the plan
  // costs today, and the amount matcher would happily accept it — the watermark identifies the
  // order, it does not re-validate the offer.
  if (new Date(q.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 404, error: 'That quote expired and its amount is no longer the price. Request a new one; nothing you already sent is lost \u2014 reply to your receipt with the txid.' };
  }
  const r = await extFetch(EXPLORER() + '/txs/' + encodeURIComponent(txid), null, null).catch(() => null);
  if (!r || r.status !== 200 || !r.json || !Array.isArray(r.json.outputs)) {
    return { ok: false, status: 404, error: 'The explorer does not know that transaction yet. In-mempool transactions appear shortly; wait for a confirmation and try again.' };
  }
  const expected = Math.round(Number(q.amount_lt) * 1e8);
  // The authorising fact: an output TO THIS ADDRESS for EXACTLY this order's amount, and the
  // transaction must not be older than the order it is being claimed against.
  const out = r.json.outputs.find((o) => Number(o.value) === expected && Array.isArray(o.addresses) && o.addresses.indexOf(q.address) >= 0);
  if (!out) return { ok: false, status: 402, error: 'That transaction does not send ' + q.amount_lt + ' LTC to this order\u2019s address.' };
  const height = Number(r.json.block_height) || 0;
  let confs = Number(r.json.confirmations) || 0;
  if (!confs && height) {
    const head = await extFetch(EXPLORER() + '/?limit=1', null, null).catch(() => null);
    const tip = head && head.json && (head.json.height || (head.json[0] && head.json[0].height));
    if (tip) confs = Math.max(0, Number(tip) - height + 1);
  }
  const minConfs = Number(await readCfg('LTC_MIN_CONFS') || '') || 2;
  if (confs < minConfs) {
    await rpc('crypto_probe', { p_id: id, p_token: token, p_txid: txid, p_amount: expected, p_height: height, p_confs: confs, p_min_confs: minConfs }, SERVICE_KEY).catch(() => null);
    return { ok: true, json: false, v: { status: 'seen', confirmations: confs, min_confs: minConfs, txid, note: 'matched on the chain, not confirmed enough yet' } };
  }
  return settle(id, token, txid, expected, confs, q, minConfs);
}


/* ---- third-party calls go through ONE seam ----
   Why: the harness must be able to answer BlockCypher without a network, and it must be the only
   place a header could ever leak. A fetch written inline near the payment provider has already
   shipped a secret to the wrong host once in the wild; a helper whose name says what it is for,
   with the caller passing a bearer it obtained from config, is much harder to misuse. */
async function extFetch(url, opts, bearer) {
  const headers = Object.assign({ 'accept': 'application/json' }, (opts && opts.headers) || {});
  if (bearer) headers['authorization'] = 'Bearer ' + bearer;
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { }
  return { status: r.status, json, text };
}

/* A config value, from the environment first, then the app_config table. The table is the half
   you can change from the SQL editor without a redeploy, which matters for exactly the settings
   you want to swap on a Saturday: a deposit address, a receipt email, a confirmation count. */
async function readCfg(name) {
  const fromEnv = env(name);
  if (fromEnv) return fromEnv;
  if (!SUPABASE_URL || !SERVICE_KEY) return '';
  const r = await rpc('cfg', { p_key: name }, SERVICE_KEY).catch(() => null);
  // cfg() returns scalar TEXT, so the body is the value itself — not {value: …}. This line was the
  // live bug: LTC_ADDRESS was set in the database and every quote still said "not configured".
  const v = r && r.value;
  return v === null || v === undefined ? '' : String(v);
}

const json = (code, obj, extra) => new Response(JSON.stringify(obj), {
  status: code,
  headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {})
});

Deno.serve(async (req) => {
  const ctx = {};
  const url = new URL(req.url);
  let p = decodeURIComponent(url.pathname);
  // MOUNTING, in the form it actually arrives. Observed on this project: the browser calls
  //   https://<ref>.supabase.co/functions/v1/annotate/task.html
  // but the function's own req.url only carries the slug:
  //   /annotate/task.html
  // So the public base (/functions/v1/annotate) is NOT visible in req.url, and the two need
  // different treatment:
  //   · routing  -> strip a leading /<slug> here, whatever the host's gateway already did
  //   · cookies  -> scope to the path the BROWSER sees, derived from the forwarded request, or a
  //     cookie set at Path=/ on supabase.co would be shared with PostgREST and storage, and one
  //     set at Path=/annotate would never be returned on a /functions/v1/annotate request.
  if (p === SLUG || p === SLUG + '/') p = '/';
  else if (p.startsWith(SLUG + '/')) p = p.slice(SLUG.length) || '/';
  const external = externalBase(req);
  const COOKIE_PATH = external.path || '/';   // '' on a root-mounted deploy (custom domain)
  if (p === '/') p = '/index.html';
  // NB: the ".html" convenience is applied further down, AFTER the extensionless API routes are
  // matched. Appending it here rewrote /api/health to /api/health.html and every RPC 404'd.

  const cookieKey = (req.headers.get('cookie') || '').split(';').map((s) => s.trim())
    .filter((s) => s.indexOf(KEY_COOKIE + '=') === 0).map((s) => decodeURIComponent(s.slice(KEY_COOKIE.length + 1)))[0];
  const headerKey = req.headers.get('x-access-key');
  const presented = cookieKey || headerKey || '';

  /* ---------- unlock ---------- */
  if (p === '/unlock' && req.method === 'POST') {
    let body = {}; try { body = await req.json(); } catch (e) { }
    const v = await verify(body.key, req);
    if (!v.ok) return json(402, { error: v.error });
    return new Response(JSON.stringify(v), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Path is the mount, not the host root: on Supabase this function IS the site, but it is
        // mounted at /functions/v1/annotate, and a cookie scoped to "/" would also be sent to
        // anything else ever served from the project domain (PostgREST, storage). Scope it.
        'set-cookie': KEY_COOKIE + '=' + encodeURIComponent(body.key) + '; Path=' + COOKIE_PATH +
          '; Max-Age=7776000; HttpOnly; SameSite=Lax'
      }
    });
  }
  if (p === '/session') {
    const v = await verify(presented, req);
    return v.ok ? json(200, { label: v.label, until: v.until, mode: MODE }) : json(402, { error: v.error });
  }
  /* ---- the extensionless API routes, matched BEFORE the lock ----
     They must come first: the lock ends with "if (!isPublic(p)) → serve 404.html", and a route
     like /fulfill is not a public page, so it was answered with the site's 404 page while the
     handler below never ran. Only a real page path belongs in that fallback. */

  /* ---------- fulfilment: a payment reference in, a key out ---------- */
  // The trust boundary is NOT the caller, it is the provider: an unauthenticated visitor cannot
  // mint keys because every reference is re-checked against Paystack/Flutterwave before a single
  // row is written. MINT_SECRET lives in this function's environment (not the browser, not a
  // webhook payload), which is the only reason the key_mint RPC can stay service-role-only.
  if (p === '/fulfill' && req.method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch (e) { }
    const ref = String(body.ref || '').trim();
    const plan = String(body.plan || '').trim().toLowerCase();
    if (!/^[A-Za-z0-9_\-]{6,64}$/.test(ref)) return json(400, { error: 'Send the payment reference from your receipt.' });
    const out = await fulfil(ref, plan);
    return out.ok ? json(200, out) : json(out.status || 402, { error: out.error });
  }

  /* ---------- crypto: quote in, access out, no human between ---------- */
  // These are deliberately reachable without an access key — a buyer who has not paid is the whole
  // point — and they carry no privileged read: every response is scoped to a quote token that only
  // the buyer's browser holds, and every write goes through crypto_mark, which re-checks
  // MINT_SECRET in the database.
  if (p === '/crypto/quote' && req.method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch (e) { }
    const out = await cryptoQuote(String(body.plan || '').trim().toLowerCase(), body.email);
    return out.ok ? json(200, out.v) : json(out.status || 402, { error: out.error });
  }
  if (p === '/crypto/status' && (req.method === 'POST' || req.method === 'GET')) {
    let body: any = {};
    try { body = await req.json(); } catch (e) { }
    const q = url.searchParams;
    const id = String(body.id || q.get('id') || '').slice(0, 16);
    const token = String(body.token || q.get('token') || '').slice(0, 64);
    if (!id || !token) return json(400, { error: 'An order id and its token are both needed.' });
    const out = await cryptoStatus(id, token);
    return out.ok ? json(200, out.v) : json(out.status || 402, { error: out.error });
  }
  if (p === '/crypto/claim' && req.method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch (e) { }
    const out = await cryptoClaim(String(body.id || '').slice(0, 16), String(body.token || '').slice(0, 64), String(body.txid || '').trim());
    return out.ok ? json(200, out.v) : json(out.status || 402, { error: out.error });
  }
  // One read that answers "is crypto usable from here?" without a browser and without a payment.
  if (p === '/crypto/check') {
    const ms = env('MINT_SECRET') || await readCfg('MINT_SECRET');
    const address = (await readCfg('LTC_ADDRESS')).trim();
    const rate = await ltcRates();
    const rows: any = {};
    for (const k of ['week', 'season', 'usd']) {
      const plan = PLANS[k];
      rows[k] = rate.ok ? fmtLtc(Math.round(plan.amount * 1e8 / (plan.currency === 'NGN' ? rate.v.ltc_usd * (rate.v.ngn_usd || 0) : rate.v.ltc_usd))) + ' LTC' : '(no rate)';
    }
    return json(200, {
      address: address ? address.slice(0, 10) + '\u2026' + address.slice(-4) + ' \u00b7 ' + address.length + ' chars' : 'NOT SET',
      address_shape_ok: LTC_ADDR_RE.test(address), mint_secret: ms ? 'configured' : 'MISSING',
      db: !!(SUPABASE_URL && SERVICE_KEY), rate: rate.ok ? rate.v : { unavailable: true },
      amounts: rows, explorer: EXPLORER(), min_confs: 'read per poll', cache: '45s per address, in app_config'
    });
  }

  if (p === '/api/health') {
    return json(200, {
      ok: true, gate: 'on', backend: MODE, protected: 'server-side (402)',
      bucket: BUCKET, build: BUILD, url: SUPABASE_URL ? 'configured' : 'MISSING',
      service: SERVICE_KEY ? 'configured' : 'MISSING', anon: ANON_KEY ? 'configured' : 'MISSING',
      crypto: (await readCfg('LTC_ADDRESS')) ? 'address configured' : 'no deposit address (set LTC_ADDRESS)'
    });
  }
  // One diagnostic that answers "is the bucket reachable from in here?" from the inside, because
  // a bucket read that fails and a router that mis-paths both look identical from the outside.
  if (p === '/api/debug') {
    const probe = '/css/app.css';
    const target = SUPABASE_URL + '/storage/v1/object/authenticated/' + BUCKET + probe;
    let bucket = {};
    try {
      const r = await fetch(target, { headers: { Authorization: 'Bearer ' + SERVICE_KEY } });
      const t = await r.text();
      bucket = { status: r.status, bytes: t.length, head: t.slice(0, 24) };
    } catch (e) { bucket = { error: String(e && e.message || e) }; }
    return json(200, {
      pathname: new URL(req.url).pathname, probe: p, publicPath: isPublic(p), protectedPath: isProtected(p),
      siteBase: env('SITE_BASE') || '(unset)', cookiePath: COOKIE_PATH,
      baseWarning: !env('SITE_BASE') ? 'set the SITE_BASE secret to the browser-visible mount (e.g. /functions/v1/annotate) or unlock cookies will be scoped wrong on a sub-path deploy' : '',
      bucketTarget: target.replace(/https:\/\/[^/]+/, '(origin)'), bucket,
      types: { css: TYPES['.css'] || null }
    });
  }
  // /task -> /task.html, but only for paths that will be looked up as files

  /* ---------- the lock ---------- */
  if (!presented || !(await verify(presented, req)).ok) {
    if (isProtected(p)) {
      if (/\.js$/.test(p)) {
        // the product is the corpus; without a key you get an empty stub, not the file
        const stub = p.indexOf('tasks.js') >= 0
          ? 'window.Tasks={list:function(){return[]},get:function(){return null},count:0};window.POLICY={};'
          : 'window.Detector={analyze:function(){return{index:null,locked:true,features:[],tips:[]}}};';
        return new Response(stub, { status: 402, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' } });
      }
      if (/\.html$/.test(p)) {
        // Rendered, not copied: the buyer who unlocks from here should land on the page they were
        // locked out of, not on the front page. Same sentinel as gate.html and server.js, same
        // replace-on-either-shape rule, so one edit cannot leave one host stamping and another not.
        // The path is sanitised down to ^/[\w./-]+ — anything with a query, a colon or a // goes empty
        // and the screen falls back to reloading, which is the behaviour before this existed.
        const ret = /^\/[\w.\/-]+$/.test(p) ? p : '';
        const screen = GATE_HTML.indexOf('/*@@GATE_PATH@@*/') >= 0
          ? GATE_HTML.replace("/*@@GATE_PATH@@*/''", JSON.stringify(ret))
          : GATE_HTML.replace(/var __GATE_TARGET=[^;]*;/, 'var __GATE_TARGET=' + JSON.stringify(ret) + ';');
        // The lock screen is the FIRST thing a browser sees at this URL, and it is built here rather than
        // served from the bucket, so it needs the notice on its own path or a visitor reads raw tags and
        // no explanation anywhere.
        const wantNotice = /text\/html/.test(req.headers.get('accept') || '') &&
          /mozilla|chrome|safari|firefox|edg\//i.test(req.headers.get('user-agent') || '') &&
          new URL(req.url).searchParams.get('notice') !== '0';
        const lockDoc = wantNotice ? annotateNotice(screen, RENDER_URL + p) : screen;
        return new Response(lockDoc, { status: 402, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
      }
      return new Response('locked', { status: 402, headers: { 'content-type': 'text/plain' } });
    }
    if (!isPublic(p)) {
      const nf = await fromBucket(ctx, '/404.html');
      return new Response(nf.body, { status: 404, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
    }
  }

  /* ---------- serve ---------- */
  if (!/\.[a-z0-9]+$/i.test(p) && !FREE_API.test(p)) p += '.html';
  // An extensionless path that reached here is not a page and not an RPC: answer plainly,
  // without asking the bucket for a file that cannot exist.
  if (!/\.[a-z0-9]+$/i.test(p)) return json(404, { error: 'No such route. Pages end in .html.' });

  const up = await fromBucket(ctx, p);
  if (!up.ok) {
    // a missing asset stays a 404 with its own content type; only page paths get the styled page
    if (/\.html$/.test(p)) {
      const nf = await fromBucket(ctx, '/404.html');
      return new Response(nf.body, { status: 404, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
    }
    return new Response('not found', { status: up.status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });   // never cache a miss
  }
  // CACHING. This is a paywall decision, not a performance one, and getting it wrong is a leak:
  // the first draft here gave every file under /css|/js|/assets a 5-minute TTL. /js/tasks.js is
  // in /js AND is the paid corpus, so a buyer's authenticated 200 was cached by the CDN and then
  // served to the NEXT visitor with no key at all — a paid file, from the cache, for free, for
  // five minutes. The rule is therefore: anything PROTECT, and any page, is no-store; only a
  // PUBLIC asset may be cached, and briefly, so a stale 404 during an upload cannot stick.
  const cache = (!isProtected(p) && /^\/(?:css|js|assets)\//.test(p))
    ? 'public, max-age=300, stale-while-revalidate=60'
    : 'no-store';
  // Supabase rewrites text/html to text/plain for anything served from *.supabase.co without a custom
  // domain (docs: /guides/functions/limits), so a browser pointed at this URL reads the site's markup
  // instead of seeing it. The bytes are intact; only the label is forced. For a real navigation we say so
  // in the document itself, and name the URL that renders, rather than leave a visitor squinting at tags.
  // Deliberately NOT applied to the /gate.html render below, and never to a fetch() from another
  // runtime: the banner is keyed on a browser's Accept header, so the mirror's own pulls stay clean.
  const isBrowserNav = /text\/html/.test(req.headers.get('accept') || '') &&
    /mozilla|chrome|safari|firefox|edg\//i.test(req.headers.get('user-agent') || '') &&
    url.searchParams.get('notice') !== '0';
  let served: BodyInit = up.body;
  if (isBrowserNav) served = annotateNotice(await up.text(), RENDER_URL + p);
  if (p === '/gate.html') {
    // The lock screen is the one page that must be RENDERED rather than streamed: its sentinel holds
    // the path the visitor should land on after a successful unlock, and handing out the bucket copy
    // verbatim shows them the token instead. Read the body here — this path is no-store and low volume,
    // and a streamed response cannot be patched without buffering it anyway.
    const q = new URL(req.url).searchParams.get('next') || '';
    // served may already hold the notice-bearing text; only read the body if nobody has consumed it.
    const t = typeof served === 'string' ? served : await up.text();
    served = renderGate(t, /^\/[\w.\/-]+$/.test(q) ? q : '');
  }
  return new Response(served, {
    status: 200,
    headers: {
      'content-type': TYPES[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream',
      'cache-control': cache, etag: 'W/"' + BUCKET + p.length + '-' + (up.headers.get('x-upstream') || '') + '"',
      'x-served-by': 'annotate-edge'
    }
  });
});
