/* AnnotateTrainer — local ledger. No network. localStorage-backed. */
(function () {
  var KEY = 'annotatetrainer:v1';

  var blank = function () {
    return {
      version: 1,
      profile: null,                 // {name, country, field, rate, languages, createdAt}
      onboard: null,                 // {score, passed, minutes, answers, at}
      attempts: [],                  // {id, task, score, passed, seconds, integrity[], at}
      flags: [],                     // {code, at, detail}
      time: { assessment: 0, training: 0, paid: 0 },   // seconds
      log: []                        // {t, msg}
    };
  };

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var d = JSON.parse(raw);
      var b = blank();
      Object.keys(b).forEach(function (k) { if (d[k] === undefined) d[k] = b[k]; });
      return d;
    } catch (e) { return blank(); }
  }

  function save(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* file:// quota */ }
    return d;
  }

  var S = {
    get: load,
    reset: function () { return save(blank()); },

    setProfile: function (p) { var d = load(); d.profile = p; return save(d); },

    setOnboard: function (o) { var d = load(); d.onboard = o; return save(d); },

    /* record a task attempt + its graded result */
    record: function (rec) {
      var d = load();
      rec.at = Date.now();
      rec.id = 'AT-' + Date.now().toString(36).toUpperCase().slice(-6);
      d.attempts.push(rec);
      if (d.attempts.length > 400) d.attempts = d.attempts.slice(-400);
      d.time.paid += (rec.seconds || 0);
      d.log.push({ t: Date.now(), msg: rec.task + ' → ' + rec.score + '/100 ' + (rec.passed ? 'ACCEPTED' : 'REWORK') });
      d.log = d.log.slice(-160);
      save(d);
      return rec;
    },

    addTime: function (bucket, seconds) {
      var d = load(); d.time[bucket] = (d.time[bucket] || 0) + seconds; return save(d);
    },

    flag: function (code, detail) {
      var d = load();
      d.flags.push({ code: code, detail: detail || '', at: Date.now() });
      d.log.push({ t: Date.now(), msg: '⚑ TRUST & SAFETY flag: ' + code });
      d.log = d.log.slice(-160);
      return save(d);
    },
    clearFlags: function () { var d = load(); d.flags = []; return save(d); },

    log: function (msg) {
      var d = load();
      d.log.push({ t: Date.now(), msg: msg });
      d.log = d.log.slice(-160);
      return save(d);
    },

    /* ---- derived numbers used across the UI ---- */
    stats: function () {
      var d = load();
      var a = d.attempts, n = a.length;
      var avg = n ? Math.round(a.reduce(function (s, x) { return s + x.score; }, 0) / n) : null;
      var acc = n ? Math.round(100 * a.filter(function (x) { return x.passed; }).length / n) : null;
      var qscore = avg === null ? null : Math.max(0, Math.min(100, Math.round(avg * (0.6 + 0.4 * (acc / 100)))));
      var paidH = (d.time.paid || 0) / 3600;
      var unpaidH = ((d.time.assessment || 0) + (d.time.training || 0)) / 3600;
      var rate = d.profile && d.profile.rate ? d.profile.rate : 0;
      return {
        tasks: n,
        avgScore: avg,
        acceptance: acc,
        qualityScore: qscore,
        paidHours: paidH,
        unpaidHours: unpaidH,
        earned: paidH * rate,
        unpaidValue: unpaidH * rate,
        flags: d.flags.length,
        cleared: a.filter(function (x) { return x.integrity && x.integrity.length === 0; }).length,
        onboarding: d.onboard,
        profile: d.profile
      };
    },

    /* per-day buckets for the earnings chart */
    byDay: function (days) {
      days = days || 7;
      var d = load(), out = [], now = new Date();
      for (var i = days - 1; i >= 0; i--) {
        var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        var start = day.getTime(), end = start + 864e5;
        var secs = d.attempts.filter(function (a) { return a.at >= start && a.at < end; })
          .reduce(function (s, a) { return s + (a.seconds || 0); }, 0);
        var paid = d.attempts.filter(function (a) { return a.at >= start && a.at < end && a.passed; })
          .reduce(function (s, a) { return s + (a.seconds || 0) / 3600 * ((a.rate) || 0); }, 0);
        out.push({ label: day.toLocaleDateString(undefined, { weekday: 'short' }), seconds: secs, usd: paid, date: day });
      }
      return out;
    }
  };

  window.Store = S;
})();
