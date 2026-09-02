// The tutorial phase: a welcome screen, then two practice tasks with the parts pointed at.
// ========================================================================================
// WHY THIS EXISTS. A participant used to meet the mechanics on task 1 of 8 — the countdown,
// the verdict → problem → error-type → step chain, and clicking a sentence inside the page snapshot
// to give evidence. Task 1's time is data. Learning the interface on it means the first row of every
// participant measures something different from the other seven.
//
// WHAT IT DOES NOT DO. It never explains the answer to a real task, never shows a real stimulus, and
// never writes a row. The practice material is invented (app/tutorial_fixtures.js) and its results
// go nowhere.
//
// THE WALKTHROUGH RUNS OVER THE REAL SCREEN, not a mock-up of it. Every step points at an element
// the study itself renders — #q-find-answer, .q-step, .tv-journey-row — so what is rehearsed is the
// thing that comes next rather than a diagram of it. The cost is that this file knows those
// selectors; the alternative is a tutorial that can silently stop describing the study.
//
// SKIPPABLE FROM ANYWHERE. The welcome screen offers it, and every coachmark carries it. Somebody
// who has done this before should not be made to sit through it, and somebody who is lost partway
// through should not have to finish to escape.

(function () {
  const DONE_KEY = 'pageguide_web_tutorial_done';

  // Not in the saved session, deliberately. `validParticipantSession` pins sessionVersion === 2, so
  // adding a field to the session would force a version bump that invalidates every in-flight run —
  // and a refresh mid-walkthrough should simply offer it again rather than resume it half-done.
  function isDone() {
    try { return localStorage.getItem(DONE_KEY) === 'yes'; } catch (e) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(DONE_KEY, 'yes'); } catch (e) { /* private mode — not worth failing over */ }
  }
  function clearDone() {
    try { localStorage.removeItem(DONE_KEY); } catch (e) { /* ignore */ }
  }

  const tut = {
    active: false, idx: 0, queue: [], previewOnly: false,
    // Where in the walkthrough we are, and what was answered on each practice task. Both exist so
    // that Back can re-render an earlier screen: a walkthrough somebody cannot retrace is one they
    // have to get right first time, which is the opposite of what practice is for.
    stage: null,          // {kind:'welcome'|'practice'|'debrief'|'nongrounded', idx}
    answers: [],
  };

  const S = () => window.StudySession;
  const stimulusPane = () => document.getElementById('stimulus-pane');
  const questionPane = () => document.getElementById('question-pane');

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── The welcome screen ─────────────────────────────────────────────────────────────────────────

  function renderWelcome() {
    stopTour();
    window.detachQuestionPane?.();
    tut.stage = { kind: 'welcome', idx: 0 };
    renderNav();
    document.body.classList.add('tut-on');
    stimulusPane().innerHTML = `
      <div class="tut-hero">
        <p class="tut-eyebrow">Before you start</p>
        <h1 class="tut-title">A quick walkthrough</h1>
        <p class="tut-lead">Two practice tasks, one of each kind you are about to see, with the
          parts of the screen pointed out as you go. Nothing here is recorded, and neither practice
          task is one of your eight.</p>
        <ol class="tut-list">
          <li><strong>Where everything is.</strong> The page and the agent's answer on one side, the
            questions on the other.</li>
          <li><strong>How to answer.</strong> Choosing a verdict, then saying <em>where</em> it went
            wrong. Those two are asked separately and timed separately.</li>
          <li><strong>How to point at evidence.</strong> On a Find task you click the sentence or the
            picture in the page itself.</li>
        </ol>
        <p class="tut-kinds-lead">The eight tasks come in two kinds, and they ask different things
          of you:</p>
        <div class="tut-kinds">
          <section class="tut-kind tut-kind-find">
            <header class="tut-kind-head"><span aria-hidden="true">🔍</span> Find information</header>
            <div class="tut-kind-body">
              <p class="tut-kind-what">The agent answers a question about a web page.</p>
              <p><strong>Your job:</strong> answer the question yourself from the page, then judge
                whether the agent's answer is right and point at the sentence or picture on the page
                that settles it.</p>
              <p class="tut-kind-fine">One answer, checked against the page it came from.</p>
            </div>
          </section>
          <section class="tut-kind tut-kind-guide">
            <header class="tut-kind-head"><span aria-hidden="true">🧭</span> Follow a guide</header>
            <div class="tut-kind-body">
              <p class="tut-kind-what">The agent carries out a task on a website, step by step.</p>
              <p><strong>Your job:</strong> read the agent's trajectory — every step and its
                screenshot — and decide whether it completed the task. If it did not, say which step
                went wrong and what kind of error it was.</p>
              <p class="tut-kind-fine">A sequence of actions, checked step by step.</p>
            </div>
          </section>
        </div>
        <p class="tut-fine">About 2 minutes. You can skip it now, or leave it at any point.</p>
      </div>`;
    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">👋 Welcome</span></div>
      <div class="q-body">
        <p class="q-text">Would you like the walkthrough first?</p>
        <p class="q-sub">It uses two made-up practice tasks. Your answers to them are not saved, and
          the countdown on them is not measuring anything.</p>
        <div class="q-actions tut-welcome-actions">
          <button class="q-btn q-btn-primary" id="tut-start">Show me how it works →</button>
          <button class="q-btn" id="tut-skip-all">${tut.previewOnly
            ? 'Back to the welcome screen' : 'Skip, start the study'}</button>
        </div>
      </div>`;

    document.getElementById('tut-start').onclick = start;
    document.getElementById('tut-skip-all').onclick = skipAll;
  }

  function start() {
    tut.active = true;
    tut.idx = 0;
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
      sessionId: null,
      queue: [],
      idx: 0,
      results: [],
      // NOT adminReview: that flag makes a Find task render the reviewer's read-only preview instead
      // of the questions, and the point of previewing the walkthrough is to walk it. Nothing is
      // written regardless — the practice paths never build a row.
      adminReview: false,
    });
    tut.previewOnly = true;
    renderWelcome();
  }

  /** Leave the walkthrough, from the welcome screen or from any coachmark. */
  function skipAll() {
    stopTour();
    tut.active = false;
    tut.queue = [];
    S().state.tutorial = null;
    removeNav();
    document.body.classList.remove('tut-on', 'tv-nogrounding');
    if (tut.previewOnly) { location.href = 'find-v1.html'; return; }
    markDone();
    window.showTask();       // idx is untouched, so this is task 1 of 8
  }

  // ── Retracing your steps ───────────────────────────────────────────────────────────────────────
  // A bar of its own, outside both panes, because every screen in the walkthrough rebuilds the pane
  // it lives in — an inline Back button would be wiped by the next render, and on a practice task
  // the pane belongs to the instrument.
  //
  // WHY BACK EXISTS AT ALL. The practice tasks were one-way: answer the Find one and it is gone,
  // whatever you wanted to look at again. Nothing here is recorded, so there is no reason to lock
  // anybody out of a screen — and somebody who wants a second look at the grounded task while
  // reading the non-grounded one is doing exactly the comparison this study is about.

  let nav = null;

  const STAGE_LABEL = {
    welcome: () => 'Walkthrough',
    practice: (i) => `Practice ${i + 1} of ${tut.queue.length}`,
    debrief: (i) => `Practice ${i + 1} · what we were looking for`,
    nongrounded: (i) => `Practice ${i + 1} · the other condition`,
  };

  /** The screen behind this one, or null at the very start. */
  function previousStage() {
    const { kind, idx } = tut.stage || {};
    if (kind === 'practice') return idx > 0 ? { kind: 'nongrounded', idx: idx - 1 } : { kind: 'welcome', idx: 0 };
    if (kind === 'debrief') return { kind: 'practice', idx };
    // Only offered when the answer was banked — a debrief with nothing to report would be a blank
    // screen, and that is worse than the button not being there.
    if (kind === 'nongrounded') return tut.answers[idx] ? { kind: 'debrief', idx } : { kind: 'practice', idx };
    return null;
  }

  /**
   * The screen ahead of this one — but only one already visited.
   *
   * Forward is the twin of Back, not a way to skip the practice: a task that has not been answered
   * has no debrief to go forward to, so from an unanswered practice there is nothing here. Once
   * somebody has been through a screen, going back to compare should not cost them the walk home.
   */
  function nextStage() {
    const { kind, idx } = tut.stage || {};
    if (kind === 'practice') return tut.answers[idx] ? { kind: 'debrief', idx } : null;
    if (kind === 'debrief') return { kind: 'nongrounded', idx };
    if (kind === 'nongrounded') return idx < tut.queue.length - 1 ? { kind: 'practice', idx: idx + 1 } : null;
    return null;
  }

  function renderNav() {
    if (tut.stage?.kind === 'welcome') return removeNav();
    if (!nav) {
      nav = document.createElement('div');
      nav.className = 'tut-nav';
      document.body.appendChild(nav);
    }
    const back = previousStage();
    const forward = nextStage();
    nav.innerHTML = `
      <span class="tut-nav-label">${esc(STAGE_LABEL[tut.stage?.kind || 'welcome'](tut.stage?.idx || 0))}</span>
      ${back ? '<button type="button" class="tut-nav-back" id="tut-nav-back">← Go back</button>' : ''}
      ${forward ? `<button type="button" class="tut-nav-fwd" id="tut-nav-fwd">${esc(stageAhead(forward))} →</button>` : ''}
      <button type="button" class="tut-nav-skip" id="tut-nav-skip">${tut.previewOnly
        ? 'Leave the walkthrough' : 'Skip the walkthrough'}</button>`;
    if (back) document.getElementById('tut-nav-back').onclick = () => goStage(back);
    if (forward) document.getElementById('tut-nav-fwd').onclick = () => goStage(forward);
    document.getElementById('tut-nav-skip').onclick = skipAll;
  }

  /** What the forward button should call the screen it leads to. */
  function stageAhead(stage) {
    if (stage.kind === 'debrief') return 'What we were looking for';
    if (stage.kind === 'nongrounded') return 'The other condition';
    return `Practice ${stage.idx + 1}`;
  }

  function removeNav() {
    nav?.remove();
    nav = null;
  }

  /** Re-render an earlier screen. Practice answers are thrown away on the way back, as practice. */
  function goStage(stage) {
    stopTour();
    window.detachQuestionPane?.();   // a task left mid-question must stop its timers
    document.body.classList.remove('tv-nogrounding');
    if (stage.kind === 'welcome') {
      tut.active = false;
      S().state.tutorial = null;
      return renderWelcome();
    }
    tut.idx = stage.idx;
    tut.active = true;
    S().state.tutorial = tut;
    if (stage.kind === 'practice') return void window.showTask();
    if (stage.kind === 'debrief') return finishPracticeTask(tut.queue[stage.idx], tut.answers[stage.idx]);
    return void showNonGrounded(tut.queue[stage.idx], stage.idx >= tut.queue.length - 1);
  }

  function currentTask() {
    return tut.queue[tut.idx] || null;
  }

  function progressLabel() {
    return `Practice ${tut.idx + 1} of ${tut.queue.length} · not recorded`;
  }

  // ── The two tours ──────────────────────────────────────────────────────────────────────────────
  // Every target is an element the study renders for itself. `wait` steps advance on the real
  // interaction rather than on a Next button: the point of a practice task is that the participant
  // does the thing once, not that they read a description of doing it.

  function findTour() {
    return [
      // FOUR STEPS, and the first two are the orientation: what you are looking at, and what is
      // marked on it. Merging them is a straight win — each named one part of a screen the
      // participant is already looking at, and a card that has to be dismissed three times before
      // anything can be done is read less carefully, not more.
      {
        target: '.tv-head',
        also: ['.q-timer-chip'],
        place: 'bottom',
        title: 'The question, the badge, and the clock',
        body: 'The question is what the agent was asked, and most have two parts, so read it first. '
          + 'The badge under it says <b>Grounded</b> (evidence highlighted in the page and cited in '
          + 'the answer) or <b>Non-grounded</b> (neither), which is the condition being studied and '
          + 'not a broken page. The clock counts down the <b>3 minutes</b> this task is meant to '
          + 'take; it turns red if you go past, but nothing is cut off and your answer still counts.',
      },
      {
        target: '#find-page',
        also: ['.find-answer'],
        // Under the answer card, not beside the page: both holes together fill the width, so a card
        // placed against either one lands on top of the other. The strip below the answer is the one
        // patch of screen this step is not asking anybody to look at.
        tipTarget: '.find-answer',
        place: 'bottom',
        title: 'The page, and what the agent said about it',
        body: 'The real page, frozen, so you can scroll it, read it and search it. This task is '
          + 'grounded, so the sentences the agent leaned on are highlighted, and its answer on the '
          + 'right carries numbered citations back to them. Worth checking rather than trusting: a '
          + 'highlight says the agent used a sentence, not that it read it correctly.',
      },
      {
        // The exploring comes BEFORE the answer, not after it. Asked afterwards it is advice nobody
        // can act on, since the answer is already given and "have another look" reads as "you got
        // it wrong". Asked first it is just how the task is done.
        //
        // THE ANSWER CARD IS THE PRIMARY TARGET, and the card sits above it rather than beside it:
        // this step needs the page, the agent's answer and the options all legible at once, and a
        // card placed against the page covered the very thing the step is pointing at.
        target: '.find-answer',
        also: [
          '#find-page',
          '#q-find-answer',
          // Nothing until an option is ticked, then the button they are told to press.
          () => (document.querySelector('input[name="q-find-answer"]:checked')
            ? document.getElementById('q-find-next') : null),
        ],
        refresh: onAnswerChange('input[name="q-find-answer"]'),
        // Against the page, not the answer: everything this step names (the answer, the options,
        // the button) lives in the 420px pane on the right, and a card placed there covers one of
        // them whichever way it is turned.
        tipTarget: '#find-page',
        place: 'inside-right',
        title: 'Read it, then answer',
        body: 'Now do the task. The agent\'s answer is <b>clickable</b>: click it for the phrases it '
          + 'cited, then a numbered chip to jump to that sentence in the page. Choose the matching '
          + 'option below and press <b>Next</b>.',
        wait: onRevealed('#q-support-stage'),
        satisfied: () => !!document.getElementById('q-support-stage') && !document.getElementById('q-support-stage').hidden,
      },
      // Picking the evidence and submitting are one step, because they are one motion: the Submit
      // button is revealed with the evidence stage and refuses to go anywhere until both picks are
      // in, so the button itself already says what a separate coachmark would have said.
      {
        target: '#find-page',
        also: ['#q-support-stage', '#q-find-submit'],
        place: 'left',
        title: 'Point at what proves it, then submit',
        body: 'One piece of evidence per part of the question: press <b>✏️ Pick evidence</b>, then '
          + 'click the sentence <em>in the page</em> that told you the answer, and do that for both. '
          + 'Nothing can be left blank, so the Submit button says what is still missing. After it '
          + 'come the same two questions every task ends with, on confidence and helpfulness.',
        wait: onClick('#q-find-submit'),
        satisfied: () => !document.getElementById('q-find-submit'),
      },
    ];
  }

  function guideTour() {
    return [
      // Four steps here too, and for the same reason: the second one covers the whole left pane at
      // once, which is how a participant actually reads it — steps, before-and-after and the claim
      // together, rather than three cards naming three neighbouring boxes.
      {
        target: '.tv-head',
        also: ['.q-timer-chip'],
        place: 'bottom',
        title: 'The task, the badge, and the clock',
        body: 'You are not answering this question yourself, you are judging whether the agent did '
          + 'what it was asked. <b>Grounded</b> gives you its evidence twice over, as the page '
          + 'behind each step and as marks on the claims it saw, while <b>Non-grounded</b> gives '
          + 'you words only. The clock counts down the <b>3 minutes</b> this task is meant to take, '
          + 'across both stages together \u2014 deciding something is wrong, then finding where.',
      },
      {
        target: '.tv-journey',
        also: ['.tv-states', '.tv-answer'],
        place: 'right',
        title: 'What it did, and what it claims it did',
        body: 'Every action in order, and because this one is grounded, hovering a step shows the '
          + 'page the agent was looking at when it acted, with a click for full size. Above the '
          + 'steps sit the page before and after, the quickest way to see whether the job got done. '
          + 'Below them is the claim you are judging, and an answer can confidently name something '
          + 'that appears nowhere on the page it was looking at.',
      },
      {
        // THE WHOLE PANE, not just the journey: the verdict is judged from the before/after pair,
        // the steps, the answer and the trail together, and dimming three of the four says the
        // judgement can be made from the step list alone.
        target: '#stimulus-pane',
        also: [
          '#q-correct',
          // Both appear as the participant answers: the problem list when "No" reveals it, and the
          // button once there is a verdict to move on from.
          () => (document.getElementById('q-problem-wrap')?.hidden === false
            ? document.getElementById('q-problems') : null),
          () => (document.querySelector('input[name="q-correct"]:checked')
            ? document.getElementById('q-next') : null),
        ],
        refresh: onAnswerChange('input[name="q-correct"], input[name="q-problem"]'),
        // Inside the pane, low and to the right: everything this step names (the verdict, the
        // problem list, the button) is in the pane on the right, and a card placed against a
        // full-height target lands on top of one of them whichever way it is turned.
        place: 'inside-bottom',
        title: 'Look first, then give your verdict',
        body: 'Now do the task: check the steps and the screenshots against the answer, then say on '
          + 'the right whether the agent completed it. Saying no asks what kind of problem it was, '
          + 'so tick everything that applies and press <b>Next</b>.',
        wait: onRevealed('#q-errors-stage'),
        satisfied: () => !!document.getElementById('q-errors-stage') && !document.getElementById('q-errors-stage').hidden,
      },
      // The type, the step and the Submit press are one step: an error type with no step will not
      // submit, so the button is already the reminder a separate card would have been. "No error"
      // has no steps to tap and is a legitimate answer, and the button accepts it on its own.
      //
      // THE WHOLE PANE, not the step list. Deciding which step an error happened at is done against
      // the before/after pair and the answer as much as the journey, and spotlighting the journey
      // alone told a participant the other three were finished with.
      {
        target: '#q-errors',
        also: ['#stimulus-pane', '#q-submit'],
        place: 'left',
        title: 'Which error, where, then submit',
        body: 'Tick the kind of error and numbered buttons appear, which are the steps, so tap the '
          + 'one it happened at. An error type with no step is half an answer and will not submit, '
          + 'and if the run was fine then <b>No error</b> is an answer in its own right. After '
          + 'Submit come the same two questions every task ends with, on confidence and '
          + 'helpfulness.',
        wait: onClick('#q-submit'),
        satisfied: () => !document.getElementById('q-submit'),
      },
    ];
  }

  // ── Hooks called from study.js ─────────────────────────────────────────────────────────────────

  function onTaskRendered(task) {
    if (!tut.active) return;
    tut.stage = { kind: 'practice', idx: tut.idx };
    renderNav();
    startTour(task?.taskType === 'find' ? findTour() : guideTour());
  }

  /**
   * A practice task, answered.
   *
   * Nothing is built, pushed or written — S.state.idx stays where it was, so the real study still
   * begins at task 1. What the participant gets instead is the answer, which is the reason the
   * practice is worth doing: the mechanics can be learnt from any task, but what counts as an error
   * and how sure “sure” should feel cannot.
   */
  function finishPracticeTask(task, answer) {
    stopTour();
    window.detachQuestionPane?.();
    tut.answers[tut.idx] = answer;
    tut.stage = { kind: 'debrief', idx: tut.idx };
    renderNav();
    const debrief = window.TutorialSource.debrief(task?.id);
    const last = tut.idx >= tut.queue.length - 1;
    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">✅ Practice ${tut.idx + 1} done</span></div>
      <div class="q-body">
        ${task?.taskType === 'find'
          ? findDebriefHtml(debrief, answer)
          : guideDebriefHtml(debrief, answer)}
        <p class="q-sub tut-debrief-closing">${esc(debrief.closing)}</p>
        <!-- Said plainly, because a participant who expects to be marked answers differently from
             one who knows nobody is marking them. -->
        <p class="q-sub tut-no-feedback"><strong>This part only happens in practice.</strong> The
          real tasks never tell you whether you were right, and there is no score, because we are
          studying the interface and not you.</p>
        <div class="q-actions">
          <button class="q-btn q-btn-primary" id="tut-continue">See this one non-grounded →</button>
        </div>
      </div>`;

    document.getElementById('tut-continue').onclick = () => showNonGrounded(task, last);
  }

  /**
   * The other condition, shown rather than described — and only shown.
   *
   * Half of a participant's tasks will have no evidence in them at all, and the failure mode we are
   * trying to avoid is somebody meeting their first non-grounded task and reading it as a broken
   * page: hunting for screenshots that were never captured, and spending the time we are measuring
   * on looking for a bug. So they see one, once, with the difference named.
   *
   * NO QUESTIONS AND NO SECOND WALKTHROUGH. It is the same practice task they have just answered, in
   * the other condition, so everything except the difference is already familiar. Asking them to
   * answer it again would teach them nothing and cost two more minutes.
   */
  async function showNonGrounded(task, last) {
    stopTour();
    window.detachQuestionPane?.();
    tut.stage = { kind: 'nongrounded', idx: tut.queue.indexOf(task) < 0 ? tut.idx : tut.queue.indexOf(task) };
    renderNav();
    const isFind = task?.taskType === 'find';
    const answer = isFind ? await renderNonGroundedFind(task) : await renderNonGroundedGuide();
    stimulusPane().scrollTop = 0;

    questionPane().innerHTML = `
      <div class="q-head"><span class="q-title">◐ The other condition</span></div>
      <div class="q-body">
        <p class="q-text"><strong>The same task you just did, non-grounded.</strong></p>
        ${isFind ? `<div class="q-card">
          <div class="q-card-head"><span class="q-badge">A</span>
            <p class="q-text">The agent's answer (non-grounded)</p></div>
          <div class="find-answer">${window.renderFindAnswer(answer, 'nongrounding')}</div>
        </div>` : ''}
        <p class="q-sub">Four of your eight tasks look like this. Nothing is missing or broken: what
          the agent's evidence is worth is exactly what this study is measuring, so half the tasks
          withhold it.</p>
        <dl class="tut-compare">
          <div><dt>Grounded</dt>
            <dd>${isFind
              ? 'The sentences behind the answer are highlighted in the page, AND the answer carries numbered citations that jump to them.'
              : 'Every step comes with the page the agent was acting on, AND the answer marks the claims it backed with something it saw.'}</dd></div>
          <div><dt>Non-grounded</dt>
            <dd>${isFind
              ? 'Neither: nothing is marked in the page, and the answer is plain text with no citations to follow. The page itself is still all there to read.'
              : 'Neither: the steps are words only, and the answer carries no evidence marks either. The before and after pictures stay.'}</dd></div>
        </dl>
        <p class="q-sub">Everything else is identical, questions included. If you cannot tell what
          the answer was based on, say so, because that is a real answer and a useful one.</p>
        <div class="q-actions">
          <button class="q-btn q-btn-primary" id="tut-finish">${last
            ? (tut.previewOnly ? 'Done, back to the welcome screen' : 'Start the study →')
            : 'Next practice task →'}</button>
        </div>
      </div>`;
    document.getElementById('tut-finish').onclick = () => {
      if (last) return endTutorial();
      document.body.classList.remove('tv-nogrounding');
      tut.idx++;
      window.showTask();
    };

    startTour([
      {
        target: '.tv-condition',
        place: 'bottom',
        title: 'The banner names it, every time',
        body: 'Every task says which condition it is in, right here, and the ⓘ says what that means '
          + 'for that kind of task. You never have to guess whether something is missing.',
      },
      isFind ? {
        target: '#find-page',
        place: 'left',
        title: 'The same page unmarked, the same answer uncited',
        body: 'Two things are gone, not one: no highlights in the page, and no numbered chips in the '
          + 'answer. The page is still entirely readable, and you are simply the one finding the '
          + 'sentence. That is the whole difference, and it is deliberate.',
      } : {
        target: '.tv-journey',
        place: 'right',
        title: 'The same steps without pictures, an answer with nothing behind it',
        body: 'Two things are gone, not one: the steps are all still here but there is nothing to '
          + 'hover or open, and the answer no longer marks which claims it actually saw. That is '
          + 'the whole difference, and it is deliberate.',
      },
    ]);
  }

  async function renderNonGroundedGuide() {
    const record = await window.TutorialSource.getStudyTrajectory('TUTORIAL-GUIDE');
    window.renderGuideShell('nongrounding');
    window.Stimulus.mountStimulus(record, 'nongrounding', {
      goal: document.getElementById('tv-goal'),
      count: document.getElementById('tv-count'),
      stage: document.getElementById('tv-stage'),
    });
  }

  /**
   * The Find practice, re-rendered non-grounded and read-only.
   *
   * Built here rather than through showFindTask because that renders the questions and starts the
   * timers, and this screen is for looking at. The pieces it does reuse are the study's own —
   * conditionBannerHtml and renderFindAnswer — so the banner and the stripped answer are the ones a
   * real non-grounded task shows, markers removed by the vendored stripper rather than by this file.
   */
  async function renderNonGroundedFind(task) {
    const page = await window.TutorialSource.getTaskPage(task.id);
    const canned = await window.TutorialSource.getCannedResponse(task.id, 'nongrounding');
    const answer = canned?.answer_display || canned?.answer_raw || '';
    document.body.classList.remove('tv-nogrounding');
    stimulusPane().innerHTML = `
      <header class="tv-head">
        <div class="tv-head-main">
          <div class="tv-kicker">Task</div>
          <h1 class="tv-goal">${esc(task.question || '')}</h1>
          ${window.conditionBannerHtml('nongrounding', 'find')}
        </div>
      </header>
      <main class="tv-main">
        <iframe class="find-page" id="find-page" title="The page this question is about"></iframe>
      </main>`;
    // No applyFindGrounding call: this arm marks nothing, and that absence is the whole point.
    // Sealed all the same — nothing is picked on this screen, but a link followed out of the
    // snapshot would replace the comparison the screen exists to show with a live website.
    const frame = document.getElementById('find-page');
    frame.__pgSnapshotHtml = page.html;
    frame.addEventListener('load', () => window.sealSnapshot?.(frame), { once: true });
    frame.srcdoc = page.html;
    return answer;
  }

  function endTutorial() {
    document.body.classList.remove('tv-nogrounding');
    stopTour();
    removeNav();
    tut.active = false;
    tut.queue = [];
    S().state.tutorial = null;
    if (tut.previewOnly) { location.href = 'find-v1.html'; return; }
    markDone();
    window.showTask();
  }

  function verdictRow(ok, label) {
    return `<p class="tut-verdict ${ok ? 'is-ok' : 'is-off'}">
      <span class="tut-verdict-mark">${ok ? '✓' : '✗'}</span>${esc(label)}</p>`;
  }

  /** Loose containment, the way scoreFindEvidence compares evidence: either may hold the other. */
  function sameSentence(a, b) {
    const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const [x, y] = [norm(a), norm(b)];
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
  }

  function findDebriefHtml(debrief, answer) {
    const chosen = String(answer?.answer || '');
    const right = chosen.trim().toLowerCase() === String(debrief.answer).trim().toLowerCase();
    const picks = Array.isArray(answer?.evidenceResponses) ? answer.evidenceResponses : [];
    return `
      <div class="tut-debrief">
        <p class="q-text"><strong>What we were looking for</strong></p>
        ${verdictRow(right, right
          ? 'You picked the right answer.'
          : `You picked “${chosen}”.`)}
        <p class="q-sub">The answer was: <strong>${esc(debrief.answer)}</strong></p>
        <p class="q-sub">${esc(debrief.why)}</p>
        <!-- The sentences they picked, against the ones that support the answer. The evidence half
             of a Find task is the half grounding is supposed to help with, so "was mine one of
             these?" is the question worth answering while it costs nothing. -->
        <ul class="tut-evidence">
          ${debrief.hops.map((hop, i) => {
            const mine = picks[i]?.text || picks[i]?.label || '';
            const ok = sameSentence(mine, hop.text);
            return `
            <li class="${ok ? 'is-ok' : 'is-off'}">
              <span class="tut-evidence-label">${esc(hop.label)}
                <span class="tut-evidence-mark">${ok ? '✓ that is what you picked' : '✗'}</span></span>
              <span class="tut-evidence-text">${esc(hop.text)}</span>
              ${ok || !mine ? '' : `<span class="tut-evidence-mine">You picked: ${esc(mine)}</span>`}
            </li>`;
          }).join('')}
        </ul>
      </div>`;
  }

  function guideDebriefHtml(debrief, answer) {
    const given = answer?.guideAnswer || {};
    const verdictRight = given.correct === debrief.verdict;
    const errors = Array.isArray(given.errors) ? given.errors : [];
    const rightStep = errors.some(e => (e.steps || []).includes(debrief.step));
    const rightType = errors.some(e => e.type === debrief.errorType && (e.steps || []).includes(debrief.step));
    return `
      <div class="tut-debrief">
        <p class="q-text"><strong>What we were looking for</strong></p>
        ${verdictRow(verdictRight, verdictRight
          ? 'You spotted that it did not complete the task.'
          : 'This one did not complete the task.')}
        <p class="q-sub">${esc(debrief.why)}</p>
        ${verdictRow(rightStep, rightStep
          ? `And you put the error at the right step, step ${debrief.step}.`
          : `The step to mark was step ${debrief.step}.`)}
        <p class="q-sub">${esc(debrief.where)}</p>
        <!-- The type gets its own verdict row, so the three judgements a Guide answer is made of —
             did it work, which step, which kind of error — each come back marked. The prose under
             it stays soft: two of these types can be argued for on the same step. -->
        ${verdictRow(rightType, rightType
          ? `And you picked the right kind of error: ${debrief.errorLabel}.`
          : `The type we had in mind was ${debrief.errorLabel}.`)}
        <p class="q-sub tut-nuance">${esc(debrief.nuance)}</p>
      </div>`;
  }

  // ── The coachmark engine ───────────────────────────────────────────────────────────────────────
  // A dimmed backdrop with holes cut in it, and a card beside them. The backdrop takes no pointer
  // events, so whatever is being pointed at stays clickable — which it must, since half of these
  // steps ask the participant to use it.
  //
  // THE BACKDROP IS AN SVG MASK, not a huge box-shadow. A shadow can only cut ONE hole: a second
  // element casting its own shadow re-dims the first one, which is exactly how the Pick evidence
  // card ended up grey while being the thing the step was telling somebody to use. A mask takes as
  // many holes as the step has parts, and all of them come out at full brightness.

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let layer = null;
  let maskSvg = null;
  let maskAll = null;
  let maskGroup = null;
  let dimRect = null;
  let tip = null;
  let tour = null;
  let tipAnchor = null;
  let frame = 0;
  const holes = [];   // [{target, el, hole, ring, action}] — index 0 is the step's own target

  function ensureLayer() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'tut-layer';
    layer.innerHTML = `
      <div class="tut-tip">
        <div class="tut-tip-kicker"></div>
        <div class="tut-tip-title"></div>
        <div class="tut-tip-body"></div>
        <div class="tut-tip-tools">
          <button type="button" class="tut-tip-peek">See the whole page</button>
          <button type="button" class="tut-tip-pause">Explore on my own</button>
        </div>
        <div class="tut-tip-actions">
          <button type="button" class="tut-tip-skip">Skip the walkthrough</button>
          <span class="tut-tip-spacer"></span>
          <button type="button" class="tut-tip-back">Back</button>
          <button type="button" class="tut-tip-next">Next →</button>
        </div>
      </div>`;

    maskSvg = document.createElementNS(SVG_NS, 'svg');
    maskSvg.setAttribute('class', 'tut-mask');
    const defs = document.createElementNS(SVG_NS, 'defs');
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', 'tut-mask-holes');
    maskAll = document.createElementNS(SVG_NS, 'rect');
    maskAll.setAttribute('fill', '#fff');
    maskGroup = document.createElementNS(SVG_NS, 'g');
    mask.appendChild(maskAll);
    mask.appendChild(maskGroup);
    defs.appendChild(mask);
    dimRect = document.createElementNS(SVG_NS, 'rect');
    dimRect.setAttribute('fill', 'rgba(14,14,26,0.52)');
    dimRect.setAttribute('mask', 'url(#tut-mask-holes)');
    maskSvg.appendChild(defs);
    maskSvg.appendChild(dimRect);
    layer.insertBefore(maskSvg, layer.firstChild);

    document.body.appendChild(layer);
    tip = layer.querySelector('.tut-tip');
    layer.querySelector('.tut-tip-skip').onclick = skipAll;
    layer.querySelector('.tut-tip-back').onclick = () => go(-1);
    layer.querySelector('.tut-tip-next').onclick = () => go(1);
    layer.querySelector('.tut-tip-peek').onclick = () => setPeek(!peeking);
    layer.querySelector('.tut-tip-pause').onclick = pauseTour;

    setupTipDrag();
  }

  let userDragPos = null;
  let isDraggingTip = false;
  let dragStart = null;

  function setupTipDrag() {
    if (!tip) return;
    const startDrag = (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const rect = tip.getBoundingClientRect();
      dragStart = { x: clientX - rect.left, y: clientY - rect.top };
      isDraggingTip = true;
      tip.classList.add('is-dragging');
      if (e.cancelable && e.type === 'touchstart') e.preventDefault();
    };

    const onDrag = (e) => {
      if (!isDraggingTip || !dragStart) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;

      let left = clientX - dragStart.x;
      let top = clientY - dragStart.y;
      left = Math.min(Math.max(8, left), vw - tw - 8);
      top = Math.min(Math.max(8, top), vh - th - 8);

      userDragPos = { left, top };
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      if (e.cancelable) e.preventDefault();
    };

    const endDrag = () => {
      if (isDraggingTip) {
        isDraggingTip = false;
        tip?.classList.remove('is-dragging');
      }
    };

    tip.addEventListener('mousedown', startDrag);
    tip.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('touchmove', onDrag, { passive: false });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);
  }

  // ── Seeing the whole screen, and stepping out of the walk ──────────────────────────────────────
  // TWO DIFFERENT COMPLAINTS, TWO CONTROLS. "I can only see the bit you cut a hole in" wants the dim
  // gone but the card kept — that is the peek. "Let me just poke at this task for a minute" wants
  // the walkthrough out of the way entirely, and then wants it back on the same step — that is the
  // pause. Neither ends the walkthrough: leaving for good is still the Skip button.
  //
  // The peek survives from step to step on purpose. Somebody who has said once that they would
  // rather see the whole page does not want to say it again on every card.

  let peeking = false;
  let paused = false;
  let resumeBtn = null;

  function setPeek(on) {
    peeking = !!on;
    layer?.classList.toggle('is-peek', peeking);
    const btn = layer?.querySelector('.tut-tip-peek');
    if (btn) btn.textContent = peeking ? 'Spotlight this step again' : 'See the whole page';
  }

  /**
   * Step out of the walkthrough without leaving it: the card, the dim and the rings all go, and a
   * single button stays behind to come back to the very step that was open.
   *
   * The step's `wait` binding is deliberately left alive. Somebody exploring on their own who goes
   * ahead and does the thing the step was asking for has done it — coming back to a card still
   * waiting for it would be the walkthrough disagreeing with the screen.
   */
  function pauseTour() {
    if (!tour) return;
    paused = true;
    layer.classList.remove('is-on');
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    holes.forEach(h => { h.ring.style.opacity = '0'; });
    showResume();
  }

  function resumeTour() {
    if (!tour) return removeResume();
    paused = false;
    removeResume();
    layer.classList.add('is-on');
    setPeek(peeking);
    track(tour.step, tour.el);
  }

  function showResume() {
    if (!resumeBtn) {
      resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'tut-resume';
      resumeBtn.onclick = resumeTour;
      document.body.appendChild(resumeBtn);
    }
    resumeBtn.innerHTML = '<span aria-hidden="true">↩</span> Back to the walkthrough';
  }

  function removeResume() {
    resumeBtn?.remove();
    resumeBtn = null;
  }

  function clearHoles() {
    holes.splice(0).forEach(h => { h.hole.remove(); h.ring.remove(); });
  }

  /** One hole in the backdrop, with a ring drawn on top of its edge. */
  function addHole(target, el, action) {
    const hole = document.createElementNS(SVG_NS, 'rect');
    hole.setAttribute('fill', '#000');
    hole.setAttribute('rx', '12');
    maskGroup.appendChild(hole);
    const ring = document.createElement('div');
    ring.className = `tut-ring${action ? ' is-action' : ''}`;
    layer.appendChild(ring);
    holes.push({ target, el, hole, ring });
  }

  function startTour(steps) {
    ensureLayer();
    stopTour();
    setPeek(peeking);
    tour = { steps, i: -1, cleanup: null, step: null, el: null };
    go(1);
  }

  function stopTour() {
    if (tour?.cleanup) { try { tour.cleanup(); } catch (e) { /* ignore */ } }
    if (tour?.refreshCleanup) { try { tour.refreshCleanup(); } catch (e) { /* ignore */ } }
    tour = null;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    clearHoles();
    tipAnchor = null;
    userDragPos = null;
    paused = false;
    removeResume();
    if (layer) layer.classList.remove('is-on', 'is-waiting');
  }

  function go(direction) {
    if (!tour) return;
    if (tour.cleanup) { try { tour.cleanup(); } catch (e) { /* ignore */ } tour.cleanup = null; }
    if (tour.refreshCleanup) { try { tour.refreshCleanup(); } catch (e) { /* ignore */ } tour.refreshCleanup = null; }
    let i = tour.i + direction;
    while (i >= 0 && i < tour.steps.length && tour.steps[i].skipIf?.()) i += direction;
    if (i < 0) return go(1);
    if (i >= tour.steps.length) return stopTour();
    tour.i = i;
    showStep(tour.steps[i], direction);
  }

  async function showStep(step, direction = 1) {
    // Somebody who reads ahead and answers before the coachmark asks them to would otherwise land on
    // a step waiting for a thing that has already happened, with no Next button to leave by. A step
    // that is already satisfied has nothing left to teach.
    //
    // SKIPPED IN THE DIRECTION OF TRAVEL. Skipping forward from a Back press was why Back looked
    // broken on the later steps: every step behind them was already satisfied, so each one bounced
    // the participant straight back to where they had just left.
    if (step.wait && step.satisfied?.()) return go(direction);

    const el = await resolveTarget(step.target, step.optional ? 600 : 3000);
    if (!el && step.optional) return go(direction);

    const total = tour.steps.length;
    // A step with no Next button has to say so, or the card reads as a dead end: the participant is
    // waiting for the walkthrough and the walkthrough is waiting for them. "Your turn" plus a pulsing
    // ring on the thing to use is the difference between a pause and being stuck.
    tip.querySelector('.tut-tip-kicker').textContent =
      `Walkthrough · ${tour.i + 1} of ${total}${step.wait ? ' · your turn' : ''}`;
    tip.querySelector('.tut-tip-title').textContent = step.title;
    tip.querySelector('.tut-tip-body').innerHTML = step.body;
    tip.querySelector('.tut-tip-back').hidden = tour.i === 0;
    // A step that asks for an action has no Next: the action is the Next, and a button beside it
    // would let someone skip past the one thing the step exists to have them try.
    tip.querySelector('.tut-tip-next').hidden = !!step.wait;
    layer.classList.toggle('is-waiting', !!step.wait);

    await buildHoles(step, el);
    // A step can place its card against something OTHER than its spotlight. Needed where the two
    // pull in opposite directions: the answer card is what this step is pointing at, so a card
    // placed against it lands on top of it.
    tipAnchor = step.tipTarget ? (await resolveTarget(step.tipTarget, 1200)) : null;
    tour.step = step;
    tour.el = el;
    // A step reached while paused — the participant did the thing the old step was waiting for,
    // out on their own — must not yank the card back over the screen they asked to be left alone
    // with. The resume button is already there, and it now leads here.
    if (!paused) layer.classList.add('is-on');

    if (el?.scrollIntoView && !paused) {
      try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    }

    if (!paused) track(step, el);

    if (step.wait) tour.cleanup = step.wait(advanceOnce());
    // A step whose parts appear as the participant works — the Next button once an answer is
    // chosen, the problem list once "No" is ticked — re-cuts its holes rather than leaving the new
    // control sitting in the dim under an instruction that names it.
    if (step.refresh) {
      tour.refreshCleanup = step.refresh(() => {
        if (tour?.steps[tour.i] === step) buildHoles(step, el);
      });
    }
  }

  /**
   * Cut a hole for every part this step needs, so nothing it asks somebody to use is left dim.
   *
   * The step's own target is first — it is what the card is placed against. An `also` entry that
   * resolves to nothing is simply skipped, which is what makes a control that does not exist yet
   * (the Next button before an answer is chosen) cost nothing here.
   */
  async function buildHoles(step, el) {
    clearHoles();
    if (el) addHole(step.target, el, !!step.wait);
    for (const also of (step.also || [])) {
      const alsoEl = await resolveTarget(also, 1200);
      if (alsoEl) addHole(also, alsoEl, !!step.wait);
    }
  }

  /**
   * A one-shot "move on" bound to the step that asked for it.
   *
   * An interaction that ends a step often also builds the next screen — pressing Submit renders the
   * follow-up questions, which starts a tour of its own. Without this, the advance queued by the old
   * step landed in the new tour and skipped its first coachmark. Tied to the tour object and the step
   * index, so a stale advance simply does nothing.
   */
  function advanceOnce() {
    const mine = tour;
    const at = tour.i;
    let used = false;
    return () => {
      if (used || tour !== mine || tour.i !== at) return;
      used = true;
      go(1);
    };
  }

  /** The target's rect in viewport coordinates, iframes included. */
  function rectOf(target, el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (target && target.frame) {
      const host = document.querySelector(target.frame);
      if (!host) return null;
      const outer = host.getBoundingClientRect();
      return {
        top: outer.top + rect.top, left: outer.left + rect.left,
        width: rect.width, height: rect.height,
      };
    }
    return rect;
  }

  /**
   * Keep the holes and the card glued to the target.
   *
   * One rAF loop rather than scroll/resize listeners: the target can also move because a pane
   * re-rendered, an iframe scrolled, or a section unfolded, and none of those fire a scroll event on
   * this document. Stopped while the walkthrough is paused — there is nothing on screen to track.
   */
  function track(step, el) {
    if (frame) cancelAnimationFrame(frame);
    const tick = () => {
      position(step, el);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function position(step, el) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    maskSvg.setAttribute('width', vw);
    maskSvg.setAttribute('height', vh);
    [maskAll, dimRect].forEach(node => {
      node.setAttribute('x', 0); node.setAttribute('y', 0);
      node.setAttribute('width', vw); node.setAttribute('height', vh);
    });

    const pad = 8;
    holes.forEach(h => {
      const r = rectOf(h.target, h.el);
      const on = r && (r.width || r.height);
      h.hole.setAttribute('x', on ? r.left - pad : -9999);
      h.hole.setAttribute('y', on ? r.top - pad : -9999);
      h.hole.setAttribute('width', on ? r.width + pad * 2 : 0);
      h.hole.setAttribute('height', on ? r.height + pad * 2 : 0);
      h.ring.style.opacity = on ? '1' : '0';
      if (!on) return;
      h.ring.style.top = `${r.top - pad}px`;
      h.ring.style.left = `${r.left - pad}px`;
      h.ring.style.width = `${r.width + pad * 2}px`;
      h.ring.style.height = `${r.height + pad * 2}px`;
    });

    if (userDragPos) {
      tip.style.top = `${Math.min(Math.max(8, userDragPos.top), vh - tip.offsetHeight - 8)}px`;
      tip.style.left = `${Math.min(Math.max(8, userDragPos.left), vw - tip.offsetWidth - 8)}px`;
      return;
    }

    const rect = tipAnchor
      ? rectOf(step.tipTarget, tipAnchor)
      : rectOf(step.target, el);
    if (!rect || (!rect.width && !rect.height)) {
      // Nothing to point at (yet): centre the card rather than place it against a 0×0 rect.
      tip.style.top = `${Math.max(16, (vh - tip.offsetHeight) / 2)}px`;
      tip.style.left = `${Math.max(16, (vw - tip.offsetWidth) / 2)}px`;
      return;
    }

    const gap = 16;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let top = rect.top;
    let left = rect.left - tw - gap;

    if (step.place === 'right') left = rect.left + rect.width + gap;
    if (step.place === 'bottom') { left = rect.left; top = rect.top + rect.height + gap; }
    if (step.place === 'top') { left = rect.left; top = rect.top - th - gap; }
    // INSIDE the target rather than beside it. The page fills its half of the screen, so there is
    // no "beside" left to place a card in — and the fallback below would push it onto the question
    // pane, which is the one place this step needs kept clear.
    if (step.place === 'inside-right') { left = rect.left + rect.width - tw - gap; top = rect.top + gap; }
    if (step.place === 'inside-bottom') { left = rect.left + gap; top = rect.top + rect.height - th - gap; }
    // Fall back to the other side rather than off-screen — the question pane is 420px wide, so a
    // card placed to its left has room while one placed to its right does not.
    if (left < 8) left = Math.min(rect.left + rect.width + gap, window.innerWidth - tw - 8);
    if (left + tw > window.innerWidth - 8) left = Math.max(8, rect.left - tw - gap);

    tip.style.top = `${Math.min(Math.max(8, top), window.innerHeight - th - 8)}px`;
    tip.style.left = `${Math.max(8, left)}px`;
  }

  /**
   * Find the element a step points at, waiting for it if it is not there yet.
   *
   * Needed because the screen builds itself in stages: the highlights inside the Find snapshot
   * appear on the iframe's load event, and #q-support-stage does not exist until the participant has
   * pressed Next. Polling briefly is simpler than threading a callback through every render path.
   */
  function resolveTarget(target, timeoutMs) {
    const attempt = () => {
      try {
        if (typeof target === 'function') return target();
        if (target && target.frame) {
          const host = document.querySelector(target.frame);
          const doc = host && host.contentDocument;
          return doc ? doc.querySelector(target.selector) : null;
        }
        return document.querySelector(target);
      } catch (e) {
        return null;   // a cross-origin frame, in principle; ours is srcdoc and same-origin
      }
    };
    const now = attempt();
    if (now) return Promise.resolve(now);
    return new Promise(resolve => {
      const started = Date.now();
      const timer = setInterval(() => {
        const el = attempt();
        if (el || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(el || null);
        }
      }, 120);
    });
  }

  // ── Waiting on a real interaction ──────────────────────────────────────────────────────────────
  // Each returns a cleanup, so a step that is left early (Back, Skip, a new tour) unbinds itself.

  // BUBBLE PHASE, AND A BEAT LATER. The screen's own handlers run on the same events and are what
  // reveal the next thing: ticking "no" unhides the problem list, pressing Next builds the evidence
  // stage. Advancing from the capture phase pointed the following coachmark at an element that was
  // still hidden, and it skipped itself.
  function onClick(selector) {
    return (next) => {
      const handler = (e) => { if (e.target.closest?.(selector)) setTimeout(next, 80); };
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    };
  }

  /**
   * A stage of the task has opened — the only reliable signal that the stage before it was answered.
   * Watching the button instead would advance on a press the study itself rejected: both Next
   * buttons refuse to move on until the question under them is answered.
   */
  function onRevealed(selector) {
    return (next) => {
      const el = document.querySelector(selector);
      if (!el) { setTimeout(next, 0); return () => {}; }
      if (!el.hidden) { setTimeout(next, 0); return () => {}; }
      const observer = new MutationObserver(() => { if (!el.hidden) setTimeout(next, 150); });
      observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
      return () => observer.disconnect();
    };
  }

  /** Re-cut the step's holes whenever something inside the question pane changes. */
  function onAnswerChange(selector) {
    return (refresh) => {
      const handler = (e) => { if (e.target.matches?.(selector)) setTimeout(refresh, 80); };
      document.addEventListener('change', handler);
      return () => document.removeEventListener('change', handler);
    };
  }

  window.Tutorial = {
    isDone, markDone, clearDone,
    renderWelcome, preview, start, skipAll, endTutorial,
    currentTask, progressLabel,
    onTaskRendered, finishPracticeTask,
    isActive: () => tut.active,
  };
}());
