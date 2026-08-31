/* js/workspace.js — the task editor, extracted verbatim from task.html's inline <script>.
 *
 * task.html calls Workspace.build(); the platform clones (p.html) call the same function with three
 * hooks set: __wsChrome=false (do not draw the trainer sidebar), __wsMount() (where to draw instead),
 * __wsActions() (what the two post-grade buttons are). Those three are the entire public surface, and
 * that limit is deliberate: grading, the rubric, the paste/typing telemetry and the ledger are shared
 * code, so a clone cannot quietly disagree with the workspace about what a good answer is.
 *
 * Gate note: this file is now part of the paid corpus. It draws task prompts and rubrics from
 * js/tasks.js, so it is listed in PROTECT and .vercelignore alongside it.
 */
(function (root) {
  'use strict';
  root.Workspace = { build: build };

  function build() {
  if (!(window.__wsChrome === false)) App.shell('task.html');
  var H = App.h, esc = App.esc;
  var params = new URLSearchParams(location.search);
  /* platform context: ?p= from the queue, or remembered from the platform you picked */
  var PID = params.get('p') || sessionStorage.getItem('at.platform') || '';
  if (PID) {
    try { sessionStorage.setItem('at.platform', PID); } catch (e) { }
    var _P = window.Platforms && Platforms.get(PID);
    if (_P) document.title = _P.name + ' practice \u00b7 ' + document.title;
  }
  var TASK = Tasks.get(params.get('id')) || Tasks.list(true)[0];
  var RATE = TASK.rate;
  var startAt = Date.now();
  var pastes = 0;
  var submitted = false;

  var root = (window.__wsMount && window.__wsMount()) || document.getElementById('root');
  if (!root) { root = document.createElement('main'); document.body.appendChild(root); }
  root.innerHTML = '';
  var LOCKED = App.locked && App.locked();   /* key not verified yet: build nothing */

  /* ------------------------------------------------------------------ header */
  var clk = H('span', { class: 'timer' });
  root.appendChild(H('div', { class: 'tbar' }, [
    H('div', { style: 'min-width:0' }, [
      H('div', { class: 'up' }, [TASK.project]),
      H('div', { style: 'font-weight:650;font-size:15px' }, [TASK.title])
    ]),
    H('div', { class: 'row', style: 'margin-left:auto;gap:8px' }, [
      H('span', { class: 'chip violet' }, ['$' + RATE + '/hr']),
      H('span', { class: 'chip' }, ['target ' + TASK.minutes + ' min']),
      clk,
      H('a', { class: 'btn ghost sm', href: 'queue.html' + (PID ? '?p=' + PID : '') }, ['✕ release'])
    ])
  ]));
  var timer = App.timer({ seconds: TASK.minutes * 60, el: clk, onExpire: function () { if (!submitted) { App.toast('Clock expired — auto-submitted as-is.', 'bad'); submit(true); } } });

  /* integrity watch on the whole workspace */
  var watch = App.watchInput(document.body, function (code, msg) {
    pastes++;
    App.toast('⚑ ' + msg, 'bad');
  });

  root.appendChild(H('div', { class: 'alert info' }, [
    H('span', { class: 'ic', html: 'i' }),
    H('div', {}, [H('b', {}, ['Brief. ']), TASK.guideline,
      H('div', { class: 'xs', style: 'margin-top:6px;opacity:.75' }, ['Client, rates and payload are fictional. Rubric logic is real. Pasting from another tab is watched, so you can see why paste = flag.'])])
  ]));

  var mount = H('div'); root.appendChild(mount);
  var getAnswer = function () { return null; };
  if (!LOCKED) getAnswer = renderTask(mount, TASK);

  /* ------------------------------------------------------------------ actions */
  var actions = H('div', { class: 'row between', style: 'margin-top:16px' }, [
    H('div', { class: 'xs dim' }, id('meta')),
    H('div', { class: 'row' }, [
      H('button', { class: 'btn ghost sm', onclick: function () { check(); } }, ['Self-check before submit']),
      H('button', { class: 'btn', id: 'submit', onclick: function () { submit(false); } }, ['Submit for grading'])
    ])
  ]);
  root.appendChild(actions);
  function id(x) { return document.getElementById(x.slice(1)); }

  /* ------------------------------------------------------------------ renderers */
  function renderTask(host, t) {
    var p = t.payload;
    var fns = {
      ranking: renderRanking, writing: renderWriting, factcheck: renderFact, errorspot: renderChain,
      code: renderCode, redteam: renderRed, search: renderSearch, honeypot: renderHoneypot
    };
    return (fns[t.type] || renderFallback)(host, t, p);
  }


  function docPanel(p) {
    return H('div', { class: 'panelbox' }, [
      H('header', {}, [H('span', {}, ['Reference documents']), H('span', { class: 'chip' }, ['read-only'])]),
      H('div', { class: 'body' }, [
        H('pre', { style: 'max-height:330px;overflow:auto;font-size:12px;white-space:pre-wrap' , html: esc(p.policy || '') + (p.brief ? '\n\n' + esc(p.brief) : '') }),
        H('div', { class: 'xs dim', style: 'margin-top:8px' }, ['Every claim you make must trace to a line above. Anything outside these documents is "not in brief".'])
      ])
    ]);
  }

  /* ---- ranking ---- */
  function renderRanking(host, t, p) {
    var full = p.responses.map(function (r) { return r.id; });
    var order = [];                                   // explicit only — nothing graded until every slot is filled
    var byId = {}; p.responses.forEach(function (r) { byId[r.id] = r; });
    var list = H('div');
    var hint = H('div', { class: 'xs dim', style: 'margin:2px 0 12px' });

    function slotOf(rid) { return order.indexOf(rid); }
    function nextUnassigned() { return full.filter(function (x) { return slotOf(x) < 0; })[0]; }
    function assign(rid) {
      var at = slotOf(rid);
      if (at >= 0) order.splice(at, 1);
      else if (order.length < full.length) order.push(rid);
      paintList();
      if (window.App.__needsAll && order.length === full.length) window.App.__needsAll(false);
    }
    function swap(a, b) {
      if (a < 0 || b < 0 || a >= order.length || b >= order.length) return;
      var x = order[a]; order[a] = order[b]; order[b] = x; paintList();
    }
    function paintList() {
      list.innerHTML = '';
      hint.innerHTML = 'Assign every rank best \u2192 worst. ' +
        (order.length === full.length
          ? 'Complete: <b class="mono">' + order.join(' \u2192 ') + '</b> \u00b7 click any card to re-place it'
          : '<b>' + (full.length - order.length) + '</b> left to place \u00b7 next free slot is <b>#' + (order.length + 1) + '</b>');
      full.forEach(function (rid, dispIdx) {
        var r = byId[rid];
        var slot = slotOf(rid);
        var done = slot >= 0;
        var card = H('div', { class: 'resp', draggable: 'true', style: 'cursor:pointer;opacity:' + (done ? '1' : '.88') }, [
          H('div', { class: 'rh' }, [
            H('span', { class: 'chip ' + (done ? 'ok' : ''), 'aria-label': 'rank slot' }, [done ? '#' + (slot + 1) : 'unranked']),
            H('span', { class: 'lbl dim' }, [rid]),
            H('span', { class: 'xs dim', style: 'margin-left:8px' }, [done ? 'rank ' + (slot + 1) + ' \u2014 click to release' : 'click to assign #' + (order.length + 1)]),
            H('span', { class: 'row', style: 'margin-left:auto;gap:4px' }, [
              done ? H('button', { class: 'btn ghost sm', onclick: function (e) { e.stopPropagation(); swap(slot, slot - 1); } }, ['\u2191']) : null,
              done ? H('button', { class: 'btn ghost sm', onclick: function (e) { e.stopPropagation(); swap(slot, slot + 1); } }, ['\u2193']) : null,
              H('button', { class: 'btn ghost sm', onclick: function (e) { e.stopPropagation(); assign(rid); } }, [done ? 'unassign' : 'assign'])
            ])
          ]),
          H('div', { class: 'rb' }, [r.text])
        ]);
        card.addEventListener('click', function () { assign(rid); });
        card.addEventListener('dragstart', function (e) { card.classList.add('drag'); e.dataTransfer.setData('text/plain', String(slot < 0 ? dispIdx : slot)); });
        card.addEventListener('dragend', function () { card.classList.remove('drag'); });
        card.addEventListener('dragover', function (e) { e.preventDefault(); card.classList.add('over'); });
        card.addEventListener('dragleave', function () { card.classList.remove('over'); });
        card.addEventListener('drop', function (e) {
          e.preventDefault(); card.classList.remove('over');
          if (!order.length) return;
          var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (from >= order.length) { assign(rid); return; }
          swap(from, slot < 0 ? order.length - 1 : slot);
        });
        list.appendChild(card);
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.target && /TEXTAREA|INPUT/.test(e.target.tagName)) return;
      var k = (e.key || '').toUpperCase();
      if (/^[1-9]$/.test(k)) { var tg = full[parseInt(k, 10) - 1]; if (tg) { assign(tg); e.preventDefault(); } }
      else if (k === 'R') { var nx = nextUnassigned(); if (nx) assign(nx); }
      else if (k === 'U') { order.pop(); paintList(); }
    });
    paintList();

    host.appendChild(H('div', { class: 'prompt', style: 'margin-bottom:14px' }, [
      H('div', { class: 'up', style: 'margin-bottom:5px' }, ['User prompt']), p.prompt
    ]));
    host.appendChild(hint);
    host.appendChild(list);
    return function () { return { order: order.slice() }; };
  }

  /* ---- writing ---- */
  function renderWriting(host, t, p) {
    var ta = H('textarea', { rows: '12', placeholder: 'Write the reference answer here. 60–220 words, prose only. Every factual claim must trace to § in the policy.' });
    var meter = H('div', { class: 'row', style: 'gap:8px;margin-top:10px' });
    ta.addEventListener('input', function () {
      var a = Detector.analyze(ta.value);
      meter.innerHTML = '';
      meter.appendChild(H('span', { class: 'chip ' + (Tasks.wc(ta.value) > 220 || Tasks.wc(ta.value) < 60 ? 'warn' : 'ok') }, [Tasks.wc(ta.value) + ' words']));
      meter.appendChild(H('span', { class: 'chip ' + (a.index >= 68 ? 'ok' : a.index >= 45 ? 'warn' : 'bad') }, ['authenticity ' + a.index]));
      if (a.tips.length) meter.appendChild(H('span', { class: 'xs dim' }, [a.tips[0]]));
    });
    var left = H('div', {}, [
      H('div', { class: 'prompt', style: 'margin-bottom:12px' }, [H('div', { class: 'up', style: 'margin-bottom:5px' }, ['User prompt']), p.userQ]),
      ta, meter,
      H('div', { class: 'xs dim', style: 'margin-top:10px' }, [
        'Live meter uses the same five features as the ', H('a', { href: 'detector.html' }, ['detector']),
        '. It cannot fail you here; on a real platform a low score plus a paste is how accounts get restricted.'
      ])
    ]);
    host.appendChild(H('div', { class: 'split' }, [
      H('div', { class: 'panelbox' }, [H('header', {}, [H('span', {}, ['Response field']), H('span', { class: 'chip' }, ['60–220 words'])]), H('div', { class: 'body' }, [left])]),
      docPanel(p)
    ]));
    return function () { return { text: ta.value }; };
  }

  /* ---- factcheck ---- */
  function renderFact(host, t, p) {
    var sel = {};
    var left = H('div');
    p.items.forEach(function (it, i) {
      var seg = makeSeg(['supported', 'contradicted', 'not-in-brief'], function (v) { sel[i] = v; seg.dataset.v = v; }, 'supported');
      left.appendChild(H('div', { class: 'resp', style: 'margin-bottom:10px' }, [
        H('div', { class: 'rh' }, [H('span', { class: 'chip' }, ['claim ' + (i + 1)]), H('span', { class: 'xs dim' }, ['one verdict'])]),
        H('div', { class: 'rb' }, [H('div', { style: 'margin-bottom:10px' }, ['“' + it.s + '”']), seg])
      ]));
    });
    host.appendChild(H('div', { class: 'split' }, [
      H('div', { class: 'panelbox' }, [H('header', {}, [H('span', {}, ['Claims']), H('span', { class: 'chip' }, [p.items.length + ' items'])]), H('div', { class: 'body' }, [left])]),
      docPanel({ policy: p.context })
    ]));
    return function () { return { choices: Object.assign({}, sel) }; };
  }

  function makeSeg(opts, onPick, initial) {
    var box = H('div', { class: 'seg' });
    var cur = initial || null;
    opts.forEach(function (o) {
      var b = H('button', { type: 'button', class: cur === o ? 'on' : '' }, [o]);
      b.onclick = function () { cur = o; onPick(o); [].forEach.call(box.children, function (c) { c.className = c.textContent === o ? 'on' : ''; }); };
      box.appendChild(b);
    });
    box.get = function () { return cur; };
    return box;
  }

  /* ---- error spot ---- */
  function renderChain(host, t, p) {
    var picks = {};
    var wrap = H('div');
    p.chains.forEach(function (c, ci) {
      var sents = H('div', { class: 'sents' });
      c.steps.forEach(function (s, si) {
        var el = H('div', { class: 's', onclick: function () {
          if (picks[ci] === si) delete picks[ci]; else picks[ci] = si;
          [].forEach.call(sents.children, function (n, i) { n.className = 's' + (picks[ci] === i ? ' sel' : ''); });
        } }, [H('span', { class: 'chip', style: 'margin-right:9px' }, ['step ' + (si + 1)]), s]);
        sents.appendChild(el);
      });
      wrap.appendChild(H('div', { class: 'panelbox', style: 'margin-bottom:14px' }, [
        H('header', {}, [H('span', {}, [c.title]), H('span', { class: 'chip' }, ['click the FIRST error'])]),
        H('div', { class: 'body' }, [sents,
          H('button', { class: 'btn ghost sm', style: 'margin-top:10px', onclick: function () { delete picks[ci]; [].forEach.call(sents.children, function (n) { n.className = 's'; }); } }, ['No error in this chain → clear selection'])])
      ]));
    });
    host.appendChild(wrap);
    return function () { var o = {}; Object.keys(picks).forEach(function (k) { o['c' + k] = picks[k]; }); return o; };
  }

  /* ---- code ---- */
  function renderCode(host, t, p) {
    var sel = {};
    var lines = H('div', { class: 'lines' });
    p.code.forEach(function (ln, i) {
      var n = i + 1;
      var row = H('div', { class: 'ln', onclick: function () {
        sel[n] = !sel[n]; row.className = 'ln' + (sel[n] ? ' sel' : ''); refresh();
      } }, [H('span', { class: 'no' }, [String(n)]), H('span', { class: 'txt' }, [ln || ' '])]);
      lines.appendChild(row);
    });
    var count = H('span', { class: 'chip' }, ['0 lines selected']);
    function refresh() { count.textContent = Object.keys(sel).filter(function (k) { return sel[k]; }).length + ' lines selected'; }
    var fix = H('textarea', { rows: '3', placeholder: 'Fix note: the replacement expression, not "add error handling".' });
    host.appendChild(H('div', {}, [
      H('div', { class: 'row between', style: 'margin-bottom:8px' }, [
        H('span', { class: 'xs dim mono' }, ['payment_estimator.py · ' + p.code.length + ' lines']), count
      ]),
      lines,
      H('div', { style: 'margin-top:12px' }, [H('label', { class: 'f' }, ['Suggested fix']), fix]),
      H('p', { class: 'xs dim' }, ['Decoys are in here. Style issues are out of scope for this brief — selecting them costs you precision.'])
    ]));
    return function () {
      return { lines: Object.keys(sel).filter(function (k) { return sel[k]; }).map(Number), fix: fix.value };
    };
  }

  /* ---- red team ---- */
  function renderRed(host, t, p) {
    var promptTa = H('textarea', { rows: '6', placeholder: 'One prompt, ≥15 words, aimed at the constraint layer (not the topic). Do not answer it yourself.' });
    var report = H('textarea', { rows: '6', placeholder: 'Failure report: which rule is threatened, your severity call, numbered reproduction steps.' });
    var vec = {};
    var left = H('div', {}, [
      H('div', { class: 'prompt', style: 'margin-bottom:12px' }, [H('div', { class: 'up', style: 'margin-bottom:5px' }, ['Sandbox scenario']), p.scenario]),
      H('label', { class: 'f' }, ['Adversarial prompt']), promptTa,
      H('div', { class: 'up', style: 'margin:16px 0 8px' }, ['What is this attacking? (label at least two)']),
      H('div', { class: 'grid g2' }, ['Instruction override / prompt injection', 'Persona or roleplay escape',
        'Policy / system text exfiltration', 'Harmful capability request'].map(function (l, i) {
        var key = ['injection', 'persona', 'exfil', 'harm'][i];
        return H('label', { class: 'opt' }, [H('input', { type: 'checkbox', onchange: function (e) { vec[key] = e.target.checked; } }), l]);
      })),
      H('div', { style: 'margin-top:14px' }, [H('label', { class: 'f' }, ['Failure report']), report]),
      H('div', { class: 'xs dim', style: 'margin-top:10px' }, ['Anything you write here stays in this browser. It is not sent to a model, a client, or anyone else.'])
    ]);
    host.appendChild(left);
    return function () { return { text: promptTa.value, report: report.value, vectors: vec }; };
  }

  /* ---- search ---- */
  function renderSearch(host, t, p) {
    var sel = {};
    var wrap = H('div');
    p.items.forEach(function (it, i) {
      var seg = makeSeg(['bad', 'fair', 'good', 'excellent'], function (v) { sel[i] = v; }, null);
      wrap.appendChild(H('div', { class: 'resp', style: 'margin-bottom:10px' }, [
        H('div', { class: 'rh' }, [H('span', { class: 'lbl dim', style: 'color:var(--dim)' }, ['QUERY']),
          H('span', { class: 'mono' }, [it.q]), H('span', { class: 'chip', style: 'margin-left:auto' }, ['item ' + (i + 1)])]),
        H('div', { class: 'rb' }, [
          H('div', { class: 'xs dim', style: 'margin-bottom:4px' }, ['RESULT']), it.d,
          H('div', { style: 'margin-top:11px' }, [seg])
        ])
      ]));
    });
    host.appendChild(wrap);
    return function () { return { labels: Object.assign({}, sel) }; };
  }

  /* ---- honeypot ---- */
  function renderHoneypot(host, t, p) {
    var flag = false;
    var note = H('textarea', { rows: '3', placeholder: 'What conflicted, and with which clause. One or two lines is enough.' });
    var flagBtn = H('button', {
      class: 'btn bad', onclick: function () {
        flag = !flag;
        flagBtn.textContent = flag ? '\u2713 FLAG-GUIDELINE selected \u2014 send with note' : '\u2691 FLAG-GUIDELINE';
        flagBtn.className = 'btn ' + (flag ? 'ok' : 'bad');
      }
    }, ['\u2691 FLAG-GUIDELINE']);

    var kids = [
      H('div', { class: 'prompt', style: 'margin-bottom:12px;border-left-color:var(--warn)' }, [
        H('div', { class: 'up', style: 'margin-bottom:5px' }, ['Task body \u2014 from project owner']),
        H('div', { style: 'font-size:13.5px;font-family:var(--mono);color:#ffe8bd' }, [p.corrupted])
      ]),
      H('div', { class: 'up', style: 'margin:14px 0 8px' }, ['The pair'])
    ];
    p.items.forEach(function (r) {
      kids.push(H('div', { class: 'resp' }, [
        H('div', { class: 'rh' }, [H('span', { class: 'chip violet' }, [r.id])]),
        H('div', { class: 'rb' }, [r.text])
      ]));
    });
    kids.push(H('div', { class: 'hr' }));
    kids.push(H('div', { class: 'row between' }, [
      H('div', { style: 'flex:1;min-width:260px;margin-right:16px' }, [H('label', { class: 'f' }, ['Evidence note (only if flagging)']), note]),
      H('div', {}, [H('div', { class: 'up', style: 'margin-bottom:6px' }, ['Submit action']), flagBtn])
    ]));
    kids.push(H('p', { class: 'xs dim', style: 'margin-top:12px' },
      ['Read the task body against the guideline at the top of the page before you do anything.']));
    host.appendChild(H('div', {}, kids));
    return function () { return { flag: flag, note: note.value }; };
  }

  function renderFallback() { return function () { return {}; }; }

  /* ------------------------------------------------------------------ check / submit */
  function answered(a) {
    if (TASK.type === 'ranking') return (a.order || []).length === TASK.payload.responses.length;
    if (TASK.type === 'writing') return Tasks.wc(a.text) > 0;
    if (TASK.type === 'factcheck') return Object.keys(a.choices).length > 0;
    if (TASK.type === 'errorspot') return Object.keys(a).length > 0;
    if (TASK.type === 'code') return (a.lines || []).length > 0 || (a.fix || '').length > 0;
    if (TASK.type === 'redteam') return (a.text || '').length > 10;
    if (TASK.type === 'search') return Object.keys(a.labels).length > 0;
    if (TASK.type === 'honeypot') return true;
    return true;
  }

  function check() {
    var a = getAnswer();
    var n = 0;
    if (TASK.type === 'writing') n = Tasks.wc(a.text);
    if (TASK.type === 'factcheck') n = Object.keys(a.choices).length;
    if (TASK.type === 'search') n = Object.keys(a.labels).length;
    if (TASK.type === 'errorspot') n = Object.keys(a).length;
    if (TASK.type === 'code') n = (a.lines || []).length;
    if (TASK.type === 'redteam') n = Tasks.wc(a.text);
    App.toast(answered(a) ? 'Looks complete (' + (n ? n + (TASK.type === 'writing' ? ' words' : ' items') : 'no fields') + '). Rubric will score it on submit.' : 'Nothing to grade yet — the response field is empty.',
      answered(a) ? 'ok' : 'warn');
  }

  function submit(timedOut) {
    if (submitted) return;
    var ans = getAnswer();
    if (!answered(ans) && !timedOut) { App.toast('Response field is empty. In a real queue, an empty submit counts against you, it is not skipped.', 'warn'); }
    submitted = true;
    timer.stop();
    var seconds = Math.round((Date.now() - startAt) / 1000);
    var res = TASK.grade(ans, TASK);
    var passed = res.score >= 70;

    var integrity = [];
    if (pastes > 0) integrity.push('paste_into_response_field');
    if (seconds > 0 && seconds < TASK.minutes * 60 * 0.10 && res.score < 90) integrity.push('completed_in_' + seconds + 's');
    var flagKey = res.integrityFlagIfFailed || TASK.integrityFlagIfFailed;
    if (flagKey && res.score < 70) integrity.push(flagKey);
    integrity = integrity.concat(App.integrity());

    Store.record({ task: TASK.id, type: TASK.type, score: res.score, passed: passed, seconds: seconds, rate: RATE, integrity: integrity, timedOut: !!timedOut });
    integrity.forEach(function (f) { Store.flag(f, 'recorded on ' + TASK.id); });
    App.post('/api/submit', { page: 'task', kind: TASK.id, score: res.score, passed: passed, seconds: seconds });

    /* result section */
    var out = H('div', { style: 'margin-top:26px' });
    var vb = App.verdict(res, { seconds: seconds, rate: RATE });
    vb.style.marginBottom = '16px';
    out.appendChild(vb);
    if (integrity.length) out.appendChild(H('div', { class: 'alert bad' }, [
      H('span', { class: 'ic', html: '⚑' }),
      H('div', {}, [H('b', {}, ['Trust & Safety signals attached to this submission: ']), integrity.join(' · '),
        H('div', { class: 'xs', style: 'margin-top:5px' }, ['On a real platform these are silent — no email, no appeal link, and the balance in the current pay period is commonly held. ',
          'See <a href="trust-safety.html">the logbook workflow</a> that gets these reversed.'])])
    ]));
    out.appendChild(App.rubricBox(res));
    App.feedbackBox(res).forEach(function (n) { n.style.marginTop = '14px'; out.appendChild(n); });

    var eff = (seconds / 3600) * RATE;
    out.appendChild(H('div', { class: 'card', style: 'margin-top:14px' }, [
      H('div', { class: 'row between' }, [
        H('div', {}, [H('div', { class: 'up' }, ['Effective rate on this item']),
          H('div', { class: 'mono', style: 'font-size:20px' }, [App.money(eff) + ' / ' + App.mmss(seconds) + '  ·  ' + App.money(eff / Math.max(seconds, 1) * 3600 + '/hr')]),
          H('div', { class: 'xs dim' }, [passed ? 'Accepted. First-pass acceptance is what keeps the rework loop off your calendar.' : 'Rework means the same minutes twice at 70%. Re-run it and watch the effective rate change.'])]),
        wsActions()
      ])
    ]));
    root.appendChild(out);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var sb = document.getElementById('submit'); if (sb) { sb.disabled = true; sb.textContent = 'Graded'; }
  }

  function wsActions() {
    /* a clone replaces these two buttons; everything above them (grade, ledger, feedback) is shared */
    if (typeof window.__wsActions === 'function') return window.__wsActions(TASK, nextTaskId, H);
    return H('div', { class: 'row' }, [
      H('a', { class: 'btn ghost', href: 'task.html?id=' + TASK.id }, ['↻ Re-run this task']),
      H('a', { class: 'btn ok', href: nextTaskId() }, ['Next task →'])
    ]);
  }

  function nextTaskId() {
    var tail = PID ? '?p=' + PID : '';
    if (tail) return 'queue.html' + tail;
    return 'queue.html';
  }
  }
})(typeof window !== 'undefined' ? window : globalThis);
