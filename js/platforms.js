/*
  AnnotateTrainer — platform catalogue + per-platform presets.

  Everything under `facts` is what is publicly documented or contributor-reported about the
  real vendor, so a learner knows what to expect before spending unpaid hours. `preset` is a
  *recommended practice set* built from this site's own fictional tasks — AnnotateTrainer is
  not affiliated with any vendor and none of these queues are theirs.
  "status" fields decay fast; they are dated on the page so nobody trusts them blindly.
*/
(function () {
  var ASOF = 'as of mid-2026 — verify on the vendor site before you apply';

  function mk(o) {
    o.fictionalNote = 'Practice set below is AnnotateTrainer\u2019s own, built to resemble the task shapes \u00b7 ' +
      'no affiliation with ' + o.name;
    return o;
  }

  var P = [
    mk({
      id: 'outlier', name: 'Outlier', short: 'O',
      operator: 'Scale AI', tier: 'Direct contractor platform',
      url: 'https://outlier.ai', accent: '#ff7a45',
      blurb: 'The highest-volume general queue in the category. Domain-based squads, hourly pay, weekly payout. ' +
        'Also the platform with the most complaints about silent account restrictions.',
      rates: { advertised: '$15\u201350/hr', actual: '$15\u201320 general \u00b7 $25\u201340 coding \u00b7 $40\u201380 law/medicine', cap: '$75/hr on some specialist projects, dropping to ~$21/hr once you run past the allotted tasking time' },
      funnel: [
        ['Sign up with Google', 'Instant', 'Profile only \u2014 no task access yet'],
        ['Education + work history', '15 min', 'You self-report the domain you will be tested on'],
        ['ID + phone verification', '1\u20133 days', 'Government ID. Country on the ID decides everything'],
        ['Domain screening test', '2\u20135 hrs, UNPAID', 'Reasoning + writing, ~80% threshold'],
        ['Squad placement', 'days\u2013weeks', 'You land in a squad with a team lead (Slack)'],
        ['Training modules', '1\u20135 hrs, usually unpaid', 'Some projects credit a small amount here; people report getting nothing'],
        ['Live queue', 'varies wildly', 'Task supply swings from 40 hrs/week to zero for weeks']
      ],
      gates: ['Valid government ID whose country matches your IP and payout account',
        'Domain assessment at roughly an 80% bar, retake policy not published',
        'Expert-rate tiers need a verifiable degree or credential',
        'A working PayPal, AirTM or ACH account'],
      tasks: ['Response ranking (RLHF)', 'Grounded writing / golden answers', 'Rubric grading of model output',
        'Code review and debugging', 'Math/STEM verification', 'Prompt creation and rewriting', 'Content moderation review'],
      breaks: ['Paste into a response field, or auto-correct that looks like an auto-typer',
        'Sub-threshold completion time (fast finishing is treated as a signal, not efficiency)',
        'Agreement collapse with your squad on the same items',
        'Opening devtools during a tasking session'],
      payout: { rails: 'PayPal \u00b7 AirTM \u00b7 ACH (Hyperwallet underneath)', cadence: 'Weekly \u2014 processed Tuesday for Tue\u2013Mon work, lands around Friday', minimum: '$10' },
      nigeria: { status: 'reported closed to new sign-ups', note: 'Not a policy ban \u2014 Nigeria is simply not on the operating list. Yoruba/Hausa writer projects have appeared with Nigeria location tags in past hiring rounds, so re-check quarterly.' },
      practiceLabel: 'the generalist + expert mix that gets most people rejected',
      preset: ['rank-health-01', 'write-policy-01', 'fact-01', 'reasoning-01', 'code-01', 'redteam-01', 'search-01', 'honeypot-01']
    }),
    mk({
      id: 'handshake', name: 'Handshake AI', short: 'H',
      operator: 'Handshake AI Solutions LLC', tier: 'Structured fellowship',
      url: 'https://joinhandshake.com', accent: '#8b7cff',
      blurb: 'Not an open queue. A credentialed, fixed-term, part-time engagement routed through the university ' +
        'career platform. Best rates in the market, narrowest front door.',
      rates: { advertised: '$75\u2013125/hr, specialist listings to $500/hr', actual: '~$90\u2013100/hr cluster for graduate work; per-task projects quoted $120\u2013140 each', cap: 'Rates and terms changed in early 2026 \u2014 several contributors reported cuts; verify the current posting' },
      funnel: [
        ['Find a Fellowship posting', 'rolling', 'Rolled up through Handshake\u2019s career platform, not an open signup form'],
        ['R\u00e9sum\u00e9 + research statement', '1 hr, UNPAID', 'Short, technical, scoped to your sub-field'],
        ['Credential verification', 'days', 'Degree/dissertation evidence for the top tiers'],
        ['Human interview', '20\u201345 min', 'Usually a research lead; some tracks use an AI screen'],
        ['Fixed-term engagement', '10\u201320 hrs/week', 'Defined hours, defined scope, then it ends'],
        ['Payout', 'weekly Wed', 'Via Deel \u2014 Mon\u2013Sun period, up to 48h to clear']
      ],
      gates: ['US work authorization for many \u2014 check the posting, it is the hard wall',
        'Graduate-level credential in the requested field',
        'Willingness to sign lab IP terms; work output belongs to the client',
        'A Deel account'],
      tasks: ['High-stakes domain evaluation (medicine, law, finance)', 'Design-spec review (hardware, games)',
        'Benchmark item authoring', 'Expert rubric construction', 'Adjudicating other reviewers\u2019 disagreements'],
      breaks: ['The contractor agreement: a terms violation can void in-progress pay for the period',
        'Term expiry \u2014 engagements end on schedule, and the queue does not reopen for you',
        'Credential mismatch between your statement and the vetting evidence'],
      payout: { rails: 'Deel \u2192 bank, Wise, PayPal, Payoneer, Revolut', cadence: 'Weekly', minimum: 'set by Deel rail' },
      nigeria: { status: 'effectively unavailable', note: 'Built for US students, postdocs and recent PhDs with US work authorisation. If that is not you, this is a "not for me", not a "not yet" \u2014 skip to Outlier-style or vendor-pool practice.' },
      practiceLabel: 'the credential-gated eval work, rehearsed without credentials',
      preset: ['fact-01', 'reasoning-01', 'redteam-01', 'write-policy-01', 'code-01']
    }),
    mk({
      id: 'rws', name: 'RWS TrainAI', short: 'R',
      operator: 'RWS plc (LSE-listed)', tier: 'Vendor crowd pool',
      url: 'https://www.rws.com/artificial-intelligence/train-ai-data-services/trainai-community/', accent: '#39d98a',
      blurb: 'A 40-year language-services company running a global contributor pool. Their own page puts it at ' +
        '~250k community members, ~500 language pairs and variants, ~193 countries. Low ceiling, real company, auditable.',
      rates: { advertised: 'not published; project-specific', actual: '$14\u201315/hr on entry language-identification listings; US-based Glassdoor submissions for AI Data Annotator cluster at $20\u201322/hr', cap: 'their modelled "$36\u201349/hr" band is an estimate, not what people reported' },
      funnel: [
        ['Apply via their job portal / WorkZone', '~1 day', 'Pick the option that describes you: private individual, sole proprietor, or company'],
        ['Profile vetting', '~5 days', 'Language pairs, education, industry experience, desired rate'],
        ['Qualifying assessments', '~5 days', 'Language-knowledge tests plus general machine-learning tests (attention to detail, critical thinking)'],
        ['Project invitations by email', 'hours\u2013weeks', 'You are in the pool; projects come to you \u2014 this is the slow part'],
        ['Project-specific training rounds', 'varies, sometimes UNPAID', 'You must pass each round to be production-eligible'],
        ['Production + monthly-ish pay', '\u2014', 'Support answers within 48h on business days, per their published commitment']
      ],
      gates: ['18+', 'Native or near-native fluency in the requested language pair',
        'English B2\u2013C2 to read guidelines', 'Reliable PC (Win 10+/macOS Catalina+) and connection',
        'Tolerance for sensitive or objectionable content \u2014 stated on some briefs'],
      tasks: ['Online rater (text/audio/image/video against criteria)', 'Data collector / creator',
        'Data annotator against client platforms', 'Search engine evaluator', 'Ad evaluator',
        'Language & dialect identification', 'Project-specific specialist work'],
      breaks: ['Failing a training round quietly puts you back in the pool with no feedback',
        'Ignoring guideline updates between rounds \u2014 guideline version drift is a real rework cause',
        'Going quiet for weeks: invitations are batched and nobody chases you'],
      payout: { rails: 'PayPal or bank transfer', cadence: 'per project terms', minimum: 'not published' },
      nigeria: { status: 'genuinely global', note: 'The TrainAI pool lists 193 countries and hires on language pairs, so Nigerian English plus a local language is a real qualification here. No documented country lockout.' },
      practiceLabel: 'rater + annotator work at vendor-pool difficulty',
      preset: ['search-01', 'fact-01', 'rank-health-01', 'write-policy-01']
    }),
    mk({
      id: 'alignerr', name: 'Alignerr', short: 'A',
      operator: 'Labelbox', tier: 'Expert-leaning contractor',
      url: 'https://alignerr.com', accent: '#4cc9f0',
      blurb: 'Labelbox\u2019s contributor brand. Sits between the crowd pools and the fellowship programs: ' +
        'open-ish signup, credential verification for the queues that pay properly.',
      rates: { advertised: '$20\u2013150/hr by domain', actual: '$20\u201340 general, $25\u201350 expert, credentialed tiers higher', cap: 'availability is uneven \u2014 the common complaint, not the rate' },
      funnel: [
        ['Apply with r\u00e9sum\u00e9', 'same day', 'No formal degree requirement to create the profile'],
        ['Skills screening', '1\u20133 weeks', 'Writing sample plus domain test'],
        ['Credential verification', 'for expert tiers', 'Only unlocks the queues worth doing'],
        ['Project assignment', 'varies', 'Per project, not an open board'],
        ['Payout', 'bi-weekly', 'Via Deel']
      ],
      gates: ['Clear command of English; other languages for multilingual queues',
        'Domain claim you can evidence', 'Deel account', 'Patience for sparse availability'],
      tasks: ['Expert response evaluation', 'Rubric and golden-answer authoring', 'Specialist rewriting',
        'Model-output QA for verticals (legal, medical, finance)'],
      breaks: ['Stalling on a project while availability empties \u2014 the pattern that makes people quit',
        'Claiming a domain you cannot evidence at verification'],
      payout: { rails: 'Deel \u2192 PayPal, Wise, Payoneer, bank', cadence: 'bi-weekly per project', minimum: 'rail-specific' },
      nigeria: { status: 'reported open to international applicants', note: 'Frequently recommended as the fallback when an Outlier queue dries up. Confirm at signup.' },
      practiceLabel: 'expert evaluation with an availability problem',
      preset: ['write-policy-01', 'fact-01', 'rank-health-01', 'redteam-01']
    }),
    mk({
      id: 'mercor', name: 'Mercor', short: 'M',
      operator: 'Mercor', tier: 'Marketplace + AI screening',
      url: 'https://mercor.com', accent: '#f5b13d',
      blurb: 'The 2026 story: an interview agent screens you, then matches you to lab projects. ' +
        'Highest ceiling for software engineers, and a reported rejection rate around 80%.',
      rates: { advertised: 'you quote a rate; $16\u2013200+/hr across tracks', actual: '~$40\u201360 general RLHF, $85\u2013110 coding, expert tracks higher', cap: 'the marketplace clears lower than the ad for people who price greedily' },
      funnel: [
        ['Profile + verified history', '30 min', 'Public proof (GitHub, publications) carries weight'],
        ['AI interview', '30\u201360 min', 'Structured, recorded, scored \u2014 practise talking through your reasoning'],
        ['Skills verification', 'domain tests', 'Coding rounds for engineering tracks'],
        ['Matching / offer', 'days', 'You may be held in a queue with no offer'],
        ['Contract work', 'project length', 'Rates agreed per engagement'],
        ['Payout', '24\u201348h after approval', 'Among the fastest in the industry']
      ],
      gates: ['Verifiable professional or graduate-level expertise',
        'Ability to think out loud on camera \u2014 the interview is the gate, not a formality',
        'A Stripe or Wise receiving account'],
      tasks: ['Production code review on real repos', 'Agentic/tool-use evaluation', 'Expert benchmark authoring',
        'RLHF for specialised verticals'],
      breaks: ['Under-preparing the interview \u2014 it is the filter', 'Accepting a rate that prices you out of matching'],
      payout: { rails: 'Stripe (Express) \u00b7 Wise', cadence: 'tracked hours \u2192 approval \u2192 automatic payout', minimum: 'per contract' },
      nigeria: { status: 'global, screened', note: 'Location is not the wall; the interview and evidence are. Strong engineering portfolios get through from anywhere.' },
      practiceLabel: 'expert reasoning under a clock, plus an interview you can rehearse',
      preset: ['code-01', 'reasoning-01', 'redteam-01', 'fact-01', 'write-policy-01']
    }),
    mk({
      id: 'dataannotation', name: 'DataAnnotation', short: 'D',
      operator: 'Surge AI', tier: 'Direct contractor platform',
      url: 'https://www.dataannotation.tech', accent: '#ff5f6d',
      blurb: 'Advertises the cleanest deal in the category and is consequently the most faked by scammers. ' +
        'Writing-sample gate, then per-project queues with widely fluctuating availability.',
      rates: { advertised: '$25\u201330/hr general, $50\u2013100 coding', actual: '$14\u201320 general and $25\u201345 coding in contributor reports', cap: 'queue empties are normal, not a punishment' },
      funnel: [
        ['Signup + starter assessment', '1\u20132 hrs, UNPAID', 'Carefully: retakes are generally not offered'],
        ['Writing sample', 'inside the assessment', 'Quality of prose decides more than credentials'],
        ['Valid ID matching an approved country', '1\u20137 days', 'This is where most international applicants stop'],
        ['Queue access', 'immediate\u2013weeks', 'Some accounts sit with zero projects for months'],
        ['Payout on request', 'every 3\u20137 days', 'PayPal only \u2014 if PayPal cannot receive in your country, this platform cannot pay you']
      ],
      gates: ['Bachelor\u2019s degree or equivalent real-world experience',
        'Starter assessment with effectively no retake', 'ID in an approved country', 'PayPal that can receive'],
      tasks: ['Creative + technical writing', 'Response comparison', 'Coding challenges and review',
        'Prompt creation', 'Fact and reasoning checks'],
      breaks: ['Rushing the starter assessment (no second chance)', 'PayPal-only payout in unsupported regions'],
      payout: { rails: 'PayPal', cadence: 'on request, roughly weekly', minimum: '$5\u201310 depending on era' },
      nigeria: { status: 'project-by-project, generally no', note: 'Reported approved-country list is US, CA, UK, IE, AU, NZ \u2014 and the company publishes no list, so treat as unconfirmed and check at signup.' },
      practiceLabel: 'the writing-sample gate, rehearsed cold',
      preset: ['write-policy-01', 'rank-health-01', 'fact-01', 'redteam-01']
    }),
    mk({
      id: 'mindrift', name: 'Mindrift', short: 'Mi',
      operator: 'Toloka', tier: 'Hybrid: all-access + expert CV track',
      url: 'https://mindrift.ai', accent: '#39d98a',
      blurb: 'The most accessible door in the set. In 2026 they split onboarding: instant all-access tasks with ' +
        'no CV and no assessment, plus the old CV/expert route for specialised projects.',
      rates: { advertised: '$15\u2013100+/hr', actual: 'all-access tasks sit low; the CV/expert track is where the range lives', cap: '70% of their community report master\u2019s or PhD backgrounds on specialist projects' },
      funnel: [
        ['Register with basic details', 'minutes', 'All-access path: no CV, no assessment, no waiting'],
        ['Short onboarding', 'under an hour', 'Explains what the tasks require'],
        ['Browse all-access tasks', 'immediate', 'Self-contained, no domain expertise needed'],
        ['(Expert path) CV + assessment + interview', '1\u20132 weeks', 'STEM/medicine/law projects'],
        ['Payout', 'per project cycle', 'Payoneer \u2014 reaches most countries Toloka serves']
      ],
      gates: ['Strong English even for all-access work',
        'For specialist projects: verifiable academic/professional background',
        'Not resident in a blocked jurisdiction (their terms list sanctions-style exclusions)'],
      tasks: ['Short annotation and rating tasks (all-access)', 'Expert writing and evaluation (CV track)',
        'Multilingual tasks', 'Domain QA'],
      breaks: ['Treating all-access pay as the platform rate \u2014 it is the floor',
        'Skipping the onboarding and losing the quality gate on your first batch'],
      payout: { rails: 'Payoneer \u00b7 PayPal \u00b7 wire depending on project', cadence: 'bi-weekly / per project', minimum: 'rail-specific' },
      nigeria: { status: 'open', note: 'Widely reported as working from Nigeria with Payoneer. Good first stop while slower platforms vet you.' },
      practiceLabel: 'fast low-stakes reps, then the expert gate',
      preset: ['search-01', 'rank-health-01', 'fact-01']
    }),
    mk({
      id: 'appen', name: 'Appen', short: 'Ap',
      operator: 'Appen (ASX: APX)', tier: 'Global crowd platform',
      url: 'https://appen.com', accent: '#93a0b4',
      blurb: 'The old giant. Huge language reach, low rates, and a worker-rating reputation that has decayed for ' +
        'years. Useful as a fallback and for rare-language work; not a career.',
      rates: { advertised: 'project-based, often undisclosed', actual: '$10\u201320/hr, some specialist higher; CrowdGen route lower', cap: 'monthly cycles mean slow cash flow' },
      funnel: [
        ['Create account + profile', '1 hr', 'Languages and qualifications declared once'],
        ['Language proficiency tests', '1\u20133 days', 'Determines which projects invite you'],
        ['Project applications', 'rolling', 'You apply per project; rejection is silent'],
        ['Project onboarding', 'varies, often unpaid', 'Guidelines per project, no global standard'],
        ['Payout', 'monthly', 'PayPal, Payoneer or bank']
      ],
      gates: ['Valid ID', 'Language proficiency test pass', 'Project-specific qualifications'],
      tasks: ['Search relevance', 'Social media evaluation', 'Annotation and transcription', 'Ad rating',
        'Multilingual collection tasks'],
      breaks: ['Long gaps with no invitation while your profile ages', 'Unpaid project onboarding loops'],
      payout: { rails: 'PayPal \u00b7 Payoneer \u00b7 bank', cadence: 'monthly', minimum: 'per project' },
      nigeria: { status: 'open (170+ countries)', note: 'One of the few that has never restricted broadly. Rates reflect that.' },
      practiceLabel: 'rater-style work, the unglamorous version',
      preset: ['search-01', 'fact-01', 'rank-health-01']
    }),
    mk({
      id: 'toloka', name: 'Toloka', short: 'T',
      operator: 'Toloka', tier: 'Crowd + invited experts',
      url: 'https://toloka.ai', accent: '#4cc9f0',
      blurb: 'Repositioned upmarket in 2025: the crowd tasks are micro-pennies, the paid expert work is ' +
        'invitation-only. Parent company of Mindrift, which is where the accessible work went.',
      rates: { advertised: 'per task', actual: '$0.01\u20130.10 per crowd task \u2014 often under $3/hr \u2014 expert queues by invite only', cap: 'do not budget from the crowd rates' },
      funnel: [
        ['Register + verify', 'same day', 'No CV for crowd work'],
        ['Pick microtasks', 'immediate', 'Volume game, not a rate game'],
        ['Qualify for expert projects', 'invite only', 'You cannot apply your way in'],
        ['Payout', 'on demand', 'PayPal, $20 minimum']
      ],
      gates: ['Nothing for crowd work', 'Invitation for the work that pays'],
      tasks: ['Image classification microtasks', 'Transcription snippets', 'Search result comparison',
        'Data validation loops', 'Expert annotation by invite'],
      breaks: ['Counting cents-per-task as an hourly income', 'Spending earned time on ungraded filler'],
      payout: { rails: 'PayPal \u00b7 Payoneer \u00b7 local rails via partners', cadence: 'on demand', minimum: '$20' },
      nigeria: { status: 'open for crowd tasks', note: 'Fine as a gap-filler between real queues; not a target.' },
      practiceLabel: 'speed, accuracy, and not being fooled by cents',
      preset: ['search-01', 'fact-01']
    }),
    mk({
      id: 'pareto', name: 'Pareto.AI', short: 'P',
      operator: 'Pareto.AI', tier: 'Expert marketplace',
      url: 'https://pareto.ai', accent: '#f5b13d',
      blurb: 'Expert-first with published rate bands and a straightforward apply-as-expert flow. ' +
        'Reported as actively recruiting Africa-based contributors in 2026, which is rare.',
      rates: { advertised: '$35\u201360/hr on specialist roles', actual: 'bands are published, so what you see is close', cap: 'avg pay sits lower for generalists \u2014 some listings show a wide low end' },
      funnel: [
        ['Apply at pareto.ai/experts', '20 min', 'R\u00e9sum\u00e9 and domain selection'],
        ['Skills review', 'days', 'Domain assessment'],
        ['Project matching', 'days\u2013weeks', 'Priced at the published band'],
        ['Payout', 'weekly', 'Payoneer or ACH (Grey)']
      ],
      gates: ['Demonstrable domain expertise', 'Payoneer or Grey/ACH receiving account'],
      tasks: ['Specialist evaluation', 'Expert writing', 'Benchmark item authoring', 'Data QA for verticals'],
      breaks: ['Applying as a generalist and accepting generalist rates when your credential clears a band'],
      payout: { rails: 'Payoneer \u00b7 ACH via Grey', cadence: 'weekly', minimum: 'per contract' },
      nigeria: { status: 'reported actively hiring', note: 'One of the few with a documented Africa contributor base plus USD rails. Worth an application before the harder gates.' },
      practiceLabel: 'published-rate expert bands, rehearsed',
      preset: ['fact-01', 'write-policy-01', 'code-01', 'redteam-01']
    }),
    mk({
      id: 'prolific', name: 'Prolific', short: 'Pr',
      operator: 'Prolific', tier: 'Research participant pool',
      url: 'https://prolific.com', accent: '#39d98a',
      blurb: 'Not an annotation platform, and that is why it matters: academic and commercial studies under ethics ' +
        'review, with a hard hourly minimum. Reliable pocket money while you wait on the real queues.',
      rates: { advertised: 'minimum enforced at ~$8/hr', actual: '$8\u201315/hr typical, studies are short', cap: 'you are paid for participation, not quality \u2014 no score to lose' },
      funnel: [
        ['Register + attention check', '20 min', 'ID verification in some regions'],
        ['Fill your profile', '30 min', 'Determines which studies invite you'],
        ['Wait in the queue', 'variable', 'Popular studies need the waitlist'],
        ['Payout', 'on cash-out', 'PayPal; UK/US may get other rails']
      ],
      gates: ['Genuine, consistent answers \u2014 they ban for careless responding',
        'A PayPal that can receive in your country'],
      tasks: ['Surveys and behavioural studies', 'Model-interaction studies', 'Translation and rating tasks',
        'Longitudinal follow-ups'],
      breaks: ['Speeding through attention checks \u2014 instant account action'],
      payout: { rails: 'PayPal', cadence: 'cash out anytime above a small threshold', minimum: '~\u00a35' },
      nigeria: { status: 'reported available, study supply varies', note: 'Low-volume for some countries. Check your inbox before you build a plan on it.' },
      practiceLabel: 'attention checks and consistency \u2014 the underrated skill',
      preset: ['fact-01', 'search-01', 'reasoning-01']
    }),
    mk({
      id: 'telus', name: 'TELUS Digital AI', short: 'Tl',
      operator: 'TELUS International', tier: 'Global crowd / rater programs',
      url: 'https://www.telusinternational.ai', accent: '#8b7cff',
      blurb: 'Long-running search and social evaluation programs. Projects can last years, which is genuinely rare ' +
        'in this category \u2014 and the reason people tolerate the rates.',
      rates: { advertised: 'undisclosed per program', actual: '$10\u201320/hr, US around $14\u201317', cap: 'monthly payout on a fixed cycle' },
      funnel: [
        ['Apply to a program', '1 hr', 'Rater, evaluator, or specialist track'],
        ['Qualifying exam', '1\u20132 hrs, often unpaid', 'Guideline-heavy'],
        ['Device + connectivity checks', 'per program', 'Some require a desktop and specific browser'],
        ['Training period', 'paid or unpaid depending on program', 'Ask before you commit'],
        ['Payout', 'monthly', 'Hyperwallet or direct bank']
      ],
      gates: ['Passing a guideline exam that is deliberately strict',
        'Staying inside a program\u2019s time-tracking rules',
        'Equipment requirements enforced during audits'],
      tasks: ['Search engine evaluation', 'Ads quality rating', 'Social media relevance', 'Map/local results',
        'Long-running moderation-adjacent review'],
      breaks: ['Drifting from the guideline as it gets updated mid-program', 'Unlogged time during audits'],
      payout: { rails: 'Hyperwallet \u00b7 direct bank', cadence: 'monthly', minimum: 'per program' },
      nigeria: { status: 'mostly open, 100+ countries', note: 'Program availability is the gate rather than country.' },
      practiceLabel: 'strict-guideline rating over a long horizon',
      preset: ['search-01', 'fact-01', 'rank-health-01', 'write-policy-01']
    })
  ];

  window.Platforms = {
    asOf: ASOF,
    all: P,
    get: function (id) { return P.filter(function (x) { return x.id === id; })[0] || null; },
    /* resolve a platform's practice set against the task corpus */
    tasksFor: function (id) {
      var p = this.get(id); if (!p) return null;
      var out = p.preset.map(function (tid) { return window.Tasks.get(tid); }).filter(Boolean);
      return out.length ? out : window.Tasks.list(false);
    }
  };
})();
