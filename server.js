/* AnnotateTrainer — zero-dependency dev server: static files, shared submissions log,
   and the paid-access gate (HMAC keys issued by tools/keygen.js).

   Protected = page and script bodies. Public by design = css/, assets/, gate.html, buy.html,
   index.html, guide.html, platforms.html, platform.html (the marketing + catalogue layer you
   want Google to see). Set GATE=off to disable the lock locally, or ANNOTATE_SECRET to share a
   secret with an edge function in production. See DEPLOY.md. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const LOG = path.join(DATA, 'submissions.jsonl');
const GATE = process.env.GATE !== 'off';
fs.mkdirSync(DATA, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg'
};

/* ---------------- keys ---------------- */
function secret() {
  if (process.env.ANNOTATE_SECRET) return process.env.ANNOTATE_SECRET;
  const f = path.join(DATA, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
function sign(id, exp) {
  return crypto.createHmac('sha256', secret()).update(id + '.' + exp).digest('base64url').slice(0, 28);
}
function revoked() {
  try { return new Set(fs.readFileSync(path.join(DATA, 'revoked.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)); }
  catch (e) { return new Set(); }
}
function verifyKey(key) {
  const m = String(key || '').trim().match(/^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/);
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  const [, id, sig, exp] = m;
  if (Number(exp) < Date.now()) return { ok: false, error: 'This key expired. Renew it from your receipt.' };
  if (sign(id, exp) !== sig) return { ok: false, error: 'This key was not issued by this copy of AnnotateTrainer.' };
  if (revoked().has(id)) return { ok: false, error: 'This key has been revoked.' };
  let label = id, until = null;
  try {
    const rec = fs.readFileSync(path.join(DATA, 'issued.jsonl'), 'utf8').trim().split('\n').reverse()
      .map((l) => JSON.parse(l)).find((r) => r.id === id);
    if (rec) { label = rec.label; until = rec.until; }
  } catch (e) { }
  return { ok: true, id, label, until: until || new Date(Number(exp)).toISOString().slice(0, 10) };
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
/* Free to the world: the front door, the catalogue, the guide, the paywall pages, styles, media. */
/* Everything a locked visitor may see. `PROTECT` is checked first, so a file can never be both
   free and withheld; the bare `/` is the `(?:|$)` alternative, not an unanchored catch-all. */
const PUBLIC = /^\/(?:(?:index|gate|buy|guide|platforms|platform)\.html|(?:css|assets|api|\.well-known)\/[^/]*(?:\/[^/]*)*|js\/(?:storage|access|app|platforms|mockups|crypto)\.js|robots\.txt|sitemap\.xml|favicon\.ico|(?:|$))$/;
function isPublic(p) { return PUBLIC.test(p); }/* Behind the key: the graded corpus and the pages that render it. The *content* is the product,
   so the task data files are withheld too — locked requests get an empty stub instead. */
const PROTECT = /^\/(?:task|queue|onboarding|detector|trust-safety|earnings)\.html$|^\/js\/(?:tasks|detector)\.js$|^\/data\//;

/* ---- optional backend: verify keys against Supabase Postgres ----------------
   Set SUPABASE_URL (+ SUPABASE_ANON_KEY, or SERVICE_ROLE_KEY) and the gate asks
   public.key_check() instead of trusting a local secret file. You then get
   instant revocation, buyer labels and a brute-force counter for free, from
   anywhere the same database is reachable (Cloudflare function, this server,
   a second box). Set ACCESS_MODE=local to force the offline path in tests.     */
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SB_ON = !!SB_URL && !!SB_KEY && process.env.ACCESS_MODE !== 'local';
function rpc(fn, args) {
  return fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  }).then((r) => r.json()).catch(() => null);
}
async function verifyAsync(key, req) {
  const m = String(key || '').trim().match(/^([A-Za-z0-9]{6,10})\.([A-Za-z0-9_\-]{20,})\.(\d{10,13})$/);
  if (!m) return { ok: false, error: 'Key format not recognised.' };
  if (Number(m[3]) < Date.now()) return { ok: false, error: 'This key expired. Renew it from the payment receipt.' };
  if (!SB_ON) return verifyKey(key);
  const out = await rpc('key_check', { p_id: m[1], p_sig: m[2], p_exp: Number(m[3]) });
  rpc('key_attempt', {
    p_fp: String((req && req.headers && req.headers['x-forwarded-for']) || req.socket.remoteAddress || 'unknown').split(',')[0].trim(),
    p_key_id: m[1], p_ok: !!(out && out.ok)
  });
  if (!out) return { ok: false, error: 'Backend unreachable, and local fallback is disabled in postgres mode.' };
  return out;
}

function authed(req) {
  if (!GATE) return { label: 'gate disabled', until: null };
  const c = cookies(req);
  if (c.at_key) { const v = verifyKey(c.at_key); if (v.ok) return v; }
  const hdr = req.headers['x-access-key'];
  if (hdr) { const v = verifyKey(hdr); if (v.ok) return v; }
  return null;
}
async function authedA(req) {
  if (!GATE) return { label: 'gate disabled', until: null };
  const c = cookies(req);
  const k = c.at_key || req.headers['x-access-key'];
  if (!k) return null;
  const v = await verifyAsync(k, req);
  return v.ok ? v : null;
}

function safeJoin(rel) {
  const p = path.normalize(path.join(ROOT, rel));
  return p.startsWith(ROOT) ? p : null;
}
function readBody(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e5) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { res(null); } });
  });
}
const json = (res, code, obj, extra) => {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'access-control-allow-origin': '*' }, extra || {}));
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);

  /* ---------- unlock flow ---------- */
  if (p === '/unlock' && req.method === 'POST') {
    const body = await readBody(req);
    const v = body && await verifyAsync(body.key, req);
    if (!v || !v.ok) return json(res, 402, { error: (v && v.error) || 'Missing key.' });
    return json(res, 200, { label: v.label, until: v.until, id: v.id }, {
      'set-cookie': 'at_key=' + encodeURIComponent(body.key) + '; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax'
    });
  }
  if (p === '/session') {
    const a = await authedA(req);
    if (!a) return json(res, 402, { error: 'locked' });
    return json(res, 200, { label: a.label, until: a.until, mode: GATE ? 'server' : 'off' });
  }
  if (p === '/api/submit' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST,GET,OPTIONS' });
    return res.end();
  }

  /* ---------- submissions log ---------- */
  if (p === '/api/submit' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) { res.writeHead(400); return res.end('bad json'); }
    fs.appendFile(LOG, JSON.stringify({
      at: new Date().toISOString(),
      page: String(body.page || '').slice(0, 40),
      kind: String(body.kind || '').slice(0, 40),
      score: Number.isFinite(body.score) ? Math.max(0, Math.min(100, body.score)) : null,
      passed: !!body.passed,
      seconds: Number.isFinite(body.seconds) ? Math.min(86400, Math.max(0, body.seconds)) : null
    }) + '\n', () => { });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/stats') {
    let rows = [];
    try { rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { }
    const scores = rows.filter((r) => r.score !== null).map((r) => r.score);
    return json(res, 200, {
      submissions: rows.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      passRate: rows.length ? Math.round(100 * rows.filter((r) => r.passed).length / rows.length) : null,
      recent: rows.slice(-12).reverse()
    });
  }
  if (p === '/api/health') return json(res, 200, {
    ok: true, gate: GATE ? 'on' : 'off',
    protected: GATE ? ['/task.html', '/queue.html', '/onboarding.html', '/detector.html', '/trust-safety.html', '/earnings.html', '/js/tasks.js', '/js/detector.js'] : [],
    backend: SB_ON ? 'supabase-postgres (revocation + rate limit)' : 'local HMAC (data/.secret)',
    note: 'protected files return 402 (HTML: gate screen, JS: empty stub) unless a valid key is presented'
  });

  /* ---------- static ---------- */
  if (p === '/') p = '/index.html';
  if (!path.extname(p)) p += '.html';
  const a = await authedA(req);
  if (GATE && !a && PROTECT.test(p) && !fs.existsSync(safeJoin('.' + p) || '')) {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    return res.end(fs.readFileSync(path.join(ROOT, '404.html'), 'utf8'));
  }
  if (GATE && !a && PROTECT.test(p)) {
    /* the payload never leaves the server: HTML pages get the gate screen, JS gets an empty stub */
    if (/\.js$/.test(p)) {
      const stub = p.indexOf('tasks.js') >= 0
        ? 'window.Tasks={list:function(){return[]},get:function(){return null},count:0};window.POLICY={};'
        : 'window.Detector={analyze:function(){return{index:null,locked:true,features:[],tips:[]}}};';
      res.writeHead(402, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      return res.end(stub);
    }
    res.writeHead(402, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(ROOT, 'gate.html'), 'utf8'));
  }
  const file = safeJoin('.' + p);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const fb = safeJoin('/404.html');
    if (fs.existsSync(fb)) { res.writeHead(404, { 'content-type': TYPES['.html'] }); return res.end(fs.readFileSync(fb)); }
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('AnnotateTrainer → http://0.0.0.0:' + PORT +
    '  |  gate: ' + (GATE ? 'ON (issue keys with: node tools/keygen.js new)' : 'OFF') +
    '  |  log: data/submissions.jsonl');
});
