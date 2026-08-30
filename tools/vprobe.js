/* Deploys a tiny probe (or a real tree) to the ai-annotation project over the Vercel API, using the
   project-scoped token in ~/.vercel-token. Exists because I cannot read runtime logs on this scope:
   when a function 500s, the only way to tell "Vercel can't load my handler" from "my handler throws"
   is to deploy a handler that does nothing, and look.

     node tools/vprobe.js                    → deploys the do-nothing probe, prints its URL
     node tools/vprobe.js --gate              → deploys the real api/index.js + the CF function it
                                                evaluates, so the crash can be reproduced with a
                                                known-good file set
   Everything is uploaded base64 in one POST /v13/deployments call; no build step, no repo link, so
   what lands in the deployment is exactly what this script lists — which is the point. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const TOKEN = fs.readFileSync(path.join(os.homedir(), '.vercel-token'), 'utf8').trim();
const PROJECT = 'ai-annotation';
const ROOT = path.join(__dirname, '..');

function api(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: 'api.vercel.com', path: urlPath, method,
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'content-length': body ? Buffer.byteLength(body) : 0 }
    }, (res) => {
      let s = ''; res.on('data', (d) => s += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, text: s.slice(0, 400) }); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const file = (p) => ({ file: p, data: fs.readFileSync(path.join(ROOT, p)).toString('base64'), encoding: 'base64' });

(async () => {
  const mode = process.argv.indexOf('--site') >= 0 ? 'site' : (process.argv.indexOf('--gate') >= 0 ? 'gate' : 'probe');
  const toProd = process.argv.indexOf('--prod') >= 0;
  const ign = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let tree = null;
  if (mode === 'site') {
    // Upload exactly what the repo contains minus .vercelignore, so "did Vercel honour the ignore file"
    // stops being a question about its heuristics and becomes a fact about this list.
    const want = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(ROOT, rel || '.'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = (rel ? rel + '/' : '') + e.name;
        if (['node_modules', '.git'].indexOf(e.name) >= 0) continue;
        if (ign.some((g) => r === g || r === g.replace(/\/$/, '') || (g.endsWith('/') && r.startsWith(g)))) continue;
        if (e.isDirectory()) { walk(r); continue; }
        if (!e.isFile()) continue;
        if (/(^|\/)\.env|\.secret$|issued\.jsonl$/.test(r)) continue;
        want.push(r);
      }
    };
    walk('');
    tree = want.map(file);
    console.log('  site mode: ' + tree.length + ' files (repo minus .vercelignore)');
  }
  const files = mode === 'probe'
    ? [{ file: 'index.html', data: Buffer.from('<!DOCTYPE html><title>probe</title><p>ok</p>').toString('base64'), encoding: 'base64' },
       { file: 'api/index.js', data: Buffer.from(
         "// do-nothing handler: proves whether Vercel can load a CommonJS function at all\n" +
         "module.exports = async function (req, res) {\n" +
         "  res.statusCode = 200;\n" +
         "  res.setHeader('content-type', 'application/json');\n" +
         "  res.end(JSON.stringify({ probe: 'ok', node: process.version, hasFetch: typeof fetch, hasRequest: typeof Request }));\n" +
         "};\n").toString('base64'), encoding: 'base64' }]
    : mode === 'site' ? tree
    : [{ file: 'index.html', data: fs.readFileSync(path.join(ROOT, 'index.html')) },
       { file: 'vercel.json', data: fs.readFileSync(path.join(ROOT, 'vercel.json')) }]
      .map((f) => (typeof f.data === 'string' ? f : { file: f.file, data: f.data.toString('base64'), encoding: 'base64' }))
      .concat(['api/index.js', 'api/_gate.js', 'deploy/cloudflare-pages-function.js', 'deploy/gate-fallback.html', 'buy.html', 'gate.html', 'js/crypto.js', 'css/app.css'].map(file));
  if (mode === 'gate') files.forEach((f) => { if (typeof f.data !== 'string') { f.data = f.data.toString('base64'); f.encoding = 'base64'; } });

  const r = await api('POST', '/v13/deployments?next=1', {
    name: 'ai-annotation', project: PROJECT, ...(toProd ? { target: 'production' } : {}),
    functions: { 'api/index.js': { runtime: 'nodejs22.x', memory: 1024, maxDuration: 30 } },
    routes: [{ handle: 'rewrite' }, { src: '/((?!api/|_vercel/).*)', dest: '/api/index' }],
    files
  });
  const d = r.json && (r.json.deployment || r.json);
  console.log('  POST → HTTP ' + r.status + '  mode=' + mode);
  if (!d || !d.url) { console.log('  ' + JSON.stringify(r.json || r.text).slice(0, 400)); process.exit(1); }
  console.log('  url: https://' + d.url);
  console.log('  id : ' + d.id);
  const base = 'https://' + d.url;
  if (mode === 'site') { console.log('  (site mode: not polling; probe the URL yourself)'); process.exit(0); }
  for (let t = 0; t < 24; t++) {
    await new Promise((s) => setTimeout(s, 2500));
    const st = await new Promise((res) => https.get(base + '/api/index', (r2) => { let b = ''; r2.on('data', (c) => b += c); r2.on('end', () => res({ code: r2.statusCode, body: b.slice(0, 220), type: r2.headers['content-type'] })); }).on('error', (e) => res({ code: 0, body: String(e.message) })));
    if (st.code && st.code !== 404) {
      console.log('  /api/index → ' + st.code + '  ' + st.type);
      console.log('  body: ' + st.body);
      const idx = await new Promise((res) => https.get(base + '/index.html', (r2) => res(r2.statusCode)).on('error', () => res(0)));
      console.log('  /index.html → ' + idx);
      process.exit(0);
    }
  }
  console.log('  never came up');
  process.exit(1);
})().catch((e) => { console.log('  ERR ' + e.message); process.exit(1); });
