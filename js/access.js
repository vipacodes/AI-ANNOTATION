/*
  AnnotateTrainer — paid-access gate.

  TWO MODES, and the difference matters if you are selling this:

  1. SERVER MODE (enforced). When the site is served by server.js — or a Cloudflare Pages
     Function / any edge middleware — the server refuses to send the page and script bodies
     without a valid key cookie. This actually gates content.

  2. LOCAL MODE (not enforced). Opening index.html straight from disk has no server, so the
     gate here only checks the key's *shape* in the browser. That is a soft lock: anyone who
     reads the source can bypass it. Do not sell access with local mode. See DEPLOY.md.

  Keys are issued by tools/keygen.js: "<id>.<hmac>", so the server can verify a key from a
  shared secret alone and only needs to remember the ones you revoke.
*/
(function () {
  var KEY = 'annotatetrainer:key';
  var CLAIM = 'annotatetrainer:claim';
  var RE = /^[A-Za-z0-9]{6,10}\.[A-Za-z0-9_\-]{20,}\.([0-9]{10,13})$/;
  /* Where the API lives, derived rather than assumed. '/unlock' is a 404 under a sub-path mount — the
     Supabase function serves the site from /functions/v1/annotate/, and a root-absolute fetch there lands
     on the project root. Every page of this site sits at the mount root, so stripping the filename from
     location.pathname is exact for all of them, needs no config, and changes nothing at '/'. */
  var BASE = String(location.pathname || '/').replace(/[^/]*$/, '');

  function hasShape(k) { return RE.test(String(k || '').trim()); }

  var A = {
    key: function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    /* cheap local check: right shape + not expired. NOT a security decision — the server decides. */
    looksValid: function (k) {
      k = k === undefined ? this.key() : k;
      if (!hasShape(k)) return false;
      return Number(String(k).split('.')[2]) >= Date.now();
    },
    claim: function () { try { return JSON.parse(localStorage.getItem(CLAIM) || 'null'); } catch (e) { return null; } },
    set: function (k, c) {
      try {
        localStorage.setItem(KEY, k);
        // Mirror for the pre-paint head script, which runs before this file exists and can only read a
        // fixed key name. Same value, same 3-part shape, so the two checks cannot disagree.
        try { localStorage.setItem('at_key', k); } catch (e) { }
        localStorage.setItem(CLAIM, JSON.stringify(c || { label: 'local', until: null }));
      } catch (e) { }
    },
    clear: function () { try { localStorage.removeItem(KEY); localStorage.removeItem(CLAIM); localStorage.removeItem('at_key'); } catch (e) { } },

    /* is the visitor allowed in? cb(bool, info) */
    check: function (cb) {
      var k = A.key();
      if (!k) return cb(false, { reason: 'no key' });
      if (!hasShape(k)) return cb(false, { reason: 'malformed key' });
      // ask the server, if there is one
      var x = new XMLHttpRequest();
      x.open('GET', BASE + 'session', true);
      x.withCredentials = true;
      x.timeout = 2500;
      x.onload = function () {
        if (x.status === 200) {
          try { var j = JSON.parse(x.responseText); A.set(k, j); return cb(true, { mode: 'server', claim: j }); }
          catch (e) { return cb(false, { reason: 'session unreadable' }); }
        }
        if (x.status === 402 || x.status === 401) return cb(false, { reason: 'key rejected or expired', mode: 'server' });
        return cb(false, { reason: 'unexpected status ' + x.status });
      };
      x.ontimeout = x.onerror = function () {
        // no server -> soft local mode. Clearly labelled in the UI.
        cb(true, { mode: 'local', claim: A.claim() || { label: 'offline unlock', until: null } });
      };
      try { x.send(); } catch (e) { cb(true, { mode: 'local', claim: null }); }
    },

    /* submit a key. cb(ok, message) */
    unlock: function (k, cb) {
      k = String(k || '').trim();
      if (!hasShape(k)) return cb(false, 'That key is not in the right shape. Keys look like XXXXX-yyyyyy-1700000000000 (issued by tools/keygen.js).');
      var body = JSON.stringify({ key: k });
      var x = new XMLHttpRequest();
      x.open('POST', BASE + 'unlock', true);
      x.setRequestHeader('content-type', 'application/json');
      x.setRequestHeader('x-test-key', k);   /* harmless; lets a headless test see which key went out */
      x.timeout = 3000;
      x.onload = function () {
        if (x.status === 200) {
          var c = {}; try { c = JSON.parse(x.responseText); } catch (e) { }
          A.set(k, c); return cb(true, 'Accepted' + (c.label ? ' \u2014 ' + c.label : '') + (c.until ? ', valid until ' + c.until : '.'));
        }
        var msg = 'Key rejected.';
        try { msg = JSON.parse(x.responseText).error || msg; } catch (e) { }
        A.clear(); cb(false, msg);
      };
      x.ontimeout = x.onerror = function () {
        // file:// demo path
        A.set(k, { label: 'offline demo unlock', until: null, soft: true });
        cb(true, 'Accepted in LOCAL mode. There is no server here, so this does not actually lock anything \u2014 see DEPLOY.md.');
      };
      try { x.send(body); } catch (e) { cb(false, 'Could not reach the server.'); }
    },

    /* Draws the lock screen over the page. Called by protected pages. */
    gate: function () {
      var overlay = document.createElement('div');
      overlay.id = 'at-gate';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(8,10,14,.96);' +
        'display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
      overlay.innerHTML =
        '<div style="max-width:520px;width:100%;background:#141922;border:1px solid #232b39;border-radius:14px;padding:28px">' +
        '<div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6d7c92;font-weight:700">Locked</div>' +
        '<h2 style="margin:6px 0 8px;font-size:21px">This practice platform is paid-access</h2>' +
        '<p style="color:#93a0b4;font-size:13.5px;margin:0 0 18px">Enter the key you were given after purchase. ' +
        'No key? <a href="buy.html" style="color:#8b7cff">See how to get access</a>.</p>' +
        '<div style="display:flex;gap:8px"><input id="at-key" placeholder="XXXXXX-yyyyyyyy-yyyyyyyyyyyyyy" ' +
        'style="flex:1;background:#0e131c;border:1px solid #2e3848;color:#e7ecf3;border-radius:9px;padding:11px 13px;font-family:ui-monospace,monospace;font-size:13px">' +
        '<button id="at-go" style="background:#6a5bf0;border:1px solid #7f70ff;color:#fff;border-radius:9px;padding:11px 17px;font-weight:700;cursor:pointer;font-size:13.5px">Unlock</button></div>' +
        '<div id="at-msg" style="font-size:12.5px;margin-top:12px;min-height:18px;color:#93a0b4"></div>' +
        '<div style="border-top:1px solid #232b39;margin-top:18px;padding-top:14px;font-size:11.5px;color:#6d7c92">' +
        'AnnotateTrainer is a study tool. It is not affiliated with, or endorsed by, any AI-training platform, ' +
        'and it cannot get you hired by one.</div></div>';
      document.body.appendChild(overlay);
      var go = function () {
        var msg = document.getElementById('at-msg');
        msg.textContent = 'checking\u2026'; msg.style.color = '#93a0b4';
        A.unlock(document.getElementById('at-key').value, function (ok, m) {
          msg.textContent = m; msg.style.color = ok ? '#39d98a' : '#ff5f6d';
          if (ok) setTimeout(function () { location.reload(); }, 900);
        });
      };
      document.getElementById('at-go').onclick = go;
      document.getElementById('at-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      return overlay;
    },

    /* Wrap a page: run fn when allowed, otherwise show the lock. */
    require: function (fn) {
      A.check(function (ok, info) {
        if (ok) {
          if (info && info.mode === 'local') {
            var n = document.createElement('div');
            n.className = 'banner';
            n.innerHTML = '<span class="tag" style="background:var(--warn);color:#1b1400">Soft lock</span>' +
              '<span>Served from disk \u2014 the key is checked in the browser only, so this does not really gate the files. ' +
              'Run the server or deploy behind the middleware in <b>DEPLOY.md</b> before you charge for it.</span>';
            document.body.insertBefore(n, document.body.children[0]);
          }
          return fn(info);
        }
        A.gate();
        fn(null, info);
      });
    }
  };

  window.Access = A;
})();
