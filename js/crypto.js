/* Pay-once-by-Litecoin, client side. Free to load — it is the page a buyer sees BEFORE they have
   paid, so it can never reveal anything that belongs behind the gate, and it holds no secret: an
   order is only ever readable with the 128-bit token the server handed to this browser, which we
   keep in sessionStorage AND in the URL fragment so a reload or a lost tab is not a lost order.

   Everything authoritative happens on the server (/crypto/quote, /crypto/status, /crypto/claim).
   What is here is a countdown, a status line, a copy button and a QR — convenience, not control. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var go = $('ltc-go'), box = $('ltc-box'), planSel = $('ltc-plan'), emailIn = $('ltc-email');
  if (!go || !box) return;                                   // page without the crypto panel

  /* Root-absolute URLs only work where the site is mounted at '/'. This site is also served from
     /functions/v1/annotate/, where '/crypto/quote' lands on the Supabase project root and answers 404 —
     so the pay panel looked wired-up and silently did nothing there. One derivation from the page's own
     path, correct at the root AND under a mount, with no config and no build step. */
  var apiBase = String(location.pathname || '/').replace(/[^/]*$/, '');
  function at(u) { return apiBase + String(u).replace(/^\/+/, ''); }

  var STORE = 'at.crypto';
  var poll = null, deadline = 0;

  /* An order is only as good as its quote token, and the token is only ever sent to the issuer of
     THIS page. Persisting it is what makes "close the tab, come back, still get your key" work, so
     the URL fragment is written deliberately: a buyer who bookmarks the page keeps their order.
     Keep it out of the query string, though — those get logged by proxies and pasted into chats. */
  function save(q) {
    try { sessionStorage.setItem(STORE, JSON.stringify(q)); } catch (e) { }
    try { history.replaceState(null, '', '#ltc=' + q.id + '.' + q.token); } catch (e) { }
  }
  function load() {
    var m = /[#&]ltc=([A-Za-z0-9]{1,16})\.([A-Za-z0-9-]{8,64})/.exec(location.hash || '');
    if (m) return { id: m[1], token: m[2] };
    try { return JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch (e) { return null; }
  }
  function clear() {
    try { sessionStorage.removeItem(STORE); } catch (e) { }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  }

  function api(route, body) {
    // Every call resolves to {code, j}: a body that is not JSON (a proxy's 502 page, an HTML error
    // from a CDN) is turned into an error the UI can show, because fetch only rejects on a network
    // failure and a buyer staring at a silent box is the outcome being avoided.
    return fetch(at(route), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().then(
          function (j) { return { code: r.status, j: j }; },
          function () { return { code: r.status, j: { error: 'The server answered with something that was not JSON (' + r.status + ').' } }; }
        );
      });
  }

  function line(txt, kind) {
    var st = $('ltc-status');
    if (!st) return;
    st.textContent = txt;
    st.style.color = kind === 'ok' ? 'var(--good, #2f9e63)' : kind === 'bad' ? 'var(--bad, #c0392b)' : 'var(--dim)';
  }

  function fmt(sats) { return (sats / 1e8).toFixed(8); }

  function renderQuote(q) {
    box.style.display = 'block';
    $('ltc-amount').textContent = q.amount + ' LTC';
    var approx = q.currency === 'NGN'
      ? '\u2248 \u20a6' + Number(q.price).toLocaleString() + ' at ' + Number(q.rates.ltc_usd).toFixed(2) + ' USD/LTC \u00d7 ' + Number(q.rates.ngn_usd).toFixed(0)
      : '\u2248 $' + Number(q.price).toLocaleString() + ' at ' + Number(q.rates.ltc_usd).toFixed(2) + ' USD/LTC';
    $('ltc-approx').textContent = approx + ' \u00b7 quoted ' + (q.rates.at || '').slice(0, 16).replace('T', ' ') + ' UTC';
    $('ltc-addr').textContent = q.address;
    $('ltc-uri').href = q.pay;
    $('ltc-order').textContent = 'Order ' + q.id + ' \u00b7 watermark ' + q.dust_litoshi + ' litoshi \u00b7 ' + q.min_confs + ' confirmations needed';
    // No QR is drawn. A real one needs a byte-mode encoder with Reed-Solomon error correction, and a
    // half-right QR code is worse than none: it scans, looks valid, and can encode the WRONG amount
    // for a payment the buyer cannot reverse. So the box carries the machine-readable part as text
    // and the wallet link does the rest. Drop a local js/qrcode.js in and window.QR is used instead.
    var qr = $('ltc-qr');
    if (qr) {
      if (window.QR && window.QR.render) qr.innerHTML = window.QR.render(q.pay, 200) || fallbackQr(q);
      else qr.innerHTML = fallbackQr(q);
    }
    deadline = Date.now() + q.expires_in * 1000;
    // An amount is only "exact" if the buyer can paste it without transcription error, so both the
    // number and the address travel together in one clipboard write.
    var cp = $('ltc-copy');
    if (cp) cp.onclick = function () {
      var txt = q.amount + ' LTC\n' + q.address;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { cp.textContent = 'Copied \u2014 send exactly that'; },
        function () { cp.textContent = 'Copy failed; select the text'; });
      else cp.textContent = 'No clipboard access; select the text';
    };
    line('Watching the chain for ' + q.amount + ' LTC to this address\u2026');
    startPolling(q);
  }

  function renderPaid(v) {
    stopPolling();
    var out = $('ltc-out');
    var r = v.receipt || {};   // a paid verdict may legitimately have no receipt (double-poll path): the key is what matters, so degrade to that alone
    // The receipt is rendered rather than emailed: an email needs an account, a SPF record and a
    // deliverability reputation, none of which a solo seller should be debugging at 11pm. What the
    // buyer needs is the key and the proof, both of which they can send to themselves in a click.
    out.innerHTML = '<div class="alert" style="margin-top:16px;border-color:var(--good,#2f9e63)"><span class="ic">\u2713</span><div>' +
      '<b>Paid, and you are in.</b> Your access key is below; keep it, it is the only credential.' +
      '<div class="mono" style="font-size:13px;margin:10px 0;word-break:break-all;padding:8px 10px;background:var(--bg);border-radius:6px">' + v.key + '</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn" href="gate.html">Unlock now</a>' +
      '<button class="btn ghost" id="ltc-receipt">Copy receipt</button>' +
      '<button class="btn ghost" id="ltc-forget">Done \u2014 clear this order</button></div>' +
      '<div class="dim" style="font-size:11.5px;margin-top:10px">' +
      (r.amount_ltc ? 'Received <span class="mono">' + Number(r.amount_ltc).toFixed(8) + ' LTC</span> \u00b7 ' : '') +
      (r.txid ? 'confirmed in tx <span class="mono">' + String(r.txid).slice(0, 16) + '\u2026</span> \u00b7 ' : '') +
      (r.confirmations != null ? r.confirmations + ' confirmations \u00b7 ' : '') +
      (r.paid_at ? 'received ' + String(r.paid_at).slice(0, 16).replace('T', ' ') + ' UTC' : '') +
      (r.until ? ' \u00b7 access until ' + String(r.until).slice(0, 10) : v.until ? ' \u00b7 access until ' + String(v.until).slice(0, 10) : '') +
      '</div></div></div>';
    var rc = $('ltc-receipt');
    if (rc) rc.onclick = function () {
      var txt = 'AnnotateTrainer \u2014 payment receipt\n\nPlan: ' + (r.plan || '') +
        '\nPaid: ' + (r.amount_ltc || '') + ' LTC\nTransaction: ' + (r.txid || '') +
        '\nConfirmations: ' + (r.confirmations || '') + '\nReceived: ' + (r.paid_at || '') +
        '\nAccess until: ' + (r.until || '') + '\n\nYour access key:\n' + v.key + '\n\nPaste it on the unlock page.';
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { rc.textContent = 'Copied'; });
    };
    var fg = $('ltc-forget');
    if (fg) fg.onclick = function () { clear(); box.style.display = 'none'; out.innerHTML = ''; };
    line('Access granted.', 'ok');
  }

  function fallbackQr(q) {
    return '<div style="width:100%"><div class="mono" style="font-size:15px;color:var(--violet)">' + q.amount + ' LTC</div>' +
      '<div class="mono" style="font-size:8px;word-break:break-all;margin-top:8px;opacity:.85">' + q.address + '</div>' +
      '<div class="mono" style="font-size:7px;word-break:break-all;margin-top:6px;opacity:.5">' + q.id + '.' + q.token.slice(0, 6) + '\u2026</div>' +
      '<div class="dim" style="margin-top:8px;font-size:10.5px">On a phone: use “Open in wallet”. On a desktop: copy both.</div></div>';
  }

  function tick() {
    var e = $('ltc-expiry');
    if (!e) return;
    var left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    e.textContent = left > 0 ? 'quote holds for ' + Math.floor(left / 60) + 'm ' + (left % 60) + 's' : 'quote expired \u2014 request a new amount';
    e.style.color = left > 120 ? 'var(--dim)' : 'var(--bad,#c0392b)';
  }

  function stopPolling() { if (poll) { clearInterval(poll); poll = null; } }
  function startPolling(q) {
    stopPolling();
    var probe = function () {
      api('/crypto/status', { id: q.id, token: q.token }).then(function (r) {
        if (r.code === 404) { stopPolling(); line((r.j && r.j.error) || 'This order is closed.', 'bad'); return; }
        var v = r.j || {};
        if (v.status === 'paid') { renderPaid(v); return; }
        if (v.status === 'seen') line('Seen on the chain \u2014 ' + v.confirmations + ' of ' + v.min_confs + ' confirmations. Keep this page open.', 'ok');
        else if (v.note) line('Watching the chain\u2026 ' + v.note);
        else line('Watching the chain for ' + fmt(v.expected_litoshi || 0) + ' LTC\u2026');
      });
    };
    poll = setInterval(probe, 7000);        // the server caches the explorer read; this costs ~1 call/minute
    tick();
    setInterval(tick, 1000);
    var rf = $('ltc-refresh');
    if (rf) rf.onclick = probe;
  }

  go.onclick = function () {
    go.disabled = true; go.textContent = 'Pricing\u2026';
    api('/crypto/quote', { plan: planSel.value, email: (emailIn && emailIn.value || '').trim() }).then(function (r) {
      go.disabled = false; go.textContent = 'Get a Litecoin amount';
      if (r.code !== 200) { box.style.display = 'block'; line((r.j && r.j.error) || 'Could not open an order.', 'bad'); return; }
      save(r.j); renderQuote(r.j);
    });
  };
  var claim = $('ltc-claim');
  if (claim) claim.onclick = function () {
    var q = load();
    if (!q || !q.id) { line('I do not have an order in this browser to attach that txid to. Get an amount first.', 'bad'); return; }
    claim.disabled = true;
    api('/crypto/claim', { id: q.id, token: q.token, txid: ($('ltc-txid').value || '').trim() }).then(function (r) {
      claim.disabled = false;
      if (r.code === 200 && r.j.status === 'paid') { renderPaid(r.j); return; }
      if (r.code === 200 && r.j.status === 'seen') { line('Matched \u2014 ' + r.j.confirmations + ' of ' + r.j.min_confs + ' confirmations. It will unlock itself.', 'ok'); return; }
      line((r.j && r.j.error) || 'That transaction did not match this order.', 'bad');
    });
  };
  var existing = load();
  if (existing && existing.id && existing.token) {
    // Re-attaching to a known order is not a payment and must not look like one, so the amount is
    // re-read from the server rather than trusted from what we wrote in the fragment.
    api('/crypto/status', { id: existing.id, token: existing.token }).then(function (r) {
      if (r.code !== 200) { clear(); return; }
      if (r.j.status === 'paid') { box.style.display = 'block'; renderQuoteFrom(r.j, existing); return; }
      resume(r.j, existing);
    });
  }
  function renderQuoteFrom(v, q) { renderPaid(v); void q; }
  function resume(v, q) {
    box.style.display = 'block';
    $('ltc-addr').textContent = v.address || '';
    $('ltc-amount').textContent = v.amount ? v.amount + ' LTC' : '';
    deadline = v.expires_at ? new Date(v.expires_at).getTime() : Date.now() + 600000;
    line('Re-attached to order ' + q.id + '.');
    if (v.status === 'paid') { renderPaid(v); return; }
    startPolling(q);
    if (v.status === 'seen') line('Seen on the chain \u2014 ' + v.confirmations + ' of ' + v.min_confs + ' confirmations.');
  }
})();
