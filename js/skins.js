/* Platform skins — the chrome, vocabulary and per-view copy of each clone.
 *
 * A clone is DATA, not a hand-built page. That is the only way "all 12" stays honest: a second copy of the
 * editor markup would drift from the trainer's grading engine within a commit, and a clone whose scores
 * come from a different place than the real workspace is worse than no clone. So the renderer reads this
 * table, and the ONLY executable part of a clone is the same Tasks/Store/App code the paid workspace uses.
 *
 * What a skin may change: colours, wordmark, header, nav labels, section headings, stat labels, link
 * labels, the wording of the disabled payout step, and which task fields surface as columns.
 * What it may not: any scoring, any key handling, any network path. Those stay in the trainer.
 *
 * `practiceNotice` is load-bearing. This is a paid product's interface around an account that cannot be
 * paid: the notice is the one line that stops a learner mistaking a good clone for a job.
 */
(function (root) {
  'use strict';

  /* Inline line icons: the real UIs put a small stroke icon in a grey circle beside every section title,
     and an <img> would be a second asset to ship, to gate, and to fail. */
  var ICON = {
    wallet: '<path d="M3 7h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 7V6a2 2 0 0 1 2-2h9"/><circle cx="16" cy="12.5" r="1.2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    star: '<path d="M12 4.5l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10.2l5.4-.8z"/>',
    doc: '<path d="M7 3.5h6.5L18 8v12.5H7z"/><path d="M13 3.5V8h4.5"/><path d="M9.5 12.5h6M9.5 16h6"/>',
    users: '<circle cx="9" cy="9" r="2.6"/><path d="M4.5 18.5c.5-2.7 2.3-4.2 4.5-4.2s4 1.5 4.5 4.2"/><path d="M16 7.4a2.4 2.4 0 0 1 0 4.6"/><path d="M17.2 18.5c-.3-1.6-.9-2.7-1.8-3.4"/>',
    check: '<path d="M5 12.5l4.2 4.2L19 7.5"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4"/>',
    bolt: '<path d="M13.5 3.5L6 13.5h5l-1.5 7 8-10.5h-5z"/>',
    bank: '<path d="M4 10.5L12 5l8 5.5"/><path d="M6 10.5v7M10 10.5v7M14 10.5v7M18 10.5v7"/><path d="M4 20h16"/>'
  };

  var SKINS = {
    outlier: {
      id: 'outlier', label: 'Outlier', platformId: 'outlier',
      brand: { wordmark: 'Outlier', mark: 'o', tagline: '' },
      palette: {
        '--cl-bg': '#0a0d11', '--cl-card': '#14181f', '--cl-card2': '#191e26', '--cl-line': '#232a35',
        '--cl-txt': '#f2f5f9', '--cl-dim': '#8b98ab', '--cl-accent': '#ff5c1f', '--cl-accent2': '#ff7a45',
        '--cl-ok': '#34c98a', '--cl-warn': '#f5b13d', '--cl-bad': '#ff5f6d'
      },
      header: {
        /* the product's own queue nudge sits above the header, not in it */
        queueHint: 'This project is <b>{rank}st in your queue</b> <span class="chev">›</span>',
        nav: ['Projects', 'Similar projects', 'My tasks', 'Earnings', 'Help'],
        account: { initials: 'PR', label: 'practice@outlier' }
      },
      views: {
        projects: {
          title: 'Projects',
          intro: 'Projects open and close per squad without notice. A rate you can see is not a rate you can ' +
            'take: the number on the card is the deliverable rate, and the tasking cap below it is what decides ' +
            'your effective hour.',
          empty: 'No projects are open for your domain in this copy.',
          card: {
            stats: [
              { k: 'Total Earned', v: '{earned}', sub: 'Completed {done} tasks', icon: 'wallet' },
              { k: 'Task Completion Time', v: '{elapsed}', icon: 'clock' },
              { k: 'Avg. Feedback Score', v: '{avg}', icon: 'star' }
            ],
            overview: { title: 'Project Overview', icon: 'doc', cols: [
              { k: 'Deliverable rate', v: '{rate}/hr', info: 'Paid per accepted deliverable, converted from your time on it.' },
              { k: 'Assessment rate', v: '{rate}/hr', info: 'Screening work is unpaid on the real platform. Here it is timed too.' },
              { k: 'Est. time per task', v: '{est}', info: 'The tasking cap. Go past it and the rate is re-cut.' }
            ] },
            links: [
              { k: 'Assessment', v: '{assessment}' },
              { k: 'Skills', v: '{skills}' }
            ],
            actions: [{ t: 'View Pay Terms', icon: 'wallet', disabled: true, why: 'Pay terms live on the real platform.' },
                        { t: 'View Project Guidelines', icon: 'doc', href: 'guide.html' }]
          }
        },
        work: {
          title: 'My tasks',
          columns: ['Task', 'Skills', 'Rate', 'Cap', 'State'],
          cta: 'Open task',
          editor: { brief: 'Instructions', prompt: 'Prompt', answer: 'Your response',
                    flag: 'FLAG-GUIDELINE', submit: 'Submit task', selfCheck: 'Self-check before submit' },
          afterSubmit: 'Feedback is applied after review on the real platform. Here it is immediate, because ' +
            'the only thing on offer is the correction.'
        },
        earnings: {
          title: 'Earnings',
          stats: [
            { k: 'Total Earned', v: '{earned}', sub: 'Completed {done} tasks' },
            { k: 'Billable hours', v: '{hours}' },
            { k: 'Unpaid rework', v: '{unpaid}', warn: true }
          ],
          ledger: ['Task', 'Rate', 'Time', 'Would have earned', 'Verdict'],
          payout: {
            heading: 'Withdraw', icon: 'bank',
            balance: 'Available balance', methods: ['PayPal', 'Hyperwallet', 'Airtm'],
            cta: 'Withdraw funds', disabledLabel: 'Withdrawal disabled',
            body: 'Nothing is held in escrow here and there is no payment rail behind this account, so the ' +
              'balance above is a running total of the work you did, not money owed to you.'
          }
        }
      },
      practiceNotice: 'Practice account. Tasks, rubrics and grading are real; the account cannot be paid. ' +
        'No submission leaves this browser, and no earnings here exist anywhere else.',
      returnLabel: 'Back to the trainer'
    }
  };

  /* The other eleven, declared so the renderer never has to special-case a platform. Each is filled with the
     same shape as outlier; only the chrome differs, which is the point of the table. */
  function derive(id, o) {
    var base = SKINS.outlier;
    var s = JSON.parse(JSON.stringify(base));
    s.id = id; s.label = o.label; s.platformId = o.platformId;
    s.brand = { wordmark: o.wordmark, mark: o.mark, tagline: o.tagline || '' };
    Object.assign(s.palette, o.palette || {});
    s.header = Object.assign({}, base.header, o.header || {});
    if (o.nav) s.header.nav = o.nav;
    if (o.account) s.header.account = o.account;
    s.views.work.editor.submit = o.submitLabel || s.views.work.editor.submit;
    s.views.projects.card.actions[0].t = o.payTermsLabel || s.views.projects.card.actions[0].t;
    if (o.earningsTitle) s.views.earnings.title = o.earningsTitle;
    if (o.payoutHeading) s.views.earnings.payout.heading = o.payoutHeading;
    if (o.methods) s.views.earnings.payout.methods = o.methods;
    if (o.notice) s.practiceNotice = o.notice;
    SKINS[id] = s;
    return s;
  }
  derive('handshake', { label: 'Handshake AI', platformId: 'handshake', wordmark: 'Handshake', mark: 'H',
    palette: { '--cl-accent': '#1f5fd6', '--cl-accent2': '#4c8dff', '--cl-card': '#101725', '--cl-bg': '#080d16' },
    nav: ['Dashboard', 'Qualifications', 'Missions', 'Payments', 'Support'], submitLabel: 'Submit mission',
    earningsTitle: 'Payments', payoutHeading: 'Payout method', methods: ['Stripe', 'Bank transfer'],
    account: { initials: 'PR', label: 'practice@handshake' } });
  derive('rws', { label: 'RWS TrainAI', platformId: 'rws', wordmark: 'TrainAI', mark: 'T', tagline: 'by RWS',
    palette: { '--cl-accent': '#d92a2a', '--cl-accent2': '#ff6b6b', '--cl-bg': '#101014', '--cl-card': '#1a1a20' },
    nav: ['Home', 'Projects', 'My work', 'Finance', 'Guides'], submitLabel: 'Submit unit',
    earningsTitle: 'Finance', payoutHeading: 'Invoice', methods: ['Bank transfer', 'PayPal'],
    account: { initials: 'PR', label: 'practice@trainai' } });
  derive('alignerr', { label: 'Alignerr', platformId: 'alignerr', wordmark: 'Alignerr', mark: 'A',
    palette: { '--cl-accent': '#7b4dff', '--cl-accent2': '#a68bff', '--cl-bg': '#0b0a14', '--cl-card': '#15131f' },
    nav: ['Dashboard', 'Courses', 'Projects', 'Payouts', 'Community'], submitLabel: 'Submit for review',
    earningsTitle: 'Payouts', payoutHeading: 'Request payout', methods: ['PayPal', 'Wise'],
    account: { initials: 'PR', label: 'practice@alignerr' } });
  derive('dataannotation', { label: 'DataAnnotation', platformId: 'dataannotation', wordmark: 'DataAnnotation', mark: 'D',
    palette: { '--cl-bg': '#f6f7f9', '--cl-card': '#ffffff', '--cl-card2': '#f0f1f4', '--cl-line': '#e0e2e8',
      '--cl-txt': '#161a22', '--cl-dim': '#5b6472', '--cl-accent': '#2f6df6', '--cl-accent2': '#2f6df6' },
    header: { queueHint: '<b>{rank} new board items</b> waiting', account: { initials: 'PR', label: 'practice@dataannotation' } },
    nav: ['Boards', 'Skill test', 'Timeline', 'Payments'], submitLabel: 'Submit',
    earningsTitle: 'Payments', payoutHeading: 'Withdraw', methods: ['PayPal', 'AirTM'],
    notice: 'Practice account. The real DataAnnotation board pays weekly once your rating is established; here ' +
      'the same tasks are graded the same way and nothing is payable.' });
  derive('mercor', { label: 'Mercor', platformId: 'mercor', wordmark: 'Mercor', mark: 'M',
    palette: { '--cl-bg': '#0d0d0f', '--cl-card': '#17171b', '--cl-card2': '#1d1d22', '--cl-accent': '#2ad07b', '--cl-accent2': '#5ce49f' },
    nav: ['Interviews', 'Skills', 'Projects', 'Payments'], submitLabel: 'Submit response',
    earningsTitle: 'Payments', payoutHeading: 'Payout', methods: ['Wise', 'Bank'],
    account: { initials: 'PR', label: 'practice@mercor' } });
  derive('mindrift', { label: 'Mindrift', platformId: 'mindrift', wordmark: 'Mindrift', mark: 'Mi',
    palette: { '--cl-bg': '#0a0f1a', '--cl-card': '#131a28', '--cl-card2': '#18202f', '--cl-accent': '#4cc9f0', '--cl-accent2': '#7fdcf7' },
    nav: ['Projects', 'Assessments', 'Wallet', 'Help'], submitLabel: 'Submit task',
    earningsTitle: 'Wallet', payoutHeading: 'Withdraw', methods: ['USDT', 'Bank'],
    account: { initials: 'PR', label: 'practice@mindrift' } });
  derive('appen', { label: 'Appen', platformId: 'appen', wordmark: 'Appen', mark: 'A', tagline: 'Connect',
    palette: { '--cl-bg': '#0f1319', '--cl-card': '#181e27', '--cl-card2': '#1e252f', '--cl-accent': '#f47b20', '--cl-accent2': '#ff9a4d' },
    nav: ['Home', 'Qualifications', 'Jobs', 'Time reports', 'Payments'], submitLabel: 'Submit',
    earningsTitle: 'Time reports', payoutHeading: 'Payment', methods: ['Payoneer', 'Bank'],
    account: { initials: 'PR', label: 'practice@appen' } });
  derive('toloka', { label: 'Toloka', platformId: 'toloka', wordmark: 'Toloka', mark: 'T',
    palette: { '--cl-bg': '#0e1116', '--cl-card': '#171c24', '--cl-card2': '#1d232d', '--cl-accent': '#5c40e8', '--cl-accent2': '#8a74ff' },
    nav: ['Assignments', 'Requests', 'History', 'Wallet'], submitLabel: 'Done',
    earningsTitle: 'Wallet', payoutHeading: 'Withdraw', methods: ['Papara', 'Payoneer', 'Crypto'],
    account: { initials: 'PR', label: 'practice@toloka' } });
  derive('pareto', { label: 'Pareto.AI', platformId: 'pareto', wordmark: 'Pareto', mark: 'P',
    palette: { '--cl-bg': '#0b0d12', '--cl-card': '#141822', '--cl-card2': '#1a1f2b', '--cl-accent': '#e6b03c', '--cl-accent2': '#f2c961' },
    nav: ['Projects', 'Tests', 'Payouts'], submitLabel: 'Submit',
    earningsTitle: 'Payouts', payoutHeading: 'Payout request', methods: ['Wise', 'Crypto'],
    account: { initials: 'PR', label: 'practice@pareto' } });
  derive('prolific', { label: 'Prolific', platformId: 'prolific', wordmark: 'Prolific', mark: 'P',
    palette: { '--cl-bg': '#0d1017', '--cl-card': '#161b25', '--cl-card2': '#1c2230', '--cl-accent': '#00b8a2', '--cl-accent2': '#3fd5c2' },
    nav: ['Dashboard', 'Studies', 'Submissions', 'Withdraw'], submitLabel: 'Submit submission',
    earningsTitle: 'Withdraw', payoutHeading: 'Withdraw balance', methods: ['PayPal', 'Wise'],
    account: { initials: 'PR', label: 'practice@prolific' } });
  derive('telus', { label: 'TELUS Digital AI', platformId: 'telus', wordmark: 'TELUS Digital', mark: 'T', tagline: 'AI community',
    palette: { '--cl-bg': '#0f1217', '--cl-card': '#191d24', '--cl-card2': '#20252d', '--cl-accent': '#00b2a9', '--cl-accent2': '#42d3cb' },
    nav: ['Home', 'Rater portal', 'Qualifications', 'Payments'], submitLabel: 'Submit rating',
    earningsTitle: 'Payments', payoutHeading: 'Payment centre', methods: ['Payment service', 'Bank'],
    account: { initials: 'PR', label: 'practice@telus' } });

  root.Skins = {
    ICON: ICON,
    get: function (id) { return SKINS[id] || SKINS.outlier; },
    all: function () { return Object.keys(SKINS).map(function (k) { return SKINS[k]; }); },
    ids: function () { return Object.keys(SKINS); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
