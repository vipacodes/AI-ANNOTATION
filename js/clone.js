/* The clone renderer. Everything a "looks like the real product" page needs, driven by js/skins.js.
 *
 * Two rules this file exists to keep:
 *   1. The only thing that SCORES work is the same Tasks.grade() the paid workspace uses. A clone with its
 *      own grading is a second, worse product; a clone with the real grading is the same product wearing
 *      different clothes.
 *   2. Nothing here can earn money or move it. The payout view is deliberately the most honest part of the
 *      imitation: the balance is real arithmetic over your own graded work, and the button next to it says
 *      it does nothing, in the product's own typography. */
(function (root) {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); };
  var hms = function (sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + '<span class="u">h</span> ' + m + '<span class="u">m</span>';
    if (m) return m + '<span class="u">min</span> ' + s + '<span class="u">s</span>';
    return s + '<span class="u">sec</span>';
  };
  var icon = function (name) {
    var d = (root.Skins && root.Skins.ICON[name]) || '';
    return '<span class="cl-ic"><svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg></span>';
  };
  var ord = function (n) { return n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'); };
  /* fill('{rate}/hr', {rate:'$18.00'}) — skins are templates, so a new platform needs no code */
  var fill = function (tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? '—' : vars[k]; });
  };

  var QS = 'p=outlier';
  var S = null, PLAT = null, view = 'projects', openTask = null, t0 = 0, tick = null;

  function stats() {
    var st = root.Store.stats(), d = root.Store.get();
    var earned = 0, elapsed = 0, scores = [];
    (d.attempts || []).forEach(function (a) { earned += (a.rate || 0) * (a.seconds || 0) / 3600; elapsed += a.seconds || 0; if (typeof a.score === 'number') scores.push(a.score); });
    st.earnedLive = earned; st.elapsedLive = elapsed;
    st.avgLive = scores.length ? Math.round(scores.reduce(function (x, y) { return x + y; }, 0) / scores.length) : null;
    st.attempts = d.attempts || [];
    return st;
  }
  /* The rate the product shows for the project: the highest one on the board, which is what a real
     dashboard puts in the stat block. */
  function projectRate() {
    var best = 0;
    root.Tasks.list(true).forEach(function (t) { if (t.rate > best && !t.hidden) best = t.rate; });
    return best || 18;
  }

  function shell() {
    var el = document.getElementById('cl-app');
    var st = stats(), rate = projectRate();
    var head = '' +
      '<div class="cl-queuehint">' + fill(S.header.queueHint, { rank: ord(1) }) + '</div>' +
      '<header class="cl-head">' +
        '<div class="cl-logo"><span class="cl-mark">' + esc(S.brand.mark) + '</span><span>' + esc(S.brand.wordmark) + '</span>' +
          (S.brand.tagline ? '<span style="font-weight:400;font-size:12px;color:var(--cl-dim);margin-left:2px">' + esc(S.brand.tagline) + '</span>' : '') + '</div>' +
        '<nav class="cl-nav">' + S.header.nav.map(function (n) {
          var on = /earning|payment|finance|payout|withdraw|wallet/i.test(n) ? view === 'earnings'
            : /task|mission|board|assignment|work|job/i.test(n) ? view === 'work'
              : view === 'projects';
          return '<button data-nav="' + (on ? (view === 'earnings' ? 'earnings' : /task|mission|board|assignment|work|job/i.test(n) ? 'work' : 'projects') : 'projects') +
            '" aria-current="' + (on ? 'true' : 'false') + '">' + esc(n) + '</button>';
        }).join('') + '</nav>' +
        '<div class="cl-acct"><span>' + esc(S.header.account.label) + '</span><span class="cl-avatar">' + esc(S.header.account.initials) + '</span></div>' +
      '</header>';
    var notice = '<div class="cl-notice" style="margin:16px 0 0">' + icon('check') +
      '<div><b>Practice account.</b> ' + esc(S.practiceNotice) +
      ' <span class="cl-return"><a href="queue.html">' + esc(S.returnLabel) + '</a></span></div></div>';
    el.innerHTML = head + notice + '<main id="cl-view"></main>';
    Array.prototype.forEach.call(el.querySelectorAll('[data-nav]'), function (b) {
      b.onclick = function () { go(b.getAttribute('data-nav')); };
    });
  }

  function projectsView() {
    var st = stats(), rate = projectRate(), d = root.Tasks.list(true).filter(function (t) { return !t.hidden; });
    var done = st.attempts.filter(function (a) { return a.passed; }).length;
    var vars = {
      earned: money(st.earnedLive), done: done, elapsed: hms(st.elapsedLive),
      avg: st.avgLive === null ? '--' : st.avgLive + ' / 100',
      rate: '$' + rate.toFixed(2), est: d[0] ? d[0].minutes + ' <span class="u">m</span>' : '45 <span class="u">m</span>',
      assessment: done ? 'Passed' : 'Pending', skills: (d[0] && d[0].skills ? d[0].skills.join(', ') : 'Generalist')
    };
    var card = S.views.projects.card;
    var html = '' +
      '<div class="cl-card">' +
        '<div class="cl-stats">' + card.stats.map(function (s) {
          return '<div class="cl-stat">' + icon(s.icon) + '<div style="flex:1">' +
            '<div class="k">' + esc(s.k) + '</div><div class="v">' + fill(s.v, vars) + '</div>' +
            (s.sub ? '<div class="s">' + fill(s.sub, vars) + '</div>' : '') + '</div></div>';
        }).join('') + '</div>' +
      '</div>' +
      '<div class="cl-card">' +
        '<h2 class="cl-h">' + icon(card.overview.icon) + esc(card.overview.title) + '</h2>' +
        '<div class="cl-stats">' + card.overview.cols.map(function (c) {
          return '<div class="cl-stat"><div class="v">' + fill(c.v, vars) + '</div><div class="k">' + esc(c.k) +
            ' <i class="cl-info" title="' + esc(c.info || '') + '">i</i></div></div>';
        }).join('') + '</div><hr class="cl-hr"/>' +
        '<div class="cl-stats">' + card.links.map(function (l) {
          return '<div class="cl-stat"><div class="k">' + esc(l.k) + '</div><div class="v" style="font-size:15px;font-weight:650">' + fill(l.v, vars) + '</div></div>';
        }).join('') + '</div><hr class="cl-hr"/>' +
        '<div class="cl-links">' + card.actions.map(function (a, i) {
          return '<button class="cl-link" data-act="' + i + '"' + (a.disabled ? ' disabled title="' + esc(a.why) + '"' : '') + '>' +
            esc(a.t) + ' <span>›</span></button>';
        }).join('') + '</div>' +
      '</div>' +
      '<div class="cl-card">' +
        '<h2 class="cl-h">' + icon('grid') + esc(S.views.projects.title) + '</h2>' +
        '<p style="font-size:13px;color:var(--cl-dim);margin:-6px 0 12px;max-width:78ch">' + esc(S.views.projects.intro) + '</p>' +
        d.slice(0, 6).map(function (t) {
          return '<div class="cl-proj"><div><div class="t">' + esc(t.title) + '</div>' +
            '<div class="m">' + esc(t.project) + ' · ' + esc(t.id) + ' · ' + (t.skills || []).join(', ') + '</div></div>' +
            '<div style="display:flex;align-items:center;gap:14px">' +
              '<span class="cl-pill ' + (t.minutes <= 15 ? 'ok' : 'warn') + '">$' + t.rate.toFixed(2) + '/hr</span>' +
              '<span class="cl-pill">' + t.minutes + ' min cap</span>' +
              '<button class="cl-btn sm" data-open="' + esc(t.id) + '">' + esc(S.views.work.cta) + '</button>' +
            '</div></div>';
        }).join('') +
      '</div>';
    document.getElementById('cl-view').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (b) {
      b.onclick = function () { openTask = b.getAttribute('data-open'); go('work'); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      var a = card.actions[+b.getAttribute('data-act')];
      if (a && a.href) location.href = a.href;
    });
  }

  function workView() {
    var v = S.views.work, list = root.Tasks.list(true).filter(function (t) { return !t.hidden; });
    var t = openTask ? root.Tasks.get(openTask) : null;
    if (!t) {
      document.getElementById('cl-view').innerHTML = '<div class="cl-card"><h2 class="cl-h">' + icon('doc') + esc(v.title) + '</h2>' +
        '<div>' + v.columns.map(function (c) { return '<span class="cl-pill" style="margin:0 6px 8px 0">' + esc(c) + '</span>'; }).join('') + '</div>' +
        list.map(function (x) {
          var graded = stats().attempts.some(function (a) { return a.task === x.id && a.passed; });
          return '<div class="cl-proj"><div><div class="t">' + esc(x.title) + '</div><div class="m">' + esc(x.project) + ' · ' + esc(x.id) + '</div></div>' +
            '<div style="display:flex;align-items:center;gap:12px"><span class="cl-pill">' + (x.skills || []).slice(0, 2).join(', ') + '</span>' +
            '<span class="cl-pill ok">$' + x.rate.toFixed(2) + '/hr</span><span class="cl-pill">' + x.minutes + ' min</span>' +
            '<span class="cl-pill ' + (graded ? 'ok' : '') + '">' + (graded ? '✓ accepted' : 'ungraded') + '</span>' +
            '<button class="cl-btn sm" data-open="' + esc(x.id) + '">' + esc(v.cta) + '</button></div></div>';
        }).join('') + '</div>';
      Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (b) {
        b.onclick = function () { openTask = b.getAttribute('data-open'); go('work'); };
      });
      return;
    }
    cloneEditor(t);
  }

  /* The editor is the product's, and the work inside it is the trainer's: we hand the real
     Workspace builder a mount point inside our own chrome and turn its sidebar off. Everything that
     scores the work — rubric boxes, paste/typing telemetry, the honeypot, the ledger write — runs from
     js/workspace.js exactly as it does on task.html, because a clone that graded differently would be a
     second, quieter product teaching something else. */
  function cloneEditor(t) {
    var v = S.views.work;
    var back = '<div class="cl-card" style="padding:0;border:0;background:none;margin:0 0 4px">' +
      '<button class="cl-link" id="cl-back" style="font-size:13px">‹ ' + esc(v.title) + '</button></div>';
    document.getElementById('cl-view').innerHTML = back + '<div class="cl-card cl-scope" id="cl-ws"' +
      ' data-light="' + (isLight() ? '1' : '0') + '"></div>';
    document.getElementById('cl-back').onclick = function () { openTask = null; go('work'); };
    var host = document.getElementById('cl-ws');
    window.__wsChrome = false;              /* do not draw the trainer sidebar inside the imitation */
    window.__wsMount = function () { return host; };
    window.__wsActions = function (T, nextTaskId, H) {
      /* the re-run button keeps pointing at the trainer page: same task, same engine, plainly marked */
      var back = H('a', { class: 'btn ok', href: 'p.html?' + QS }, ['Back to ' + S.label + ' →']);
      back.onclick = function (ev) {
        if (!window.Clone) return;              /* no JS: plain link, which still works */
        ev.preventDefault();
        openTask = null; window.Clone.go('earnings');
      };
      return H('div', { class: 'row' }, [
        H('a', { class: 'btn ghost', href: 'task.html?id=' + T.id }, ['Open in the trainer']),
        back
      ]);
    };
    gateThen(function () {
      if (!document.getElementById('cl-ws')) return;   /* the learner moved on; do not resurrect the editor */
      try {
        if (!window.Workspace || !window.Workspace.build) throw new Error('workspace unavailable');
        window.Workspace.build();
      } catch (e) {
        host.innerHTML = '<p class="cl-count">The practice workspace could not start: ' + esc(e.message) +
          '. <a class="cl-link" href="task.html?id=' + esc(t.id) + '">Open the task directly</a>.</p>';
      }
      /* The hooks stay set for the life of the page. finish() — the post-grade result render — reads
         __wsActions minutes after build() returns, and clearing them on return handed the clone's own
         buttons back to the trainer default. The page never renders the trainer workspace, so a sticky
         hook is the correct contract; __wsMount is re-pointed at each new editor open anyway. */
    });
  }

  /* workspace.js draws nothing while the key is still being verified (App.locked() is true during the
     server round trip), so building too early produces a chrome-only shell with no task in it. Wait for the
     verdict, then build; if the verdict is slow but the page is already revealed, build anyway — the page is
     rendered, which is proof enough that this browser holds a key. */
  function gateThen(then) {
    var n = 0;
    (function poll() {
      var st = root.App && root.App.gateState ? root.App.gateState() : 'open';
      if (st === 'open' || st === 'local' || n++ > 130) { then(); return; }
      if (st === 'locked' && n > 130) {
        document.getElementById('cl-view').innerHTML =
          '<div class="cl-card cl-count">The key on this device was not accepted by the server, so the ' +
          'workspace is not drawn. <a class="cl-link" href="gate.html">Enter a key</a> or ' +
          '<a class="cl-link" href="buy.html">buy access</a>.</div>';
        return;
      }
      setTimeout(poll, 60);
    })();
  }

  /* DataAnnotation ships a white app; dark form fields inside a light theme read as a broken page. */
  function isLight() {
    var bg = (S.palette['--cl-bg'] || '#0a0d11').replace('#', '');
    var r = parseInt(bg.slice(0, 2), 16), g = parseInt(bg.slice(2, 4), 16), b = parseInt(bg.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 140;
  }

  function earningsView() {
    var v = S.views.earnings, st = stats();
    var vars = { earned: money(st.earnedLive), done: st.attempts.filter(function (a) { return a.passed; }).length,
      hours: (st.attempts.reduce(function (s, a) { return s + (a.seconds || 0); }, 0) / 3600).toFixed(2),
      unpaid: st.attempts.filter(function (a) { return !a.passed; }).length + ' items' };
    var rows = st.attempts.slice().reverse().map(function (a) {
      return '<div class="cl-proj" style="grid-template-columns:1fr auto auto auto auto">' +
        '<div><div class="t" style="font-size:14px">' + esc(a.task) + '</div><div class="m">' + esc(a.type || '') + '</div></div>' +
        '<span class="cl-pill">$' + (a.rate || 0).toFixed(2) + '/hr</span>' +
        '<span class="cl-pill">' + Math.round(a.seconds || 0) + 's</span>' +
        '<span class="cl-pill ok">' + money((a.rate || 0) * (a.seconds || 0) / 3600) + '</span>' +
        '<span class="cl-pill ' + (a.passed ? 'ok' : 'bad') + '">' + (a.passed ? 'accepted' : 'rework') + '</span></div>';
    }).join('') || '<p style="font-size:13px;color:var(--cl-dim)">Nothing graded yet. Open a task and the ledger fills as you go.</p>';
    document.getElementById('cl-view').innerHTML =
      '<div class="cl-card"><h2 class="cl-h">' + icon('wallet') + esc(v.title) + '</h2>' +
      '<div class="cl-stats">' + v.stats.map(function (s) {
        return '<div class="cl-stat"><div class="k">' + esc(s.k) + '</div><div class="v"' +
          (s.warn ? ' style="color:var(--cl-warn)"' : '') + '>' + fill(s.v, vars) + '</div></div>';
      }).join('') + '</div></div>' +
      '<div class="cl-card"><h2 class="cl-h">' + icon('bank') + esc(v.payout.heading) + '</h2>' +
      '<div class="cl-grid two"><div>' +
        '<div class="cl-stat"><div class="k">' + esc(v.payout.balance) + '</div><div class="v">' + money(st.earnedLive) + '</div>' +
        '<div class="s">' + v.payout.methods.map(function (m) { return '<span class="cl-pill" style="margin-right:6px">' + esc(m) + '</span>'; }).join('') + '</div></div>' +
        '<button class="cl-btn" style="margin-top:16px" disabled>' + esc(v.payout.disabledLabel) + '</button>' +
        '<p style="font-size:12.5px;color:var(--cl-dim);max-width:62ch;margin:14px 0 0">' + esc(v.payout.body) + '</p>' +
      '</div><div><div class="cl-notice">' + icon('check') +
        '<div><b>Why this button does nothing.</b> A real payout screen is where a platform asks for your ' +
        'bank, PayPal or wallet details. There is no account behind this one to attach, and a clone that ' +
        'asked for those details would be a phishing page, not a trainer.</div></div></div></div></div>' +
      '<div class="cl-card"><h2 class="cl-h">' + icon('doc') + 'Ledger</h2>' +
      '<div style="margin-bottom:8px">' + v.ledger.map(function (c) { return '<span class="cl-pill" style="margin-right:6px">' + esc(c) + '</span>'; }).join('') + '</div>' +
      rows + '</div>';
  }

  function go(to) {
    view = to;
    if (to !== 'work') openTask = to === 'projects' ? null : openTask;
    document.documentElement.className = 'cl-body';
    var sk = S.palette;
    Object.keys(sk).forEach(function (k) { document.documentElement.style.setProperty(k, sk[k]); });
    shell();
    if (view === 'work') workView(); else if (view === 'earnings') earningsView(); else projectsView();
  }

  root.Clone = {
    start: function (skinId) {
      S = root.Skins.get(skinId || 'outlier');
      QS = 'p=' + encodeURIComponent(S.id);
      PLAT = root.Platforms && root.Platforms.get && root.Platforms.get(S.platformId);
      var q = new URLSearchParams(location.search);
      /* the workspace reads ?id= like every other page does, so a clone link may use either name — and if it
         uses ?task= we rewrite the URL before workspace.js looks at it, so there is one param, not two. */
      if (q.get('task') && !q.get('id')) {
        openTask = q.get('task');
        q.set('id', q.get('task')); q.delete('task');
        try { history.replaceState({}, '', location.pathname + '?' + q.toString()); } catch (e) { }
      } else if (q.get('id')) openTask = q.get('id');
      var v = q.get('view'); if (v === 'work' || v === 'earnings') view = v;
      document.documentElement.className = 'cl-body';
      if (!document.getElementById('cl-app')) {
        var d = document.createElement('div'); d.className = 'cl-app'; d.id = 'cl-app';
        document.body.appendChild(d);
      }
      go(view);
      document.title = S.label + ' — ' + S.views[view === 'work' ? 'work' : view === 'earnings' ? 'earnings' : 'projects'].title;
    },
    /* used by the post-grade action row and by tests: change view without a page load */
    go: function (to) { if (to === 'work' || to === 'earnings' || to === 'projects') go(to); },
    view: function () { return view; },
    skin: function () { return S && S.id; },
    _views: function () { return view; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
