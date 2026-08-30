/*
  AnnotateTrainer — "AI tells" detector.

  READ THIS FIRST: this is NOT a classifier and it is NOT trying to be one.
  Determining whether text was written by a model is unreliable at short lengths and
  the published detectors have documented false-positive harm, particularly against
  non-native English writers. This module computes five transparent surface features,
  shows you each raw number and the weight applied, and combines them into an
  "authenticity index". Use it on your OWN drafts to learn which habits read as
  templated. Never use it to accuse or screen another person.
*/
(function () {
  var CLICHE = [
    'delve', 'leverage', 'robust', 'seamless', 'crucial', 'pivotal', 'foster', 'cultivate',
    'navigate the', 'in the realm of', 'it is important to note', 'it is worth noting',
    'when it comes to', 'in today', 'unlock', 'elevate', 'streamline', 'holistic',
    'testament to', 'ever-evolving', 'fast-paced world', 'game-changer', 'myriad', 'underscores',
    'in conclusion', 'overall, ', 'furthermore', 'moreover', 'additionally', 'tapestry',
    'delves', 'showcase', 'boasts', 'realm', 'embark'
  ];
  var HEDGES = ['may', 'might', 'could', 'often', 'generally', 'typically', 'arguably',
    'it depends', 'some people', 'many experts', 'studies show', 'however', 'while', 'although'];

  function sentences(t) {
    var s = t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g);
    return s ? s.map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 1; }) : [];
  }
  function countWhere(arr, fn) { return arr.reduce(function (n, x) { return n + (fn(x) ? 1 : 0); }, 0); }
  function words(t) { return t.toLowerCase().match(/[a-z']+/g) || []; }

  function analyze(text) {
    text = String(text || '').trim();
    var wc_ = text.toLowerCase().match(/[a-z']+/g) || [];
    var sents = sentences(text);
    var lens = sents.map(function (s) { return (s.match(/[a-z']+/gi) || []).length; })
      .filter(function (n) { return n > 0; });

    var uniq = {}; wc_.forEach(function (w) { uniq[w] = 1; });
    var ttr = wc_.length ? Object.keys(uniq).length / Math.sqrt(wc_.length) : 0;

    // 1. burstiness — coefficient of variation of sentence length.
    var mean = lens.length ? lens.reduce(function (a, b) { return a + b; }, 0) / lens.length : 0;
    var sd = lens.length > 1 ? Math.sqrt(lens.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (lens.length - 1)) : 0;
    var cv = mean ? sd / mean : 0;
    var burstScore = Math.round(Math.max(0, Math.min(1, (cv - 0.20) / 0.55)) * 100); // human ~0.5-0.9, templated ~0.2-0.4

    // 2. lexical diversity
    var lexScore = Math.round(Math.max(0, Math.min(1, (ttr - 2.2) / 3.6)) * 100);

    // 3. human voice — first person + specific, checkable detail markers
    var lower = text.toLowerCase();
    var fp = countWhere(wc_, function (w) { return ['i', 'my', 'me', "i'm", "i've", 'we', 'our'].indexOf(w) >= 0; });
    var fpd = wc_.length ? fp / wc_.length : 0;
    var specifics = countWhere(sents, function (s) { return /\d|\b(naija|naira|lagos|benin|payoneer|paypal|gist)\b/i.test(s); });
    var specificsPer = sents.length ? specifics / sents.length : 0;
    var voiceScore = Math.round(Math.min(1, fpd / 0.035) * 62 + Math.min(1, specificsPer / 0.6) * 38);

    // 4. structure — bullet/numbered lines, headings, heavy bold, "X: Y" list rhythm
    var lines = text.split(/\n+/);
    var structLines = countWhere(lines, function (l) { return /^\s*([-*•]|\d+[.)])\s+/.test(l) || /^#{1,4}\s/.test(l); });
    var bold = (text.match(/\*\*[^*]+\*\*/g) || []).length;
    var colonHeads = countWhere(lines, function (l) { return /^\s*\*\*?[A-Z][^:\n]{2,42}:/.test(l); });
    var structRaw = lines.length ? structLines / lines.length : 0;
    var structScore = Math.round(100 - Math.min(1, structRaw * 1.5 + bold / 8 * 0.5 + colonHeads / 6 * 0.5) * 100);

    // 5. tells — cliché + hedge density
    var hits = [];
    CLICHE.forEach(function (c) {
      var re = new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      var m = text.match(re);
      if (m) hits.push({ w: c.trim(), n: m.length });
    });
    var hedgeN = countWhere(wc_, function (w) { return HEDGES.indexOf(w) >= 0; });
    var per100 = wc_.length ? (hits.reduce(function (a, h) { return a + h.n; }, 0) + hedgeN * 0.5) / wc_.length * 100 : 0;
    var tellsScore = Math.round(100 - Math.min(1, per100 / 9) * 100);

    var em = (text.match(/[—–]/g) || []).length;
    var emPer100 = wc_.length ? em / wc_.length * 100 : 0;

    var w = { burst: 0.26, lex: 0.16, voice: 0.24, struct: 0.16, tells: 0.18 };
    var index = Math.round(burstScore * w.burst + lexScore * w.lex + voiceScore * w.voice +
      structScore * w.struct + tellsScore * w.tells);
    if (wc_.length < 40) index = Math.round(index * 0.55 + 45 * 0.45); // too short to judge -> pull to neutral

    var band = index >= 68 ? 'human-voice' : index >= 45 ? 'mixed' : 'templated';
    var labels = { 'human-voice': 'Reads like a person', 'mixed': 'Mixed signals', templated: 'Reads like templated output' };

    var tips = [];
    if (burstScore < 45) tips.push('Every sentence is about the same length (' + Math.round(mean) + ' words, ±' + Math.round(sd) + '). Humans vary a lot — drop one long sentence and one three-word sentence.');
    if (tellsScore < 55 && hits.length) tips.push('Removed the boilerplate openers that models reach for: ' + hits.slice(0, 6).map(function (h) { return '"' + h.w + '"'; }).join(', ') + '.');
    if (structScore < 55) tips.push('Your answer is a bullet scaffold (' + structLines + ' list lines out of ' + lines.length + '). Real graders want prose that answers the question asked.');
    if (voiceScore < 40) tips.push('No first-person voice or concrete specifics. Say what you actually did, with numbers and names — "I clocked 12 hrs on Alignerr in June" beats "many contributors find work available".');
    if (emPer100 > 1.2) tips.push('Em-dash density ' + emPer100.toFixed(1) + ' per 100 words. This one specific tell has become a running joke among reviewers; use a comma.');
    if (hedgeN > wc_.length / 45) tips.push('Hedging stack (' + hedgeN + ' "may/might/often/typically"). Commit or cite.');
    if (wc_.length < 40) tips.push('Only ' + wc_.length + ' words — too short to judge anything. Write at least 100.');

    return {
      index: index, band: band, bandLabel: labels[band],
      counts: { words: wc_.length, sentences: sents.length },
      features: [
        { k: 'Sentence burstiness', v: 'σ ' + sd.toFixed(1) + ' / μ ' + mean.toFixed(1), score: burstScore, hint: 'std-dev ÷ mean of sentence length. Higher = more human rhythm.' },
        { k: 'Lexical diversity', v: 'TTR ' + ttr.toFixed(2), score: lexScore, hint: 'unique words ÷ √total words.' },
        { k: 'Human voice', v: fp + ' first-person, ' + specifics + ' specific', score: voiceScore, hint: '"I/my/we" density plus concrete details and figures.' },
        { k: 'Structure', v: structLines + ' list lines, ' + bold + ' bold', score: structScore, hint: 'Heavy bullet/heading scaffolding is a formatting tell.' },
        { k: 'Tells density', v: per100.toFixed(1) + ' / 100w', score: tellsScore, hint: 'Boilerplate phrases + hedges per 100 words.' }
      ],
      hits: hits, em: em, weights: w, tips: tips
    };
  }

  window.Detector = { analyze: analyze, CLICHE: CLICHE };
})();
