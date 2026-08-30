/*
  AnnotateTrainer — inline workspace mockups.

  Deliberately DRAWN, not screenshotted. Each one is a hand-built reconstruction of the shape of
  a real workspace (what panels exist, what the timer does, where the guideline lives) so a
  learner recognises the layout when they see the real thing. They are labelled as reconstructions
  in the UI. I am not embedding proprietary screenshots, logos or brand marks, and you should not
  either: the honest version of "show them what it looks like" is a diagram of the workflow plus a
  link to the vendor's own public material.

  Videos: same rule. Embed the vendor's own public video (see the `media` slot on the platform page)
  or record and publish your own screencast. Anything you scrape and rehost is copyright the vendor
  owns, and rehosting it is how a teaching project turns into a takedown.
*/
(function () {
  var HEAD = '<defs><style>' +
    '@keyframes atPulse{0%,100%{opacity:.25}50%{opacity:1}}' +
    '@keyframes atSlide{0%{transform:translateX(-8px)}50%{transform:translateX(0)}100%{transform:translateX(8px)}}' +
    '@keyframes atBar{0%{width:6%}70%{width:82%}100%{width:82%}}' +
    '@keyframes atBlink{50%{opacity:.35}}' +
    '@keyframes atIn{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}' +
    '.p{animation:atPulse 2s infinite}.s{animation:atSlide 3.4s ease-in-out infinite alternate}' +
    '.b{animation:atBar 6s ease-out infinite}.k{animation:atBlink 1.4s steps(2) infinite}' +
    '.i{animation:atIn .7s cubic-bezier(.2,.8,.2,1) both}' +
    'text{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}</style></defs>';

  function frame(title, accent, body, foot) {
    return '<svg viewBox="0 0 660 400" role="img" aria-label="' + title + '" style="width:100%;height:auto;display:block;border-radius:12px;border:1px solid #232b39">' +
      HEAD +
      '<rect width="660" height="400" fill="#0e1219"/>' +
      '<rect width="660" height="30" fill="#151b25"/><circle cx="16" cy="15" r="4.5" fill="#ff5f6d"/>' +
      '<circle cx="32" cy="15" r="4.5" fill="#f5b13d"/><circle cx="48" cy="15" r="4.5" fill="#39d98a"/>' +
      '<text x="68" y="19" fill="#93a0b4" font-size="11">' + title + '</text>' +
      '<rect x="560" y="8" width="88" height="15" rx="7" fill="' + accent + '22" stroke="' + accent + '55"/>' +
      '<text x="604" y="19" fill="' + accent + '" font-size="9.5" text-anchor="middle" font-weight="700">ILLUSTRATIVE</text>' +
      body + (foot || '') + '</svg>';
  }
  function panel(x, y, w, h, label) {
    return '<g class="i"><rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="9" fill="#141a24" stroke="#232b39"/>' +
      (label ? '<text x="' + (x + 11) + '" y="' + (y + 18) + '" fill="#6d7c92" font-size="9.5" font-weight="700" letter-spacing="1">' + label + '</text>' : '') + '</g>';
  }
  function line(x, y, w, c, o) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="7" rx="3.5" fill="' + (c || '#2a3444') + '" opacity="' + (o || 1) + '"/>'; }
  function btn(x, y, w, t, c) {
    return '<g><rect x="' + x + '" y="' + y + '" width="' + w + '" height="26" rx="7" fill="' + c + '"/>' +
      '<text x="' + (x + w / 2) + '" y="' + (y + 17) + '" fill="#0b0d12" font-size="11" font-weight="800" text-anchor="middle">' + t + '</text></g>';
  }

  var M = {
    /* squad workspace: prompt, ranked responses, timer, guideline rail */
    squad: function (accent) {
      var body =
        panel(16, 42, 400, 342, 'TASKING CANVAS') +
        '<text x="28" y="80" fill="#e7ecf3" font-size="11">User prompt \u00b7 personal finance</text>' +
        line(28, 90, 360, '#232c3b') + line(28, 103, 300, '#232c3b') +
        [0, 1, 2, 3].map(function (i) {
          return '<g class="i" style="animation-delay:' + (0.1 * i) + 's">' +
            '<rect x="28" y="' + (124 + i * 62) + '" width="372" height="54" rx="8" fill="#0e131c" stroke="' + (i === 0 ? accent : '#242e3d') + '"/>' +
            '<rect x="38" y="' + (134 + i * 62) + '" width="30" height="16" rx="5" fill="' + (i === 0 ? accent : '#1d2532') + '"/>' +
            '<text x="53" y="' + (146 + i * 62) + '" fill="' + (i === 0 ? '#0b0d12' : '#6d7c92') + '" font-size="9.5" text-anchor="middle" font-weight="800">#' + (i + 1) + '</text>' +
            line(78, 135 + i * 62, 250, '#252f3e') + line(78, 150 + i * 62, 300, '#1e2632') +
            '<rect x="360" y="' + (133 + i * 62) + '" width="30" height="20" rx="5" fill="#1b2230"/>' +
            '</g>';
        }).join('') +
        panel(428, 42, 216, 122, 'GUIDELINE v3.2') +
        line(440, 74, 190, '#242e3d') + line(440, 87, 172, '#242e3d') + line(440, 100, 186, '#242e3d') +
        '<rect x="440" y="118" width="152" height="30" rx="6" fill="' + accent + '18" stroke="' + accent + '55"/>' +
        '<text x="516" y="137" fill="' + accent + '" font-size="10" text-anchor="middle" font-weight="700">updated 2 days ago \u2191 read it</text>' +
        panel(428, 176, 216, 88, 'SESSION TIMER') +
        '<text x="440" y="212" fill="#e7ecf3" font-size="26" font-weight="800" font-family="ui-monospace,monospace">03:12</text>' +
        '<text x="440" y="230" fill="#ff5f6d" font-size="9.5" class="p" font-weight="700">counts only while this tab is focused</text>' +
        '<rect x="440" y="240" width="188" height="6" rx="3" fill="#1c2431"/>' +
        '<rect x="440" y="240" height="6" rx="3" fill="' + accent + '" class="b" width="82"/>' +
        panel(428, 276, 216, 108, 'SQUAD \u00b7 QM ONLINE') +
        '<circle cx="446" cy="300" r="5" fill="#39d98a" class="p"/>' +
        '<text x="458" y="304" fill="#93a0b4" font-size="10">#math-general \u00b7 34 online</text>' +
        line(440, 316, 190, '#212a37') + line(440, 330, 150, '#212a37') +
        '<text x="440" y="366" fill="#6d7c92" font-size="9.5" class="k">queue: 6 items \u00b7 41s/item</text>';
      return frame('squad workspace \u2014 response ranking queue', accent, body);
    },

    /* fellowship: scoped deliverables, fixed term, per-task rate */
    fellowship: function (accent) {
      var body =
        panel(16, 42, 300, 170, 'ENGAGEMENT') +
        '<text x="28" y="72" fill="#e7ecf3" font-size="13" font-weight="700">Philosophy \u00b7 reasoning audit</text>' +
        line(28, 84, 240, '#242e3d') +
        '<text x="28" y="110" fill="#6d7c92" font-size="10">TERM</text>' +
        '<text x="110" y="110" fill="#e7ecf3" font-size="10.5" font-family="ui-monospace,monospace">6 weeks \u00b7 12 hrs/wk</text>' +
        '<text x="28" y="130" fill="#6d7c92" font-size="10">RATE</text>' +
        '<text x="110" y="130" fill="#39d98a" font-size="10.5" font-family="ui-monospace,monospace">$120/hr \u00b7 or $135/task</text>' +
        '<text x="28" y="150" fill="#6d7c92" font-size="10">IP</text>' +
        '<text x="110" y="150" fill="#f5b13d" font-size="10.5">output assigned to lab</text>' +
        '<text x="28" y="170" fill="#6d7c92" font-size="10">PAYOUT</text>' +
        '<text x="110" y="170" fill="#e7ecf3" font-size="10.5" font-family="ui-monospace,monospace">Deel \u00b7 Wed weekly</text>' +
        panel(16, 224, 300, 160, 'DELIVERABLES \u00b7 4 of 9') +
        [0, 1, 2, 3, 4].map(function (i) {
          return '<g class="i" style="animation-delay:' + (0.09 * i) + 's">' +
            '<rect x="28" y="' + (248 + i * 26) + '" width="13" height="13" rx="3.5" fill="' + (i < 4 ? '#39d98a' : '#1d2532') + '"/>' +
            (i < 4 ? '<path d="M31 ' + (254.5 + i * 26) + ' l2.6 2.6 l4.4-5.2" stroke="#0b0d12" stroke-width="1.7" fill="none" stroke-linecap="round"/>' : '') +
            '<text x="50" y="' + (258.5 + i * 26) + '" fill="' + (i < 4 ? '#6d7c92' : '#e7ecf3') + '" font-size="10.5" text-decoration="' + (i < 4 ? 'line-through' : 'none') + '">' +
            ['adjudicate 12 disputed items', 'rewrite 4 rubric anchors', 'flag 2 unsupported citations', 'write counterargument set', 'ethics note (in review)'][i] + '</text></g>';
        }).join('') +
        panel(332, 42, 312, 170, 'REVIEW PANEL') +
        '<text x="344" y="72" fill="#93a0b4" font-size="10.5">Two reviewers disagree. You are the tie-break.</text>' +
        line(344, 84, 288, '#242e3d') + line(344, 97, 240, '#242e3d') +
        '<g class="s"><rect x="344" y="112" width="140" height="60" rx="8" fill="#0e131c" stroke="#242e3d"/>' +
        '<text x="414" y="132" fill="#8b7cff" font-size="10" text-anchor="middle" font-weight="700">REVIEWER A</text>' +
        line(356, 140, 116, '#212a37') + line(356, 152, 92, '#212a37') + '</g>' +
        '<g class="s" style="animation-delay:.4s"><rect x="500" y="112" width="140" height="60" rx="8" fill="#0e131c" stroke="#242e3d"/>' +
        '<text x="570" y="132" fill="#ff5f6d" font-size="10" text-anchor="middle" font-weight="700">REVIEWER B</text>' +
        line(512, 140, 116, '#212a37') + line(512, 152, 92, '#212a37') + '</g>' +
        panel(332, 224, 312, 160, 'STANDING') +
        ['credential verified \u00b7 PhD, 2024', 'agreement with consensus 94%', '1 late deliverable \u00b7 noted', 'eligibility: US work authorisation'].map(function (t, i) {
          return '<g class="i" style="animation-delay:' + (0.1 * i) + 's"><circle cx="348" cy="' + (258 + i * 30) + '" r="4" fill="' + (i === 3 ? '#f5b13d' : '#39d98a') + '"/>' +
            '<text x="362" y="' + (262 + i * 30) + '" fill="#93a0b4" font-size="11">' + t + '</text></g>';
        }).join('') +
        '<rect x="344" y="348" width="288" height="24" rx="6" fill="#1a2130"/>' +
        '<text x="488" y="364" fill="#f5b13d" font-size="9.5" text-anchor="middle" class="p">engagement ends on schedule \u2014 the queue does not reopen</text>';
      return frame('fellowship brief \u2014 scoped, credentialed, time-boxed', accent, body);
    },

    /* vendor pool: invitation email, training rounds, project onboarding */
    pool: function (accent) {
      var body =
        panel(16, 42, 300, 200, 'INBOX \u00b7 PROJECT INVITATIONS') +
        ['Yoruba dialect ID \u2014 250 items \u00b7 $15/hr', 'Search relevance refresh \u2014 round 2', 'Ad quality \u2014 closed (quota filled)']
          .map(function (t, i) {
            return '<g class="i" style="animation-delay:' + (0.12 * i) + 's">' +
              '<rect x="28" y="' + (66 + i * 56) + '" width="276" height="46" rx="8" fill="#0e131c" stroke="' + (i === 2 ? '#242e3d' : accent + '44') + '"/>' +
              '<circle cx="42" cy="' + (89 + i * 56) + '" r="4" fill="' + (i === 0 ? '#39d98a' : i === 1 ? '#f5b13d' : '#39424f') + '"/>' +
              '<text x="56" y="' + (86 + i * 56) + '" fill="' + (i === 2 ? '#4a5568' : '#e7ecf3') + '" font-size="10.5">' + t + '</text>' +
              '<text x="56" y="' + (101 + i * 56) + '" fill="#6d7c92" font-size="9.5">' + ['invitation valid 72h \u00b7 accept to hold your slot', 'requires re-certification this round', 'reopens next quarter, no fixed date'][i] + '</text></g>';
          }).join('') +
        panel(332, 42, 312, 200, 'TRAINING ROUNDS \u00b7 dialect ID') +
        [0, 1, 2, 3].map(function (i) {
          return '<g class="i" style="animation-delay:' + (0.1 * i) + 's"><rect x="348" y="' + (70 + i * 34) + '" width="276" height="26" rx="7" fill="#0e131c" stroke="#242e3d"/>' +
            '<rect x="356" y="' + (76 + i * 34) + '" width="' + [258, 258, 168, 0][i] + '" height="14" rx="4" fill="' + (i < 2 ? '#39d98a55' : i === 2 ? accent + '55' : 'transparent') + '"/>' +
            '<text x="366" y="' + (87 + i * 34) + '" fill="' + (i <= 2 ? '#e7ecf3' : '#4a5568') + '" font-size="10">' + ['round 1 \u00b7 passed', 'round 2 \u00b7 passed', 'round 3 \u00b7 in progress (unpaid)', 'production eligibility'][i] + '</text></g>';
        }).join('') +
        panel(16, 254, 628, 130, 'PRODUCTION TASK \u00b7 listen, classify, move on') +
        '<rect x="28" y="282" width="180" height="52" rx="8" fill="#0e131c" stroke="#242e3d"/>' +
        '<path d="M40 308 q6-16 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0" stroke="' + accent + '" stroke-width="1.7" fill="none" class="p"/>' +
        '<text x="44" y="326" fill="#6d7c92" font-size="9.5">0:07 / 0:11 \u00b7 1.25\u00d7</text>' +
        ['Yoruba (standard)', 'Yoruba (Benin variant)', 'Edo', 'Nigerian Pidgin', 'Cannot determine'].map(function (t, i) {
          return '<g class="i" style="animation-delay:' + (0.07 * i) + 's"><rect x="' + (224 + (i % 3) * 146) + '" y="' + (282 + Math.floor(i / 3) * 30) + '" width="136" height="24" rx="6" fill="#0e131c" stroke="' + (i === 1 ? accent : '#242e3d') + '"/>' +
            '<text x="' + (234 + (i % 3) * 146) + '" y="' + (298 + Math.floor(i / 3) * 30) + '" fill="' + (i === 1 ? accent : '#93a0b4') + '" font-size="10">' + t + '</text></g>';
        }).join('') +
        '<rect x="28" y="344" width="604" height="26" rx="7" fill="#1a2130"/>' +
        '<text x="40" y="361" fill="#93a0b4" font-size="10">volume: 3\u20139 hrs/wk \u00b7 no floor, no ceiling \u00b7 guideline v4 updated mid-project \u2014 re-read before round 4</text>';
      return frame('vendor pool \u2014 invitations, training rounds, volume games', accent, body);
    },

    /* interview + microtasks, the two extremes */
    gate: function (accent) {
      var body =
        panel(16, 42, 628, 150, 'SCREENING \u00b7 the gate is the whole product') +
        '<text x="28" y="72" fill="#e7ecf3" font-size="12" font-weight="700">Live interview, recorded and scored</text>' +
        '<rect x="28" y="84" width="272" height="88" rx="8" fill="#0e131c" stroke="#242e3d"/>' +
        '<circle cx="164" cy="120" r="20" fill="' + accent + '22" stroke="' + accent + '88"/>' +
        '<text x="164" y="125" fill="' + accent + '" font-size="10" text-anchor="middle" font-weight="800">YOU</text>' +
        '<rect x="28" y="152" width="272" height="6" rx="3" fill="#1c2431"/>' +
        '<rect x="28" y="152" height="6" rx="3" fill="' + accent + '" class="b" width="80"/>' +
        '<text x="316" y="98" fill="#93a0b4" font-size="10.5">\u201cWalk me through why you flagged line 12, not line 14.\u201d</text>' +
        '<text x="316" y="116" fill="#6d7c92" font-size="10">silence is scored \u00b7 thinking out loud is the deliverable</text>' +
        line(316, 128, 300, '#212a37') + line(316, 142, 250, '#212a37') +
        '<text x="316" y="170" fill="#f5b13d" font-size="10.5" class="p">~80% rejected at this step</text>' +
        panel(16, 206, 306, 178, 'MICROTASK STRIP \u00b7 cents, not hours') +
        [0, 1, 2, 3, 4, 5].map(function (i) {
          return '<g class="i" style="animation-delay:' + (0.06 * i) + 's"><rect x="' + (30 + (i % 3) * 96) + '" y="' + (232 + Math.floor(i / 3) * 68) + '" width="86" height="58" rx="7" fill="#0e131c" stroke="#242e3d"/>' +
            '<rect x="' + (38 + (i % 3) * 96) + '" y="' + (240 + Math.floor(i / 3) * 68) + '" width="70" height="24" rx="4" fill="#1d2532"/>' +
            '<text x="' + (73 + (i % 3) * 96) + '" y="' + (279 + Math.floor(i / 3) * 68) + '" fill="#6d7c92" font-size="11" text-anchor="middle" font-family="ui-monospace,monospace">$0.0' + (i + 1) + '</text></g>';
        }).join('') +
        '<text x="30" y="366" fill="#ff5f6d" font-size="10" class="k">18 of these = about 1 hour of your life</text>' +
        panel(338, 206, 306, 178, 'WHAT A PAYOUT SCREEN ACTUALLY LOOKS LIKE') +
        '<text x="352" y="236" fill="#6d7c92" font-size="10" font-weight="700" letter-spacing="1">EARNINGS (ILLUSTRATIVE)</text>' +
        [['Mon', 14], ['Tue', 22], ['Wed', 8], ['Thu', 0], ['Fri', 0], ['Sat', 26], ['Sun', 18]].map(function (b, i) {
          return '<g class="i" style="animation-delay:' + (0.07 * i) + 's"><rect x="' + (352 + i * 41) + '" y="' + (330 - b[1] * 3.2) + '" width="26" height="' + (b[1] * 3.2 + 2) + '" rx="3" fill="' + (b[1] ? accent : '#232b39') + '"/>' +
            '<text x="' + (365 + i * 41) + '" y="346" fill="#4a5568" font-size="9" text-anchor="middle">' + b[0] + '</text></g>';
        }).join('') +
        '<text x="352" y="372" fill="#93a0b4" font-size="10">two zero days are the norm, not a failure \u2014 budget for them</text>';
      return frame('screening gate, microtask strip, real payout shape', accent, body);
    }
  };

  var MAP = {
    outlier: 'squad', alignerr: 'squad', dataannotation: 'squad', mindrift: 'pool',
    handshake: 'fellowship', mercor: 'gate', telus: 'pool', appen: 'pool', rws: 'pool',
    toloka: 'gate', prolific: 'gate', pareto: 'fellowship'
  };

  window.Mockups = {
    for: function (id, accent) {
      var k = MAP[id] || 'pool';
      return M[k](accent || '#8b7cff');
    },
    caption: {
      squad: 'Reconstructed layout, not a screenshot: prompt rail, ranked response list, guideline version with a mid-project update, focused-tab timer, squad channel.',
      fellowship: 'Reconstructed layout, not a screenshot: scoped engagement, deliverable list with review states, a disagreement you adjudicate, standing metrics, hard end date.',
      pool: 'Reconstructed layout, not a screenshot: time-boxed invitation email, unpaid training rounds, a production task, and the volume note under it all.',
      gate: 'Reconstructed layout, not a screenshot: recorded screening interview, per-task penny strip, and what a real weekly payout histogram looks like.'
    }
  };
})();
