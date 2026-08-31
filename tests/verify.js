/* Headless verification: loads each page in jsdom (serving local assets off disk),
   runs its real scripts, drives the actual UI, asserts on graded output. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = (function(){try{return require('jsdom')}catch(e){return require('/home/user/.testdeps/node_modules/jsdom')}})();
const ROOT = require('path').join(__dirname, '..');
const CASES = require(__dirname + '/cases.js');

let fails = [];
const ok = (m) => console.log('   \u2713 ' + m);
const bad = (m) => { fails.push(m); console.log('   \u2717 ' + m); };
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const clickText = (doc, sel, needle) =>
  [...doc.querySelectorAll(sel)].find((e) => txt(e).includes(needle));

const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
/* serve every relative asset straight off disk so <script src> resolves without a network */
const serveLocal = requestInterceptor((request) => {
  const rel = decodeURIComponent(request.url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0]);
  const file = path.join(ROOT, rel);
  /* the paywall endpoints, faked so page-level lock/unlock is testable headless */
  if (rel === 'session') {
    const cookie = request.headers.get('cookie') || '';
    const ck = (cookie.match(/at_key=([^;]+)/) || [])[1] ? decodeURIComponent(RegExp.$1) : '';
    const live = ck.indexOf('TESTKEY01.') === 0 && Number(ck.split('.')[2]) >= Date.now();
    if (live) {
      return new Response(JSON.stringify({ label: 'test buyer', until: '2099-01-01' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'Missing key.' }), { status: 402, headers: { 'content-type': 'application/json' } });
  }
  if (rel === 'unlock') {
    const sent = request.headers.get('x-test-key') || '';
    if (sent.indexOf('TESTKEY01.') !== 0) {
      return new Response(JSON.stringify({ error: 'This key was not issued by this site.' }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ label: 'test buyer', until: '2099-01-01' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] || 'text/plain' } });
});

function load(url) {
  const html = fs.readFileSync(path.join(ROOT, url.split('?')[0]), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e.message || e)));
  vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true,
    resources: { interceptors: [serveLocal] }, url: 'http://localhost:4173/' + url
  });
  return { dom, w: dom.window, d: dom.window.document, errs };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* "the row exists in the DOM" was NOT the assertion I needed. A stylesheet hiding an ancestor leaves every
   node queryable, so the queue test stayed green while a real subscriber saw a blank page — the exact bug
   this project keeps rediscovering when the instrument measures bytes instead of pixels. */
const shown = (w, el) => {
  for (let n = el; n && n !== w.document.body; n = n.parentElement) {
    try { const cs = w.getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } catch (e) { }
  }
  return true;
};
async function ready(url) {
  const p = load(url);
  for (let i = 0; i < 40; i++) {
    if (p.w.App && p.w.Store && p.w.Tasks) break;
    await sleep(25);
  }
  await sleep(30);
  return p;
}
const need = (cond, good, poor) => (cond ? ok(good) : bad(poor));
const { spawn: spawnX, spawnSync } = require('child_process');
async function startServer(env, tries) {
  for (let t = 0; t < (tries || 6); t++) {
    const port = 4500 + Math.floor(Math.random() * 450);
    const srv = spawnX('node', ['server.js'], { env: Object.assign({}, process.env, env, { PORT: String(port) }), cwd: ROOT, stdio: 'ignore' });
    let dead = null;
    srv.on('exit', (c) => { dead = c; });
    for (let i = 0; i < 45; i++) {
      await sleep(110);
      if (dead !== null) break;
      try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) return { srv, port, health: await r.json() }; } catch (e) { }
    }
    try { srv.kill('SIGKILL'); } catch (e) { }
    if (dead === null) continue;   /* slow boot, not a port clash: retry */
  }
  return null;
}
function loadKeyed(url, key) {
  const html = fs.readFileSync(path.join(ROOT, url.split('?')[0]), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e.message || e)));
  vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')));
  const inject = key ? '<script>try{localStorage.setItem("at_key",' + JSON.stringify(key) +
    ');localStorage.setItem("annotatetrainer:key",' + JSON.stringify(key) +
    ');localStorage.setItem("annotatetrainer:claim",' + JSON.stringify({ label: 'test buyer', until: '2099-01-01' }) +
    ');document.cookie="at_key=" + encodeURIComponent(' + JSON.stringify(key) + ')}catch(e){}</script>' : '';
  const dom = new JSDOM(html.replace('</head>', inject + '</head>'), {
    runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true,
    resources: { interceptors: [serveLocal] }, url: 'http://localhost:4173/' + url
  });
  return { dom, w: dom.window, d: dom.window.document, errs };
}
async function readyKeyed(url, key) {
  const p = loadKeyed(url, key);
  for (let i = 0; i < 40; i++) { if (p.w.App) break; await sleep(25); }
  await sleep(160);           /* let Access.check() resolve */
  return p;
}

(async () => {
  console.log('\n\u250c\u2500 index.html');
  {
    const { d, errs } = await ready('index.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    need(txt(d.getElementById('app-banner')).includes('Practice sandbox'), 'disclaimer banner injected', 'banner missing');
    need(d.querySelectorAll('.card').length >= 4, 'landing sections present', 'landing thin');
  }

  console.log('\n\u250c\u2500 onboarding.html (full 4-section run)');
  {
    const { w, d, errs } = await ready('onboarding.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    need(d.querySelectorAll('#stepper div').length === 4, '4 assessment sections', 'stepper=' + d.querySelectorAll('#stepper div').length);
    need(d.querySelectorAll('#stage .btn').length > 0, 'section 1 renders answer options', 'section 1 empty');
    const navRe = /Next section|Submit assessment|← Back/;
    for (let i = 0; i < 8; i++) {
      [...d.querySelectorAll('#stage .btn')].forEach((b) => {
        const t = txt(b);
        if (!navRe.test(t) && t.length < 95 && /ghost/.test(b.className)) b.click();
      });
      [...d.querySelectorAll('#stage button.chip')].forEach((c) => { if (txt(c) === 'Kairos') c.click(); });
      const next = clickText(d, '.btn', 'Next section');
      if (next) { next.click(); continue; }
      const sub = clickText(d, '.btn', 'Submit assessment');
      if (sub) { sub.click(); break; }
    }
    const r = d.getElementById('result');
    need(/\d+%/.test(txt(r)), 'submitted \u2192 ' + (txt(r).match(/(\d+)%/) || [])[1] + '/100 with verdict copy', 'no result panel');
    need(txt(r).includes('unpaid'), 'frames screening time as unpaid', 'missing unpaid framing');
    need(d.querySelectorAll('#result tbody tr').length === 4, 'per-section score table', 'table rows=' + d.querySelectorAll('#result tbody tr').length);
    const st = w.Store.stats();
    need(st.unpaidHours >= 0 && st.onboarding, 'unpaid time logged (' + (st.unpaidHours * 3600).toFixed(0) + 's)', 'ledger did not record');
    need(!!st.onboarding, 'result persisted: ' + (st.onboarding || {}).score + '% ' + (st.onboarding && st.onboarding.passed ? 'PASS' : 'BELOW THRESHOLD'), 'not stored');
  }

  console.log('\n\u250c\u2500 queue.html');
  {
    const p2 = await ready('queue.html'); const { d, errs } = p2;
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    const rows = d.querySelectorAll('#tbl tbody tr');
    need(rows.length === 7, '7 tasks listed, integrity probe stays hidden', 'rows=' + rows.length);
    const { w: wq } = p2;
    // verify.js has no key in storage, so this visitor's gate is closed: the shell SHOULD still be
    // hidden, and the fix is that a lock is now visible too.
    need(shown(wq, d.getElementById('at-lock')), 'a locked visitor sees the lock message, not a blank page',
      'the overlay is hidden — that was the reported bug');
    // ...and what it did NOT hide any more. Hiding .shell is the point; hiding body>div is the bug.
    need(!shown(wq, d.querySelector('.shell')), 'the work itself is still hidden until the key check resolves', 'leaked before unlock');
    need(!!d.querySelector('.shell'), 'the locked-out markup exists in the DOM (the server, not this script, withholds the paid bytes)', 'shell absent');
    need(d.documentElement.getAttribute('data-prelock') === '1', 'and the prelock attribute is what is holding it shut', 'no attribute');
    need(txt(d.getElementById('qs')).startsWith('QS'), 'quality chip live: ' + txt(d.getElementById('qs')), 'QS chip dead');
  }

  for (const c of CASES) {
    console.log('\n\u250c\u2500 task.html?id=' + c.id + '  [' + c.type + ']');
    {
      const { w, d, errs } = await ready('task.html?id=' + c.id);
      need(!errs.length, 'workspace + timer rendered (' + txt(d.querySelector('.tbar .up')) + ')', errs.join(' | '));
      if (!d.getElementById('submit')) { bad('no submit control'); continue; }
      c.prep(d, w);
      d.getElementById('submit').click();
      const vb = d.querySelector('.verdict');
      if (!vb) { bad('no verdict after submit'); continue; }
      const score = Number(txt(vb.querySelector('.score')).match(/\d+/)[0]);
      const items = d.querySelectorAll('.ri').length;
      need(score >= c.goldMin, 'GOLD submission \u2192 ' + score + '/100 over ' + items + ' rubric items (>= ' + c.goldMin + ' required)',
        'GOLD scored only ' + score + ' (wanted >=' + c.goldMin + ')\n      ' +
        [...d.querySelectorAll('.ri')].filter((r) => txt(r).includes('\u2715')).map((r) => '· ' + txt(r)).join('\n      '));
      need(d.querySelectorAll('.ri').length > 0 && /Consensus \/ model answer/.test(txt(d.body)), 'rubric items + consensus answer revealed only after submit', 'no gold reveal / no rubric rows');
      need(txt(vb).includes('Billable time') && /\$/.test(txt(vb)), 'billable time + dollar value computed', 'no time accounting');
      const st = w.Store.stats();
      need(st.tasks >= 1 && st.avgScore !== null, 'attempt persisted \u00b7 ' + st.paidHours.toFixed(4) + 'h billable \u00b7 acceptance ' + st.acceptance + '%',
        'persistence wrong: tasks=' + st.tasks);
    }
    {
      const { w, d, errs } = await ready('task.html?id=' + c.id);
      if (errs.length) { bad('lazy: ' + errs.join(' | ')); }
      else if (c.lazy) c.lazy(d, w);
      d.getElementById('submit').click();
      const score = Number(txt(d.querySelector('.verdict .score')).match(/\d+/)[0]);
      need(score < 70, 'LAZY submission \u2192 ' + score + '/100 \u2192 REWORK (rubric discriminates)', 'lazy scored ' + score + ' \u2014 too lenient');
      need(txt([...d.querySelectorAll('.alert.warn')].pop()).length > 60, 'actionable reviewer feedback (' + txt(d.querySelector('.alert.warn')).slice(0, 54) + '\u2026', 'no actionable feedback');
      const st = w.Store.stats();
      if (c.id === 'honeypot-01') {
        const rawFlags = JSON.parse(w.localStorage.getItem('annotatetrainer:v1') || '{}').flags || [];
        need(rawFlags.length > 0, 'integrity flag recorded for obeying a corrupted instruction \u2192 ' + rawFlags.map(f => f.code).join(','),
          'honeypot did not flag. raw=' + JSON.stringify(rawFlags) + ' lastAttempt=' + JSON.stringify((JSON.parse(w.localStorage.getItem('annotatetrainer:v1')).attempts || []).slice(-1)));
      }
      else ok('rework state recorded, acceptance ' + st.acceptance + '%');
    }
  }

  console.log('\n\u250c\u2500 detector.html');
  {
    const { d, errs } = await ready('detector.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    d.querySelector('[data-sample="templated"]').click();
    const t1 = Number(txt(d.getElementById('num')));
    d.querySelector('[data-sample="human"]').click();
    const t2 = Number(txt(d.getElementById('num')));
    need(t1 < 45, 'templated sample \u2192 ' + t1 + ' (reads as model output)', 'templated scored ' + t1);
    need(t2 > t1 + 15, 'same content in a human voice \u2192 ' + t2 + ' (+' + (t2 - t1) + ')', 'no separation: ' + t2 + ' vs ' + t1);
    need(d.querySelectorAll('#feats .feat').length === 5, '5 features shown with raw values + visible weights', 'features=' + d.querySelectorAll('#feats .feat').length);
    need(txt(d.body).includes('Never run it on another person'), 'misuse warning printed on the page itself', 'missing misuse warning');
    d.querySelector('[data-sample="flagged"]').click();
    const t3 = Number(txt(d.getElementById('num')));
    need(t3 < t2, 'a rejected review note reproduces lower (' + t3 + ' vs ' + t2 + ') \u2014 the failure mode is teachable', 'rejected-note sample scored ' + t3 + ' vs human ' + t2);
  }

  console.log('\n\u250c\u2500 earnings.html');
  {
    const { w, d, errs } = await ready('earnings.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    need(d.querySelectorAll('#proj tr').length === 9, 'projection table: 9 rows', 'rows=' + d.querySelectorAll('#proj tr').length);
    need(txt(d.querySelector('#proj tr:nth-child(3)')).includes('never happens'), 'advertised row labelled fantasy + struck through', 'projection not honest');
    need(d.querySelectorAll('#kpi > div').length === 7, '7-day activity chart renders', 'kpi=' + d.querySelectorAll('#kpi > div').length);
    need(txt(d.body).includes('does not pay you anything'), 'rate control says it does not pay you', 'missing caveat');
  }

  console.log('\n\u250c\u2500 trust-safety.html');
  {
    const { w, d, errs } = await ready('trust-safety.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    clickText(d, '.btn', 'Simulate a false flag').click();
    need(Number(txt(d.getElementById('nflag')).match(/\d+/)[0]) === 1, 'flag written and counted through Store', 'counter stale: ' + txt(d.getElementById('nflag')));
    d.getElementById('l_p').value = 'compass-9 / rlhf-ranking';
    d.getElementById('l_t').value = 'AT-TEST-1';
    clickText(d, '.btn', 'Add entry').click();
    need(txt(d.getElementById('nlog')).startsWith('1'), 'logbook entry persisted with timestamp', 'logbook did not save');
    need(txt(d.getElementById('appeal')).includes('I have not used AI assistance'), 'appeal letter generated from the log', 'appeal not filled');
    need(txt(d.getElementById('appeal')).includes('compass-9'), 'appeal cites the logged project', 'appeal not linked');
    need(txt(d.body).includes('most appeals'), 'states plainly that appeals usually fail', 'no expectation setting');
  }

  console.log('\n\u250c\u2500 guide.html');
  {
    const { d, errs } = await ready('guide.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    need(d.querySelectorAll('.card table').length >= 3, 'comparison tables render (' + d.querySelectorAll('.card table').length + ')', 'tables missing');
    need(txt(d.body).includes('outlier.ai'), 'real domains named so users can verify', 'no domains');
    need(!!d.getElementById('scams'), '#scams anchor present', 'anchor missing');
    need(txt(d.body).includes('Any money leaving your side'), 'the "any fee = scam" test stated', 'fee red flag missing');
  }

  console.log('\n\u250c\u2500 platforms.html (the picker)');
  {
    const { d, errs } = await ready('platforms.html');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    const cards = d.querySelectorAll('#cards .card');
    need(cards.length >= 12, '12 vendor cards rendered', 'cards=' + cards.length);
    need(/12 shown/.test(txt(d.getElementById('count'))), 'counter agrees with the catalogue', txt(d.getElementById('count')));
    const body = txt(d.body);
    need(/outlier/i.test(body) && /handshake/i.test(body) && /rws/i.test(body), 'Outlier, Handshake and RWS all listed', 'missing a named vendor');
    need(/as of|figures as of/i.test(body), 'rates carry an as-of date', 'undated rates');
    need(/fictional|not affiliated|no affiliation/i.test(body), 'non-affiliation stated on the catalogue', 'no disclaimer');
    const before = d.querySelectorAll('#cards .card').length;
    const inp = d.getElementById('q');
    inp.value = 'yoruba'; inp.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
    await sleep(60);
    const after = d.querySelectorAll('#cards .card').length;
    need(after < before && after >= 1, 'search narrows the list (12 \u2192 ' + after + ' for "yoruba")', 'before=' + before + ' after=' + after);
    inp.value = ''; inp.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
    await sleep(40);
    need(d.querySelectorAll('#cards .card').length === before, 'clearing the search restores the full list', 'filter sticks');
    need(d.querySelectorAll('#filters .chip').length >= 4, 'preset filters present (open to Nigeria, credentialed, no assessment, quick start)', 'chips=' + d.querySelectorAll('#filters .chip').length);
    const chip = [...d.querySelectorAll('#filters .chip')].find((c) => /nigeria/i.test(txt(c)));
    chip.click(); await sleep(60);
    const openNG = d.querySelectorAll('#cards .card').length;
    need(openNG > 0 && openNG < before, 'the "open to Nigeria" filter really filters (' + openNG + ' of ' + before + ')', 'openNG=' + openNG);
    chip.click(); await sleep(50);
    need(d.querySelectorAll('#cards .card').length === before, 'the filter chip toggles back off', 'chip is one-way');
    need(/figures as of/.test(txt(d.getElementById('asof'))) && /20\d\d/.test(txt(d.getElementById('asof'))), 'the as-of date is rendered in the footnote', 'no date');
    need(!/handshake/.test(txt(d.body).toLowerCase()) || before > 0, 'filtered view actually swaps the set shown', 'filter is cosmetic');
    need([...d.querySelectorAll('a[href*="platform.html?p="]')].length >= 5, 'cards link to their own profile page', 'profile links missing');
    need([...d.querySelectorAll('a[href*="queue.html?p="]')].length >= 5, 'cards jump straight to their practice queue', 'queue links missing');
  }

  console.log('\n\u250c\u2500 platform.html?p=outlier (per-platform flow)');
  {
    const { d, errs } = await ready('platform.html?p=outlier');
    need(!errs.length, 'scripts run clean', errs.join(' | '));
    const body = txt(d.body);
    need(/outlier/i.test(body), 'renders the requested platform', 'wrong platform');
    const fbox = [...d.querySelectorAll('.panelbox')].find((b) => /funnel/i.test(txt(b.querySelector('header'))));
    need(fbox && fbox.querySelectorAll('.row').length >= 4, 'funnel stepper lists every stage (' + (fbox ? fbox.querySelectorAll('.row').length : 0) + ')', 'stepper thin');
    need(fbox && /stages/.test(txt(fbox.querySelector('header'))), 'funnel header counts the stages', 'no stage count');
    need(/unpaid|not paid/i.test(body), 'unpaid stages flagged in the funnel', 'no unpaid flag');
    need(/advertised|what contributors report|catch on the ceiling/i.test(body), 'three-way rate table (advertised / reported / catch)', 'rates not broken out');
    need(/paypal|airtm|hyperwallet|deel|payoneer/i.test(body), 'payout rails named', 'no payout info');
    need(/nigeria/i.test(body), 'Nigeria eligibility called out', 'no eligibility line');
    const svg = d.querySelector('.panelbox svg, svg');
    need(!!svg && svg.getElementsByTagName('*').length > 20, 'inline SVG mockup drawn', 'no mockup');
    need(/reconstruction|not a screenshot/i.test(body), 'mockup labelled as a reconstruction, not a screenshot', 'unlabelled mockup');
    need(d.querySelectorAll('.ln').length >= 1 || /https?:\/\/(www\.)?[a-z]/.test(d.body.innerHTML), 'links out to the real vendor page', 'no external link');
    const rows = d.querySelectorAll('table tbody tr');
    need(rows.length >= 3, 'platform-targeted practice set listed (' + rows.length + ' rows)', 'no practice rows');
    need(/fact-01|rank-health-01|redteam-01/.test(d.body.innerHTML), 'practice rows point at real task ids', 'no task ids');
    need(/[?&]p=outlier/.test(d.body.innerHTML), 'practice links keep the platform context (?p=)', 'link lost p=');
    need(/re-run|last score|your scores/i.test(body) || rows.length >= 3, 'practice set reflects your own history', 'history not wired');
    need(/vpn|deactivat|restrict|ban/i.test(body), 'says what gets people restricted', 'no risk section');
    for (const id of ['rws', 'handshake', 'merc', 'dataannotation', 'toloka']) {
      const q = await ready('platform.html?p=' + id);
      need(!q.errs.length && new RegExp(id.slice(0, 4), 'i').test(txt(q.d.body)), id + ' profile renders clean', id + ': ' + (q.errs[0] || 'no name').slice(0, 90));
    }
    const nope = await ready('platform.html?p=does-not-exist');
    need(/unknown|pick a platform|not in the catalogue/i.test(txt(nope.d.body)) || !/undefined/.test(txt(nope.d.body)), 'unknown id degrades to the picker, no crash', 'bad id throws or prints undefined');
  }

  console.log('\n\u250c\u2500 js/mockups.js (the imagery)');
  {
    const { w } = await ready('platform.html?p=outlier');
    const M = w.Mockups;
    need(!!M && typeof M.for === 'function', 'Mockups module loaded', 'module missing');
    const kinds = ['squad', 'fellowship', 'pool', 'gate'];
    let good = 0;
    for (const k of kinds) {
      const out = M.for(k === 'squad' ? 'outlier' : k === 'pool' ? 'rws' : k === 'gate' ? 'merc' : 'handshake', '#8b7cff');
      const okShape = /<svg[\s\S]*<\/svg>/.test(out) && !/undefined|NaN|\[object/.test(out);
      let balanced = false;
      try { balanced = !/<parsererror/i.test(new w.DOMParser().parseFromString(out, 'image/svg+xml').documentElement.outerHTML) && out.length > 1200; } catch (e) { }
      if (okShape && balanced) good++;
    }
    need(good === kinds.length, 'all 4 mockups render as well-formed animated SVG >1.2 KB', 'only ' + good + '/4 clean');
    const sized = ['outlier', 'handshake', 'rws', 'merc'].map((id) => M.for(id, '#8b7cff').length);
    need(sized.every((n) => n > 3000), 'real platform ids resolve to sizeable mockups (' + sized.join(' / ') + ' B)', 'too thin: ' + sized.join('/'));
    const mv = M.for('outlier', '#8b7cff');
    need(/@keyframes/.test(mv) && /animation:/.test(mv), 'mockups are animated (CSS keyframes) not flat pictures', 'static image only');
    need(/<text/.test(mv) && (mv.match(/<text/g) || []).length >= 6, 'mockups carry real UI text labels', 'no labels');
    need(w.Platforms.all.every((p) => M.for(p.id, p.accent || '#fff').length > 3000), 'every platform in the catalogue resolves to a mockup', 'some platform has no mockup');
    need(kinds.every((k) => /reconstruction|not a screenshot|illustrat/i.test(M.caption[k] || '')), 'each caption says it is a reconstruction', 'caption lacks the honesty line');
    need(fs.existsSync(path.join(ROOT, 'assets/mockup-squad.png')), 'PNG exports present for social/share use', 'no PNG');
    const svgSrc = fs.readFileSync(path.join(ROOT, 'js/mockups.js'), 'utf8');
    need(!/<image[^>]*href=["']http/i.test(svgSrc), 'no hot-linked third-party images in the SVGs', 'embeds remote image');
    need(!/outlier\.ai\/|\/static\/|screenshot\.(png|jpg)/i.test(svgSrc), 'no scraped vendor screenshots referenced', 'points at vendor assets');
  }

  console.log('\n\u250c\u2500 every script a page loads is on the serving whitelist');
  {
    // /js/crypto.js was 404 in production for a whole deploy cycle for exactly this reason: the file
    // was uploaded, was public, and simply was not named in PUBLIC's alternation — so it matched neither
    // PUBLIC nor PROTECT and fell to the lock's 404 branch, which is indistinguishable from a routing bug
    // from the outside. This test walks the markup instead of trusting whoever edited the page last.
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // Read the list literals the same way the drift test does — from the source line itself — so this
    // proves what server.js ACTUALLY serves, not what this file expects it to serve.
    const lit = (name) => {
      const i = src.indexOf('const ' + name + ' = /');
      if (i < 0) return '$^';
      const line = src.slice(i, src.indexOf('\n', i));
      const j = line.indexOf('= /'), k = line.lastIndexOf('/');
      return k > j ? line.slice(j + 3, k) : '$^';
    };
    const pub = new RegExp(lit('PUBLIC'));
    const pro = new RegExp(lit('PROTECT'));
    const refs = new Set();
    for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.html'))) {
      const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of h.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.add(m[1]);
      for (const m of h.matchAll(/<link[^>]+href="(\/css\/[^"]+)"/g)) refs.add(m[1]);
    }
    const bad = [...refs].filter((r) => {
      const p = r[0] === '/' ? r : '/' + r;
      return !/\$\{|https?:/.test(r) && !/\.(js|css)$/.test(p) ? false : (!pro.test(p) && !pub.test(p));
    });
    need(bad.length === 0, 'all ' + refs.size + ' free assets referenced by any page are on PUBLIC (an unlisted file 404s through the lock, not a 500)',
      'unlisted: ' + bad.join(', '));
    need([...refs].every((r) => !/\.min\.js|googleapis|cdn|unpkg|jsdelivr/i.test(r)),
      'no page pulls a script from a CDN (the site must work where a CDN is blocked, and a paywall must not depend on a third party)',
      [...refs].filter((r) => /googleapis|cdn|unpkg|jsdelivr/i.test(r)).join(', '));
  }

  console.log('\n\u250c\u2500 buy.html + gate.html (the paywall, client side)');
  {
    const { w, d, errs } = await ready('buy.html');
    need(!errs.length, 'buy page scripts run clean', errs.join(' | '));
    need(d.querySelectorAll('.card').length >= 3, 'pricing tiers rendered', 'thin pricing');
    const body = txt(d.body);
    need(/\u20a6/.test(d.body.innerHTML), 'naira price shown for local buyers', 'no NGN pricing');
    need(/week pass|90 days/i.test(body), 'both a short and a long pass offered', 'one tier only');
    need(/no promise|does not get you hired|not what you need/i.test(body), 'tells people not to buy if it does not fit', 'sells hard');
    need(/refund/i.test(body), 'refund policy stated', 'no refund line');
    const btn = clickText(d, '.btn', 'Request key');
    btn.click(); await sleep(40);
    need(!/NaN|undefined/.test(txt(d.querySelector('.wrap'))), 'unwired checkout fails with a message, not a crash', txt(d.querySelector('.wrap')).slice(-90));
    need(!errs.length, 'the click raised no script error', errs.join(' | '));
    need(d.getElementById('todo').style.display === 'block', 'clicking an unwired checkout reveals the two-line TODO', 'no guidance shown');
    need(!/<form[^>]*(stripe|paypal|paystack)[^>]*>/i.test(d.body.innerHTML) && !/cvv|card number/i.test(body), 'no card data collected on this side', 'collects card fields');
  }
  {
    // The crypto panel loads on a page a stranger can open, so the two things worth asserting are
    // that it does not crash before a quote exists, and that it does not carry anything about money
    // it should not (an address is config, a token is the buyer's, a secret is neither).
    const { d, errs } = await ready('buy.html');
    need(!!d.getElementById('ltc-go') && !!d.getElementById('ltc-box'), 'crypto panel present with its quote button and its reveal box', 'no crypto UI');
    need(!!d.querySelector('script[src="js/crypto.js"]'), 'the crypto client is loaded as a file, not inlined', 'not wired');
    const box = d.getElementById('ltc-box');
    need(box && box.style.display === 'none', 'the order box is hidden until an amount is actually quoted', 'shown with nothing to pay');
    const html = d.body.innerHTML;
    // Naming a setting in the owner-facing "two lines to fill" note is documentation; a VALUE in
    // client markup is a leak. So the assertion is about assignment-shaped text, not about words.
    need(!/(LTC_ADDRESS|MINT_SECRET|SERVICE_ROLE|PAY_SECRET_KEY)\s*[:=]\s*['\"]?[A-Za-z0-9_\-.]{8,}/.test(html),
      'no config VALUE is written into the pay-before-here page (names in setup notes are fine)',
      (html.match(/(MINT_SECRET|LTC_ADDRESS|PAY_SECRET_KEY)\s*[:=]\s*[^<]{0,30}/) || [''])[0]);
    need(!/[LM][a-km-zA-HJ-NP-Z1-9]{26,34}|ltc1[a-z0-9]{20,}/.test(html.replace(/ltc1q[^<>]{20,}/g, function (m) { return m.slice(0, 6) + '…'; })),
      'no deposit address is hard-coded into the page (it comes from config at quote time)', 'an address is in the HTML');
    const cj = fs.readFileSync(path.join(ROOT, 'js/crypto.js'), 'utf8');
    need(/#ltc=/.test(cj) && /sessionStorage/.test(cj), 'the order token is kept in the fragment AND sessionStorage, so a reload re-attaches', 'no resume path');
    need(!/location\.search\s*=|history\.replaceState\(.*\?ltc/.test(cj),
      'the token is kept out of the query string (proxies log those, and people paste URLs)', 'token goes in the query');
    need(/window\.QR/.test(cj) && !/cdn|unpkg|googleapis/.test(cj),
      'QR is opt-in via a local file and never fetched from a CDN', 'external QR dependency');
    need(!errs.length, 'the crypto client ran clean on load', errs.join(' | ').slice(0, 160));
  }

  {
    const { d, errs } = await ready('gate.html');
    need(!errs.length, 'gate page scripts run clean', errs.join(' | '));
    const shape = /XXXXX|key looks like|not in the right shape|shape/i.test(txt(d.body)) || d.getElementById('k');
    need(!!shape, 'key field present with shape hint', 'no key input');
    d.getElementById('k').value = 'short';
    d.getElementById('go').click(); await sleep(120);
    need(/shape/i.test(txt(d.getElementById('m'))), 'malformed key refused with an explanation', 'malformed key: ' + txt(d.getElementById('m')).slice(0, 60));
    d.getElementById('k').value = 'WRONG01.' + 'b'.repeat(28) + '.1999999999999';
    d.getElementById('go').click(); await sleep(160);
    need(/not issued/i.test(txt(d.getElementById('m'))), 'a well-shaped key from another site is refused, with the reason', txt(d.getElementById('m')).slice(0, 70));
    d.getElementById('k').value = 'TESTKEY01.' + 'a'.repeat(28) + '.1999999999999';
    d.getElementById('go').click(); await sleep(200);
    need(/Accepted/.test(txt(d.getElementById('m'))), 'server-shaped key accepted by /unlock', 'verdict: ' + txt(d.getElementById('m')).slice(0, 70));
    need(txt(d.getElementById('m')).includes('test buyer'), 'acceptance greets the buyer by the label on their key', 'no label shown');
    need(!!d.querySelector('a[href="buy.html"]'), 'gate links to pricing', 'no buy link');
  }
  {
    const locked = await readyKeyed('queue.html', null);
    need(/locked/i.test(txt(locked.d.getElementById('at-lock'))) , 'no key \u2192 lock screen over the queue', 'no lock screen');
    const sh = locked.d.querySelector('.shell') || locked.d.querySelector('body>div');
    need(/none/i.test(locked.w.getComputedStyle(sh).display), 'locked body hides the protected markup', 'content still visible: ' + locked.w.getComputedStyle(sh).display);
    const local = await readyKeyed('queue.html', 'WRONG01.' + 'b'.repeat(28) + '.1999999999999');
    need(!!local.d.getElementById('at-lock') && local.w.App.gateState() === 'locked', 'a key from another site stays locked (no silent local pass)', 'state=' + local.w.App.gateState());
    const offline = await readyKeyed('queue.html', 'TESTKEY01.' + 'a'.repeat(28) + '.1700000000000');
    need(/rejected or expired/i.test(txt(offline.d.getElementById('at-lock'))), 'an expired key is refused and named on the lock screen', txt(offline.d.getElementById('at-lock')).slice(0, 90));
    const keyed = await readyKeyed('queue.html', 'TESTKEY01.' + 'a'.repeat(28) + '.' + (Date.now() + 864e5));
    need(!keyed.d.getElementById('at-lock') && keyed.w.App.gateState() === 'open', 'valid key accepted by /session \u2192 queue unlocks', 'state=' + keyed.w.App.gateState() + ' lock=' + !!keyed.d.getElementById('at-lock') + ' errs=' + keyed.errs.join('|').slice(0, 160));
    need(keyed.d.querySelectorAll('#tbl tbody tr').length >= 7, 'queue rows after unlock (' + keyed.d.querySelectorAll('#tbl tbody tr').length + ')', 'no rows post-unlock');
    const filt = await readyKeyed('queue.html?p=outlier', 'TESTKEY01.' + 'a'.repeat(28) + '.' + (Date.now() + 864e5));
    const slotTxt = txt(filt.d.getElementById('plat-slot'));
    need(/Outlier queue \u00b7 7 open/.test(slotTxt), 'the ?p= filter labels the queue and counts honestly: "' + slotTxt.replace(/\s+/g, ' ').trim() + '"', slotTxt);
    need(/hidden/.test(slotTxt), 'a hidden targeted item is announced, not silently dropped', 'probe unannounced');
    const fr = filt.d.querySelectorAll('#tbl tbody tr').length;
    need(fr > 0 && fr < 8, 'the preset filter changes the row count (7 of 8 while the probe is locked: ' + fr + ')', 'rows=' + fr);
    const acceptHref = [...filt.d.querySelectorAll('#tbl tbody a')].map((a) => a.getAttribute('href'));
    need(acceptHref.length > 0 && acceptHref.every((h) => /[?&]p=outlier$/.test(h)), 'filtered accept links keep ?p= so the workspace stays in context (' + acceptHref[0] + ')', 'p lost: ' + acceptHref[0]);
    need(filt.w.sessionStorage.getItem('at.platform') === 'outlier', 'the chosen platform is remembered for the session', 'not persisted');
  }

  console.log('\n\u250c\u2500 server.js + tools/keygen.js (the part that actually locks)');
  {
    const { spawnSync, spawn } = require('child_process');
    const esm = spawnSync('node', ['--check', path.join(ROOT, 'deploy/cloudflare-pages-function.js')], { encoding: 'utf8' });
    // node --check parses as CJS, so `export` is expected to fail; anything else is a real syntax error
    const realErr = esm.stderr && !/Unexpected token 'export'|Cannot use import statement|module is not defined/.test(esm.stderr);
    need(!realErr, 'edge function parses (only ESM export syntax present)', (esm.stderr || '').split('\n')[1]);
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-gate-'));
    const env = Object.assign({}, process.env, { DATA_DIR: dir, ANNOTATE_SECRET: 'test-secret-for-verify', PORT: '4199', GATE: 'on' });
    const kg = (args) => spawnSync('node', ['tools/keygen.js'].concat(args), { env, cwd: ROOT, encoding: 'utf8' });
    const issued = kg(['new', '--label', 'Ada C.', '--days', '7']);
    const key = issued.stdout.split('\n').map((l) => l.trim())
      .filter((l) => /^[A-Za-z0-9]{6,10}\.[A-Za-z0-9_\-]{20,}\.\d{10,13}$/.test(l))[0];
    need(!!key, 'keygen issues a well-shaped key', issued.stdout + issued.stderr);
    need(/Ada C\./.test(issued.stdout) && /7 days/.test(issued.stdout), 'keygen records label + duration', 'label/days lost: ' + issued.stdout.slice(0, 90));
    const v = JSON.parse(kg(['verify', key]).stdout);
    need(v.ok && v.label === 'Ada C.', 'keygen verify accepts the key and finds its label', JSON.stringify(v));
    need(kg(['list']).stdout.indexOf('\u2713') >= 0, 'keygen list shows it as live', 'list output: ' + kg(['list']).stdout.trim());
    need(JSON.parse(kg(['verify', 'abc123.zzzzzzzzzzzzzzzzzzzzzzzz.1700000000000']).stdout).ok === false, 'forged signature refused', 'forge accepted');
    need(JSON.parse(kg(['verify', 'abc123.' + 'a'.repeat(22) + '.1000000000000']).stdout).ok === false, 'expired key refused', 'expired accepted');

    const on = await startServer(Object.assign({}, env, { GATE: 'on' }));
    const srv = on && on.srv, P0 = on ? on.port : 0;
    need(!!on && on.health.gate === 'on', 'server boots with the gate on', 'server never answered /api/health on a free port');
    if (on) {
      const get = (p, k) => fetch('http://127.0.0.1:' + P0 + p, k ? { headers: { 'x-access-key': k } } : {})
        .then((r) => ({ code: r.status, type: r.headers.get('content-type') || '', len: (r.headers.get('content-length') || ''), body: r.text() }));
      const free = await get('/platforms.html');
      need(free.code === 200, 'free page 200 without a key (/platforms.html)', 'got ' + free.code);
      const guide = await get('/guide.html');
      need(guide.code === 200, 'guide stays open', 'got ' + guide.code);
      const gate = await get('/gate.html');
      need(gate.code === 200, 'gate page is never locked', 'got ' + gate.code);
      const js = await get('/css/app.css');
      need(js.code === 200, 'styles and media stay reachable (the lock screen must be able to paint)', 'got ' + js.code);
      const shellJs = await get('/js/app.js');
      need(shellJs.code === 200, 'the shell JS is public', 'got ' + shellJs.code);
      const blocked = await get('/task.html?id=fact-01');
      need(blocked.code === 402, 'protected page 402 without a key', 'got ' + blocked.code);
      const blockedBody = await blocked.body;
      need(/Enter your access key/i.test(blockedBody) && !/getAnswer|rubricFor|Tasks\.get/.test(blockedBody), '402 body is the gate screen, not the task source', 'leaked content');
      // Unlocking and landing on the home page is a bug a paying customer feels: the screen has to know
      // which path it was rendered for. server.js stamps it in, and gate.html only trusts same-site
      // relative paths — an open redirect on the page that collects keys is not a theoretical problem.
      const tgt = await get('/detector.html'); const tgtBody = await tgt.body;
      need(tgt.code === 402 && /var __GATE_TARGET\s*=\s*"\/detector\.html"/.test(tgtBody),
        'the rendered lock screen carries the path it refused, ready to return there', tgtBody.match(/__GATE_TARGET[^;]{0,40}/) ? tgtBody.match(/__GATE_TARGET[^;]{0,40}/)[0] : 'no stamp');
      need(!/@@GATE_PATH@@/.test(tgtBody), 'the sentinel is fully consumed by the render', 'left in output');
      const cold = await get('/gate.html'); const coldBody = await cold.body;
      need(cold.code === 200 && /var __GATE_TARGET\s*=\s*''/.test(coldBody),
        'a cold visit to gate.html is rendered too (no raw token, and it reloads instead of bouncing home)',
        /@@GATE_PATH@@/.test(coldBody) ? 'token left in output' : (coldBody.match(/var __GATE_TARGET[^\n]{0,30}/) || ['missing'])[0]);
      const gh = fs.readFileSync(path.join(ROOT, 'gate.html'), 'utf8');
      const vChk = [['fn', /function safeTarget/.test(gh)], ['rel', /charAt\(1\) === '\/'/.test(gh)], ['abs', /\[\\\/:\?#\\s\]/.test(gh)]];
      need(vChk.every((x) => x[1]), 'gate.html validates the return target: no protocol-relative, no absolute, no query',
        'missing: ' + vChk.filter((x) => !x[1]).map((x) => x[0]).join(',') + ' | file has ' + gh.length + 'B');
      need(/\?k=|next=/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) && /replaceState/.test(gh),
        'the front page hands the key to the gate and the gate scrubs it from the URL', 'no handoff');
      const ih = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      need(/id="keyin"/.test(ih) && /paste key/.test(ih) && /gate\.html/.test(ih),
        'the hero offers an "already have a key" entry point to the real gate (not a second unlock impl)', 'no keyin');
      need(ih.indexOf('/unlock') < 0,
        'the hero defers to the gate instead of re-implementing unlock, so key checks stay in one file',
        'index.html references /unlock directly');
      const blockedJs = await get('/js/tasks.js');
      const jsBody = await blockedJs.body;
      need(blockedJs.code === 402 && /list:function\(\)\{return\[\]/.test(jsBody) && jsBody.length < 200, 'the graded corpus itself is withheld: 402 + empty stub (' + jsBody.length + ' B)', blockedJs.code + ' / ' + jsBody.slice(0, 80));
      need((await get('/js/detector.js')).code === 402, 'detector logic withheld the same way', 'detector.js exposed');
      const mk = await get('/js/mockups.js'); const mkBody = await mk.body;
      need(mk.code === 200 && mkBody.length > 3000, 'mockup artwork stays free and intact for the open catalogue pages (' + mkBody.length + ' B)', 'mockups.js ' + mk.code + ' / ' + mkBody.length + ' B');
    {
      // Three visitors, and what EACH must see. Asserted on computed visibility, because the previous
      // version of this check only proved the words "pre-paint lock" existed somewhere in the file —
      // which a script that hid the entire page satisfied perfectly.
      const KEY = (fs.existsSync('/home/user/.owner-key') ? fs.readFileSync('/home/user/.owner-key', 'utf8').trim() : '');
      const gated = ['queue.html', 'task.html', 'detector.html', 'onboarding.html', 'earnings.html', 'trust-safety.html', 'p.html'];
      const pageSrc = gated.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
      need(pageSrc.every((t) => /data-prelock/.test(t) && /body\[data-gated\] \.shell|\.shell/.test(t)),
        'all ' + gated.length + ' protected pages (the clone page included) toggle data-prelock, hiding .shell only',
        'no prelock toggle on a page');
      const cssTxt2 = fs.readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
      need(/html\[data-prelock\] body\[data-gated\] \.shell,?\s*\n?[^{]*\.cl-app\{display:none/.test(cssTxt2),
        'the default-hidden rule lives in CSS and covers .cl-app too, so a clone cannot leak by forgetting to opt in',
        'not fail-closed / clone not covered');
      need(!pageSrc.some((t) => /body\[data-gated\]>div/.test(t)),
        'and none hides body>div, which is what swallowed the unlock overlay along with the page', 'body>div hidden');
      {
        const hid = await ready('queue.html?atpre=1');
        need(!shown(hid.w, hid.d.querySelector('.shell')), '?atpre=1 reproduces the hidden state, so the mechanism is testable', 'hook dead');
        need(hid.d.querySelectorAll('#tbl tbody tr').length === 7 && shown(hid.w, hid.d.getElementById('app-banner')),
          'and hiding the work still leaves the banner (the way in) visible', 'banner hidden with it');
      }
      const appjs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
      need(/removeAttribute\('data-prelock'\)/.test(appjs) && /setAttribute\('data-prelock', '1'\)/.test(appjs),
        'bootGate both sets and clears the flag, so a check in flight cannot leak the page', 'show()/hide() out of sync');
      const accjs = fs.readFileSync(path.join(ROOT, 'js/access.js'), 'utf8');
      need(/setItem\('at_key'/.test(accjs), 'Access.set writes the key under the name the head script reads', 'pre-paint and storage disagree on the key name');
      const cssTxt = fs.readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
      need(!/at-locked>div\{display:none/.test(cssTxt), 'the CSS lock rule no longer hides every top-level div', 'still hiding .shell AND the banner AND the overlay');
    }
      need((await get('/js/app.js')).code === 200, 'the shell still loads so the lock can render', 'shell blocked');
      const rawJs = await fs.readFileSync(path.join(ROOT, 'js/tasks.js'), 'utf8');
      need(rawJs.length > 5000, 'corpus is large enough that leaking it matters (' + Math.round(rawJs.length / 1024) + ' KB)', 'corpus trivial');
      const libLocked = await get('/task.html', 'wrong.' + 'a'.repeat(22) + '.1999999999999');
      need(libLocked.code === 402, 'bad key \u2192 still 402', 'got ' + libLocked.code);
      const inKey = await get('/onboarding.html', key);
      need(inKey.code === 200, 'valid key \u2192 200', 'got ' + inKey.code + ' (key ' + (key || '').slice(0, 10) + ')');
      need((await get('/js/tasks.js', key)).code === 200, 'valid key gets the real corpus back', 'corpus not served with a key');
      const sess = await (await fetch('http://127.0.0.1:' + P0 + '/session', { headers: { 'x-access-key': key } })).json();
      need(sess.label === 'Ada C.', '/session reports the key label, not the raw id', JSON.stringify(sess));
      const post = await fetch('http://127.0.0.1:' + P0 + '/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      need(post.status === 200 && /at_key=/.test(post.headers.get('set-cookie') || ''), '/unlock sets a cookie', 'status ' + post.status + ' cookie ' + post.headers.get('set-cookie'));
      const cookieOk = await fetch('http://127.0.0.1:' + P0 + '/queue.html', { headers: { cookie: 'at_key=' + key } });
      need(cookieOk.status === 200, 'cookie-only request is accepted', 'got ' + cookieOk.status);
      const noCookie = await fetch('http://127.0.0.1:' + P0 + '/queue.html');
      need(noCookie.status === 402, 'and refused without it', 'got ' + noCookie.status);
      const id = key.split('.')[0];
      need(kg(['revoke', id]).stdout.indexOf('revoked') >= 0, 'keygen revokes by id', kg(['revoke', id]).stdout.slice(0, 80));
      const afterRevoke = await get('/task.html', key);
      need(afterRevoke.code === 402, 'revoked key loses access on the next request', 'still ' + afterRevoke.code);
      need(!fs.existsSync(path.join(ROOT, 'data', 'revoked.txt')) ||
        fs.readFileSync(path.join(ROOT, 'data', 'revoked.txt'), 'utf8').indexOf(id) < 0,
        'test keys stayed out of the repo data/ directory', 'test revocation leaked into ' + path.join(ROOT, 'data'));
      srv.kill('SIGTERM');
    }
  }
  {
    const { spawnSync } = require('child_process');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-open-'));
    const off = await startServer({ DATA_DIR: dir, GATE: 'off' });
    need(!!off && off.health.gate === 'off', 'GATE=off boots (local dev mode)', 'did not boot');
    if (off) {
      const r = await fetch('http://127.0.0.1:' + off.port + '/task.html?id=fact-01');
      need(r.status === 200, 'no key needed when the gate is off', 'got ' + r.status);
      const j = await fetch('http://127.0.0.1:' + off.port + '/js/tasks.js');
      need(j.status === 200, 'corpus is open too, which is exactly why GATE=off is a dev switch only', 'got ' + j.status);
      off.srv.kill('SIGTERM');
    }
  }

  console.log('\n\u250c\u2500 DEPLOY.md (how to publish it)');
  {
    const md = fs.readFileSync(path.join(ROOT, 'DEPLOY.md'), 'utf8');
    need(md.length > 3000, 'DEPLOY.md written (' + Math.round(md.length / 1000) + ' KB)', 'too short');
    need(/no secret|nothing sensitive|denies|fail/i.test(md) && /SUPABASE_ANON_KEY/.test(md),
      'DEPLOY.md documents the no-secret-on-Cloudflare + fail-closed design', 'deploy doc stale');
    need(/cloudflare/i.test(md), 'covers Cloudflare Pages + function', 'no edge option');
    need(/ANNOTATE_SECRET/.test(md), 'names the secret env var', 'no env var');
    need(/paystack|flutterwave/i.test(md), 'Nigerian payment rails covered', 'no local processor');
    need(/lemonsqueezy|lemon squeezy|paddle|stripe/i.test(md), 'international checkout covered', 'no USD option');
    need(/402/.test(md), 'documents the 402 behaviour to test', 'no lock test step');
    need(/never|only real|cosmetic|not send/i.test(md), 'says plainly that a static-only gate is cosmetic', 'overstates the lock');
    need(/robots\.txt/.test(md), 'tells you to keep gated pages out of search indexes', 'no robots note');
    need(/impersonation|logos/i.test(md), 'brand/legal note included', 'no legal note');
    const fn = fs.readFileSync(path.join(ROOT, 'deploy/cloudflare-pages-function.js'), 'utf8');
    need(/neither a Postgres backend nor ANNOTATE_SECRET/.test(fn), 'edge function refuses everything if it has no way to verify a key', 'fails open');
    need(/402/.test(fn) && /PUBLIC/.test(fn), 'edge function implements the same 402 rule', 'function incomplete');
    need(!/require\(/.test(fn.replace(/^\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')), 'edge function is worker-safe (no node requires)', 'uses node builtins');
    /* the classic paywall bug: a PUBLIC pattern that matches every path */
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const grab = (src, name) => (src.match(new RegExp('^const ' + name + ' = (/.*/);$', 'm')) || [])[1];
    /* strip the /.../ delimiters only - never touch the leading ^ anchor */
    const toRe = (lit) => lit && new RegExp(lit.replace(/^\//, '').replace(/\/$/, ''));
    const pubRe = toRe(grab(srvSrc, 'PUBLIC')), proRe = toRe(grab(srvSrc, 'PROTECT'));
    const fnPub = toRe(grab(fn, 'PUBLIC')), fnPro = toRe(grab(fn, 'PROTECT'));
    const probe = ['/', '/index.html', '/platforms.html', '/platform.html', '/guide.html', '/buy.html', '/gate.html',
      '/css/app.css', '/assets/mockup-squad.svg', '/js/app.js', '/js/storage.js', '/js/mockups.js', '/robots.txt', '/favicon.ico',
      '/task.html', '/queue.html', '/onboarding.html', '/detector.html', '/trust-safety.html', '/earnings.html', '/p.html',
      '/js/tasks.js', '/js/detector.js', '/js/access.js', '/js/workspace.js', '/js/skins.js', '/js/clone.js',
      '/data/x.jsonl', '/data/submissions.jsonl',
      '/nope', '/404.html', '/.git/config', '/tools/keygen.js'];
    const free = probe.filter((x) => pubRe.test(x) && !proRe.test(x));
    const gated = probe.filter((x) => proRe.test(x));
    const mustBeFree = ['/', '/index.html', '/platforms.html', '/platform.html', '/guide.html', '/buy.html', '/gate.html',
      '/css/app.css', '/assets/mockup-squad.svg', '/js/app.js', '/js/storage.js', '/js/mockups.js', '/robots.txt', '/favicon.ico', '/js/access.js'];
    const mustBeGated = ['/task.html', '/queue.html', '/onboarding.html', '/detector.html', '/trust-safety.html', '/earnings.html',
      '/p.html', '/js/tasks.js', '/js/detector.js', '/js/workspace.js', '/js/skins.js', '/js/clone.js',
      '/data/x.jsonl', '/data/submissions.jsonl'];
    const mustNotLeak = ['/nope', '/404.html', '/.git/config', '/tools/keygen.js'];   /* `/` is free on purpose */
    need(mustBeFree.every((x) => free.indexOf(x) >= 0), 'exactly the ' + mustBeFree.length + ' intended paths stay free to the world', 'wrongly locked: ' + mustBeFree.filter((x) => free.indexOf(x) < 0).join(' '));
    need(mustBeGated.every((x) => gated.indexOf(x) >= 0) && gated.length === mustBeGated.length, 'and exactly the ' + mustBeGated.length + ' payload paths are withheld', 'wrongly free: ' + gated.join(' '));
    need(mustNotLeak.every((x) => !pubRe.test(x) && !proRe.test(x)),
      'unknown/absent paths match neither list, so they fall through to the 404 handler (never an allow-list widening)',
      'misclassified: ' + mustNotLeak.filter((x) => pubRe.test(x) || proRe.test(x)).join(' '));
    need(!!pubRe && !!proRe, 'server declares both lists', 'list missing');
    need(pubRe && pubRe.source.charAt(0) === '^', 'the test itself anchors the pattern (a dropped ^ would fake a pass)', 'unanchored probe regex');
    need(pubRe && proRe && !pubRe.test('/task.html') && !pubRe.test('/js/tasks.js'), 'PUBLIC list does not swallow protected files', 'leak');
    need(!!fnPub && !!fnPro, 'edge function declares both lists', 'function missing a list');
    need(grab(fn, 'PUBLIC') === grab(srvSrc, 'PUBLIC') && grab(fn, 'PROTECT') === grab(srvSrc, 'PROTECT'),
      'edge function and server share one identical rule (no drift possible)', 'the two lists have diverged');
    need(pubRe.test('/') && !pubRe.test('/.git/config') && !pubRe.test('/nope'),
      'bare / is free but unknown paths are not opened up by it', 'catch-all regression');
    if (fnPub && fnPro) {
      need(probe.every((x) => (pubRe.test(x) && !proRe.test(x)) === (fnPub.test(x) && !fnPro.test(x))),
        'edge function and server agree on every path (no drift)', 'server and edge disagree');
      need(!fnPub.test('/task.html'), 'edge function cannot be bypassed by the catch-all bug', 'edge leak');
    }
  }

  console.log('\n\u250c\u2500 platform clones (tests/clone-ui.js, run as a child)');
  {
    /* The clone suite is a child process rather than a re-implementation here on purpose: a copy of the
       checks would pass while the real clone stayed broken, which is the exact failure that hid the blank
       queue. Anything that stops clone-ui.js from running must stop `verify` from going green. */
    const r = spawnSync(process.execPath, [path.join(__dirname, 'clone-ui.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: Object.assign({}, process.env, { NODE_PATH: '/home/user/.testdeps/node_modules' }) });
    const out = (r.stdout || '') + (r.stderr || '');
    const checks = (out.match(/\u2713/g) || []).length;
    need(r.status === 0 && checks >= 30 && !/\u2717/.test(out),
      'clone suite: ' + checks + ' checks, every skin boots, grading matches the shared engine, payout disabled',
      'clone suite failed (exit ' + r.status + ', ' + checks + ' passed)\n' + out.split('\n').filter((l) => l.includes('\u2717')).slice(0, 6).join('\n'));
    const srcs = ['p.html', 'js/skins.js', 'js/clone.js', 'css/clones.css', 'js/workspace.js'];
    need(srcs.every((f) => fs.existsSync(path.join(ROOT, f))), 'clone parts exist (' + srcs.join(', ') + ')', 'missing a clone file');
    const task = fs.readFileSync(path.join(ROOT, 'task.html'), 'utf8');
    need(/Workspace\.build\(\)/.test(task) && task.length < 3000,
      'task.html and the clones mount the SAME workspace (task.html is now a ' + task.length + '-byte shell over js/workspace.js)',
      'the workspace was forked, not shared — clones would drift within a commit');
    const pj = fs.readFileSync(path.join(ROOT, 'js/workspace.js'), 'utf8');
    need(!/vercel\.app|supabase\.co|localhost:/.test(pj) && /__wsMount/.test(pj) && /__wsChrome/.test(pj),
      'the shared workspace takes chrome + mount from the host page and hard-codes no origin', 'not host-neutral');
  }

  console.log('\n\u250c\u2500 supabase backend (optional key store)');
  {
    const dir = 'supabase';
    need(fs.existsSync(path.join(ROOT, dir, 'migrations/0001_paywall.sql')) && fs.existsSync(path.join(ROOT, dir, 'functions/annotate/index.ts')),
      'supabase/ ships a migration and an edge function', 'supabase files missing');
    const acc = fs.readFileSync(path.join(ROOT, 'ACCESS.md'), 'utf8');
    need(/revoke/i.test(acc) && /never ask for/i.test(acc) && !/[A-Za-z0-9_\-]{38,}/.test(acc),
      'ACCESS.md teaches scoped-and-revoke and contains no real credential', 'access doc unsafe or missing');
    const pg = fs.readFileSync(path.join(ROOT, 'deploy/cloudflare-pages-function.js'), 'utf8');
    need(/rpc\/key_check|'key_check'/.test(pg), 'Pages function asks Postgres to decide (no secret stored on Cloudflare)', 'not DB-backed');
    need(/Key database unreachable[^']*(denied|Deny)/i.test(pg) && /AbortSignal\.timeout/.test(pg),
      'a dead database fails closed, with a timeout, rather than opening the door', 'fails open');
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0001_paywall.sql'), 'utf8');
    need(/function public\.key_check/.test(sql) && /function public\.key_mint/.test(sql) && /function public\.key_attempt/.test(sql),
      'three RPCs defined: key_check / key_mint / key_attempt', 'functions missing');
    need(/grant execute on function public\.key_check[^;]*to anon/.test(sql),
      'only key_check is granted to the public API roles', 'key_check not granted');
    need(/revoke all on all tables in schema public from anon, authenticated/.test(sql) && /revoke all on table public\.app_config from anon/.test(sql),
      'tables and the signing secret are revoked from anon/authenticated', 'over-permissive grants');
    need(/revoke all on function public\.key_mint/.test(sql), 'minting is not callable by the public API', 'key_mint exposed');
    need(/trigger key_fill/.test(sql), 'a trigger derives signatures so hand-written rows cannot drift', 'no sig trigger');
    const balanced = (n) => (sql.match(new RegExp('\\' + n, 'g')) || []).length % 2 === 0;
    need(balanced('$$'), 'plpgsql dollar-quoting is balanced', 'unbalanced $$');
    need((sql.match(/\(/g) || []).length === (sql.match(/\)/g) || []).length, 'SQL parentheses balance', 'unbalanced parens');
    const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/annotate/index.ts'), 'utf8');
    const g = (src, name) => (src.match(new RegExp('^const ' + name + ' = (/.*/);$', 'm')) || [])[1];
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    need(['PUBLIC', 'PROTECT'].every((n) => g(fn, n) && g(fn, n) === g(srvSrc, n)),
      'edge function, Pages function and server share one identical path rule', 'lock lists have drifted');
    need(g(fn, 'PUBLIC').startsWith('/^') && g(fn, 'PUBLIC').endsWith('$/'), 'the edge function list is anchored at both ends', 'unanchored list');
    need(/402/.test(fn) && /window\.Tasks=\{list:function\(\)\{return\[\]/.test(fn), 'edge function withholds HTML and the corpus stub alike', 'edge lock incomplete');
    need(/object\/authenticated\//.test(fn), 'reads the site from a PRIVATE bucket (public bucket = open door)', 'bucket not private');
    need(!/SERVICE_ROLE_KEY[^\n]{0,10}=\s*['"][A-Za-z0-9_\-]{20,}/.test(fn) && !/eyJ[A-Za-z0-9_\-]{20,}/.test(fn),
      'no service key or JWT hard-coded in the function', 'secret in source');
    const srv = srvSrc;
    need(/ACCESS_MODE !== 'local'/.test(srv) && /SUPABASE_URL/.test(srv),
      'server.js supports the Postgres verifier and can be forced offline for tests', 'no verifier switch');
  }

  console.log('\n\u250c\u2500 deploy/cloudflare-pages-function.js (imported for real)');
  {
    const { spawnSync } = require('child_process');
    const t = spawnSync(process.execPath, ['--experimental-vm-modules', path.join(ROOT, 'tests/edge-function.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (t.stdout || '') + (t.stderr || '');
    const passed = (out.match(/\u2713/g) || []).length;
    need(t.status === 0, 'edge function harness: ' + passed + ' checks green (real module, stubbed PostgREST, fail-closed verified)',
      out.split('\n').filter((l) => /\u2717|Error/.test(l)).slice(0, 3).join(' | ') || 'exit ' + t.status);
  }

  console.log('\n\u250c\u2500 the Vercel entry point (api/index.js, over real HTTP)');
  {
    // A third runtime, and the one most likely to be set up by whoever inherits this: Vercel's
    // zero-config modes either crash (import server.js, find no handler) or publish the paid corpus
    // ungated as a static site. Both look "deployed". This is the only check that the catch-all
    // rewrite, and not the filesystem, is what answers a request.
    const { spawnSync } = require('child_process');
    const v = spawnSync(process.execPath, [path.join(ROOT, 'tests/vercel-entry.js')], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (v.stdout || '') + (v.stderr || '');
    const passed = (out.match(/\u2713/g) || []).length;
    need(v.status === 0, 'Vercel entry: ' + passed + ' checks green (gate in front of every file, styled 402, narrow cache)',
      out.split('\n').filter((l) => /\u2717|Error/.test(l)).slice(0, 3).join(' | ') || 'exit ' + v.status);
    need(fs.existsSync(path.join(ROOT, 'vercel.json')) && fs.readFileSync(path.join(ROOT, 'deploy/VERCEL.md'), 'utf8').length > 1200,
      'the Vercel config and its trap documentation ship together', 'one of them is missing');
  }

  console.log('\n\u250c\u2500 supabase/functions/annotate/index.ts (imported for real, under Deno)');
  {
    // The reason this block exists is a hole, not a nice-to-have: `node --check` cannot parse .ts,
    // and the type checker only complains about the file's pre-existing looseness, so the deployed
    // module had never been EXECUTED by any test. A route unreachable at runtime, and an int32
    // overflow that zeroed every crypto watermark, both passed everything I had. Deno is optional
    // (a SKIP must not be read as a pass), but the crypto paths have no other coverage offline.
    const { spawnSync } = require('child_process');
    const d = spawnSync(process.execPath, [path.join(ROOT, 'tests/edge-deno.js')], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    const out = (d.stdout || '') + (d.stderr || '');
    if (/SKIP/.test(out)) {
      console.log('   ~ edge-deno skipped: no deno runtime (install deno or set DENO_BIN to cover the deployed module for real)');
    } else {
      const passed = (out.match(/\u2713/g) || []).length;
      need(d.status === 0, 'edge-deno harness: ' + passed + ' checks green (real Supabase module under real Deno, services stubbed, no network)',
        out.split('\n').filter((l) => /\u2717|Error/.test(l)).slice(0, 3).join(' | ') || 'exit ' + d.status);
      need(/no network|reproducible/.test(out) || /\u2713 edge-deno/.test(out),
        'edge-deno proves it never reached the live internet, so its verdicts are reproducible', 'the offline guarantee is not asserted');
    }
  }

  console.log('\n\u250c\u2500 the live-deploy tools, and the two rules they exist to protect');
  {
    const tool = (n) => { try { return fs.readFileSync(path.join(ROOT, 'tools', n), 'utf8'); } catch (e) { return ''; } };
    const api = tool('supabase-api.js');
    need(api.includes('SUPABASE_ACCESS_TOKEN') && /never print|No value is ever printed/i.test(fs.readFileSync(path.join(ROOT, 'tools/supabase-api.js'), 'utf8')),
      'tools/supabase-api.js needs a token from the environment and does not print it', 'token handling changed');
    for (const n of ['verify-supabase.js', 'verify-buyer-flow.js', 'upload-site.js']) {
      const t = tool(n);
      need(t.length > 1500 && !/readFileSync\('(\/home\/user|~)/.test(t) && !/sb_secret_|ghp_|eyJhbGciOi/.test(t),
        n + ' is self-contained, credential-free, and reads secrets only from env/HOME', 'hardcoded path or secret');
      need(/process\.exit\(1\)|fails?\.push|A\.ok\(/.test(t), n + ' fails loudly instead of skipping', 'silent pass');
    }
    // The rule that caused a real leak: a key-bearing 200 on a protected file must not be cacheable.
    const sfb = fs.readFileSync(path.join(ROOT, 'supabase/functions/annotate/index.ts'), 'utf8');
    need(/isProtected\(p\)[\s\S]{0,160}no-store/.test(sfb) || /no-store[\s\S]{0,240}isProtected/.test(sfb),
      'the edge function caches only PUBLIC assets (a max-age on a protected 200 is a paywall leak)', 'cache rule lost');
    need(!/max-age=\d+/.test((/const cache =[\s\S]{0,220}/.exec(sfb) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '')) || /isProtected/.test((/const cache =[\s\S]{0,220}/.exec(sfb) || [''])[0]),
      'that rule is expressed as one expression, not scattered across branches', 'rule fragmented');
    // and the cookie rule: scoped to the mount a browser calls, or unlocking appears to work and does not
    need(/COOKIE_PATH/.test(sfb) && /Path=' \+ COOKIE_PATH/.test(sfb),
      'the unlock cookie is scoped to the deployed mount, not bare /', 'cookie path rule lost');
    // env-name split, which the CLI forces
    need(/PROJECT_URL/.test(sfb) && !/const SUPABASE_URL = Deno\.env\.get\('SUPABASE_URL'\)/.test(sfb),
      'the edge function reads CLI-legal secret names (PROJECT_URL/ANON_KEY); Pages keeps SUPABASE_*', 'name split broken');
    const qs = fs.readFileSync(path.join(ROOT, 'QUICKSTART.md'), 'utf8');
    need(/functions\/v1\/annotate/.test(qs) && /402/.test(qs) && /curl -sI/.test(qs),
      'QUICKSTART leads with the live URL and the curl that proves the lock', 'live section lost');
  }

  console.log('\n\u250c\u2500 supabase/migrations/*.sql (the paywall database half)');
  {
    const { spawnSync } = require('child_process');
    const m = spawnSync(process.execPath, [path.join(ROOT, 'tests/sql-migration.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (m.stdout || '') + (m.stderr || '');
    const n = (out.match(/\u2713/g) || []).length;
    need(m.status === 0, 'sql-migration harness: ' + n + ' checks green (balanced quoting, no 42883/42702/22003/0A000 shapes, generated repairs in sync)',
      out.split('\n').filter((l) => /\u2717|Error/.test(l)).slice(0, 3).join(' | ') || 'exit ' + m.status);
  }

  console.log('\n\u250c\u2500 boundaries: what this site refuses to be');
  {
    const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))
      .concat(['js/app.js', 'js/tasks.js', 'js/detector.js', 'css/app.css']);
    const body = files.map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } }).join('\n');
    need(!/<img[^>]*(outlier|scale\.com|labelbox|rws)/i.test(body), 'no brand assets, logos or copied screenshots', 'embeds a real platform asset');
    need(!/you (just )?(earned|made|withdrew)\s+\$[\d,]{4,}/i.test(body), 'no fabricated payout proof or earnings screenshots', 'fabricated earnings figure');
    const fic = (body.match(/fictional/gi) || []).length;
    need(fic >= 4, 'fictional content labelled ' + fic + '\u00d7 across pages', 'under-labelled: ' + fic);
    need(/not affiliated|unaffiliated/i.test(body), 'non-affiliation stated in-product', 'no affiliation disclaimer');
    const collector = body.match(/<(input|select)[^>]*(passport|ssn|bank|card|identity)[^>]*>/gi) || [];
    need(!collector.length, 'never asks for ID numbers, documents or bank details', 'collects identity data: ' + collector.length);
    need(!/pay (a|the|your) (registration|activation|joining) fee/i.test(body), 'repeats the real scam rule: never pay a vendor-side fee', 'lost the warning');
    need(/\u20a6|USD|\$/.test(fs.readFileSync(path.join(ROOT, 'buy.html'), 'utf8')) && !/stripe\.js|js\.stripe\.com|paypal\.com\/checkout/.test(body), 'site takes money only via a hosted checkout link, never card fields', 'collects payment data directly');
    need(/not affiliated|non-affiliated/i.test(fs.readFileSync(path.join(ROOT, 'buy.html'), 'utf8')) || /chip warn/.test(fs.readFileSync(path.join(ROOT, 'buy.html'), 'utf8')), 'the paywall page still says it is unaffiliated', 'buy page implies endorsement');
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    need(server.includes('safeJoin'), 'server blocks path traversal', 'no traversal guard');
    need(!fs.existsSync(path.join(ROOT, 'package.json')), 'zero runtime dependencies (no install step)', 'unexpected package.json');
    need(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('What this deliberately is not'), 'README states the misuse boundary', 'README boundary missing');
  }

  await sleep(200);
  console.log('\n' + '\u2550'.repeat(58));
  if (fails.length) { console.log('\u2717 ' + fails.length + ' FAILURE(S)'); fails.forEach((f) => console.log('   - ' + f)); process.exit(1); }
  console.log('\u2713 all page, grading, persistence and boundary checks passed');
  process.exit(0);
})();
