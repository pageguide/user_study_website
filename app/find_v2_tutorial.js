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
    stage: null,   // {kind: 'welcome' | 'practice' | 'debrief', idx}
  };

  const S = () => window.StudySession;
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
    window.detachQuestionPane?.();
    document.body.classList.add('tut-on');
    document.body.classList.remove('tv-nogrounding');

    stimulusPane().innerHTML = `
      <div class="tut-hero">
        <p class="tut-eyebrow">Before you start</p>
        <h1 class="tut-title">A quick walkthrough</h1>
        <p class="tut-lead">Two practice tasks. Nothing here is recorded.</p>

        <div class="tut-kinds">
          <div class="tut-kind">
            <div class="tut-kind-head">FIND</div>
            <div class="tut-kind-body">
              <p class="tut-given"><b>Given:</b> a saved webpage, a question about it, and the
                answer an agent gave.</p>
              <p class="tut-task"><b>Task:</b> decide whether that answer is correct.</p>
            </div>
          </div>
          <div class="tut-kind">
            <div class="tut-kind-head">GUIDE</div>
            <div class="tut-kind-body">
              <p class="tut-given"><b>Given:</b> a recording of an agent doing a task, and what it
                reported back afterwards.</p>
              <p class="tut-task"><b>Task:</b> decide whether it really did the job — and whether it
                reported truthfully what it did.</p>
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

  function start() {
    tut.active = true;
    tut.idx = 0;
    tut.answers = [];
    tut.queue = window.TutorialSource.tasks();
    S().state.tutorial = tut;
    document.body.classList.remove('tut-on');
    window.showTask();
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
    tut.active = false;
    tut.queue = [];
    S().state.tutorial = null;
    removeNav();
    document.body.classList.remove('tut-on', 'tv-nogrounding');
    if (tut.previewOnly) { location.href = 'index.html'; return; }
    markDone();
    window.showTask();       // idx is untouched, so this is task 1 of 4
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
    if (stage.kind === 'debrief') {
      tut.idx = stage.idx;
      return window.showTask();
    }
    if (stage.idx === 0) {
      tut.active = false;
      S().state.tutorial = null;
      return renderWelcome();
    }
    tut.idx = stage.idx - 1;
    return showDebrief(tut.queue[tut.idx], tut.answers[tut.idx]);
  }

  function removeNav() {
    document.getElementById('tut-v2-nav')?.remove();
  }

  function currentTask() {
    return tut.queue[tut.idx] || null;
  }

  function progressLabel() {
    return `Practice ${tut.idx + 1} of ${tut.queue.length} · not recorded`;
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
    ['A “No” answer covers two cases', 'It did not finish, or its answer claims something that did not happen.'],
  ];

  function orientationHtml(task) {
    const find = task?.taskType === 'find';
    const points = find ? FIND_POINTS : GUIDE_POINTS;
    return `
      <div class="q-card tut-orient">
        <div class="q-card-head"><span class="q-badge">Practice</span>
          <p class="q-text">${find ? 'A FIND task' : 'A GUIDE task'} — not recorded.</p></div>
        <ul class="tut-orient-list">
          ${points.map(([name, body]) => `<li><b>${esc(name)}</b> — ${body}</li>`).join('')}
        </ul>
      </div>`;
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
    setTimeout(() => {
      if (tut.active && tut.stage?.kind === 'practice') {
        startTour(task?.taskType === 'find' ? findTourSteps() : guideTourSteps());
      }
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

  function guideTourSteps() {
    return [
      {
        target: '#q-task-card',
        title: 'The task the agent was given',
        body: 'What it was supposed to do. Everything on the left is what it actually did.',
      },
      {
        target: '.tv-journey',
        title: 'The journey',
        body: 'Every action it took, in order. <b>Hover a step</b> to see the page it was looking at when it acted, and click for a full-size view.',
      },
      {
        target: '.tv-answer',
        title: 'What it reported back',
        body: 'The claim you are judging. The numbered marks are references — click one to see the step it rests on. An agent can finish, sound certain, and describe something its own steps do not show.',
      },
      {
        target: '#q-find-answer',
        title: 'Your verdict',
        body: 'Did it complete the task? <b>No</b> covers two cases: it did not finish, <b>or</b> its answer claims something that did not happen.',
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
    const given = payload && typeof payload === 'object' ? payload.answer : payload;
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
    const timedOut = given == null;
    const right = !timedOut && String(given) === debrief.verdict;

    renderNav(`Practice ${tut.idx + 1} of ${tut.queue.length} · the answer`);
    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">✅ Practice ${tut.idx + 1} done</span></div>
      <div class="q-body">
        <div class="tut-debrief">
          ${timedOut
            ? `<p class="tut-verdict is-off"><span class="tut-verdict-mark">⏱</span>The clock ran out.
                A task nobody answers is stored as unanswered, not as a No.</p>`
            : verdictRow(right, right
              ? `You said ${String(given).toUpperCase()} — right.`
              : `You said ${String(given).toUpperCase()}. It is ${debrief.verdict.toUpperCase()}.`)}
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
            ? 'Done — start task 1 →' : 'Next practice task →'}</button>
        </div>
      </div>`;

    document.getElementById('tut-v2-next').onclick = () => {
      if (last) return endTutorial();
      tut.idx++;
      window.showTask();
    };
  }

  function verdictRow(ok, label) {
    return `<p class="tut-verdict ${ok ? 'is-ok' : 'is-off'}">
      <span class="tut-verdict-mark">${ok ? '✓' : '✗'}</span>${esc(label)}</p>`;
  }

  function endTutorial() {
    stopTour();
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
