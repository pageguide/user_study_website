// The tutorial's practice material.
// =================================
// TWO PRACTICE TASKS THAT ARE NOT IN THE STUDY, and cannot become part of it. Every published row in
// `study_tasks` and `study_guide_trajectories` is `in_study=true` and reachable through the
// round-robin, so there is no spare real task to practise on: borrowing one would mean some
// participants rehearse on a task they are later scored on. These are hand-authored instead, on a
// deliberately invented subject (the Riverbend Public Library) that no real stimulus touches.
//
// The SHAPES are the real ones — a study_task_pages row, a study_canned_responses row, a
// study_ground_truth row and a study_guide_trajectories row — so the practice runs through the same
// renderers, the same timers, the same validation and the same scorers a real task does. A mock-up
// of the task screen would teach a participant to use a screen they are about to stop seeing.
//
// BOTH PRACTICE TASKS ARE GROUNDED. The tutorial explains the non-grounded condition in words (see
// the condition coachmark in app/tutorial.js) rather than rehearsing it, because the one thing a
// practice run must not do is teach someone that a missing screenshot means they did something
// wrong. Showing them the evidence, then telling them it will sometimes be absent by design, is the
// order that leaves "I could not tell" available as an answer.

// ── The Find practice ────────────────────────────────────────────────────────────────────────────
// Two facts, in two different paragraphs, exactly as a real two-hop Find question is built: the
// opening year is in the history, the branch count is in the section below it. The participant has
// to point at both, which is the interaction the real study is hardest to do cold.

const TUTORIAL_FIND_HOP_1 =
  'The Riverbend Public Library opened its doors in 1908, in a converted grain warehouse on Mill Street.';
const TUTORIAL_FIND_HOP_2 =
  'Today the system runs six branches, from the Mill Street building to the mobile stop at Halloway Farm.';

const TUTORIAL_FIND_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Riverbend Public Library — a short history</title>
<style>
  body { margin: 0; font: 16px/1.65 Georgia, 'Times New Roman', serif; color: #23232b;
         background: #fff; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 28px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
  .sub { color: #6b6b76; font: 13px/1.5 -apple-system, sans-serif; margin: 0 0 28px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  p { margin: 0 0 16px; }
  .box { background: #f6f6fa; border-left: 3px solid #d7d7e0; padding: 12px 16px; margin: 24px 0;
         font: 14px/1.6 -apple-system, sans-serif; color: #4a4a55; }
</style></head>
<body><div class="wrap">
  <h1>Riverbend Public Library</h1>
  <p class="sub">A short history · riverbendlibrary.example.org</p>

  <h2>Beginnings</h2>
  <p>${TUTORIAL_FIND_HOP_1} The building had stood empty for a decade, and the shelves for its first
  four thousand volumes were built from the warehouse's own floorboards.</p>
  <p>Funding came from a subscription drive rather than a single benefactor, which is why the reading
  room carries no name over its door. The librarians of that first year recorded 212 borrowers.</p>

  <h2>Growth</h2>
  <p>A second reading room was added in 1936, and the children's collection moved into it the
  following spring. The Oakvale branch followed after the war, in a former fire station.</p>
  <p>${TUTORIAL_FIND_HOP_2} The mobile stop keeps the shortest hours of any of them, and closes at
  four on a Friday afternoon.</p>

  <div class="box">Practice page — the Riverbend Public Library is invented for this walkthrough.
  Nothing on this page is part of the study.</div>
</div></body></html>`;

const TUTORIAL_FIND_TASK = {
  taskType: 'find',
  id: 'TUTORIAL-FIND',
  isTutorial: true,
  arm: 'grounding',
  style: 'find_text',
  type: 'FIND x TEXT',
  title: 'Riverbend Public Library (practice)',
  question: 'When did the Riverbend Public Library open, and how many branches does it have today?',
  url: 'https://riverbendlibrary.example.org/history',
  answer: 'It opened in 1908 and has six branches today.',
  distractors: [
    'It opened in 1908 and has three branches today.',
    'It opened in 1936 and has six branches today.',
    'It opened in 1936 and has eleven branches today.',
  ],
};

// The citation syntax is the real one — [n:"the exact sentence"] — so the grounded highlighting on
// the page and the numbered chips in the answer are produced by applyFindGrounding and
// renderFindAnswer rather than faked for the tutorial.
const TUTORIAL_FIND_CANNED = {
  task_id: 'TUTORIAL-FIND',
  condition: 'grounding',
  answer_display: `The Riverbend Public Library opened in 1908[1:"${TUTORIAL_FIND_HOP_1}"], and the `
    + `system runs six branches today[2:"${TUTORIAL_FIND_HOP_2}"].`,
  answer_raw: 'The Riverbend Public Library opened in 1908, and the system runs six branches today.',
  citation_anchors: [],
  evidence: [],
};

const TUTORIAL_FIND_GROUND_TRUTH = {
  task_id: 'TUTORIAL-FIND',
  hops: {
    1: [{ text: TUTORIAL_FIND_HOP_1, url: TUTORIAL_FIND_TASK.url }],
    2: [{ text: TUTORIAL_FIND_HOP_2, url: TUTORIAL_FIND_TASK.url }],
  },
};

const TUTORIAL_FIND_DEBRIEF = {
  answer: TUTORIAL_FIND_TASK.answer,
  why: 'Both halves of the question have to be right: the year AND the number of branches. Three of '
    + 'the four options get one half right, which is what makes reading the page worth the time.',
  hops: [
    { label: 'First part: the year', text: TUTORIAL_FIND_HOP_1 },
    { label: 'Second part: the branches', text: TUTORIAL_FIND_HOP_2 },
  ],
  closing: 'In the real tasks the answer will not always be right, and half of them will show you no '
    + 'highlights at all. Point at what you actually used.',
};

// ── The Guide practice ───────────────────────────────────────────────────────────────────────────
// One clear, findable failure, with the evidence for it visible in the step screenshots: at step 3
// the agent SAYS it is clicking 'Riverbend East' and instead opens the Halloway Farm stop — which
// closes at 4pm — and then reports a "Riverbend Central Annex" that appears nowhere in the list.
//
// THE ERROR IS `wrong_target`, and the step is legible as one without argument: the instruction
// names one row, the highlight in the screenshot sits on a different row, and the final URL says
// `?branch=halloway`. The vendored vocabulary defines wrong target as "clicked the wrong element",
// which is exactly what happened — the participant can check the claim against the picture rather
// than reason about intent. Practising on an unambiguous one is what makes the judgement call
// cheap; the real tasks supply the arguable cases.

const TUTORIAL_GUIDE_ROWS = [
  'Mill Street (Main) — Fri 9am – 9pm',
  'Oakvale Branch — Fri 9am – 6pm',
  'Halloway Farm stop — Fri 1pm – 4pm',
  'Riverbend East — Fri 10am – 7pm',
];

function tutorialShot(step, highlight) {
  return window.FakePage.drawFakePage({
    title: `Riverbend Library — hours (step ${step})`,
    rows: TUTORIAL_GUIDE_ROWS,
    highlight,
    host: 'riverbendlibrary.example.org',
  });
}

function buildTutorialGuideRecord() {
  return {
    id: 'TUTORIAL-GUIDE',
    goal: 'Find which Riverbend Library branch is open latest on a Friday, and save it to my list.',
    title: 'Latest-opening branch on a Friday',
    condition: 'visual',
    ground_truth: {
      correctness: 'failure',
      problems: ['hallucinated_result'],
      problem: 'It reported a "Riverbend Central Annex" that appears nowhere in the hours list.',
      errors: [{ type: 'wrong_target', steps: [3] }],
      no_error: false,
    },
    arms: {
      grounding: {
        initial_state: {
          screenshot: tutorialShot(0, -1),
          url: 'https://riverbendlibrary.example.org',
        },
        final_state: {
          screenshot: tutorialShot(4, 2),
          url: 'https://riverbendlibrary.example.org/hours?branch=halloway',
        },
        steps: [
          { n: 1, instruction: "Type 'Riverbend Library' into the search bar.", screenshot: tutorialShot(1, -1) },
          { n: 2, instruction: "Open the 'Hours' tab to compare the branches.", screenshot: tutorialShot(2, -1) },
          { n: 3, instruction: "Click 'Riverbend East' to check its Friday hours.", screenshot: tutorialShot(3, 2) },
          { n: 4, instruction: 'Report the branch that is open latest.', screenshot: tutorialShot(4, 2) },
        ],
        answer: 'The branch open latest on a Friday is the Riverbend Central Annex, which closes at 9pm.',
        answer_evidence: [],
        answer_segments: [],
        trail: {
          summary: 'I searched for the library, opened the hours tab and compared the Friday closing times.',
          milestones: [
            { step: 2, text: 'Opened the hours tab.' },
            { step: 3, text: 'Checked a branch\'s Friday hours.' },
          ],
        },
        questions: window.GUIDE_STUDY_QUESTIONS,
      },
      nongrounding: null,
    },
  };
}

const TUTORIAL_GUIDE_TASK = {
  taskType: 'guide',
  id: 'TUTORIAL-GUIDE',
  isTutorial: true,
  arm: 'grounding',
  style: 'guide_visual',
  condition: 'visual',
  title: 'Latest-opening branch on a Friday',
  goal: 'Find which Riverbend Library branch is open latest on a Friday, and save it to my list.',
};

const TUTORIAL_GUIDE_DEBRIEF = {
  verdict: false,
  problems: ['hallucinated_result'],
  errorType: 'wrong_target',
  errorLabel: 'wrong target / misclick',
  step: 3,
  why: 'The agent reported the "Riverbend Central Annex", and no such branch appears anywhere in '
    + 'the hours list it was looking at. It made the result up, so it did not complete the task.',
  where: 'Step 3 says "Click \'Riverbend East\'", but the row highlighted in the screenshot is the '
    + 'Halloway Farm stop, and the page it lands on is ?branch=halloway. So it read the wrong '
    + 'row\'s hours of 1pm to 4pm, when Mill Street (Main) is the one open until 9pm.',
  nuance: 'That is a wrong target rather than an action–goal mismatch: opening a branch\'s hours is '
    + 'exactly the right kind of move here, and the agent simply hit a different row than the one '
    + 'it named. "Action–goal mismatch" is for an action that lands where it intended and still '
    + 'does not serve the goal.',
  closing: 'Three separate judgements, and the last two are the harder ones: noticing something is '
    + 'wrong, pointing at the step, then naming the kind of error.',
};

// ── The data source ──────────────────────────────────────────────────────────────────────────────
// The same interface study.js calls on StudyDB, so a practice task travels the ordinary code path
// and never touches the network. insertStudyResult exists and deliberately does nothing: a practice
// answer that reached study_task_results_v2 would be indistinguishable from a real one.

let tutorialGuideRecord = null;

window.TutorialSource = {
  isTutorialTask(task) {
    return !!task?.isTutorial;
  },
  tasks() {
    return [TUTORIAL_FIND_TASK, TUTORIAL_GUIDE_TASK];
  },
  debrief(taskId) {
    return taskId === 'TUTORIAL-FIND' ? TUTORIAL_FIND_DEBRIEF : TUTORIAL_GUIDE_DEBRIEF;
  },
  async getStudyTrajectory(id) {
    if (id !== 'TUTORIAL-GUIDE') return null;
    // Built once: the screenshots are drawn onto a canvas, and redrawing them for every render
    // would rebuild four JPEGs each time the participant steps back through the tour.
    if (!tutorialGuideRecord) tutorialGuideRecord = buildTutorialGuideRecord();
    return tutorialGuideRecord;
  },
  async getCannedResponse(taskId, condition) {
    if (taskId !== 'TUTORIAL-FIND') return null;
    return Object.assign({}, TUTORIAL_FIND_CANNED, { condition: condition || 'grounding' });
  },
  async getStudyGroundTruth(taskId) {
    return taskId === 'TUTORIAL-FIND' ? TUTORIAL_FIND_GROUND_TRUTH : null;
  },
  async getTaskPage(taskId) {
    if (taskId !== 'TUTORIAL-FIND') return null;
    return { task_id: taskId, url: TUTORIAL_FIND_TASK.url, html: TUTORIAL_FIND_PAGE_HTML };
  },
  async insertStudyResult() {
    return true;   // practice is never recorded
  },
};
