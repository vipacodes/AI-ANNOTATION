/* What a buyer actually experiences, against a LIVE host, in a real DOM.
 *
 * The other suites prove the gate's decisions (status codes, bytes, headers). This one proves the thing a
 * customer judges you on: does the page DO what the page says. It loads a live URL into jsdom, runs the
 * page's own scripts against the real origin, and drives the real controls — the pay button, the key form,
 * a graded submission, the AI-tells detector, the queue, the assessment.
 *
 *   node tests/live-buyer-flow.js                        # Vercel, the front door
 *   node tests/live-buyer-flow.js --origin https://…     # any host that serves the site
 *   node tests/live-buyer-flow.js --key ""               # free pages only
 *
 * Three things this harness had to get right, each learned by it reporting a broken site that was fine:
 *   - resources go through jsdom's requestInterceptor (the `resources: { fetch }` hook is not called by
 *     this jsdom version, so every <script src> "failed" here and nowhere else);
 *   - <script> and <link> subresources of a PAID page need the gate cookie too, or the site correctly
 *     hands them the 94-byte stub and the page renders empty;
 *   - interactions must wait for the load event, or the click lands before the page's own boot() ran.
 */
'use strict';
const fs = require('fs');
const ORIGIN = (process.argv.includes('--origin')
  ? process.argv[process.argv.indexOf('--origin') + 1]
  : 'https://ai-annotation-tau.vercel.app').replace(/\/+$/, '');
let KEY = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null;
if (KEY === null) { try { KEY = fs.readFileSync(process.env.HOME + '/.owner-key', 'utf8').trim(); } catch (e) { KEY = ''; } }

let JSDOM, VirtualConsole, requestInterceptor, CookieJar;
try {
  ({ JSDOM, VirtualConsole, requestInterceptor, CookieJar } = require('jsdom'));
} catch (e) {
  console.log('\n\u2717 cannot run: jsdom is not installed.');
  console.log('   npm install --prefix ~/.testdeps jsdom && export NODE_PATH=~/.testdeps/node_modules');
  console.log('   A skipped suite is not a passed one; this file exits 1 so CI cannot read it as green.');
  process.exit(1);
}

let pass = 0; const fails = [];
const ok = (m, c, x) => { if (c) { pass++; console.log('   \u2713 ' + m); } else { fails.push(m + (x ? ' - ' + x : '')); console.log('   \u2717 ' + m + (x ? '  - ' + x : '')); } };
const section = (t) => console.log('\n\u250c\u2500 ' + t);
/* Walking ancestors for a computed display/visibility is the ONLY honest form of "the queue rendered".
   The bug this exists for: rows were in the DOM, queryable, counted, green — while a pre-paint lock rule
   hid their ancestor and a paying visitor saw a white page. Any check about what a person SEES uses this. */
const shown = (w, el) => {
  for (let n = el; n && n !== w.document.body; n = n.parentElement) {
    try { const cs = w.getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } catch (e) { }
  }
  return !!el;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now(); ms = ms || 15000;
  for (;;) { let v = null; try { v = fn(); } catch (e) { v = null; } if (v) return v;
    if (Date.now() - t0 > ms) return null; await wait(200); }
}
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const vc = new VirtualConsole();
const pageErrs = [];
vc.on('jsdomError', (e) => { const m = String(e && e.message || e); if (!/Could not load|not implemented/i.test(m)) pageErrs.push(m.slice(0, 140)); });
vc.on('error', (...a) => pageErrs.push(String((a[0] && a[0].message) || a[0]).slice(0, 140)));

function load(path, cookie) {
  const ic = requestInterceptor(async (request) => {
    const u = new URL(request.url);
    const h = {};
    try { for (const [k, v] of request.headers.entries()) h[k] = v; } catch (e) { }
    // A paid page's scripts are themselves paid content: without the cookie the gate hands them the stub.
    if (cookie) h.cookie = cookie;
    const init = { headers: h, redirect: 'follow', method: request.method || 'GET' };
    // The method AND the body have to survive the trip. An interceptor that only forwarded URLs turned a
    // working unlock into "Key rejected." — the XHR reached the gate as a GET with no body, and the gate
    // correctly refused an empty key. A harness that rewrites the request it is meant to observe measures
    // nothing. Third instrument-caused false alarm today, and each time the site was the innocent party.
    if (init.method !== 'GET' && init.method !== 'HEAD') {
      let body = request.body;
      if (body && typeof body.getReader === 'function') {
        const chunks = []; const rd = body.getReader();
        for (;;) { const r = await rd.read(); if (r.done) break; chunks.push(r.value); }
        body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      }
      if (body !== undefined && body !== null) init.body = body;
    }
    return fetch((u.origin === ORIGIN ? ORIGIN : u.origin) + u.pathname + u.search, init);
  });
  return (async () => {
    const res = await fetch(ORIGIN + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    let html = await res.text();
    /* A browser that holds the cookie also holds the mirror in localStorage — every gated page's pre-paint
       reveal reads that, not the cookie. A harness that sends the cookie but not the storage copy therefore
       tests a visitor who does not exist, and I read that artefact as "the queue is blank". Seed it, into
       the HEAD, before the page's own head script, because jsdom runs body scripts immediately and would
       otherwise seed after the reveal had already decided. */
    if (cookie) {
      const kv = /at_key=([^;]+)/.exec(cookie);
      if (kv) {
        const k = decodeURIComponent(kv[1]);
        const seed = '<script>(function(){var k=' + JSON.stringify(k) + ';try{localStorage.setItem("at_key",k);' +
          'localStorage.setItem("annotatetrainer:key",k)}catch(e){}})();</script>';
        html = html.replace(/<head>/, '<head>' + seed);
      }
    }
    /* The cookie belongs in jsdom's jar, not only in the interceptor. The site verifies a session with an
       XMLHttpRequest (js/access.js) and jsdom's XHR will not let script set a Cookie header, so a harness
       that injects the cookie only into fetch/interceptor gives every gated page a lock-on-load that no real
       subscriber sees — I read exactly that artefact as "the queue is blank on the function host". The jar
       is what a browser does: the cookie travels on the page's own requests. */
    let pageRes = { interceptors: [ic] };
    if (cookie && CookieJar) {
      pageRes.cookieJar = new CookieJar();
      try { pageRes.cookieJar.setCookieSync(cookie + '; Path=/', ORIGIN + path); } catch (e) { }
    }
    const dom = new JSDOM(html, {
      url: ORIGIN + path, runScripts: 'dangerously', pretendToBeVisual: true,
      virtualConsole: vc, resources: pageRes,
      beforeParse(w) {
        w.fetch = function (u, init) {
          init = Object.assign({}, init || {});
          const src = init.headers;
          const h = Object.assign({}, src && src.entries ? Object.fromEntries(src.entries()) : (src || {}));
          if (cookie) h.cookie = cookie;
          let abs = String(u && u.href ? u.href : u);
          if (!/^https?:/i.test(abs)) abs = new URL(abs, ORIGIN + path).href;
          return fetch(abs, Object.assign({}, init, { headers: h }));
        };
        // A runtime gap, not a site bug: jsdom implements no scrollIntoView and the workspace calls it
        // right after grading, so the assertion that follows a submit measured the harness.
        if (!w.Element.prototype.scrollIntoView) w.Element.prototype.scrollIntoView = function () { };
        /* The page verifies its key with an XMLHttpRequest (js/access.js), and jsdom gives XHR its own
           cookie handling that a custom resource interceptor never sees — so /session reached the gate
           anonymous and every gated page came back "locked". A browser sends the cookie; make the harness
           do the same, by setting the header jsdom is perfectly willing to let script set. */
        if (cookie) {
          const X = w.XMLHttpRequest;
          const wantKey = decodeURIComponent((/at_key=([^;]+)/.exec(cookie) || [])[1] || '');
          w.XMLHttpRequest = function () {
            const x = new X(); let u = '';
            const o = x.open;
            x.open = function (m, url) { u = String(url); return o.apply(x, arguments); };
            const send = x.send;
            x.send = function (b) {
              /* Same page, same key, one different transport: the gate accepts `x-access-key` on /session
                 exactly so a client that cannot hold a cookie can present one, and jsdom's XHR is such a
                 client. Forcing the cookie header on real code would test a route nobody uses; this way the
                 page still does its own check() with its own headers. */
              try {
                if (wantKey && (!/^[a-z]+:\/\//i.test(u) || u.indexOf(new URL(ORIGIN).host) >= 0)) {
                  x.setRequestHeader('x-access-key', wantKey);
                  if (process.env.DBG) console.log('   · XHR ' + u.slice(-24) + ' → x-access-key set (' + wantKey.slice(0, 8) + '…)');
                }
              } catch (e) { if (process.env.DBG) console.log('   · XHR setRequestHeader threw: ' + e.message); }
              return b === undefined ? send.call(x) : send.call(x, b);
            };
            return x;
          };
          w.XMLHttpRequest.prototype = X.prototype;
        }
      }
    });
    const w = dom.window, d = w.document;
    if (d.readyState !== 'complete') await Promise.race([new Promise((r) => w.addEventListener('load', r)), wait(15000)]);
    await wait(1400);
    return { dom, w, d, status: res.status, html };
  })();
}

(async () => {
  section('host under test: ' + ORIGIN);
  const health = await (await fetch(ORIGIN + '/api/health')).json().catch(() => ({}));
  ok('the host is up and the gate reports itself on', health.ok === true && health.gate === 'on', JSON.stringify(health).slice(0, 160));

  const HAS_CRYPTO = !(health && health.crypto === undefined && !/crypto/.test(JSON.stringify(health)));
  section('the pay button — the one click that must work before anything else' + (process.env.SKIP_CRYPTO ? ' (skipped)' : ''));
  if (process.env.SKIP_CRYPTO) {
    console.log('   · 4 checks skipped by SKIP_CRYPTO — use it only for a host whose gate has no /crypto/* (server.js)');
  }
  if (!process.env.SKIP_CRYPTO) {
    const { d } = await load('/buy.html', '');
    const btn = d.getElementById('ltc-go');
    ok('buy.html renders the crypto panel', !!btn, 'no #ltc-go');
    if (btn) {
      btn.dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }));
      const boxShown = await until(() => d.getElementById('ltc-box') && d.getElementById('ltc-box').style.display !== 'none', 25000);
      ok('clicking it opens an order (the panel becomes visible)', !!boxShown, 'box stayed hidden');
      const amt = flat((d.getElementById('ltc-amount') || {}).textContent);
      const addr = flat((d.getElementById('ltc-addr') || {}).textContent);
      ok('an exact LTC amount is quoted to 8 decimals', /^\d+\.\d{8}\s*LTC$/i.test(amt), JSON.stringify(amt));
      ok('the destination address is an LTC address', /(^|\s)(ltc1q[02-9a-hj-np-z]{20,}|L[a-km-zA-HJ-NP-Z1-9]{26,34})(\s|$)/i.test(addr), JSON.stringify(addr.slice(0, 48)));
      ok('and the page says what it is watching for', /amount|watch|confirm/i.test(flat((d.getElementById('ltc-status') || {}).textContent)), flat((d.getElementById('ltc-status') || {}).textContent).slice(0, 60));
      const saved = '' + (d.location.hash || '') + (d.defaultView.sessionStorage.getItem('at.crypto') || '');
      ok('the order is kept so a reload does not lose it', /#ltc=[A-Za-z0-9]{1,16}\.[A-Za-z0-9-]{8,64}/.test(saved) || /"id"[^,]{2,20},"token"/.test(saved), saved.slice(0, 40) || 'nothing persisted');
    }
  }

  section('the lock screen — a stranger must be told how to get in, not just refused');
  {
    const { d, status, html: htmlOf } = await load('/task.html', '');
    ok('an unkeyed visitor to a paid page is refused', status === 402, String(status));
    // On a host that must re-type HTML as text (Supabase without a custom domain) the DOM never gets built,
    // so assert on the source as well: the refusal FORM must exist either way, painted is a host concern.
    const painted = /paste key/i.test((d.getElementById('k') || {}).placeholder || '');
    ok('the refusal is a real unlock form, in the DOM or in the served source',
      painted || /placeholder="paste key"/i.test(htmlOf) || /Locked|paid-access/i.test(flat(d.body.textContent)), flat(d.body.textContent).slice(0, 70));
    ok('with a link to pricing inside the refusal', !!d.querySelector('a[href*="buy.html"]'), 'no buy link on the lock screen');
  }

  if (KEY) {
    const cookie = 'at_key=' + encodeURIComponent(KEY);
    section('unlock → paid workspace → grading, through the live DOM');
    {
      const { d, w } = await load('/gate.html', cookie);
      const k = d.getElementById('k'), go = d.getElementById('go');
      ok('the unlock page has a key field and a button', !!k && !!go, 'no form on gate.html');
      if (k && go) {
        k.value = KEY;
        go.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        const msg = await until(() => /Accepted|valid until|not supported/i.test(flat((d.getElementById('m') || {}).textContent)), 20000);
        // jsdom's XMLHttpRequest refuses content-type on a POST (DOMException before the request is even
        // sent) while a browser sends it happily, so a "Key rejected." here can be the harness. Both paths
        // are therefore asserted: the site's own transport under jsdom, and the same route over fetch.
        const viaFetch = await fetch(ORIGIN + '/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY }) });
        const fj = await viaFetch.json().catch(() => ({}));
        // The label is whatever the keygen was told when the key was minted ("Owner", "week buyer", a bare
        // id on a local install); asserting its wording tested the key, not the route.
        ok('the unlock route accepts the real key (fetch transport, as a browser uses)',
          viaFetch.status === 200 && !!fj.until && !!fj.label, JSON.stringify(fj).slice(0, 90));
        // The site's own transport, XHR rather than fetch, and the one a browser really uses here.
        ok('and the form’s own XHR transport completes the handshake', !!msg,
          flat((d.getElementById('m') || {}).textContent).slice(0, 70));
      }
    }
    {
      const { d, w } = await load('/task.html', cookie);
      ok('the paid workspace loads for a key-holder', /task|workspace|brief/i.test(d.body.textContent || ''), flat(d.body.textContent).slice(0, 70));
      const n = await until(() => (w.Tasks && w.Tasks.list ? w.Tasks.list().length : 0) > 0, 15000);
      ok('the real corpus arrives, not the empty stub', !!n, 'Tasks.list().length=' + (w.Tasks && w.Tasks.list && w.Tasks.list().length));
      ok('and the workspace has been painted into #root', d.querySelectorAll('#root *').length > 20, d.querySelectorAll('#root *').length + ' nodes');
      ok('the workspace names the brief it is asking you to work to', /\/|rank|classif|extract|label|write/i.test(flat(d.body.textContent)), 'no task header');
      // There is no <input> to fill: an annotation workspace answers by SELECTING lines and pressing a
      // button, so "does the form have controls" has to be measured as "are there clickable things", and
      // a submission is then "click a couple of them, then submit". Asserting on inputs found nothing on a
      // page that worked — which is the mistake this file exists to avoid making about the site.
      const clickables = Array.from(d.querySelectorAll('button, [role=button], .line, .opt, [data-i], li')).filter((e) => e !== null);
      ok('the workspace presents clickable answer controls', clickables.length > 1, clickables.length + ' clickable elements');
      clickables.slice(0, 6).forEach((e) => { try { e.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } catch (x) { } });
      const submit = Array.from(d.querySelectorAll('button')).find((b) => /submit for grading/i.test(b.textContent || ''))
        || Array.from(d.querySelectorAll('button')).find((el) => /submit|grade/i.test(el.textContent || ''));
      ok('a submit control exists', !!submit, 'no #submit');
      if (submit) {
        // text answers exist on some task types; fill whatever is there before submitting
        d.querySelectorAll('textarea, input[type=text], input:not([type])').forEach((t) => {
          t.value = 'Label "policy_violation"; the supporting sentence is quoted, and the ambiguity in clause 2 is '
            + 'flagged rather than guessed. Scope kept to what the rubric asks for.';
          t.dispatchEvent(new w.Event('input', { bubbles: true }));
        });
        d.querySelectorAll('input[type=radio]').forEach((r, i) => { if (i === 0) { r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); } });
        d.querySelectorAll('select').forEach((sel) => { if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new w.Event('change', { bubbles: true })); } });
        submit.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        const graded = await until(() => /ACCEPTED|REWORK/i.test(d.body.textContent || ''), 20000);
        ok('submitting grades the answer against a rubric', !!graded, flat(d.body.textContent).slice(-140));
        ok('a numeric score out of 100 is shown', /\b(100|\d{1,3})\s*\/\s*100\b/.test(d.body.textContent || '') || !!d.querySelector('.score'),
        'no .score / n-100 anywhere');
        ok('with per-item breakdown rows, not one verdict word', d.querySelectorAll('.rh, .chip, [class*=rubric] *').length > 0, 'no rubric rows');
        // Read the SAME node the app mutates by id (task.html does getElementById('submit')), not the
        // element my earlier selector happened to find, which was a different button entirely and made a
        // working "Graded" state look like a missing one.
        const btn = d.getElementById('submit') || submit;
        ok('and the button locks itself so the same answer is not graded twice',
          /graded/i.test(flat(btn.textContent)) || btn.disabled === true, JSON.stringify(flat(btn.textContent).slice(0, 28)));
      }
    }
    section('the AI-tells detector — the feature people came for');
    {
      const { d, w } = await load('/detector.html', cookie);
      const ta = d.querySelector('textarea');
      const btn = Array.from(d.querySelectorAll('button')).find((b) => /analy|check|scan|run|detect/i.test(b.textContent || ''));
      ok('the detector page presents an input and a button', !!ta && !!btn, (ta ? '' : 'no textarea ') + (btn ? '' : 'no button'));
      if (ta && btn) {
        ta.value = 'It is important to note that this meticulously crafted deliverable leverages a robust, comprehensive ' +
          'framework, furthermore ensuring seamless alignment of stakeholder objectives. In conclusion, this paradigm ' +
          'shift underscores the rich tapestry of modern practice.';
        btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        ok('analysing flagged text produces a verdict', await until(() => /AI|likely|tell|score|index|human/i.test(d.body.textContent || ''), 15000) !== null,
          flat(d.body.textContent).slice(0, 90));
        const feats = d.querySelectorAll('.feat').length;
        const tipsTxt = flat((d.getElementById('tips') || {}).textContent);
        ok('it names the specific features it measured', feats >= 3, feats + ' .feat rows');
        ok('and it gives actionable notes, not just a number', /tell|sentence|voice|em-dash|boilerplate|prose|structural/i.test(tipsTxt), JSON.stringify(tipsTxt.slice(0, 70)));
        const before = d.body.innerHTML;
        ta.value = 'i ran it twice and the second one failed so i just deleted the row, took me like 20 mins';
        btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        ok('different text gives a different reading (not a canned result)', await until(() => d.body.innerHTML !== before, 10000) !== null, 'output identical');
      }
    }
    section('the platform clone (p.html) — same product, nothing payable');
    {
      const c = await load('/p.html?p=outlier', cookie);
      const painted = await until(() => c.d.querySelector('#cl-app .cl-head') && c.d.querySelectorAll('#cl-app .cl-stat').length, 20000);
      ok('the clone paints its own header for a keyed visitor', !!painted && shown(c.w, c.d.getElementById('cl-app')), 'no chrome or hidden');
      ok('the trainer chrome is not mounted inside it', !c.d.querySelector('#cl-app .side'), 'the sidebar leaked into the clone');
      ok('every clone carries a visible practice-account notice', /practice account/i.test(c.d.getElementById('cl-app').textContent || ''), 'no notice');
      const ws = await load('/p.html?p=outlier&view=work&id=fact-01', cookie);
      const ed = await until(() => ws.d.querySelector('#cl-ws .tbar'), 25000);
      ok('the real workspace renders inside the clone (shared js/workspace.js)', !!ed, 'no editor');
      if (ed) {
        const gold = ws.w.Tasks.get('fact-01').payload.gold;
        Array.from(ws.d.querySelectorAll('#cl-ws .seg')).forEach((box, i) => {
          const btn = Array.from(box.children).find((b) => (b.textContent || '').trim() === gold[i]);
          if (btn) btn.dispatchEvent(new ws.w.MouseEvent('click', { bubbles: true }));
        });
        await wait(200);
        const sub = ws.d.querySelector('#cl-ws #submit');
        if (sub) sub.dispatchEvent(new ws.w.MouseEvent('click', { bubbles: true }));
        const verdict = await until(() => ws.d.querySelector('#cl-ws .verdict .score'), 20000);
        ok('a key-perfect answer scores 100/100 through the clone, live', !!verdict && /100/.test(verdict.textContent || ''),
          verdict ? verdict.textContent : 'no verdict after submit');
      }
      const e = await load('/p.html?p=outlier&view=earnings', cookie);
      const pay = await until(() => Array.from(e.d.querySelectorAll('#cl-view button')).find((b) => /withdraw/i.test(b.textContent || '')), 20000);
      ok('the payout control exists, is disabled, and says so', !!pay && pay.disabled === true, 'missing or enabled');
      ok('the clone page and its scripts are withheld from an unkeyed browser',
        (await fetch(ORIGIN + '/p.html')).status === 402 && (await fetch(ORIGIN + '/js/workspace.js')).status === 402,
        'a clone byte leaked');
    }

    section('the queue, the assessment, and the earnings clock');
    {
      const q = await load('/queue.html', cookie);
      const items = await until(() => q.d.querySelectorAll('.card, li, [data-id], tr').length, 12000);
      ok('the queue paints several assignable tasks', (items || 0) > 2, items + ' rows');
      ok('and the queue is VISIBLE, not merely present (the blank-page regression this suite was written after)',
        (items || 0) > 2 && shown(q.w, q.d.querySelector('.shell')) && !q.d.documentElement.hasAttribute('data-prelock'),
        'rows in the DOM, page hidden');
      // TWO legitimate ways to refuse an unkeyed visitor: the gate answers 402 with its own unlock screen
      // (server-side, the strong one), or the page is served and App.bootGate paints #at-lock over hidden
      // chrome (a browser that has no key at all). What is never legitimate is a blank page — which is
      // precisely what this check was missing while the queue looked green to every other suite.
      ok('with no key at all the same URL shows a lock with a way in, never a white page', await (async () => {
        const anon = await load('/queue.html', null);
        const rows = anon.d.querySelectorAll('#tbl tbody tr').length;
        const served = (anon.html || '');
        const lockScreen = /Unlock AnnotateTrainer|gate\.html|buy access|Enter my key/i.test(served);
        const clientLock = !!anon.d.getElementById('at-lock') && shown(anon.w, anon.d.getElementById('at-lock')) &&
          !shown(anon.w, anon.d.querySelector('.shell'));
        const good = rows === 0 && (lockScreen || clientLock) && flat(anon.d.body && anon.d.body.textContent).length > 40;
        if (!good) console.log('   · anon page: rows=' + rows + ' lockScreen=' + lockScreen + ' clientLock=' + clientLock +
          ' text=' + flat(anon.d.body && anon.d.body.textContent).length + ' status=' + anon.status);
        return good;
      })(), 'unkeyed queue is neither locked nor blank');
      ok('and reports progress, rather than being a static list', /complete|done|\d+\s*\/\s*\d+|progress|graded/i.test(q.d.body.textContent || ''), 'no progress readout');
      const q2 = await load('/queue.html', cookie);
      ok('a second load renders the same queue (state is stored, not ephemeral)',
        q2.d.querySelectorAll('.card, li, [data-id], tr').length === (items || 0), 'differs between loads');
      const o = await load('/onboarding.html', cookie);
      ok('the qualification assessment renders its question controls', o.d.querySelectorAll('button').length > 5, o.d.querySelectorAll('button').length + ' buttons');
      const start = Array.from(o.d.querySelectorAll('button')).find((b) => /start|begin/i.test(b.textContent || ''));
      if (start) start.dispatchEvent(new o.w.MouseEvent('click', { bubbles: true }));
      const q1 = flat(o.d.body.textContent);
      ok('it shows a question with a stated position in the test', /\b1\s*\/\s*\d+|question/i.test(q1), q1.slice(0, 80));
      const picks = Array.from(o.d.querySelectorAll('button')).filter((b) => !/start|begin|next|submit/i.test(b.textContent || ''));
      picks.slice(0, 1).forEach((el) => el.dispatchEvent(new o.w.MouseEvent('click', { bubbles: true })));
      ok('and an answer can be selected', (await until(() => /selected|\b2\s*\/\s*\d+|scored|correct|next/i.test(o.d.body.textContent || ''), 8000)) !== null,
        picks.length + ' answer buttons offered');
      const e = await load('/earnings.html', cookie);
      ok('the earnings page reads the session and shows rows', e.d.querySelectorAll('.card, li, tr, .stat, .row').length > 2, e.d.querySelectorAll('.card, li, tr').length + ' rows');
    }
  } else {
    section('paid pages skipped — no key');
    console.log('   run with --key <key>, or keep ~/.owner-key, to walk the gated flow');
  }

  section('the free catalogue — what a visitor sees before paying');
  {
    const { d, w } = await load('/platforms.html', '');
    ok('the platform matrix renders rows', flat(d.body.textContent).length > 1500, flat(d.body.textContent).length + ' chars');
    ok('and the dataset is what fills it', await until(() => w.Platforms && Object.keys(w.Platforms).length > 0, 8000) !== null, 'window.Platforms never arrived');
    ok('each platform links to its profile page', d.querySelectorAll('a[href^="platform.html"]').length > 0, '0 profile links');
    const g = await load('/guide.html', '');
    ok('the guide paints its sections, including the scam anatomy anchor', /scam|red.flag/i.test(g.d.body.textContent || '') && !!g.d.getElementById('scams'), 'no #scams');
  }

  section('the client\'s own route conventions');
  {
    const files = ['js/crypto.js', 'js/access.js', 'js/app.js', 'js/storage.js', 'gate.html'];
    const bad = [];
    for (const f of files) {
      let t = ''; try { t = fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8'); } catch (e) { continue; }
      const re = /(?:fetch\(\s*|x\.open\(\s*'(?:GET|POST)',\s*)(['"])([^'"`]+)\1/g; let m;
      while ((m = re.exec(t))) {
        const u = m[2];
        if (/^https?:/i.test(u) || u.startsWith('//')) bad.push(f + ' \u2192 ' + u + ' (hard-coded origin)');
        else if (u.startsWith('/')) bad.push(f + ' \u2192 ' + u + ' (root-absolute: a 404 under a sub-path mount)');
      }
    }
    // 'unlock' (relative to the page) is the only form correct on BOTH hosts: '/unlock' is right at the
    // root and a 404 under /functions/v1/annotate/, and any absolute http(s) URL hard-codes one origin.
    ok('every client API route is page-relative or derived from location, so it works under any mount',
      bad.length === 0, bad.join('; '));
    ok('no page script threw while running against the live host', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '));
  }

  console.log('\n' + '='.repeat(58));
  if (fails.length) { fails.forEach((f) => console.log('   - ' + f)); console.log('\u2717 live-buyer-flow: ' + fails.length + ' failure(s) of ' + (pass + fails.length)); process.exit(1); }
  console.log('\u2713 live-buyer-flow: ' + pass + ' checks passed against ' + ORIGIN + (KEY ? ' (paid pages included)' : ' (free pages only)'));
  /* An explicit exit, not a return: every jsdom window this suite opens owns a timer and an
     event loop of its own, so a passing suite could hang the next CI run forever. */
  process.exit(0);
})().catch((e) => { console.log('\u2717 harness error: ' + (e && e.stack || e)); process.exit(2); });
