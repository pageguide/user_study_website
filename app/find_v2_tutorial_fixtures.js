// The Find V2 walkthrough's practice material.
// ============================================
// TWO PRACTICE TASKS THAT ARE NOT IN THE STUDY, AND CANNOT BECOME PART OF IT. Every published claim
// and Guide task is `in_study=true` and reachable through the round robin, so there is no spare real
// item to practise on: borrowing one would mean some participants rehearse on a task they are later
// scored on, and nothing in the data would say which ones. These are hand-authored instead, on an
// invented subject — the Larkspur Community Pool — that no real stimulus touches. It is also not the
// Riverbend Public Library that V1's walkthrough uses, so somebody who has done both studies does
// not meet the same practice twice and read the second one from memory.
//
// THE SHAPES ARE THE REAL ONES — a claim row's answer variant, a page snapshot, and a
// pageguide_guide_v2_tasks trajectory — so the practice runs through the same renderers, the same
// two clocks, the same answer lock and the same validation a real task does. A mock-up of the task
// screen would teach a participant to use a screen they are about to stop seeing.
//
// BOTH PRACTICE TASKS ARE GROUNDED, and the walkthrough explains the non-grounded arm in words
// rather than rehearsing it. The one thing a practice run must not do is teach someone that a
// missing screenshot means they did something wrong: showing the evidence first, then saying it will
// sometimes be absent by design, is the order that leaves "I could not tell" available as an answer.
//
// ONE OF EACH VERDICT, deliberately. The Find practice is a correct answer and the Guide practice is
// not, because a walkthrough where the answer is No both times teaches that the answer is No.

(function () {
  // ── The Find practice ──────────────────────────────────────────────────────────────────────────
  // Two facts in two different places on the page, which is how a real claim is built. The page also
  // carries a weekday opening time and a season-pass price — the two things a careless reader grabs
  // instead — so checking the answer means finding the right sentence, not any sentence.

  const FIND_HOP_1 = 'On Saturdays and Sundays the pool opens at 6:30am, an hour earlier than on weekdays.';
  const FIND_HOP_2 = 'A single adult swim costs $5.40, and under-16s swim free before 9am.';

  const FIND_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Larkspur Community Pool — opening times and prices</title>
<style>
  body { margin: 0; font: 16px/1.65 Georgia, 'Times New Roman', serif; color: #23232b; background: #fff; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 28px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
  .sub { color: #6b6b76; font: 13px/1.5 -apple-system, sans-serif; margin: 0 0 28px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  p { margin: 0 0 16px; }
  .box { background: #f6f6fa; border-left: 3px solid #d7d7e0; padding: 12px 16px; margin: 24px 0;
         font: 14px/1.6 -apple-system, sans-serif; color: #4a4a55; }
</style></head>
<body><div class="wrap">
  <h1>Larkspur Community Pool</h1>
  <p class="sub">Opening times and prices · larkspurpool.example.org</p>

  <h2>When we are open</h2>
  <p>The pool runs from 7:30am to 9pm Monday to Friday, with the last entry half an hour before
  closing. ${FIND_HOP_1}</p>
  <p>Lane swimming has the first two hours of every morning to itself. The teaching pool opens at
  nine, and the sauna stays shut until noon at weekends.</p>

  <h2>What it costs</h2>
  <p>${FIND_HOP_2} A season pass is $54 for the quarter, which pays for itself at about ten swims.</p>
  <p>Lane bookings are free for pass holders and $2 otherwise. The lockers take a returnable coin.</p>

  <div class="box">Practice page — the Larkspur Community Pool is invented for this walkthrough.
  Nothing on this page is part of the study.</div>
</div></body></html>`;

  const FIND_TASK = {
    taskType: 'find',
    id: 'TUTORIAL-V2-FIND',
    isTutorial: true,
    studyVersion: 'find-v2',
    arm: 'grounding',
    style: 'find_text',
    type: 'FIND X TEXT',
    title: 'Larkspur Community Pool (practice)',
    question: 'When does the Larkspur pool open on a Saturday, and how much is a single adult swim?',
    url: 'https://larkspurpool.example.org/times',
    // The dealt cell, in the same fields the round robin writes. The practice is a CORRECT answer:
    // the verdict a participant should reach is Yes, and reaching it means checking both halves.
    claimCorrect: true,
    variantKey: 'correct_grounding',
    correctnessMode: 'balanced',
    answer: '',
    distractors: [],
  };

  // The citation syntax is the real one — [n:"the exact sentence"] — so the highlighting on the page
  // and the numbered chips in the answer are produced by the study's own renderer rather than faked.
  const FIND_ANSWER = {
    task_id: FIND_TASK.id,
    condition: 'grounding',
    variant_key: 'correct_grounding',
    claim_correct: true,
    url: FIND_TASK.url,
    question: FIND_TASK.question,
    answer_display: `The Larkspur pool opens at 6:30am on a Saturday[1:"${FIND_HOP_1}"], and a single `
      + `adult swim costs $5.40[2:"${FIND_HOP_2}"].`,
    answer_raw: 'The Larkspur pool opens at 6:30am on a Saturday, and a single adult swim costs $5.40.',
    citation_anchors: [],
    evidence: [],
  };

  const FIND_GROUND_TRUTH = {
    task_id: FIND_TASK.id,
    hops: {
      1: [{ text: FIND_HOP_1, url: FIND_TASK.url }],
      2: [{ text: FIND_HOP_2, url: FIND_TASK.url }],
    },
  };

  // SHORT. The debrief is read standing at a task the participant wants to get on with, and a wall
  // of explanation is skimmed to the button. One line for the verdict, one for why, and the two
  // sentences on the page that settle it.
  const FIND_DEBRIEF = {
    verdict: 'yes',
    answer: 'Yes — both halves check out.',
    why: 'The question asks two things, so both have to be right.',
    hops: [
      { label: 'Opening time', text: FIND_HOP_1 },
      { label: 'Price', text: FIND_HOP_2 },
    ],
    closing: 'A numbered mark shows where the agent looked, not that it was right.',
  };


  // ── The Guide practice ─────────────────────────────────────────────────────────────────────────
  // A MISREPORTED RUN, which is the failure the study most cares about: the agent finishes, sounds
  // certain, and says something its own steps do not support. Step 3 opens the SUNDAY 7am session
  // while the instruction names Saturday, and the answer then reports a booking reference that
  // appears nowhere in the run at all.
  //
  // Legible without argument, on purpose. The instruction names one row, the highlight in the
  // screenshot sits on a different row, and the final URL says `?session=sun-0700`. A participant can
  // check the claim against the picture rather than reason about intent — practising on an
  // unambiguous one is what makes the judgement cheap. The real tasks supply the arguable cases.

  const GUIDE_ROWS = [
    'Sat 06:30 — Early lanes (4 free)',
    'Sat 07:00 — Lane swim (2 free)',
    'Sun 07:00 — Lane swim (6 free)',
    'Sat 09:00 — Teaching pool (full)',
  ];

  function shot(step, highlight) {
    return window.FakePage.drawFakePage({
      title: `Larkspur Pool — lane bookings (step ${step})`,
      rows: GUIDE_ROWS,
      highlight,
      host: 'larkspurpool.example.org',
    });
  }

  let guideRecord = null;

  function buildGuideRecord() {
    return {
      id: 'TUTORIAL-V2-GUIDE',
      goal: 'Book a lane at the 7am Saturday swim and tell me the booking reference.',
      title: 'Saturday 7am lane booking',
      guide_ground_truth: {
        correct: false,
        correctness: 'failure',
        problems: ['hallucinated_result'],
        problem: 'It reported a booking reference that appears nowhere in the run.',
        no_error: false,
      },
      arms: {
        grounding: {
          initial_state: { screenshot: shot(0, -1), url: 'https://larkspurpool.example.org' },
          final_state: { screenshot: shot(4, 2), url: 'https://larkspurpool.example.org/book?session=sun-0700' },
          steps: [
            { n: 1, instruction: "Open the Larkspur pool's lane booking page.", screenshot: shot(1, -1) },
            { n: 2, instruction: 'Compare the sessions listed for this weekend.', screenshot: shot(2, -1) },
            { n: 3, instruction: "Click the Saturday 07:00 lane swim to book it.", screenshot: shot(3, 2) },
            { n: 4, instruction: 'Confirm the booking and read back the reference.', screenshot: shot(4, 2) },
          ],
          // THE ANSWER'S REFERENCES, POINTING BACK AT THE STEPS. A real grounded Guide answer carries
          // [ev:key] markers, which render as the numbered chips beside the answer, and phrases
          // linked to a step, which render underlined. Without them the practice taught a screen
          // with no references on it and then dropped a participant into tasks that have them.
          //
          // AND THEY ARE WHERE THE RUN COMES APART. Chip 1 opens step 3 — the session it actually
          // clicked, which is the SUNDAY row. Chip 2 opens step 4, the page it read the reference
          // off, where no reference appears at all. A participant who opens either one can see the
          // misreport rather than having to take the trail's word for it.
          answer: 'Booked. You have a lane at the 7am Saturday swim [ev:sat_session], and the booking reference is LK-4417 [ev:confirmation].',
          answer_evidence: [
            { key: 'sat_session', step: 3, note: 'The session it opened at step 3.', screenshot: shot(3, 2) },
            { key: 'confirmation', step: 4, note: 'The page it read the reference off, at step 4.', screenshot: shot(4, 2) },
          ],
          // An underlined phrase resolves to its step's own screenshot — the second way a grounded
          // answer can be checked, and the one a participant meets by hovering rather than clicking.
          answer_segments: [
            { phrase: 'the 7am Saturday swim', step: 3, note: 'Step 3 — the session it actually opened.' },
          ],
          trail: {
            summary: 'I opened the booking page, compared the weekend sessions and booked the 7am lane swim.',
            milestones: [
              { step: 2, text: 'Listed the weekend sessions.' },
              { step: 3, text: 'Selected the 7am lane swim.' },
            ],
          },
        },
        // Left null on purpose. The practice is grounded, and _stripGuideArm would derive the other
        // arm at render if it were ever asked for — see app/stimulus.js.
        nongrounding: null,
      },
    };
  }

  const GUIDE_TASK = {
    taskType: 'guide',
    id: 'TUTORIAL-V2-GUIDE',
    isTutorial: true,
    studyVersion: 'find-v2',
    arm: 'grounding',
    style: 'guide_text',
    type: 'GUIDE × TEXT',
    title: 'Saturday 7am lane booking',
    goal: 'Book a lane at the 7am Saturday swim and tell me the booking reference.',
    question: 'Book a lane at the 7am Saturday swim and tell me the booking reference.',
    agentCompleted: false,
    claimCorrect: false,
    variantKey: 'incorrect_grounding',
  };

  const GUIDE_DEBRIEF = {
    verdict: 'no',
    answer: 'No — it says it booked a lane, but it did not.',
    why: 'The reference <b>LK-4417</b> appears nowhere in the run.',
    where: 'Open the first numbered reference in the answer: step 3 names the <b>Saturday</b> 07:00 swim, and the screenshot highlights the <b>Sunday</b> one.',
    closing: '“No” covers two cases: it did not finish, or it claims something that did not happen.',
  };


  // ── The data source ────────────────────────────────────────────────────────────────────────────
  // The same interface study.js calls on StudyDB, so a practice task travels the ordinary code path
  // and never touches the network. The writers exist and deliberately do nothing: a practice answer
  // that reached the results table would be indistinguishable from a real one.

  window.TutorialSource = {
    isTutorialTask(task) { return !!task?.isTutorial; },
    tasks() { return [FIND_TASK, GUIDE_TASK]; },
    debrief(taskId) { return taskId === FIND_TASK.id ? FIND_DEBRIEF : GUIDE_DEBRIEF; },

    async getCannedResponse(taskId, condition) {
      if (taskId !== FIND_TASK.id) return null;
      return Object.assign({}, FIND_ANSWER, { condition: condition || 'grounding' });
    },
    async getStudyGroundTruth(taskId) {
      return taskId === FIND_TASK.id ? FIND_GROUND_TRUTH : null;
    },
    async getTaskPage(taskId) {
      if (taskId !== FIND_TASK.id) return null;
      return { task_id: taskId, url: FIND_TASK.url, title: 'Larkspur Community Pool', html: FIND_PAGE_HTML };
    },
    async getGuideTrajectory(id) {
      if (id !== GUIDE_TASK.id) return null;
      // Built once. The screenshots are drawn onto a canvas, and redrawing them on every render
      // would rebuild five JPEGs each time the participant steps back through the walkthrough.
      if (!guideRecord) guideRecord = buildGuideRecord();
      return guideRecord;
    },
    async insertStudyResult() { return true; },   // practice is never recorded
    async insertGuideResult() { return true; },
  };
}());
