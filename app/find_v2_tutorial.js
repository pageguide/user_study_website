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

(function () {
  // Its own key. V1's walkthrough teaches a different instrument — an error taxonomy this study does
  // not ask — so having done that one is not having done this one.
  const DONE_KEY = 'pageguide_find_v2_tutorial_done';

  // Not in the saved session, deliberately: validParticipantSession pins a session version, so a
  // field here would force a bump that invalidates every in-flight run. A refresh mid-walkthrough
  // offers it again rather than resuming it half-done, which is the right behaviour for practice.
  function isDone() {
    try { return localStorage.getItem(DONE_KEY) === 'yes'; } catch (e) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(DONE_KEY, 'yes'); } catch (e) { /* private mode — not worth failing over */ }
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
    window.detachQuestionPane?.();
    document.body.classList.add('tut-on');
    document.body.classList.remove('tv-nogrounding');

    stimulusPane().innerHTML = `
      <div class="tut-hero">
        <p class="tut-eyebrow">Before you start</p>
        <h1 class="tut-title">A quick walkthrough</h1>
        <p class="tut-lead">Two practice tasks. Nothing here is recorded, and neither is one of your
          four.</p>

        <div class="tut-kinds">
          <div class="tut-kind">
            <div class="tut-kind-head">FIND</div>
            <!-- WRAPPED IN .tut-kind-body, which is where the padding lives. A bare <p> inside
                 .tut-kind sits against the card's edge. -->
            <div class="tut-kind-body">
              <p class="tut-kind-fine">A saved webpage, and an answer an agent gave about it.</p>
              <p class="tut-kind-what">Verify the answer against the page.</p>
            </div>
          </div>
          <div class="tut-kind">
            <div class="tut-kind-head">GUIDE</div>
            <div class="tut-kind-body">
              <p class="tut-kind-fine">A recording of an agent doing a task, and what it reported back.</p>
              <p class="tut-kind-what">Verify that it finished — and that it reported truthfully
                what it did.</p>
            </div>
          </div>
        </div>

        <ol class="tut-list">
          <li>There is a short wait before you can answer, and a time limit.</li>
          <li>Some tasks show no evidence at all — no highlights, no screenshots. That is by design.</li>
          <li>There is no score. The practice tells you the answer; the real tasks never will.</li>
        </ol>

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
    ['No covers two cases', 'It did not finish, or its answer claims something that did not happen.'],
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
