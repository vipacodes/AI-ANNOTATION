/* tests/clone-ui.js — drive p.html (the platform clones) in jsdom the way a paid visitor actually meets it:
   real scripts, the real grading engine, and COMPUTED VISIBILITY rather than node existence.

   Why this file exists as its own suite: the blank-queue incident happened because every harness asked
   "is the row in the DOM?" and none asked "can a human see it?". A clone makes that failure mode worse —
   it is pure presentation, and a clone that paints the wrong palette or hides itself behind the pre-paint
   lock looks exactly like a broken product. So each check here goes through shown() / click-through.

   It is also wired into tests/verify.js as a child check, so `node tests/verify.js` alone cannot go green
   with a broken clone. */
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = (function () { try { return require('jsdom'); } catch (e) { return require('/home/user/.testdeps/node_modules/jsdom'); } })();
const ROOT = path.join(__dirname, '..');
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = [];
const ok = (m) => console.log('   \u2713 ' + m);
const bad = (m) => { fails.push(m); console.log('   \u2717 ' + m); };
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const need = (c, good, poor) => (c ? ok(good) : bad(poor || good));

const serveLocal = requestInterceptor((request) => {
  const rel = decodeURIComponent(request.url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0]);
  if (rel === 'api/submit') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  /* the fake server must be as strict as the real one about key shape and expiry, or the harness
     "passes" a locked visitor by answering 200 to a key the real gate would refuse */
  if (rel === 'session' || rel === 'unlock') {
    const raw = request.headers.get('cookie') || '';
    const ck = decodeURIComponent((raw.match(/at_key=([^;]+)/) || [])[1] || '');
    const good = /^[A-Za-z0-9]{6,10}\.[A-Za-z0-9_\-]{20,}\.[0-9]{10,13}$/.test(ck) && Number(String(ck).split('.')[2]) >= Date.now();
    if (!good) return new Response(JSON.stringify({ error: 'This key was not issued by this site.' }), { status: 402, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ label: 'probe buyer', until: '2099-01-01' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] || 'text/plain' } });
});

function keyed(url, key) {
  let html = fs.readFileSync(path.join(ROOT, url.split('?')[0]), 'utf8');
  if (key !== null) {
    /* ONE stringify: setItem already coerces to a string, so a second JSON.stringify stored the key with
       literal quotes in it, the page's shape test failed, and every visitor in the harness looked locked out.
       (This is how the harness once "proved" a blank page was fine.) */
    html = html.replace('</head>', '<script>(function(){var k=' + JSON.stringify(key) +
      ';try{localStorage.setItem("at_key",k);localStorage.setItem("annotatetrainer:key",k);document.cookie="at_key="+encodeURIComponent(k)}catch(e){}})();</script></head>');
  }
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', (e) => {
    const m = String((e && e.message) || e);
    if (/Not implemented: navigation/.test(m)) return;   /* jsdom has no page loads; a real browser navigates */
    errs.push('jsdomError: ' + m);
  });
  vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true,
    resources: { interceptors: [serveLocal] }, url: 'http://localhost:4173/' + url });
  return { dom, w: dom.window, d: dom.window.document, errs };
}
const shown = (w, el) => {
  for (let n = el; n && n !== w.document.body; n = n.parentElement) {
    try { const cs = w.getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } catch (e) { }
  }
  return true;
};
const live = 'PROBE01.' + 'a'.repeat(28) + '.' + (Date.now() + 864e5);
const expired = 'PROBE01.' + 'a'.repeat(28) + '.1700000000000';

(async () => {
  /* ---------- 1. a subscriber lands inside the clone ---------- */
  {
    const { w, d, errs } = keyed('p.html?p=outlier', live);
    for (let i = 0; i < 80; i++) { if (w.Clone && w.App && w.Store) break; await sleep(30); }
    for (let i = 0; i < 60 && d.documentElement.hasAttribute('data-prelock'); i++) await sleep(30);
    const app = d.getElementById('cl-app');
    if (process.env.DBG) console.log('   · stored=' + w.localStorage.getItem('at_key') + ' prelock=' + d.documentElement.hasAttribute('data-prelock') + ' state=' + w.App.gateState());
    need(!d.documentElement.hasAttribute('data-prelock'), 'head script lifted the prelock for a live key');
    need(shown(w, app), 'clone chrome is actually painted, not just present');
    need(errs.length === 0, 'no script threw on the clone page', 'threw: ' + errs.slice(0, 3).join(' | '));
    need(/Outlier/.test(txt(d.querySelector('.cl-logo'))), 'wordmark is the product\u2019s own', 'logo: ' + txt(d.querySelector('.cl-logo')));
    need(!/AnnotateTrainer/.test(txt(d.querySelector('.cl-head'))), 'the product header carries no trainer branding');
    const stats = [...d.querySelectorAll('.cl-stat .v')].map((n) => txt(n));
    need(stats.length >= 5, 'stat block rendered (' + stats.join(' / ') + ')', 'stats: ' + stats.join(','));
    const opened = [...d.querySelectorAll('[data-open]')];
    need(opened.length > 0, 'project list offers ' + opened.length + ' openable items', 'no rows');
    const navs = [...d.querySelectorAll('.cl-nav button')].map((b) => txt(b));
    need(navs.length === 5, 'product nav renders (' + navs.join(', ') + ')', 'nav: ' + navs.join(','));
  }

  /* ---------- 2. drive a real submission through the shared workspace ---------- */
  {
    const { w, d, errs } = keyed('p.html?p=outlier&view=work&id=fact-01', live);
    w.Element.prototype.scrollIntoView = w.Element.prototype.scrollIntoView || function () { };  /* jsdom: no layout */
    for (let i = 0; i < 120 && !d.querySelector('#cl-ws .tbar'); i++) await sleep(30);
    need(!!d.querySelector('#cl-ws .tbar'), 'the real task editor drew inside the clone');
    for (let i = 0; i < 40 && d.getElementById('cl-ws').innerHTML.length < 3000; i++) await sleep(30);
    need(d.querySelectorAll('#cl-ws .panelbox').length >= 2, 'the workspace keeps its two-panel layout inside the clone',
      'panelbox=' + d.querySelectorAll('#cl-ws .panelbox').length + ' len=' + d.getElementById('cl-ws').innerHTML.length);
    need(!d.querySelector('#cl-ws .side'), 'the trainer sidebar is NOT mounted inside the clone');
    need(/Brief\./.test(txt(d.querySelector('#cl-ws'))), 'the brief + paste warning are the shared ones');

    const segs = [...d.querySelectorAll('#cl-ws .resp button')];
    need(segs.length > 0, 'claim controls render (' + segs.length + ' segments)', 'no segments found');
    /* answer the way the key does: five three-way verdicts. Deliberately ALL correct, so the score the
       clone reports can be compared against the number the grading engine gives the same answers in node —
       a clone that graded more generously would still pass a "score > 0" check. */
    const gold = w.Tasks.get('fact-01').payload.gold;
    [...d.querySelectorAll('#cl-ws .seg')].forEach((box, i) => {
      const want = gold[i];
      const btn = [...box.children].find((b) => txt(b) === want);
      if (btn) btn.click();
    });
    await sleep(80);

    const before = (w.Store.get().attempts || []).length;
    const sub = d.querySelector('#cl-ws #submit') || [...d.querySelectorAll('#cl-ws button')].find((b) => /^Submit for grading$/.test(txt(b)));
    need(!!sub, 'submit is the product\u2019s own button');
    if (sub) {
      sub.click(); await sleep(700);
      const after = (w.Store.get().attempts || []).length;
      need(after === before + 1, 'grading ran through the shared engine and wrote the ledger', 'attempts ' + before + ' -> ' + after);
      const rec = (w.Store.get().attempts || []).slice(-1)[0] || {};
      const acts = [...d.querySelectorAll('#cl-ws a.btn')].map((b) => txt(b));
      if (process.env.DBG) console.log('   · rec=' + JSON.stringify(rec));
      need(rec.task === 'fact-01' && rec.score === 100 && rec.passed === true,
        'a key-perfect answer grades 100/100 through the clone, exactly as the engine grades it standalone',
        'clone graded it ' + rec.score + ' (engine says 100) \u2014 the clone is not running the shared scorer');
      need(d.querySelectorAll('#cl-ws .ri').length >= 5, 'the rubric rows are the shared ones (' + d.querySelectorAll('#cl-ws .ri').length + ')', 'no rubric rows');
      need(/Effective rate on this item/.test(txt(d.querySelector('#cl-ws'))), 'effective-rate line still computes inside the clone');
      need(/REWORK|ACCEPTED|Score/i.test(txt(d.querySelector('#cl-ws'))), 'the verdict box is the shared one');
      need(acts.some((a) => /Back to Outlier/.test(a)), 'clone return action replaced the trainer next-task button (' + acts.join(', ') + ')', 'actions: ' + acts.join(','));
      const back = [...d.querySelectorAll('#cl-ws a.btn')].find((b) => /Back to Outlier/.test(txt(b)));
      if (back) {
        const btnLike = [...d.querySelectorAll('#cl-ws a.btn')].find((b) => /Back to Outlier/.test(txt(b)));
        btnLike.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(600);
        need(/Would have earned|Total Earned/i.test(txt(d.getElementById('cl-view'))), 'the return action lands on the clone ledger');
      }
      const payout = [...d.querySelectorAll('#cl-view button')].find((b) => /Withdraw/i.test(txt(b)));
      need(!!payout, 'a payout control exists on the earnings view', 'no withdraw button');
      if (payout) {
        need(payout.disabled, 'the payout control is DISABLED, not hidden');
        need(/disabled/i.test(txt(payout)) || /disabled/i.test(txt(d.getElementById('cl-view'))), 'the disabled state is stated in words, not only greyed out');
      }
      const row = txt(d.querySelector('#cl-view .cl-proj'));
      need(/accepted|rework/i.test(row), 'the ledger row carries the verdict: "' + row.slice(0, 80) + '"');
    }
    need(errs.length === 0, 'submission round trip threw nothing', 'threw: ' + errs.slice(0, 2).join(' | '));
  }

  /* ---------- 3. an unkeyed visitor sees a lock, never a blank page ---------- */
  for (const [who, key] of [['no key at all', null], ['expired key', expired]]) {
    const { w, d, errs } = keyed('p.html?p=handshake', key);
    await sleep(600);
    const app = d.getElementById('cl-app');
    need(!shown(w, app), who + ': clone chrome is hidden');
    need(!!d.querySelector('#at-lock') && shown(w, d.querySelector('#at-lock')), who + ': the lock overlay is visible');
    need(shown(w, d.getElementById('app-banner')), who + ': the banner is visible');
    const body = txt(d.querySelector('#at-lock') || d.body);
    need(/key/i.test(body), who + ': lock text mentions a key');
    need(!/Outlier|Handshake/.test(txt(d.getElementById('cl-app')).slice(0, 200)) || !shown(w, app), who + ': no paid copy leaks while locked');
  }

  /* ---------- 4. every skin boots ---------- */
  for (const id of ['outlier', 'handshake', 'rws', 'alignerr', 'dataannotation', 'mercor', 'mindrift', 'appen', 'toloka', 'pareto', 'prolific', 'telus']) {
    const { w, d, errs } = keyed('p.html?p=' + id, live);
    for (let i = 0; i < 60; i++) { if (w.Clone && d.querySelector('.cl-logo')) break; await sleep(30); }
    await sleep(220);
    const mark = txt(d.querySelector('.cl-logo'));
    const bg = w.getComputedStyle(d.documentElement).getPropertyValue('--cl-bg').trim();
    need(mark.length > 1 && shown(w, d.getElementById('cl-app')), id + ': boots (' + mark + ', bg ' + bg + ')');
    need(errs.length === 0, id + ': no script errors', 'threw: ' + errs.slice(0, 2).join(' | '));
  }

  console.log('\n' + (fails.length ? 'FAILURES:\n - ' + fails.join('\n - ') : 'all clone probe checks passed'));
  process.exit(fails.length ? 1 : 0);
})();
