/* AnnotateTrainer — shared shell: nav, timers, verdict rendering, integrity checks. */
(function () {
  var NAV = [
    ['ONBOARDING', [
      ['onboarding.html', '◈', 'Qualification assessment', 'onboard'],
      ['queue.html', '▤', 'Task queue', 'tasks']
    ]],
    ['TOOLS', [
      ['detector.html', '⌖', 'AI-tells detector', ''],
      ['earnings.html', '$', 'Time & earnings', ''],
      ['trust-safety.html', '⚑', 'Trust & safety logbook', '']
    ]],
    ['LEARN', [
      ['platforms.html', '▦', 'Platform catalogue', ''],
      ['guide.html', '?', 'How real platforms work', ''],
      ['buy.html', '$', 'Access & keys', 'access']
    ]]
  ];

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k[0] === 'o' && k[1] === 'n') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  var APP = {
    h: h,
    esc: function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; },
    mmss: function (sec) {
      sec = Math.max(0, Math.round(sec));
      var m = Math.floor(sec / 60), s = sec % 60;
      return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    },
    money: function (n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); },

    banner: function () {
      var b = document.getElementById('app-banner');
      if (!b) return;
      b.className = 'banner';
      b.innerHTML = '<span class="tag">Trainer</span><span><b>Practice sandbox, not a job platform.</b> ' +
        'No client here pays you. Tasks, briefs and clients are fictional; the rubrics and the ' +
        'hazards are modelled on real ones. <a href="guide.html">How the real market works →</a></span>';
      document.body.insertBefore(b, document.body.firstChild);
    },

    shell: function (active) {
      var st = window.Store.stats();
      var side = h('aside', { class: 'side' }, [
        h('div', { class: 'brand' }, [
          h('span', { class: 'logo', html: 'A' }),
          h('div', {}, [h('div', {}, ['AnnotateTrainer']), h('small', {}, ['assessment simulator'])])
        ]),
        h('nav', { class: 'nav' }, NAV.map(function (grp) {
          return [h('div', { class: 'nav-h' }, [grp[0]])].concat(grp[1].map(function (n) {
            var isOn = n[0].indexOf(active) === 0;
            var pill = null;
            if (n[3] === 'tasks') pill = window.Tasks ? String(window.Tasks.list().length) : '';
            if (n[3] === 'onboard') pill = st.onboarding ? (st.onboarding.passed ? '✓ cleared' : 'retry') : 'start';
            return h('a', { href: n[0], class: isOn ? 'on' : '' }, [
              h('span', { class: 'ic', html: n[1] }), h('span', {}, [n[2]]),
              pill ? h('span', { class: 'pill', html: pill }) : null
            ]);
          }));
        }).reduce(function (a, b) { return a.concat(b); }, [])),
        h('div', { class: 'side-foot' }, [
          h('div', { class: 'row', style: 'gap:6px;margin-bottom:8px' }, [
            h('span', { class: 'chip ' + (st.qualityScore === null ? '' : st.qualityScore >= 85 ? 'ok' : st.qualityScore >= 65 ? 'warn' : 'bad') },
              ['QS ' + (st.qualityScore === null ? '—' : st.qualityScore)]),
            st.flags.length ? h('span', { class: 'chip bad' }, [st.flags.length + ' flag' + (st.flags.length > 1 ? 's' : '')]) : null
          ]),
          h('div', { class: 'xs' }, [st.tasks + ' graded · ' + st.paidHours.toFixed(2) + 'h billable'])
        ])
      ]);
      var shell = document.querySelector('.shell');
      if (shell) shell.insertBefore(side, shell.firstChild);
      return side;
    },

    toast: function (msg, kind) {
      var t = h('div', {
        class: 'chip ' + (kind || 'info'),
        style: 'position:fixed;right:20px;bottom:20px;z-index:99;padding:11px 15px;font-size:13px;' +
          'box-shadow:0 12px 40px rgba(0,0,0,.5);animation:rise .3s both;max-width:340px'
      }, [msg]);
      document.body.appendChild(t);
      setTimeout(function () { t.style.transition = '.4s'; t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, 3200);
      setTimeout(function () { t.remove(); }, 3800);
    },

    /* counts down; fires onExpire once */
    timer: function (opts) {
      var total = opts.seconds || 0, start = Date.now(), done = false, iv, api = {};
      function tick() {
        var left = total - (Date.now() - start) / 1000;
        if (left <= 0 && !done) { done = true; clearInterval(iv); opts.onExpire && opts.onExpire(); left = 0; }
        if (opts.el) {
          opts.el.textContent = APP.mmss(left);
          opts.el.classList.toggle('hot', left > 0 && left < total * 0.2);
        }
        if (opts.ring) opts.ring.style.width = (100 * left / total) + '%';
      }
      iv = setInterval(tick, 500); tick();
      api.elapsed = function () { return Math.round((Date.now() - start) / 1000); };
      api.stop = function () { clearInterval(iv); };
      api.done = function () { return done; };
      return api;
    },

    /* ---------- verdict / rubric rendering ---------- */
    verdict: function (res, opts) {
      opts = opts || {};
      var band = res.score >= 90 ? ['pass', 'ACCEPTED'] : res.score >= 70 ? ['warn', 'ACCEPTED W/ NOTES'] : ['fail', 'REWORK REQUIRED'];
      var box = h('div', { class: 'verdict ' + band[0] + ' reveal' }, [
        h('div', { class: 'row between', style: 'position:relative' }, [
          h('div', {}, [
            h('div', { class: 'up' }, [band[1]]),
            h('div', { class: 'score' }, [res.score + '/100'])
          ]),
          h('div', { style: 'text-align:right' }, [
            h('div', { class: 'up' }, ['Billable time']),
            h('div', { class: 'mono', style: 'font-size:19px' }, [APP.mmss(opts.seconds || 0)]),
            h('div', { class: 'xs dim' }, [opts.rate ? APP.money((opts.seconds / 3600) * opts.rate) + ' @ $' + opts.rate + '/hr' : '—'])
          ])
        ]),
        h('div', { class: 'bar', style: 'margin-top:14px' }, [
          h('i', { style: 'width:' + res.score + '%;' + (res.score >= 90 ? 'background:linear-gradient(90deg,#1fa86a,#39d98a)' : res.score >= 70 ? 'background:linear-gradient(90deg,#8a6620,#f5b13d)' : 'background:linear-gradient(90deg,#a3323e,#ff5f6d)') })
        ])
      ]);
      if (opts.mount) { opts.mount.innerHTML = ''; opts.mount.appendChild(box); }
      return box;
    },

    rubricBox: function (res) {
      var wrap = h('div', { class: 'panelbox reveal' }, [
        h('header', {}, [h('span', {}, ['Rubric breakdown']), h('span', { class: 'chip' }, [res.rubric.length + ' items'])]),
        h('div', { class: 'body', style: 'padding:0' }, res.rubric.map(function (r) {
          return h('div', { class: 'ri' }, [
            h('span', { class: 'b ' + r.ok, html: r.ok === 'y' ? '✓' : r.ok === 'p' ? '~' : '✕' }),
            h('div', {}, [
              h('div', { style: 'font-weight:600;margin-bottom:2px' }, [r.label]),
              h('div', { class: 'xs dim' }, [r.why])
            ]),
            h('span', { class: 'w' }, [r.pts !== undefined ? r.pts + '/' + r.w : ''])
          ]);
        }))
      ]);
      return wrap;
    },

    feedbackBox: function (res) {
      var kids = [];
      var good = [].concat(res.good || []).filter(function (x) { return x !== undefined && x !== null && x !== ''; });
      var impro = [].concat(res.improve || []).filter(function (x) { return x !== undefined && x !== null && x !== ''; });
      if (good.length) kids.push(h('div', { class: 'alert ok' }, [h('span', { class: 'ic', html: '\u2713' }),
        h('div', {}, good.map(function (g) { return h('div', {}, [String(g)]); }))]));
      if (impro.length) kids.push(h('div', { class: 'alert warn' }, [
        h('span', { class: 'ic', html: '!' }),
        h('div', {}, [h('b', {}, ['What the reviewer wrote back'])]
          .concat(impro.map(function (i) { return h('div', { style: 'margin-top:5px' }, [String(i)]); })))
      ]));
      if (res.gold) kids.push(h('div', { class: 'panelbox goldbox' }, [
        h('header', {}, [h('span', {}, ['Consensus / model answer']), h('span', { class: 'chip violet' }, ['revealed after submit'])]),
        h('div', { class: 'body', style: 'white-space:pre-wrap;font-size:13.5px;color:#c9d3e2' }, [String(res.gold)])
      ]));
      if (res.note) kids.push(h('p', { class: 'sm dim' }, [String(res.note)]));
      return kids;
    },

    /* ---------- integrity watch (the real reason this exists) ---------- */
    integrity: function () {
      var out = [];
      var perf = window.performance && performance.navigation ? performance.navigation.type : 0;
      /* DevTools heuristic — the same class of check platforms use, which is why
         screen-recorded sessions get flagged for innocuous reasons. */
      var wide = window.outerWidth - window.innerWidth > 160 || window.outerHeight - window.innerHeight > 170;
      if (wide) out.push('devtools_open');
      /* paste-heavy submission detection is done per-textarea in the task page */
      return out;
    },

    /* Detects copy-paste / auto-typing so the learner SEES why their paste got flagged. */
    watchInput: function (el, onFlag) {
      var pasted = 0, typed = 0, last = Date.now();
      el.addEventListener('paste', function () {
        pasted++;
        if (pasted >= 1 && onFlag) onFlag('paste_detected', 'Clipboard paste into a response field. ' +
          'On real platforms this is an automatic integrity flag even when the pasted text is your own writing.');
      });
      el.addEventListener('input', function () { typed++; last = Date.now(); });
      return { pasted: function () { return pasted; }, typed: function () { return typed; } };
    },

    /* optional server-side log; fails silently when opened as file:// */
    post: function (path, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', path, true);
        x.setRequestHeader('content-type', 'application/json');
        x.send(JSON.stringify(body));
      } catch (e) { /* offline mode */ }
    },
    get: function (path, cb) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', path, true);
        x.onload = function () { try { cb(JSON.parse(x.responseText)); } catch (e) { cb(null); } };
        x.onerror = function () { cb(null); };
        x.send();
      } catch (e) { cb(null); }
    }
  };

  /* ---------------- access gate bootstrap ----------------
     Runs at shell() time on pages marked <body data-gated>. Local check first (instant),
     then the server decides if there is one. Server mode is the only one that truly locks. */
  var LOCK = { state: 'open' };
  APP.locked = function () { return LOCK.state !== 'open'; };
  APP.gateState = function () { return LOCK.state; };

  APP.bootGate = function () {
    var body = document.body;
    if (!body || body.getAttribute('data-gated') === null) return;
    var A = window.Access;
    if (!A) return;
    var rootEl = document.documentElement;
    var hide = function () { body.classList.add('at-locked'); rootEl.setAttribute('data-prelock', '1'); };
    var show = function () {
      body.classList.remove('at-locked');
      // ONE mechanism, one place to lift it. The previous version kept a class in CSS, a rule in CSS and a
      // <style> written by a head script, and a fix that removed two of the three still showed a blank
      // page — which is precisely why the whole thing is now an attribute a test can read.
      rootEl.removeAttribute('data-prelock');
      var l = document.getElementById('at-lock'); if (l && l.parentNode) l.parentNode.removeChild(l);
    };
    hide();
    LOCK.state = 'checking';
    if (!A.key()) { LOCK.state = 'locked';   /* .shell stays hidden; the lock overlay below is the way in */
      return lock('You need an access key for the practice platform.', false); }
    A.check(function (ok, info) {
      if (ok) {
        show();
        LOCK.state = (info && info.mode === 'local') ? 'local' : 'open';
        if (info && info.mode === 'local') soft();
        return;
      }
      LOCK.state = 'locked';
      lock(info && info.reason === 'malformed key'
        ? 'The stored key is not valid for this copy.'
        : 'Your key was not accepted (' + ((info && info.reason) || 'no session') + ').', true);
    });

    function soft() {
      var d = document.createElement('div');
      d.className = 'softbar';
      d.innerHTML = '<b>Local mode.</b> You unlocked this copy from browser storage, so nothing here is actually ' +
        'server-enforced \u2014 the paywall only holds when the site is served by <code>server.js</code> or the Cloudflare ' +
        'function. <a href="DEPLOY.md" style="color:#ffd27a">How the lock works →</a>';
      body.insertBefore(d, body.firstChild);
    }

    function lock(msg, retry) {
      var d = document.createElement('div');
      d.id = 'at-lock';
      d.style.cssText = 'position:fixed;inset:0;z-index:998;background:#0b0d12;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center';
      d.innerHTML = '<div style="max-width:460px"><div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6d7c92;font-weight:700">Locked</div>' +
        '<h2 style="font-size:21px;margin:8px 0 10px">' + msg + '</h2>' +
        '<p style="color:#93a0b4;font-size:13.5px;margin:0 0 18px">The assessment, queue, tasks and tools sit behind the key. ' +
        'The platform catalogue and the guide stay open.</p>' +
        '<a class="btn" style="background:#6a5bf0;color:#fff;border:1px solid #7f70ff;padding:10px 16px;border-radius:9px;display:inline-block;text-decoration:none;font-weight:650" href="gate.html">Enter my key</a> ' +
        '<a href="buy.html" style="color:#8b7cff;font-size:13.5px;margin-left:12px">Buy access</a>' +
        (retry ? '<div class="xs dim" style="margin-top:14px">Just paid? Reload this page \u2014 the key lives in a cookie, not in this tab.</div>' : '') +
        '</div>';
      document.body.appendChild(d);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', APP.bootGate);
  else APP.bootGate();

  window.App = APP;
})();
