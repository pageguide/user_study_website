// The Find V2 walkthrough: an intro, two practice tasks, and what each one's answer was.
// ======================================================================================
// WHY THIS EXISTS. A participant used to meet the mechanics on task 1 of 4 — the two clocks, the
// answer lock, hovering a step for the page behind it, and the fact that half the tasks deliberately
// show no evidence at all. Task 1's time is data. Learning the interface on it means the first row
// of every participant measures something different from the other three, and with only four tasks
// that is a quarter of the study spent on the screen rather than on the question.
//
// WHAT IT DOES NOT DO. It never shows a real stimulus, never explains a real task's answer and never
// writes a row. The practice material is invented (app/find_v2_tutorial_fixtures.js) and its results
// go nowhere: finishPracticeTask builds nothing, pushes nothing and leaves `S.state.idx` alone, so
// the real study still begins at task 1.
//
// IT RUNS OVER THE REAL SCREEN, not a mock-up of it. Both practice tasks are rendered by showTask,
// through the study's own renderers, timers and validation — so what is rehearsed is the thing that
// comes next rather than a diagram of it. The orientation is a card inserted at the top of the
// question pane naming the sections by the headings they actually carry, rather than V1's floating
// coachmarks: those pin the walkthrough to a list of CSS selectors, and a selector that goes stale
// fails silently, leaving a tour that points at nothing.
//
// SKIPPABLE FROM ANYWHERE. Someone who has done this before should not be made to sit through it,
// and someone lost partway through should not have to finish to escape.
//
// THE INTRO SAYS ALMOST NOTHING, on purpose. It used to carry three more lines — the answer lock and
// the time limit, that some tasks deliberately show no evidence, and that nothing is scored. Every
// one of those is said again where it applies and can be acted on: the two clocks are on screen
// during the task, the condition banner names the arm and explains it behind its ⓘ, and each
// debrief closes by saying the real tasks never tell you whether you were right. A screen a
// participant reads once, before any of it means anything, is the worst place to say them.

(function () {
  // Its own key. V1's walkthrough teaches a different instrument — an error taxonomy this study does
  // not ask — so having done that one is not having done this one.
  const DONE_KEY = 'pageguide_find_v2_tutorial_done';

  /**
   * ONCE PER RUN, NOT ONCE PER BROWSER.
   *
   * This used to store a permanent "seen it" flag, so the second participant to sit at a machine —
   * and every pilot session after the first — started at task 1 with no practice, while the first
   * one got two. A study that hands different participants different preparation has put a
   * difference into the data that nothing in the analysis can see.
   *
   * So the mark is the RUN it was taken in. Every new sitting is offered the walkthrough; a refresh
   * partway through task 1 is not, because the mark still names the run in progress and re-offering
   * it would drop somebody back into practice from the middle of the study.
   *
   * Kept out of the saved session on purpose: validParticipantSession pins a session version, so a
   * field there would force a bump that invalidates every in-flight run.
   */
  function currentRunId() {
    try { return String(S()?.state?.runId || ''); } catch (e) { return ''; }
  }

  function isDone() {
    const run = currentRunId();
    if (!run) return false;              // no run yet: nothing has been practised for it
    try { return localStorage.getItem(DONE_KEY) === run; } catch (e) { return false; }
  }
  function markDone() {
    const run = currentRunId();
    if (!run) return;
    try { localStorage.setItem(DONE_KEY, run); } catch (e) { /* private mode — not worth failing over */ }
  }
  function clearDone() {
    try { localStorage.removeItem(DONE_KEY); } catch (e) { /* ignore */ }
  }

  // `stage` is what Back reads. The walkthrough is five screens — the intro, then a practice task
  // and its answer for each of the two — and without a record of which one is up, Back would have to
  // guess from the panes.
  const tut = {
    active: false, idx: 0, queue: [], previewOnly: false, answers: [],
    stage: null,   // {kind: 'welcome' | 'explain' | 'practice' | 'debrief', idx}
  };

  const S = () => window.StudySession;

  /**
   * The deck's picture slides take the whole window.
   *
   * WHY THE PANEL GOES. These are full captures of BOTH panes with handwritten labels over them, so
   * a slide shown inside the left pane is a picture of a two-pane screen squeezed into two thirds of
   * one — the labels shrink to the point where the picture stops being readable and becomes
   * decoration. There is also nothing on the right worth keeping: during a picture the panel has no
   * question on it. The one-sentence opening slide keeps it, because there the panel is saying which
   * pane is which, which is exactly the orientation that slide is for.
   */
  function setWide(on) {
    document.body.classList.toggle('tut-wide', !!on);
  }
  const stimulusPane = () => document.getElementById('stimulus-pane');
  const questionPane = () => document.getElementById('question-pane');

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── The intro ──────────────────────────────────────────────────────────────────────────────────

  function renderWelcome() {
    stopTour();
    setWide(false);
    window.detachQuestionPane?.();
    document.body.classList.add('tut-on');
    document.body.classList.remove('tv-nogrounding');

    // THE INTRO PROMISES WHAT THE WALKTHROUGH DELIVERS. It used to name both kinds of task
    // unconditionally, so under the Guide-only design a participant was shown a FIND card
    // describing "a saved webpage" and then never met one — which reads as something having gone
    // wrong with the study rather than as a study that does not contain Find tasks.
    const withFind = dealsFindTasks();
    // COUNTED OFF THE QUEUE, not off `withFind`. Dropping the Find practice does not leave one task:
    // the Guide-only design still rehearses both conditions, so it leaves two. The old copy read the
    // Find flag as the count and promised "One practice task" in front of a two-task walkthrough.
    const count = practiceQueue().length;
    const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four'];
    const countWord = COUNT_WORDS[count] || String(count);

    stimulusPane().innerHTML = `
      <div class="tut-hero">
        <p class="tut-eyebrow">Before you start</p>
        <h1 class="tut-title">A quick walkthrough</h1>
        <p class="tut-lead">${countWord} test task${count === 1 ? '' : 's'}. Nothing here is recorded.</p>
        <p class="tut-kinds-lead">Each one opens with the <b>condition</b> it is in — what you are
          shown and what is withheld — and then hands you a <b>test task</b> to try it on. The test
          tasks are a playground: no clock, nothing scored, every control there to be pressed.</p>

        <div class="tut-kinds${withFind ? '' : ' is-single'}">
          ${withFind ? `<div class="tut-kind">
            <div class="tut-kind-head">FIND</div>
            <div class="tut-kind-body">
              <p class="tut-given"><b>Given:</b> a saved webpage, a question about it, and the
                answer an agent gave.</p>
              <p class="tut-task"><b>Task:</b> decide whether that answer is correct.</p>
            </div>
          </div>` : ''}
          <div class="tut-kind">
            <div class="tut-kind-head">GUIDE</div>
            <div class="tut-kind-body">
              <p class="tut-given"><b>Given:</b> a recording of an agent doing a task, and what it
                reported back afterwards.</p>
              <p class="tut-task"><b>Task:</b> decide whether it really did the job — and whether it
                reported truthfully what it did. You may also mark any steps that went wrong.</p>
            </div>
          </div>
        </div>

        <div class="tut-welcome-actions">
          <button class="welcome-btn" id="tut-v2-start">Start the walkthrough →</button>
          <button class="tut-nav-skip" id="tut-v2-skip">Skip — take me to task 1</button>
        </div>
      </div>`;

    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">👋 Welcome</span></div>
      <div class="q-body">
        <p class="q-sub">The questions appear on this side.</p>
      </div>`;

    tut.stage = { kind: 'welcome', idx: 0 };
    document.getElementById('tut-v2-start').onclick = start;
    document.getElementById('tut-v2-skip').onclick = skipAll;
    removeNav();
  }

  /**
   * Does this sitting contain a Find task at all?
   *
   * READ OFF THE DEALT QUEUE, not off the design flag. The question the practice has to answer is
   * "will this participant meet a Find task?", and the queue is that question's answer directly —
   * it is what they are actually about to be shown. Going via `queue_design` would be a second
   * derivation of the same fact, and it would be wrong for a run resumed from a session saved before
   * the design was recorded, which is a real state on real browsers today.
   *
   * The admin preview is the one case with no dealt queue — it deliberately builds none — so there
   * the design comes from the URL the Walkthrough tab built. An empty queue in any other
   * circumstance means nothing has been dealt yet, and rehearsing both beats withholding one.
   */
  function dealsFindTasks() {
    if (tut.previewOnly) {
      return new URLSearchParams(location.search).get('design') !== 'guide_visual_4';
    }
    const queue = S().state.queue || [];
    if (!queue.length) return true;
    return queue.some(task => task?.taskType !== 'guide');
  }

  /**
   * The practice tasks this sitting should rehearse.
   *
   * A WALKTHROUGH MUST NOT TEACH A SCREEN THE STUDY THEN WITHHOLDS — the same rule the milestone
   * flag already follows. Under the Guide-only design there is no Find task in the queue, so the
   * Find practice would spend a participant's first two minutes on a page layout, a question and a
   * set of gestures they will never see again, and would leave them expecting a saved webpage that
   * never arrives. Dropping it makes the walkthrough one practice task, and every count that reads
   * `tut.queue.length` — the progress label, Back, the "Next practice task" button — follows.
   */
  function practiceQueue() {
    const all = window.TutorialSource.tasks();
    return dealsFindTasks() ? all : all.filter(task => task?.taskType === 'guide');
  }

  function start() {
    tut.active = true;
    tut.idx = 0;
    tut.answers = [];
    tut.queue = practiceQueue();
    S().state.tutorial = tut;
    document.body.classList.remove('tut-on');
    goToTask(0);
  }

  /**
   * The walkthrough on its own, for a researcher checking it.
   *
   * Seeds just enough state for the practice tasks to render — the participant id says outright that
   * this is not a participant — and leaves by the door it came in rather than falling into a study
   * that was never started.
   */
  function preview() {
    Object.assign(S().state, {
      participantId: 'ADMIN-PREVIEW',
      arm: 'grounding',
      group: 'A',
      sessionId: null,
      queue: [],
      idx: 0,
      results: [],
      // NOT adminReview: that flag renders a Find task as the reviewer's read-only preview instead
      // of the questions, and the point of previewing a walkthrough is to walk it. Nothing is
      // written either way — the practice paths never build a row.
      adminReview: false,
    });
    tut.previewOnly = true;
    renderWelcome();
  }

  /** Leave the walkthrough, from the intro or from the bar. */
  function skipAll() {
    stopTour();
    setWide(false);
    tut.active = false;
    tut.queue = [];
    S().state.tutorial = null;
    removeNav();
    document.body.classList.remove('tut-on', 'tv-nogrounding');
    if (tut.previewOnly) { location.href = 'index.html'; return; }
    markDone();
    window.showTask();       // idx is untouched, so this is task 1 of 4
  }

  // ── What the condition means: a deck of annotated screens ──────────────────────────────────────
  //
  // WHY A SCREEN OF ITS OWN. The two arms are the experiment, and a participant used to meet them as
  // a chip at the top of a task — "GROUNDED", "NON-GROUNDED" — with the difference explained behind
  // an ⓘ that most people never press. So the first time somebody discovered that hovering a step
  // does nothing was on a task whose clock was running, and the honest reading of that screen ("no
  // evidence here, and that is the point") competed with the obvious one ("this page is broken").
  //
  // WHY A DECK OF PICTURES RATHER THAN A TOUR. This was briefly a set of coachmarks walking the live
  // screen, and the live screen is the wrong teacher for a gesture: a card can point AT the chips in
  // the answer, but it cannot show what pressing one does without the participant pressing it, and
  // half of them pressed Next instead. The annotated screenshots show the RESULT of each gesture —
  // the popup open, the evidence on screen — which is the part that has to be recognised later.
  //
  // ONE SENTENCE, THEN THE PICTURES. The opening slide says what the condition IS and nothing else;
  // everything procedural is a numbered picture behind it. A screen of prose read before any of it
  // means anything is a screen that gets skimmed to the button.
  //
  // ONE DECK PER ARM, BEFORE THE FIRST TEST TASK IN IT, and computed from the queue rather than
  // remembered in a flag: Back has to be able to land on these screens again, and a "seen it" flag
  // would mean stepping back past a test task silently changed what came after it.
  //
  // THE IMAGES ARE FILES, NOT DRAWINGS. They are annotated captures of this very interface, kept in
  // figures/tutorial/ and listed by name below, so replacing one after a layout change is dropping a
  // file rather than editing this module. A missing file renders as a labelled placeholder naming
  // the path it wants: a walkthrough that has lost a picture must say which one, not show a broken
  // image icon to a participant mid-study.

  // THE PICTURES ARE FILES ON DISK, in instructions/, annotated over this very interface. Kept out
  // of this module deliberately: after a layout change the fix is to re-capture a PNG and drop it
  // in, not to edit a walkthrough. The names are the running order — instruction_1 through
  // instruction_5 for the grounded arm, nongrounding_mode for the other — and lowercase because a
  // case-sensitive host will not find a capital that macOS happily served locally.
  const SHOT_DIR = 'instructions/';

  /**
   * THE PRIMER: what the two conditions ARE, before either of them is a condition.
   *
   * The decks that follow teach the SCREEN — where the chips are, what hovering a step does. That is
   * a different question from what the study is actually about, which is whether an agent's answer
   * can be checked against the page it came from at all. A participant who has only met "grounded"
   * as a purple chip at the top of a task reads it as a mode of the website; the point is that it is
   * a property of the ANSWER, and it exists outside this study.
   *
   * TWO PICTURES AND FOUR WORDS. Both figures carry their own headings and their own worked
   * examples, so anything written around them is a third telling of what they already show. The one
   * thing this screen adds is the pairing: these two, side by side, are the two conditions.
   *
   * SHOWN ONCE, on the first deck of the sitting, because it is about the study rather than about
   * the arm — repeating it before the second condition would say the same thing to somebody who has
   * just spent a test task inside one half of it.
   */
  const PRIMER = {
    title: 'What this study is about',
    left: {
      file: 'what_is_nongrounded.png',
      label: 'Non-grounded',
      alt: 'An agent answers a question and acts on a page without marking any evidence on it.',
    },
    right: {
      file: 'what_is_grounded.png',
      label: 'Grounded',
      alt: 'The same answers, with every claim anchored to a highlighted or boxed region of the page.',
    },
  };

  const DECKS = {
    grounding: {
      badge: 'Grounded',
      title: 'Grounded mode',
      // ONE SENTENCE. Everything else this arm has to say is in the five pictures behind it.
      lead: 'Every step the agent took comes with the page it was looking at when it took it — so '
        + 'everything it claims can be checked against what it actually saw.',
      shots: [
        {
          file: 'instruction_1.png',
          title: 'What is on the screen',
          caption: 'The task the agent was given and the answer it reported back are on the right. '
            + 'Its steps are on the left, and above them the button that replays the browsing.',
        },
        {
          file: 'instruction_2.png',
          title: 'Click a numbered chip in the answer',
          caption: 'The chips mark claims the agent backed with something it saw. Click [1] and the '
            + 'evidence behind that claim opens beside it.',
        },
        {
          file: 'instruction_3.png',
          title: 'Hover or click any step',
          caption: 'A popup shows the screenshot taken at that step, so you can check what the step '
            + 'says against the page it acted on.',
        },
        {
          file: 'instruction_4.png',
          title: 'Simulate the browsing',
          caption: 'Opens the run as a slideshow. It starts on the page the agent finished on, and '
            + 'Back walks you towards the first step.',
        },
        {
          file: 'instruction_5.png',
          title: 'Make your choice',
          caption: 'After seeing the evidence, decide whether the agent’s answer is correct — and '
            + 'optionally use Mark wrong beside any step that went astray.',
        },
      ],
    },
    nongrounding: {
      badge: 'Non-grounded',
      title: 'Non-grounded mode',
      lead: 'The same kind of run and the same question — but the evidence behind each step is '
        + 'withheld. Nothing is missing or broken: that is the condition.',
      shots: [
        {
          file: 'nongrounding_mode.png',
          title: 'What you have, and what you do not',
          caption: 'You still have the agent’s answer, every step it took, and the button that '
            + 'replays the browsing. What you cannot do is hover or click a step to see the '
            + 'screenshot behind it — there is none. Decide from what is here.',
        },
      ],
    },
  };

  /** The arm of the first deck this sitting will show — the one that carries the primer. */
  function firstDeckArm() {
    for (let i = 0; i < tut.queue.length; i++) {
      const arm = explainerArmFor(i);
      if (arm) return arm;
    }
    return null;
  }

  /**
   * A deck's slides, in order: the primer (first deck only), the one-sentence opening, the screens.
   *
   * Built rather than indexed by hand so that the numbering a participant reads — "3 of 5" — counts
   * the annotated screens and nothing else. The primer and the opening sentence are not step 1 and
   * step 2 of anything, and numbering them as such would make the five instructions look like seven.
   */
  function slidesOf(armName) {
    const deck = DECKS[armName];
    const slides = [];
    if (armName === firstDeckArm()) slides.push({ kind: 'compare' });
    slides.push({ kind: 'intro' });
    deck.shots.forEach((shot, i) => slides.push({ kind: 'shot', shot, n: i + 1 }));
    return slides;
  }

  function armOf(task) {
    return task?.arm === 'nongrounding' ? 'nongrounding' : 'grounding';
  }

  /**
   * The condition deck that opens test task `i`, or null when it opens with the task.
   *
   * GUIDE ONLY, and the first task of its arm. The decks are pictures of a trajectory screen; in
   * front of a Find practice they would annotate a screen the participant is not looking at, which
   * is the same failure as a walkthrough that teaches a task the study never deals. A Find task's
   * own condition banner still names its arm.
   */
  function explainerArmFor(i) {
    const task = tut.queue[i];
    if (!task || task.taskType !== 'guide') return null;
    const arm = armOf(task);
    for (let j = 0; j < i; j++) {
      const earlier = tut.queue[j];
      if (earlier?.taskType === 'guide' && armOf(earlier) === arm) return null;
    }
    return arm;
  }

  /** Move to test task `i`, through its condition deck when it has one. */
  function goToTask(i) {
    tut.idx = i;
    const arm = explainerArmFor(i);
    if (arm) return renderExplainer(arm, 0);
    setWide(false);
    document.body.classList.remove('tut-on');
    window.showTask();
  }

  /** Straight into the task the deck was explaining. */
  function leaveExplainer() {
    setWide(false);
    document.body.classList.remove('tut-on');
    window.showTask();
  }

  /**
   * One slide of a condition deck.
   *
   * The deck's own Back/Next move within it; the bar's Back does the same thing from outside, so a
   * participant who reaches for either finds the same behaviour rather than one of them jumping out
   * of the deck entirely.
   */
  function renderExplainer(armName, slide) {
    stopTour();
    window.detachQuestionPane?.();
    document.body.classList.add('tut-on');
    document.body.classList.remove('tv-nogrounding');

    const deck = DECKS[armName];
    const slides = slidesOf(armName);
    const at = Math.max(0, Math.min(Number(slide) || 0, slides.length - 1));
    const here = slides[at];
    const withheld = armName === 'nongrounding';
    const last = at === slides.length - 1;
    // The primer is two full figures side by side and wants the window as much as a capture does.
    setWide(here.kind !== 'intro');

    const body = here.kind === 'compare' ? primerHtml()
      : here.kind === 'shot' ? shotHtml(deck, here)
      : `
          <h1 class="tut-title">${esc(deck.title)}</h1>
          <p class="tut-lead">${esc(deck.lead)}</p>
          <p class="tut-fine">Next: ${deck.shots.length} annotated screen${deck.shots.length === 1
            ? '' : 's'} showing what that means, then a test task to try it on.</p>`;

    stimulusPane().innerHTML = `
      <div class="tut-hero tut-explain tut-deck">
        ${here.kind === 'compare' ? '' : `
          <p class="tut-eyebrow">Test task ${tut.idx + 1} of ${tut.queue.length} · the condition</p>
          <div class="tut-explain-badge ${withheld ? 'is-nongrounded' : 'is-grounded'}">
            <span class="tut-explain-dot" aria-hidden="true"></span>${esc(deck.badge)}</div>`}

        ${body}

        <div class="tut-deck-nav">
          <button class="tut-deck-btn" id="tut-v2-deck-back"${at === 0 ? ' hidden' : ''}>← Back</button>
          <div class="tut-deck-dots" aria-hidden="true">
            ${slides.map((unused, i) =>
              `<span class="tut-deck-dot${i === at ? ' is-on' : ''}"></span>`).join('')}
          </div>
          <button class="welcome-btn tut-deck-next" id="tut-v2-deck-next">${last
            ? 'Try it on the test task →' : 'Next →'}</button>
        </div>
      </div>`;

    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">📘 ${esc(deck.title)}</span></div>
      <div class="q-body">
        <p class="q-sub">The task, the agent’s answer and the Yes/No appear on this side. The
          agent’s run appears on the left.</p>
      </div>`;

    tut.stage = { kind: 'explain', idx: tut.idx, arm: armName, slide: at };
    renderNav(here.kind === 'compare'
      ? 'Before you start · grounded and non-grounded'
      : `Test task ${tut.idx + 1} of ${tut.queue.length} · what this condition means`);
    stimulusPane().scrollTop = 0;
    bindMissingShots();

    document.getElementById('tut-v2-deck-next').onclick = () =>
      (last ? leaveExplainer() : renderExplainer(armName, at + 1));
    const back = document.getElementById('tut-v2-deck-back');
    if (back) back.onclick = () => renderExplainer(armName, at - 1);
  }

  /** The two figures, side by side, labelled. Deliberately almost wordless — see PRIMER. */
  function primerHtml() {
    const cell = (side, tone) => `
      <figure class="tut-primer-cell ${tone}">
        <figcaption class="tut-primer-label">${esc(side.label)}</figcaption>
        <div class="tut-deck-figure" data-figure>
          <img src="${esc(SHOT_DIR + side.file)}" alt="${esc(side.alt)}"
            data-shot="${esc(SHOT_DIR + side.file)}">
        </div>
      </figure>`;
    return `
      <p class="tut-eyebrow">Before you start</p>
      <h1 class="tut-title">${esc(PRIMER.title)}</h1>
      <div class="tut-primer">
        ${cell(PRIMER.left, 'is-off')}
        ${cell(PRIMER.right, 'is-on')}
      </div>`;
  }

  function shotHtml(deck, here) {
    const src = SHOT_DIR + here.shot.file;
    return `
      <p class="tut-deck-step">${esc(deck.title)} · ${here.n} of ${deck.shots.length}</p>
      <h1 class="tut-deck-title">${esc(here.shot.title)}</h1>
      <p class="tut-deck-caption">${esc(here.shot.caption)}</p>
      <div class="tut-deck-figure" data-figure>
        <img src="${esc(src)}" alt="${esc(here.shot.title)}" data-shot="${esc(src)}">
      </div>
      <p class="tut-fine"><a href="${esc(src)}" target="_blank" rel="noopener">Open this picture
        full size ↗</a></p>`;
  }

  /**
   * A PLACEHOLDER, NAMED. The pictures are files on disk, and a file that has not been dropped in
   * yet must say which one it is waiting for — to a participant a broken image icon is a broken
   * study, and to whoever is setting this up it is a silent one.
   */
  function bindMissingShots() {
    stimulusPane().querySelectorAll('img[data-shot]').forEach(img => {
      img.onerror = () => {
        const figure = img.closest('[data-figure]');
        if (!figure) return;
        figure.classList.add('is-missing');
        figure.innerHTML = `<span>Picture not found — expected at
          <code>${esc(img.dataset.shot)}</code></span>`;
      };
    });
  }

  // ── The bar ────────────────────────────────────────────────────────────────────────────────────
  // Outside both panes, because every screen in the walkthrough rebuilds the pane it lives in — an
  // inline Skip button would be wiped by the next render, and on a practice task the question pane
  // belongs to the instrument.

  function renderNav(label) {
    let bar = document.getElementById('tut-v2-nav');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tut-nav';
      bar.id = 'tut-v2-nav';
      document.body.appendChild(bar);
    }
    const back = backLabel();
    bar.innerHTML = `
      ${back ? `<button class="tut-nav-back" id="tut-v2-nav-back">← ${esc(back)}</button>` : ''}
      <span class="tut-nav-label">${esc(label)}</span>
      <button class="tut-nav-skip" id="tut-v2-nav-skip">Skip the walkthrough</button>`;
    document.getElementById('tut-v2-nav-skip').onclick = skipAll;
    if (back) document.getElementById('tut-v2-nav-back').onclick = goBack;
  }

  /**
   * Where Back would take you, or '' when there is nowhere behind this screen.
   *
   * WHY BACK EXISTS AT ALL. The practice was one-way: answer the Find task and it is gone, whatever
   * you wanted to look at again — and the answer to the second one is easier to reach for after
   * re-reading the first. Nothing here is recorded, so there is no reason to lock it, and a
   * walkthrough somebody cannot retrace is one they have to get right first time, which is the
   * opposite of what practice is for.
   *
   * ONLY IN THE WALKTHROUGH. A real task is timed and one-way on purpose: how long a verdict took is
   * the measurement, and a Back button would let a participant re-open a task whose clock has stopped.
   */
  function backLabel() {
    const stage = tut.stage;
    if (!stage || stage.kind === 'welcome') return '';
    if (stage.kind === 'debrief') return 'Back to the task';
    // Inside a condition deck the bar's Back is the deck's Back, so the two controls on the screen
    // do not mean different things.
    if (stage.kind === 'explain' && stage.slide > 0) return 'Back';
    // A task that was opened by a condition deck goes back to it rather than past it: the screens
    // behind this one are the ones that say what the missing screenshots mean, and that is what
    // somebody stepping back on a non-grounded task is most likely reaching for.
    if (stage.kind === 'practice' && explainerArmFor(stage.idx)) return 'Back to what this means';
    return stage.idx === 0 ? 'Back to the start' : 'Back to the last answer';
  }

  function goBack() {
    const stage = tut.stage;
    if (!stage) return;
    stopTour();
    window.detachQuestionPane?.();   // a task left mid-question must stop its timers
    document.body.classList.remove('tv-nogrounding');

    // Back onto a practice task RE-RENDERS it from scratch, which restarts its clocks and clears the
    // answer that was given. That is the honest thing for practice — the alternative is a task that
    // looks live but is holding a stopped timer — and none of it is recorded either way.
    setWide(false);
    if (stage.kind === 'debrief') {
      tut.idx = stage.idx;
      // Straight to the task, not through the explainer again: Back from an answer screen means
      // "let me look at that task again", and re-reading the condition is one more press from there.
      document.body.classList.remove('tut-on');
      return window.showTask();
    }
    if (stage.kind === 'explain' && stage.slide > 0) {
      return renderExplainer(stage.arm, stage.slide - 1);
    }
    // Back onto the LAST slide of the deck, not its first: the screen behind the task is the last
    // thing that was on screen before it, and restarting the deck would make Back feel like a reset.
    if (stage.kind === 'practice' && explainerArmFor(stage.idx)) {
      const arm = explainerArmFor(stage.idx);
      return renderExplainer(arm, slidesOf(arm).length - 1);
    }
    if (stage.idx === 0) {
      tut.active = false;
      S().state.tutorial = null;
      return renderWelcome();
    }
    tut.idx = stage.idx - 1;
    document.body.classList.remove('tut-on');
    return showDebrief(tut.queue[tut.idx], tut.answers[tut.idx]);
  }

  function removeNav() {
    document.getElementById('tut-v2-nav')?.remove();
  }

  function currentTask() {
    return tut.queue[tut.idx] || null;
  }

  // "Test task", not "practice". The screens call it a test set and a playground; a bar that then
  // says "practice" is a second name for the same thing, and a participant has to work out that
  // they are the same thing rather than reading either.
  function progressLabel() {
    return `Test task ${tut.idx + 1} of ${tut.queue.length} · not recorded`;
  }

  // ── Orientation ────────────────────────────────────────────────────────────────────────────────
  // Inserted at the top of the question pane once the study has rendered it, so it sits above the
  // question it is about and scrolls with it. Named by the headings the screen actually carries
  // ("View Journey", "Reasoning trail") rather than by position, so it keeps describing the screen
  // even if the layout moves.

  // SHORT ON PURPOSE. A card that has to be read before the task can be started is read once,
  // quickly, and mostly not at all — so it carries only what a first-timer cannot work out by
  // looking: what the numbered marks do, and that the journey is worth opening.
  const FIND_POINTS = [
    ['The page is on the left', 'Scroll it; ⌘F works inside it.'],
    ['Hover a numbered mark', 'It highlights the sentence it points at.'],
  ];

  // The label is escaped and then wrapped in <b> by orientationHtml — so it is plain text here.
  // Markup in it renders as the tags themselves.
  const GUIDE_POINTS = [
    ['Open View Journey', 'Every step it took. Hover one to see the page behind it.'],
    ['Optional step marks', 'Use Mark wrong when you can identify an incorrect step.'],
    ['“No” covers two cases', 'It did not finish, or it claims something that did not happen.'],
  ];

  // THE SAME CARD, SAYING WHAT THIS ARM ACTUALLY DOES. The grounded line above promises a page
  // behind every step, and printing it over a non-grounded task told a participant to hover
  // something that does not respond — which is the one lesson this walkthrough exists to prevent.
  const GUIDE_POINTS_NG = [
    ['Read View Journey', 'Every step it took, in words. There is no page behind them in this condition.'],
    ['Simulate the browsing', 'The pages are still reachable here, as a stepped-back slideshow.'],
    ['Optional step marks', 'Use Mark wrong when you can identify an incorrect step.'],
    ['“No” covers two cases', 'It did not finish, or it claims something that did not happen.'],
  ];

  /**
   * The card that opens a practice task — and says outright that this one is the test set.
   *
   * A PLAYGROUND, NAMED AS ONE. "Practice · not recorded" was accurate and read as a formality: it
   * told a participant what the screen was FOR without telling them what they were allowed to DO on
   * it, and the observed result was people answering the practice task the way they would answer a
   * scored one — straight to Yes/No, without ever hovering a step, clicking a chip or opening the
   * simulator. They then met those controls for the first time on task 1, which is exactly the cost
   * the walkthrough exists to remove.
   *
   * So the card gives permission explicitly: nothing is recorded, no clock is running, and the
   * invitation is to try every control on the screen before answering. The list underneath is the
   * things to try, in the arm that actually has them.
   */
  function orientationHtml(task) {
    const find = task?.taskType === 'find';
    const points = find ? FIND_POINTS
      : (armOf(task) === 'nongrounding' ? GUIDE_POINTS_NG : GUIDE_POINTS);
    const arm = find ? '' : (armOf(task) === 'nongrounding' ? 'Non-grounded' : 'Grounded');
    // FOLDED SHUT. By the time this card is on screen the participant has just read the whole
    // condition deck, so open it took a third of the question pane to say again what they were told
    // a moment ago — and pushed the task, the answer and the Yes/No down below the fold, which is
    // the material the test task exists to let them play with. What has to stay visible is the one
    // line that says nothing here counts; the rest is there for somebody who wants it back.
    return `
      <details class="q-card tut-orient">
        <summary class="tut-orient-summary">
          <span class="q-badge">Test set</span>
          <span class="tut-orient-line">${find ? 'A FIND task' : 'A GUIDE task'}${arm
            ? ` · <b>${esc(arm)}</b>` : ''} — a playground. Nothing is recorded, and no clock
            is running.</span>
        </summary>
        <p class="tut-orient-invite">Now you have the chance to test this task out. <b>Try everything
          on the screen</b> before you answer — you cannot get it wrong here.</p>
        <ul class="tut-orient-list">
          ${points.map(([name, body]) => `<li><b>${esc(name)}</b> — ${body}</li>`).join('')}
        </ul>
      </details>`;
  }

  function onTaskRendered(task) {
    if (!tut.active) return;
    tut.stage = { kind: 'practice', idx: tut.idx };
    renderNav(progressLabel());
    const body = questionPane().querySelector('.q-body');
    if (body) body.insertAdjacentHTML('afterbegin', orientationHtml(task));
    questionPane().scrollTop = 0;
    // AFTER A TICK. The snapshot iframe mounts and marks its highlights asynchronously, so a tour
    // started in the same frame as the render finds no `.pageguide-highlight` and drops the step
    // that is arguably the most useful one on a Find task.
    // NO COACHMARKS ON A TASK A DECK HAS ALREADY EXPLAINED. The Guide test tasks now open behind an
    // annotated deck that shows every gesture and its result; running a spotlight over the same
    // five things afterwards says everything twice and puts an overlay between the participant and
    // the screen they were just invited to play with. The Find practice has no deck, so it keeps
    // its tour.
    if (task?.taskType !== 'find') return;
    setTimeout(() => {
      if (tut.active && tut.stage?.kind === 'practice') startTour(findTourSteps());
    }, 400);
  }

  // ── The coachmarks ─────────────────────────────────────────────────────────────────────────────
  //
  // A spotlight, an arrow and a card, walked with Back and Next. Every target is an element the
  // STUDY renders for itself — #q-task-card, #q-answer-card, .tv-journey, a highlighted passage
  // inside the page snapshot — so what is being pointed at is the thing that comes next rather than
  // a picture of it. The cost is that this file knows those selectors; the alternative is a
  // walkthrough that can quietly stop describing the study, so each one is checked before it is
  // pointed at and a step whose target is missing is skipped rather than left pointing at nothing.
  //
  // THE PAGE SNAPSHOT IS AN IFRAME, and the evidence a Find task is about lives inside it. A target
  // may therefore name a frame — {frame: '#find-page', sel: '.pageguide-highlight'} — and its rect
  // is the element's own plus the frame's offset. Same-origin by construction: the snapshot is
  // mounted with srcdoc precisely so it can be read.

  let tour = null;      // {steps, i}
  let tourFrame = 0;    // rAF handle for keeping the spotlight on a moving target

  function tourEls() {
    let root = document.getElementById('tut-v2-tour');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'tut-v2-tour';
    root.className = 'v2tour';
    root.innerHTML = `
      <div class="v2tour-hole" id="v2tour-hole"></div>
      <div class="v2tour-card" id="v2tour-card">
        <div class="v2tour-arrow" id="v2tour-arrow"></div>
        <div class="v2tour-step" id="v2tour-step"></div>
        <div class="v2tour-title" id="v2tour-title"></div>
        <div class="v2tour-body" id="v2tour-body"></div>
        <div class="v2tour-actions">
          <button class="q-btn q-btn-link" id="v2tour-back">← Back</button>
          <button class="q-btn q-btn-primary" id="v2tour-next">Next →</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#v2tour-back').onclick = () => tourGo(-1);
    root.querySelector('#v2tour-next').onclick = () => tourGo(1);
    return root;
  }

  /** The element a step points at, or null. Waits briefly: a pane may still be rendering. */
  function resolveTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    const host = document.querySelector(target.frame);
    const doc = host?.contentDocument;
    if (!doc) return null;
    const el = doc.querySelector(target.sel);
    return el ? { el, host } : null;
  }

  /** A target's rectangle in viewport coordinates, with the frame's offset added when it is in one. */
  function rectOf(found) {
    if (!found) return null;
    if (found.el && found.host) {
      const inner = found.el.getBoundingClientRect();
      const frame = found.host.getBoundingClientRect();
      return {
        top: frame.top + inner.top, left: frame.left + inner.left,
        width: inner.width, height: inner.height,
      };
    }
    const r = found.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function startTour(steps) {
    stopTour();
    const live = steps.filter(step => !!resolveTarget(step.target));
    if (!live.length) return;
    tour = { steps: live, i: 0 };
    document.body.classList.add('v2tour-on');
    paintTour();
  }

  function stopTour() {
    tour = null;
    if (tourFrame) { cancelAnimationFrame(tourFrame); tourFrame = 0; }
    document.getElementById('tut-v2-tour')?.remove();
    document.body.classList.remove('v2tour-on');
  }

  function tourGo(direction) {
    if (!tour) return;
    const next = tour.i + direction;
    if (next < 0) return;
    if (next >= tour.steps.length) return stopTour();   // past the last card: get on with the task
    tour.i = next;
    paintTour();
  }

  function paintTour() {
    if (!tour) return;
    const root = tourEls();
    const step = tour.steps[tour.i];
    const found = resolveTarget(step.target);
    if (!found) return tourGo(1);

    root.querySelector('#v2tour-step').textContent = `Step ${tour.i + 1} of ${tour.steps.length}`;
    root.querySelector('#v2tour-title').textContent = step.title;
    root.querySelector('#v2tour-body').innerHTML = step.body;
    root.querySelector('#v2tour-back').hidden = tour.i === 0;
    root.querySelector('#v2tour-next').textContent =
      tour.i === tour.steps.length - 1 ? 'Got it — let me answer' : 'Next →';

    // Scroll the target into view before measuring, or the first card on a pane that has been
    // scrolled lands on a rectangle that is no longer where it was.
    const scrollable = found.el ? found.host : found;
    try { scrollable.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }

    const place = () => {
      if (!tour) return;
      const r = rectOf(resolveTarget(step.target));
      if (r) position(root, r, step);
      tourFrame = requestAnimationFrame(place);
    };
    if (tourFrame) cancelAnimationFrame(tourFrame);
    place();
  }

  /**
   * The spotlight over the target and the card beside it.
   *
   * The card goes on whichever side has room, and the arrow points back at the target from wherever
   * the card ended up — a fixed side puts the card off-screen on a narrow window, and an arrow that
   * does not follow it points at nothing.
   */
  function position(root, r, step) {
    const pad = 6;
    const hole = root.querySelector('#v2tour-hole');
    hole.style.top = `${r.top - pad}px`;
    hole.style.left = `${r.left - pad}px`;
    hole.style.width = `${r.width + pad * 2}px`;
    hole.style.height = `${r.height + pad * 2}px`;

    const card = root.querySelector('#v2tour-card');
    const arrow = root.querySelector('#v2tour-arrow');
    const box = card.getBoundingClientRect();
    const gap = 18;
    const roomLeft = r.left, roomRight = window.innerWidth - (r.left + r.width);

    let side = step.place || (roomLeft > box.width + gap ? 'left'
      : roomRight > box.width + gap ? 'right'
      : r.top > box.height + gap ? 'top' : 'bottom');
    if (side === 'left' && roomLeft < box.width + gap) side = 'right';
    if (side === 'right' && roomRight < box.width + gap) side = 'left';

    let top, left;
    if (side === 'left' || side === 'right') {
      top = r.top + r.height / 2 - box.height / 2;
      left = side === 'left' ? r.left - box.width - gap : r.left + r.width + gap;
    } else {
      left = r.left + r.width / 2 - box.width / 2;
      top = side === 'top' ? r.top - box.height - gap : r.top + r.height + gap;
    }
    top = Math.max(12, Math.min(top, window.innerHeight - box.height - 12));
    left = Math.max(12, Math.min(left, window.innerWidth - box.width - 12));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;

    card.dataset.side = side;
    // The arrow sits on the card's edge nearest the target and is nudged along that edge to line up
    // with the target's centre, so it points at the thing rather than at the middle of the gap.
    if (side === 'left' || side === 'right') {
      const y = Math.max(14, Math.min(r.top + r.height / 2 - top, box.height - 14));
      arrow.style.top = `${y}px`;
      arrow.style.left = '';
    } else {
      const x = Math.max(14, Math.min(r.left + r.width / 2 - left, box.width - 14));
      arrow.style.left = `${x}px`;
      arrow.style.top = '';
    }
  }

  // ── What each task kind gets pointed at ────────────────────────────────────────────────────────
  // A `.pageguide-highlight` only exists in the grounded arm, and only once the snapshot has been
  // mounted and marked — so that step is dropped rather than pointed at an empty selector, which is
  // also what makes these lists safe to reuse for the non-grounded arm later.

  function findTourSteps() {
    return [
      {
        target: '#q-task-card',
        title: 'The question',
        body: 'What the agent was asked. Read it first — it usually has <b>two parts</b>, and both have to be right.',
      },
      {
        target: '#q-answer-card',
        title: 'The agent’s answer',
        body: 'The claim you are judging. The small numbers in it are references: hover one to see the sentence it points at, highlighted on the page.',
      },
      {
        target: { frame: '#find-page', sel: '.pageguide-highlight' },
        title: 'The evidence, on the page',
        body: 'This is the passage the answer says it used. Check that it really says what the answer claims — a reference shows you where the agent looked, not that it was right.',
      },
      {
        target: '#q-find-answer',
        title: 'Your verdict',
        body: 'Yes if the answer correctly answers the question, No if it does not. You can answer once the short wait is over.',
      },
    ];
  }

  // ── The debrief ────────────────────────────────────────────────────────────────────────────────

  /**
   * A practice task, answered.
   *
   * Nothing is built, pushed or written — `S.state.idx` stays where it was, so the real study still
   * begins at task 1. What the participant gets instead is the answer, which is the reason the
   * practice is worth doing at all: the mechanics can be learnt from any task, but what counts as a
   * No, and how much of the trajectory you have to read to find one, cannot.
   *
   * `payload.answer` is null when the task's own clock ran out, which is worth saying rather than
   * scoring — it is exactly what a real task does, and better met here.
   */
  function finishPracticeTask(task, payload) {
    const given = payload && typeof payload === 'object'
      ? { answer: payload.answer, markedWrongSteps: payload.markedWrongSteps || [] }
      : { answer: payload, markedWrongSteps: [] };
    tut.answers[tut.idx] = given;
    showDebrief(task, given);
  }

  /** The answer screen, drawn from what was given — so Back can return to it unchanged. */
  function showDebrief(task, given) {
    stopTour();
    window.detachQuestionPane?.();
    tut.stage = { kind: 'debrief', idx: tut.idx };

    const debrief = window.TutorialSource.debrief(task?.id);
    const last = tut.idx >= tut.queue.length - 1;
    const answer = given && typeof given === 'object' ? given.answer : given;
    const markedSteps = given && typeof given === 'object' && Array.isArray(given.markedWrongSteps)
      ? given.markedWrongSteps.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
    const expectedSteps = Array.isArray(debrief.wrongSteps)
      ? debrief.wrongSteps.slice().sort((a, b) => a - b) : [];
    const timedOut = answer == null;
    const right = !timedOut && String(answer) === debrief.verdict;
    const stepsRight = task?.taskType !== 'guide' || (markedSteps.length === expectedSteps.length
      && markedSteps.every((step, i) => step === expectedSteps[i]));
    const stepList = steps => steps.length ? `step${steps.length === 1 ? '' : 's'} ${steps.join(', ')}` : 'no steps';

    renderNav(`Test task ${tut.idx + 1} of ${tut.queue.length} · the answer`);
    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">✅ Test task ${tut.idx + 1} done</span></div>
      <div class="q-body">
        <div class="tut-debrief">
          ${timedOut
            ? `<p class="tut-verdict is-off"><span class="tut-verdict-mark">⏱</span>The clock ran out.
                A task nobody answers is stored as unanswered, not as a No.</p>`
            : verdictRow(right, right
              ? `You said ${String(answer).toUpperCase()} — right.`
              : `You said ${String(answer).toUpperCase()}. It is ${debrief.verdict.toUpperCase()}.`)}
          ${task?.taskType !== 'guide' ? '' : !markedSteps.length
            ? `<p class="q-sub">You left the optional step markers blank. In this practice, the wrong steps are ${stepList(expectedSteps)}.</p>`
            : verdictRow(stepsRight, stepsRight
              ? `You marked ${stepList(markedSteps)} — right.`
              : `You marked ${stepList(markedSteps)}. The wrong steps are ${stepList(expectedSteps)}.`)}
          <p class="q-text tut-debrief-answer">${esc(debrief.answer)}</p>
          <p class="q-sub">${debrief.why}${task?.taskType === 'find' ? '' : ` ${debrief.where}`}</p>
          ${task?.taskType === 'find'
            ? (debrief.hops || []).map(hop => `
                <div class="tut-fact">
                  <div class="tut-fact-label">${esc(hop.label)}</div>
                  <div class="tut-fact-text">${esc(hop.text)}</div>
                </div>`).join('')
            : ''}
          <p class="q-sub tut-debrief-closing">${debrief.closing}</p>
        </div>
        <div class="q-actions">
          <button class="q-btn q-btn-primary" id="tut-v2-next">${last
            ? 'Done — start task 1 →'
            : explainerArmFor(tut.idx + 1) === 'nongrounding' ? 'Next: the non-grounded condition →'
            : explainerArmFor(tut.idx + 1) ? 'Next: the grounded condition →'
            : 'Next test task →'}</button>
        </div>
      </div>`;

    document.getElementById('tut-v2-next').onclick = () => {
      if (last) return endTutorial();
      goToTask(tut.idx + 1);
    };
  }

  function verdictRow(ok, label) {
    return `<p class="tut-verdict ${ok ? 'is-ok' : 'is-off'}">
      <span class="tut-verdict-mark">${ok ? '✓' : '✗'}</span>${esc(label)}</p>`;
  }

  function endTutorial() {
    stopTour();
    setWide(false);
    document.body.classList.remove('tv-nogrounding');
    removeNav();
    tut.active = false;
    tut.queue = [];
    S().state.tutorial = null;
    if (tut.previewOnly) { location.href = 'index.html'; return; }
    markDone();
    window.showTask();
  }

  window.Tutorial = {
    isDone, markDone, clearDone,
    renderWelcome, preview, start, skipAll,
    currentTask, progressLabel, onTaskRendered, finishPracticeTask,
  };
}());
