// The task screen driver: walk the queue, one trajectory at a time.
//
// Fetches each trajectory only when it is reached. The list query deliberately omits `arms` — a
// nine-step run carries ~1.5MB of base64 screenshots, so pulling the whole bank up front to build a
// queue would cost tens of megabytes before the first question is on screen.

const stimulusPane = document.getElementById('stimulus-pane');
const questionPane = document.getElementById('question-pane');
const S = window.StudySession;
const IS_FIND_V2 = window.STUDY_VARIANT === 'find-v2';

// Find V2 only. The verdict radios stay disabled for this long after a task opens, so a participant
// cannot click Yes before the answer they are judging has been read; and once the task limit passes
// they get this much longer to give one before the task is submitted with none.
//
// FIVE SECONDS, DOWN FROM TEN. It only has to outlast the reflex to answer before reading — ten was
// long enough to be waited out rather than read through, and on a two-minute task it spent a
// twelfth of the clock on a disabled control.
const ANSWER_LOCK_MS = 5 * 1000;
// How long a preview must be held before it counts as having been looked at. NAMED APART from
// app/stimulus.js's REFERENCE_DWELL_MS, which owns the value: classic <script> tags share one global
// lexical scope, and a second top-level `const` of that name is a parse error that kills this entire
// file — the task page then never boots and both panes stay on "Loading…". Read off the viewer when
// it is loaded so the two cannot drift; the literal is for the pages that show no trajectory.
const REFERENCE_DWELL = window.Stimulus?.REFERENCE_DWELL_MS ?? 400;
const VERDICT_GRACE_MS = 5 * 1000;
let taskTelemetry = null;

// The data source, chosen per task. demo.html sets window.STUDY_SOURCE to a local fixture bank
// before this file loads, so the demo walks THIS code — the same queue, timers, validation and
// scoring a participant gets — rather than a parallel implementation that could drift from it.
//
// A tutorial practice task reads from window.TutorialSource for the same reason: the walkthrough
// travels the ordinary code path, so what is rehearsed is what comes next rather than a mock-up of
// it. Its insertStudyResult deliberately writes nothing.
function dataSource(task) {
  if (task?.isTutorial && window.TutorialSource) return window.TutorialSource;
  return window.STUDY_SOURCE || window.StudyDB;
}

const DB = window.STUDY_SOURCE || window.StudyDB;

function startTaskTelemetry(task) {
  stopTaskTelemetry();
  const summary = {
    scroll_count: 0,
    ctrl_f_count: 0,
    website_click_count: 0,
    panel_click_count: 0,
    text_select_count: 0,
    // Kept as a float and rounded only at snapshot: a slow drag is a long run of sub-pixel steps,
    // and rounding each one to 0 would report a stationary mouse for a pointer that crossed the page.
    mouse_move_px: 0,
    // DID THEY OPEN THE EVIDENCE? The manipulation check. Clicks and dwelled hovers are kept apart
    // because they are different gestures with the same meaning — hovering a step IS how the Guide
    // viewer is read, and folding it into a click count would hide which one happened.
    reference_click_count: 0,
    reference_hover_count: 0,
    // Per kind, jsonb-only: cite, evidence, expand, highlight (Find) · chip, ref, step, state (Guide).
    reference_kinds: {},
    started_at: Date.now(),
  };
  // Identities, not tallies: ten clicks on one chip is one reference checked, not ten.
  const referencesSeen = new Set();
  let referenceFirstMs = null;

  /**
   * One reference opened.
   *
   * `via` is 'click' or 'hover'. `id` is whatever names this reference within the task — a citation
   * number, an evidence key, a step number — and only has to be stable, not meaningful.
   *
   * REVIEW IS NOT DATA. A researcher walking the task screen to check references would otherwise
   * write their own behaviour into the participant-facing number this exists to protect.
   */
  const countReference = (kind, id, via = 'click') => {
    if (S.state.adminReview) return;
    if (via === 'hover') summary.reference_hover_count++;
    else summary.reference_click_count++;
    const key = String(kind || 'ref');
    summary.reference_kinds[key] = (summary.reference_kinds[key] || 0) + 1;
    referencesSeen.add(`${key}:${id == null ? '' : id}`);
    if (referenceFirstMs == null) referenceFirstMs = Math.max(0, Date.now() - summary.started_at);
  };

  const cleanups = [];
  const scrollTimers = new WeakMap();
  const onScroll = (target) => {
    if (!target) return;
    if (!scrollTimers.has(target)) summary.scroll_count++;
    clearTimeout(scrollTimers.get(target));
    scrollTimers.set(target, setTimeout(() => scrollTimers.delete(target), 500));
  };

  // Distance travelled, tracked PER DOCUMENT. A pointer position inside the snapshot frame and one
  // in the top document are in different coordinate spaces, so a single last-point would score the
  // jump between them as real travel every time the pointer crossed the frame border.
  const lastPoint = new WeakMap();
  const onMouseMove = (doc, e) => {
    const prev = lastPoint.get(doc);
    lastPoint.set(doc, { x: e.clientX, y: e.clientY });
    if (!prev) return;
    summary.mouse_move_px += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
  };

  // One selection, not one selectionchange. Dragging across a paragraph fires the event on every
  // character it grows by, so what is counted is the EDGE from nothing selected to something
  // selected — which is the gesture "the participant highlighted a passage".
  const selectionOpen = new WeakMap();
  const onSelectionChange = (doc) => {
    let text = '';
    try { text = String(doc.getSelection?.() || '').trim(); } catch (e) { return; }
    const open = text.length > 0;
    if (open && selectionOpen.get(doc) !== true) summary.text_select_count++;
    selectionOpen.set(doc, open);
  };

  const add = (target, event, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(event, handler, options);
    cleanups.push(() => target.removeEventListener(event, handler, options));
  };
  add(stimulusPane, 'scroll', () => onScroll(stimulusPane), { passive: true });
  add(questionPane, 'scroll', () => onScroll(questionPane), { passive: true });
  add(stimulusPane, 'click', () => { summary.website_click_count++; }, true);
  add(questionPane, 'click', () => { summary.panel_click_count++; }, true);
  add(document, 'mousemove', (e) => onMouseMove(document, e), { passive: true, capture: true });
  add(document, 'selectionchange', () => onSelectionChange(document));
  add(document, 'keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'f') {
      summary.ctrl_f_count++;
    }
  }, true);
  taskTelemetry = {
    task_id: task?.id || '',
    task_type: task?.taskType || '',
    summary,
    addIframe(frame) {
      let doc;
      try { doc = frame?.contentDocument; } catch (e) { return; }
      if (!doc) return;
      add(doc, 'scroll', () => onScroll(doc), { passive: true });
      add(doc, 'click', (e) => {
        summary.website_click_count++;
        // Clicking the evidence IN THE PAGE — the marks applyFindGrounding draws on the snapshot.
        // The only place this gesture is observable, and until now it was indistinguishable from a
        // click on any other paragraph.
        if (!e.isTrusted) return;
        const mark = e.target?.closest?.('.pageguide-highlight, .pageguide-highlight-img, [data-pageguide-styled]');
        if (mark) countReference('highlight', mark.dataset?.pgCite || '', 'click');
      }, true);
      // The snapshot is where a Find participant does their reading, so its selections and its
      // pointer travel are the ones that matter most — an unwired frame would report the hunt as
      // having happened without a mouse.
      add(doc, 'mousemove', (e) => onMouseMove(doc, e), { passive: true, capture: true });
      add(doc, 'selectionchange', () => onSelectionChange(doc));
      add(doc, 'keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'f') {
          summary.ctrl_f_count++;
        }
      }, true);
    },
    snapshot() {
      return {
        scroll_count: summary.scroll_count,
        ctrl_f_count: summary.ctrl_f_count,
        website_click_count: summary.website_click_count,
        panel_click_count: summary.panel_click_count,
        text_select_count: summary.text_select_count,
        mouse_move_px: Math.round(summary.mouse_move_px),
        // The flat column's name and meaning, kept here so the jsonb and the columns cannot drift:
        // every click in the task, either pane, matching study_task_results.click_count.
        click_count: summary.website_click_count + summary.panel_click_count,
        reference_click_count: summary.reference_click_count,
        reference_hover_count: summary.reference_hover_count,
        reference_distinct_count: referencesSeen.size,
        // Null, not 0: no first open happened. The counts above are genuinely 0 in that case, which
        // is a finding; a 0 here would read as "opened one immediately".
        reference_first_ms: referenceFirstMs,
        reference_kinds: { ...summary.reference_kinds },
        active_ms: Math.max(0, Date.now() - summary.started_at),
      };
    },
    countReference,
    stop() {
      cleanups.splice(0).forEach(fn => {
        try { fn(); } catch (e) { /* ignore */ }
      });
    },
  };
}

/**
 * The hook app/stimulus.js reports through.
 *
 * The Guide viewer is also loaded by V1 and by preview.html, neither of which has this telemetry, so
 * it calls `window.StudyTelemetry?.reference(...)` and carries on when nothing is listening. Keeping
 * the dependency one-way means the viewer stays a viewer.
 */
window.StudyTelemetry = {
  reference(kind, id, via) {
    taskTelemetry?.countReference?.(kind, id, via);
  },
};

function taskInteractionSummary() {
  return taskTelemetry ? taskTelemetry.snapshot() : null;
}

/**
 * The interaction summary with the browse simulator's usage folded in.
 *
 * IN `interaction_summary` RATHER THAN ITS OWN COLUMNS, deliberately. That column already holds
 * everything about how a participant worked through a task — scrolling, selection, pointer travel —
 * and the simulator is one more of those. A column per number would need a migration to answer the
 * next question about it, and the questions are not settled yet.
 *
 * `browse_sim` is ABSENT on a grounded task and on a session that never had the button, and a zeroed
 * object on one that had it and left it alone. See browseSimStats.
 */
function withBrowseSim(summary) {
  let sim = null;
  let walk = null;
  try {
    sim = window.Stimulus?.browseSimStats?.() || null;
    walk = window.Stimulus?.stepWalkStats?.() || null;
  } catch (e) { /* no stimulus mounted */ }
  if (!sim && !walk) return summary;
  const out = { ...(summary || {}) };
  if (sim) out.browse_sim = sim;
  // Paging done after expanding a step, kept apart from the button's walk: two gestures, and this
  // one exists in the grounded arm whether or not the study offers the simulator.
  if (walk) out.step_walk = walk;
  return out;
}

function stopTaskTelemetry() {
  if (!taskTelemetry) return;
  taskTelemetry.stop();
  taskTelemetry = null;
}

/**
 * WHICH CONDITION THIS QUESTION IS IN, said out loud at the top of the material.
 *
 * The arms differ in what is on screen, and a participant who does not know that reads a missing
 * screenshot as a broken page rather than as the condition — so they hunt for something that was
 * never there, and the time we measure is the time they spent looking for a bug. Naming it turns
 * "I could not tell" from an admission into an answer, which is the answer this study needs.
 *
 * The one-liner says what is different; the ⓘ says what that means for THIS kind of task, because
 * "no evidence" means no step screenshots for a guide trajectory and no marks on the page for a
 * find question, and a participant only ever sees one of the two at a time.
 */
const CONDITION_COPY = {
  guide: {
    grounding: {
      label: 'Grounded',
      note: 'each step can be checked against the page',
      hint: 'This task shows the agent\'s evidence. Hover a step in the journey to see the page the '
        + 'agent was looking at when it took that action, and click for a full-size view. Numbered '
        + 'chips in the answer mark claims the agent backed with something it saw.',
    },
    nongrounding: {
      label: 'Non-grounded',
      note: 'no screenshots, and no evidence behind the answer',
      hint: 'This task deliberately withholds the agent\'s evidence, in both places it would appear: '
        + 'the steps are described in words only, with nothing to hover or click, and the answer '
        + 'carries no numbered chips or marked phrases either. Nothing is missing or broken — that '
        + 'is the condition. The before and after pictures of the page are still shown, as they are '
        + 'in every task. Judge from what is here, and if you cannot tell what happened, say so.',
    },
  },
  find: {
    grounding: {
      label: 'Grounded',
      note: 'the answer\'s evidence is marked on the page',
      hint: 'This task shows the agent\'s evidence. The passages the answer relies on are highlighted '
        + 'on the page beside it, and the numbered chips in the answer take you to them.',
    },
    nongrounding: {
      label: 'Non-grounded',
      note: 'no marks on the page, no citations in the answer',
      hint: 'This task deliberately withholds the agent\'s evidence, in both places it would appear: '
        + 'nothing on the page is highlighted for you, and the answer carries no citations to click '
        + 'either — it is plain text. Nothing is missing or broken — that is the condition. The page '
        + 'itself is still entirely there to read. If you cannot tell what the answer was based on, '
        + 'say so.',
    },
  },
};

function conditionBannerHtml(arm, taskType) {
  const copy = CONDITION_COPY[taskType === 'find' ? 'find' : 'guide'][arm === 'nongrounding' ? 'nongrounding' : 'grounding'];
  const cls = arm === 'nongrounding' ? ' is-nongrounded' : ' is-grounded';
  return `
    <div class="tv-condition${cls}">
      <span class="tv-condition-badge"><span class="tv-condition-dot" aria-hidden="true"></span>${esc(copy.label)}</span>
      <span class="tv-condition-note">${esc(copy.note)}</span>
      <button type="button" class="tv-info tv-condition-info" data-condition-hint aria-expanded="false"
        aria-label="What does this condition mean?">i</button>
      <div class="tv-condition-hint" hidden>${esc(copy.hint)}</div>
    </div>`;
}

/**
 * Which half of the counterbalance this sitting is in — Group A (text) or Group B (visual).
 *
 * NOT A CONDITION, and drawn apart from the condition banner for that reason. The banner says what
 * is different about THIS task; the group says which of the two protocols the whole sitting is
 * running, and a participant switches condition between tasks but never switches group.
 *
 * It is on screen for the researcher as much as the participant: a pilot session where the group is
 * only in localStorage is one where "it dealt me the wrong task" cannot be checked against anything
 * without opening devtools. `state.group` is set once in beginStudy from the server-assigned slot
 * (find_v2_welcome.js, groupOf) and each queued task carries its own copy, so a resumed session
 * still knows which it is.
 *
 * Renders NOTHING when the group is unknown — admin review and the tutorial are not dealt a slot,
 * and an empty chip there would read as a group that failed to load.
 */
function groupChipHtml() {
  // OFF UNLESS THE STUDY ASKS FOR IT. The chip names the counterbalancing half a sitting landed in —
  // an experimental factor the participant is not asked about and cannot act on, and one that invites
  // the question the study most needs them not to ask: what is the other group getting, and should I
  // be answering differently? Kept for piloting and for screenshots, behind a setting.
  //
  // The condition banner is not the same thing and is always shown: it says what is ON THE SCREEN, so
  // a missing screenshot reads as the condition rather than as a fault.
  if (!S.studyFlags().showGroupChip) return '';
  const group = S.state.group || S.state.queue?.[S.state.idx]?.group || '';
  if (group !== 'A' && group !== 'B') return '';
  return `
    <div class="tv-group" title="The counterbalancing half this session was assigned. It is the same for every task in this sitting.">
      <span class="tv-group-badge">Group ${esc(group)}</span>
      <span class="tv-group-note">${group === 'B' ? 'visual' : 'text'}</span>
    </div>`;
}

// Delegated from the panes, which outlive every shell rebuild — the banner itself is re-rendered for
// each task, so binding it per render would stack listeners. BOTH panes: V1 draws the banner above
// the material on the left, V2 draws it in the question pane on the right.
[stimulusPane, questionPane].forEach(pane => pane.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-condition-hint]');
  if (!btn) return;
  const hint = btn.parentElement.querySelector('.tv-condition-hint');
  if (!hint) return;
  hint.hidden = !hint.hidden;
  btn.setAttribute('aria-expanded', hint.hidden ? 'false' : 'true');
  btn.classList.toggle('is-open', !hint.hidden);
}));

/**
 * The V2 guide stimulus shell.
 *
 * No header, matching the V2 Find layout: the goal and the Grounded chip live in the question pane,
 * and repeating them above the trajectory would push the material down for no gain. mountStimulus
 * still wants a goal and a count element, so it gets detached ones — the trajectory writes into them
 * and nothing renders them, which is cheaper than making the viewer's mount points optional.
 */
function renderGuideV2Shell() {
  stimulusPane.innerHTML = `
    <main class="tv-main">
      <section class="tv-stage" id="tv-stage"></section>
    </main>`;
  return {
    goal: document.createElement('h1'),
    count: document.createElement('div'),
    stage: document.getElementById('tv-stage'),
  };
}

/** The guide stimulus shell — the same markup study.html ships, rebuilt after a Find task. */
function renderGuideShell(arm) {
  stimulusPane.innerHTML = `
    <header class="tv-head">
      <div class="tv-head-main">
        <div class="tv-kicker">Task</div>
        <h1 class="tv-goal" id="tv-goal">Loading…</h1>
        ${conditionBannerHtml(arm, 'guide')}
      </div>
      <div class="tv-count" id="tv-count"></div>
    </header>
    <main class="tv-main">
      <section class="tv-stage" id="tv-stage"></section>
    </main>`;
}

/**
 * Unmount whatever is in the question pane.
 *
 * mountInstrument has always returned a cleanup and study.js has always stored it — and never
 * called it. Nothing broke while the only way off a task was to submit it (both submit handlers
 * clear their own intervals), but the walkthrough's Back button leaves a task mid-question, and a
 * timer left running writes to a #q-timer that no longer exists once a tick lands.
 */
function detachQuestionPane() {
  try { S.state.detachInstrument?.(); } catch (e) { /* a cleanup must never block a render */ }
  S.state.detachInstrument = null;
}

function panelMessage(html) {
  questionPane.innerHTML = `<div class="q-body">${html}</div>`;
}

async function boot() {
  // The walkthrough on its own, from the admin panel. No session, no assignment, no queue — it needs
  // none of them, since the practice material is local, and claiming a slot to check some wording
  // would spend a participant's assignment on a researcher.
  if (new URLSearchParams(location.search).get('tutorial') === 'preview') {
    return window.Tutorial.preview();
  }

  // The final screen on its own, from the admin panel. Same reasoning as the walkthrough preview: it
  // needs no session and no queue, and the alternative — answering eight tasks to find out whether
  // the survey renders — is why nobody checks this screen.
  if (new URLSearchParams(location.search).get('finish') === 'preview') {
    return finish({ preview: true });
  }

  // In-memory state wins when it is already populated. That is how the demo hands its fixture queue
  // over without going near localStorage — which matters, because the demo and a real run would
  // otherwise share one storage key, and opening the demo would silently discard the progress of a
  // participant who was midway through the actual study.
  const seeded = S.state.participantId && Array.isArray(S.state.queue) && S.state.queue.length;
  // A review session is checked first and lives in its own sessionStorage key, so entering review
  // mode never disturbs a participant partway through the real study on the same machine.
  const saved = seeded ? S.state : (S.loadReview() || S.loadLocal());
  if (!saved || !saved.participantId || !Array.isArray(saved.queue) || !saved.queue.length) {
    // A demo says outright what is wrong. Bouncing it to the welcome screen would hide the actual
    // fault behind a redirect, which is exactly how this took three attempts to diagnose.
    if (window.STUDY_SOURCE) {
      panelMessage('<p class="q-text">Demo could not start: no queue was seeded.</p>'
        + `<pre class="q-field" style="white-space:pre-wrap">${JSON.stringify({
            participantId: S.state.participantId,
            queue: Array.isArray(S.state.queue) ? S.state.queue.length : typeof S.state.queue,
          }, null, 2)}</pre>`);
      return;
    }
    // Reached directly, or the session was cleared. Send them back rather than inventing a session:
    // a result row with no participant id is a row nobody can use.
    if (!window.STUDY_SOURCE) S.clearLocal();
    location.replace(IS_FIND_V2 ? 'index.html' : 'find-v1.html');
    return;
  }
  Object.assign(S.state, saved);

  // THE LIMIT THIS RUN BEGAN WITH, applied before the first task paints. It was snapshotted into
  // state.flags at start and saved with the session, so resuming a run tomorrow keeps the minutes it
  // was dealt even if Admin has changed them since — the same rule the evidence and follow-up
  // switches follow, and for the same reason: task 4 must be the same task as task 3.
  window.TaskTimer.setLimit(S.studyFlags().taskLimitSeconds * 1000);

  if (!S.state.runId) {
    S.state.runId = S.newRunId();
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();
  }

  // THE WALKTHROUGH, OFFERED ONCE, BEFORE TASK 1. Only at the very start: someone returning to a run
  // they are five tasks into has already learnt the screen, and interrupting them to teach it would
  // be worse than not offering it at all. A reviewer and the demo never see it.
  if (S.state.idx === 0 && !S.state.adminReview && !window.STUDY_SOURCE
      && window.Tutorial && !window.Tutorial.isDone()) {
    return window.Tutorial.renderWelcome();
  }
  await showTask();
}

async function showTask() {
  const { queue, idx } = S.state;
  // A practice task comes from the tutorial's own two-item queue and leaves `idx` alone, so the real
  // study still begins at task 1 whether the walkthrough was taken, skipped or left halfway.
  const practising = !!S.state.tutorial?.active;
  if (!practising && idx >= queue.length) return finish();

  const task = practising ? window.Tutorial.currentTask() : queue[idx];
  if (!task) return finish();
  renderDryRunNav();
  detachQuestionPane();
  startTaskTelemetry(task);
  const arm = S.taskArm ? S.taskArm(task) : S.conditionLabel(task?.arm || S.state.arm);
  panelMessage('<p class="q-text">Loading the next task…</p>');
  if (task.taskType === 'find') return showFindTask(task);
  // V2's Guide task shares the viewer but not the V1 instrument: it asks for a verdict and, after a
  // No, step numbers only — not the problem/error taxonomy — and reads from a different table.
  if (IS_FIND_V2) return showGuideV2Task(task, arm);

  let record = null;
  try {
    record = await dataSource(task).getStudyTrajectory(task.id);
  } catch (e) {
    console.error('[study] could not load the trajectory:', e);
  }

  if (!record) {
    // Skip rather than strand: one unreadable stimulus must not end the session, and a row that
    // was never shown must not be recorded as an answer.
    console.warn('[study] skipping a trajectory that could not be loaded:', task.id);
    S.state.idx++;
    if (!window.STUDY_SOURCE) S.saveLocal();
    return showTask();
  }

  // REBUILD THE SHELL EVERY TIME. A Find task replaces this pane wholesale (it renders a framed
  // page, not a step list), so after one of those the elements mountStimulus targets no longer
  // exist — and a guide task following a find task rendered into nothing until the page was
  // reloaded. Rebuilding is cheap and removes the ordering dependency entirely.
  renderGuideShell(arm);
  window.Stimulus.mountStimulus(record, arm, {
    goal: document.getElementById('tv-goal'),
    count: document.getElementById('tv-count'),
    stage: document.getElementById('tv-stage'),
  });
  stimulusPane.scrollTop = 0;

  S.state.detachInstrument = window.Instrument.mountInstrument({
    root: questionPane,
    steps: window.Stimulus.stimulusSteps(),
    index: idx,
    total: queue.length,
    progressLabel: progressText(),
    dryRun: !!S.state.dryRun,
    goal: record.goal || record.title || '',
    onSubmit: (timings) => askPostQuestions(task, record, timings),
  });
  if (S.state.adminReview) {
    questionPane.insertAdjacentHTML('beforeend', adminGuideGroundTruthHtml(record));
    questionPane.insertAdjacentHTML('beforeend', adminNavHtml());
    bindAdminNav();
  }
  questionPane.scrollTop = 0;
  window.Tutorial?.onTaskRendered(task);
}

/**
 * The line above the questions: which task this is.
 *
 * Overridden during the walkthrough, because "Task 1/8" over a practice task would be a lie about
 * the thing the study most needs a participant to trust — how much of it is left.
 */
function progressText() {
  if (S.state.tutorial?.active) return window.Tutorial.progressLabel();
  // A TEST RUN LOOKS EXACTLY LIKE A REAL ONE. Same tasks, same screens, same answers — and
  // saveStudyResult deliberately writes none of them, which is the whole point of it. The welcome
  // screen says so once and is then navigated away from, so a researcher can finish a ten-claim
  // session believing it was recorded and only discover otherwise in the console. Said here it is
  // said on every task, in the line they are already reading to see how far through they are.
  if (S.state.dryRun) return `Task ${S.state.idx + 1}/${S.state.queue.length} · test run — not saved`;
  return null;
}

/**
 * A FIND task, as far as a website can show one.
 *
 * The site cannot RUN a Find task: that needs the extension on a live page to index it, highlight
 * the citations and let a participant pick sentences off it. What it can show is the material — the
 * question, the page, and the agent's recorded answer for this arm — which is what a reviewer
 * checking wording needs, and is the whole reason admin mode exists.
 *
 * Said outright rather than mocked up, because a preview that pretended to be the task would be
 * reviewed as though it were.
 */
async function showFindTask(task) {
  const { idx, queue } = S.state;
  const arm = S.taskArm ? S.taskArm(task) : S.conditionLabel(task?.arm || S.state.arm);
  const source = dataSource(task);
  const [cannedRes, groundTruthRes, pageRes] = await Promise.allSettled([
    // The task is passed as a third argument for Find V2, whose recorded answer
    // depends on the correctness half of the dealt variant as well as the arm.
    // V1's adapter takes two arguments and ignores it.
    source.getCannedResponse ? source.getCannedResponse(task.id, arm, task) : Promise.resolve(null),
    loadFindGroundTruth(task),
    source.getTaskPage ? source.getTaskPage(task.id, task.url) : Promise.resolve(null),
  ]);

  const canned = cannedRes.status === 'fulfilled' ? cannedRes.value : null;
  if (cannedRes.status === 'rejected') console.warn('[study] no recorded answer for', task.id, cannedRes.reason?.message);

  const groundTruth = groundTruthRes.status === 'fulfilled' ? groundTruthRes.value : { error: groundTruthRes.reason?.message || String(groundTruthRes.reason), task_id: task.id };
  if (groundTruthRes.status === 'rejected') console.warn('[study] could not load ground truth for', task.id, groundTruthRes.reason?.message);

  const page = pageRes.status === 'fulfilled' ? pageRes.value : null;
  if (pageRes.status === 'rejected') console.warn('[study] no captured page for', task.id, pageRes.reason?.message);

  const answer = canned?.answer_display || canned?.answer_raw || '';

  // V2 GIVES THE WHOLE LEFT PANE TO THE PAGE. The question and the condition chip used to sit above
  // the snapshot as well as in the question pane, which said the same thing twice and pushed the
  // material a header's worth further down — on a laptop, far enough that the top of the page was
  // off screen before the participant had read anything. Both now live only in the question pane,
  // beside the answer they are about. V1 keeps its header: its runs are recorded against that layout.
  stimulusPane.innerHTML = `
    ${IS_FIND_V2 ? '' : `<header class="tv-head">
      <div class="tv-head-main">
        <div class="tv-kicker">Task</div>
        <h1 class="tv-goal">${esc(task.question || task.title || '')}</h1>
        ${conditionBannerHtml(arm, 'find')}
      </div>
    </header>`}
    <main class="tv-main">${page?.html
      ? '<iframe class="find-page" id="find-page" title="The page this question is about"></iframe>'
      : `<div class="tv-col">
          <div class="tv-section-title"><span>The page</span></div>
          <p class="tv-answer">${task.url
            ? `<a href="${esc(task.url)}" target="_blank" rel="noreferrer">${esc(task.url)}</a>`
            : 'No page recorded.'}</p>
          <p class="tv-warn">No snapshot has been captured for this task yet, so the page cannot be
            shown here. Capture it from the extension's Find recorder (📄 Capture page), then
            publish. The live URL cannot be embedded: most sites refuse to be framed, and a
            cross-origin frame cannot be scripted, so nothing could be highlighted in it.</p>
        </div>`}</main>`;

  // SAME-ORIGIN ON PURPOSE. srcdoc gives the frame this page's origin, which is the entire reason
  // the snapshot exists: a cross-origin frame cannot be indexed, highlighted or scrolled, so the
  // grounded arm would have nothing to show. The snapshot carries its own restrictive CSP and had
  // its scripts stripped at capture, so nothing in it runs.
  if (page?.html) {
    mountSnapshot(document.getElementById('find-page'), page.html, canned, arm);
  }

  const cites = parseFindCitations(answer);

  // A REVIEWER previews; a PARTICIPANT answers. Review mode deliberately shows no questions and no
  // timer: it exists to check the material, and a reviewer filling in Q1 sixteen times would be
  // producing answers that look exactly like data.
  if (S.state.adminReview) {
    questionPane.innerHTML = `
      <div class="q-head"><span class="q-title">🔍 Find task</span></div>
      <div class="q-progress">Task ${idx + 1}/${queue.length} · review</div>
      <div class="q-body">
        <div class="q-text">${questionHtml(task.question)}</div>
        ${IS_FIND_V2 ? conditionBannerHtml(arm, 'find') : ''}
        ${answerCardHtml(answer, arm)}
        ${IS_FIND_V2 && arm !== 'nongrounding'
          ? referencePanelHtml(citationLinkReport(null, answer, canned?.citation_anchors), [])
          : ''}
        ${adminFindGroundTruthHtml(groundTruth, task)}
        ${IS_FIND_V2 ? '' : adminGroundingReviewHtml(task, canned, arm, cites, !!page?.html)}
        <p class="q-sub">Review mode — participant answers are not recorded.</p>
        ${adminNavHtml()}
      </div>`;
    bindFindAnswerChips(canned, arm, cites);
    if (IS_FIND_V2) {
      // The snapshot mounts asynchronously, so the first report is drawn with no document and every
      // row reads "not found". Repaint once the frame is readable — the panel is only honest if the
      // page it is reporting on is actually there.
      if (arm !== 'nongrounding') whenSnapshotReady(() => bindReferencePanel(task, canned, arm));
    } else {
      bindAdminGroundingReview(task, canned, arm, cites);
    }
    bindAdminNav();
    return;
  }

  renderFindQuestions(task, canned, answer, arm, cites, groundTruth);
}

async function loadFindGroundTruth(task) {
  const source = dataSource(task);
  if (source?.getStudyGroundTruth) {
    const row = await source.getStudyGroundTruth(task.id, task.url);
    if (row) return row;
  }
  // A practice task carries its own ground truth or none — never fall through to Supabase for it.
  if (task?.isTutorial) return null;
  return fetchFindGroundTruthDirect(task);
}

async function fetchFindGroundTruthDirect(task) {
  const cfg = window.STUDY_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return null;
  const headers = {
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
  };
  const base = `${cfg.SUPABASE_URL}/rest/v1/study_ground_truth?select=*`;
  const byId = await fetch(`${base}&task_id=eq.${encodeURIComponent(task.id)}&limit=1`, { headers });
  if (!byId.ok) throw new Error(`Supabase ${byId.status} loading study_ground_truth`);
  const rows = await byId.json();
  if (Array.isArray(rows) && rows[0]) return rows[0];

  const allRes = await fetch(base, { headers });
  if (!allRes.ok) throw new Error(`Supabase ${allRes.status} scanning study_ground_truth`);
  const all = await allRes.json();
  const taskId = String(task.id || '').toLowerCase();
  return (Array.isArray(all) ? all : []).find(row => {
    if (String(row?.task_id || '').toLowerCase() === taskId) return true;
    const hits = Object.values(row?.hops || {}).flat();
    return hits.some(hit => String(hit?.url || '') === String(task.url || ''));
  }) || null;
}

/** The agent's recorded answer, rendered with its citations and evidence. */
function answerCardHtml(answer, arm) {
  return `
    <div class="q-card" id="q-answer-card" style="margin-top:12px;">
      <div class="q-card-head"><span class="q-badge">A</span>
        <p class="q-text">The agent's answer${arm === 'nongrounding' ? ' (non-grounded)' : ''}</p></div>
      <div class="find-answer">${answer
        ? renderFindAnswer(answer, arm)
        : '<em class="q-sub">No answer was recorded for this task in this arm.</em>'}</div>
    </div>`;
}

/**
 * The task question, as one or two numbered parts.
 *
 * These questions are two-hop by construction — find a thing in the prose, then read something off
 * the picture it points at — and the evidence prompts have always said "the first part" and "the
 * second part". The question itself was a single wall of three sentences, so a participant had to
 * work out where one part ended and the other began before they could start, under a clock.
 *
 * THE SPLIT IS AUTHORED, NOT GUESSED: one line per part in the claim's question field. A question
 * written as a single line still renders as a single paragraph, so nothing already authored changes
 * shape until somebody edits it.
 */
function questionParts(question) {
  return String(question || '')
    .split(/\r?\n/)
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * THE HINGE between two parts, marked with **double asterisks** in the authored text.
 *
 * A two-hop question only works if the reader sees what carries over. "A famous collection of
 * novels…" then "in the image of the second novel…" is one chain, but split across two numbered
 * lines it reads as two unrelated instructions, and the participant's first job becomes working out
 * which noun in part 1 part 2 is pointing at — under a clock.
 *
 * AUTHORED, NOT INFERRED. Guessing the shared term from the text would be a heuristic that is wrong
 * occasionally and silently, and the questions are the instrument. Whoever writes the question marks
 * the hinge, the same way they choose where the parts break.
 *
 * Escaped BEFORE the markers are read, so a question containing a literal < or & is safe and only
 * the two-asterisk pairs this function put there become markup.
 */
function questionHtml(question) {
  const parts = questionParts(question);
  const mark = (part) => esc(part).replace(/\*\*([^*]+)\*\*/g, '<b class="q-hinge">$1</b>');
  if (parts.length < 2) return mark(parts[0] || '');
  return `<ol class="q-task-parts">${parts.map(part => `<li>${mark(part)}</li>`).join('')}</ol>`;
}

/**
 * The two clocks every V2 verdict runs under: the opening lock and the hard cutoff.
 *
 * Both Find and Guide need exactly this, and a state machine with a `running → grace → done`
 * transition is the kind of thing that survives being copied once and then quietly diverges — one
 * task type gaining a fix the other does not. So it lives here and each task drives it from its own
 * one interval.
 *
 * The caller supplies `submit(answerValue)`, which must be idempotent: the grace expiring and a late
 * click on the submit button can both reach it.
 *
 * @param {object} opts
 * @param {Element} opts.pane        - the question pane to read and paint
 * @param {string}  opts.radioName   - the verdict radio group
 * @param {Function} opts.submit     - submit(answerValue|null); null means the grace ran out
 * @param {Function} [opts.liveButton] - the primary button to enable when the lock lifts
 * @param {Function} [opts.onExpire] - fold away anything past the verdict when time runs out
 * @param {Function} [opts.showError] - where the grace countdown is written
 * @param {Function} [opts.clearError]
 */
function verdictClocks({ pane, radioName, submit, liveButton, onExpire, showError, clearError }) {
  let unlocked = !IS_FIND_V2;   // V1 has never had an opening lock
  let deadline = 'running';     // running -> grace -> done
  let expiredAt = null;

  const $ = (id) => pane.querySelector(`#${id}`);
  const verdict = () => pane.querySelector(`input[name="${radioName}"]:checked`)?.value || null;

  /**
   * The lock, ON THE BUTTON as well as above the radios.
   *
   * The button was already `disabled` for these five seconds and a click on it genuinely did
   * nothing — but nothing SAID so. `.q-btn` had no disabled styling at all, so it stayed solid,
   * kept `cursor: pointer` and still lit up on hover: a control that looks live, feels live, and
   * silently swallows the click. The one place a participant is looking when they press Submit is
   * the button, and the only explanation was a line of grey text further up the pane, next to the
   * radios, which is not where they are looking.
   *
   * So the button counts itself down. The remaining seconds are the label, which makes the wait
   * legible exactly where the click lands, and the original label is kept on the node so unlock can
   * put it back without this function having to know whether it is driving Submit or Next.
   */
  const paintLock = (elapsed) => {
    const left = Math.max(1, Math.ceil((ANSWER_LOCK_MS - elapsed) / 1000));
    const el = $('q-answer-lock-s');
    if (el) el.textContent = String(left);
    const live = liveButton?.();
    if (!live) return;
    if (live.dataset.lockLabel == null) live.dataset.lockLabel = live.textContent;
    live.textContent = `${live.dataset.lockLabel.replace(/\s*→\s*$/, '')} in ${left}s`;
  };

  const unlock = () => {
    unlocked = true;
    pane.querySelectorAll(`input[name="${radioName}"]`).forEach(el => { el.disabled = false; });
    $('q-find-answer')?.classList.remove('is-locked');
    $('q-answer-lock')?.remove();
    const live = liveButton?.();
    if (!live) return;
    live.disabled = false;
    if (live.dataset.lockLabel != null) {
      live.textContent = live.dataset.lockLabel;
      delete live.dataset.lockLabel;
    }
  };

  const enforce = (elapsed) => {
    if (deadline === 'done') return;
    if (deadline === 'running') {
      if (elapsed < window.TaskTimer.LIMIT_MS) return;
      // A verdict already given is the thing the grace exists to obtain, so there is nothing left to
      // wait for: submit what there is.
      if (verdict()) { deadline = 'done'; return void submit(verdict()); }
      deadline = 'grace';
      expiredAt = Date.now();
      onExpire?.();
      window.QForm.markMissing($('q-find-answer'));
      try { $('q-find-answer')?.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    }
    // Answering inside the grace is a real answer, not a timeout: the run simply carries on and the
    // clock goes back to being the soft overrun it always was.
    if (verdict()) {
      deadline = 'done';
      window.QForm.clearMissing(pane);
      clearError?.();
      return;
    }
    const left = Math.ceil((VERDICT_GRACE_MS - (Date.now() - expiredAt)) / 1000);
    if (left <= 0) { deadline = 'done'; return void submit(null); }
    showError?.(`Time is up. Choose Yes or No now — ${left}s.`);
  };

  // PAINTED ONCE, NOW, rather than waiting for the first tick. The task's interval runs every 250ms,
  // so the button would otherwise spend a quarter of a second reading "Submit →" and looking ready —
  // which is exactly the quarter second an impatient participant clicks in.
  if (!unlocked) paintLock(0);

  return {
    /** Call once a tick from the task's own interval. */
    tick(elapsed) {
      if (!unlocked) {
        if (elapsed >= ANSWER_LOCK_MS) unlock();
        else paintLock(elapsed);
      }
      if (IS_FIND_V2) enforce(elapsed);
    },
    verdict,
    /** The task is submitting by its own route; stop the cutoff from firing behind it. */
    settle() { deadline = 'done'; },
  };
}

/**
 * The verdict radios plus the lock notice, shared by both task types.
 *
 * The container keeps the id `q-find-answer` on both: app/tutorial.js points V1's walkthrough at it
 * by that name, and only one pane is ever mounted, so Guide reusing it costs nothing and renaming it
 * would silently break a tour step in the other study.
 */
function verdictOptionsHtml(options, labelFor) {
  const locked = IS_FIND_V2;
  return `
        ${locked ? `<p class="q-sub q-answer-lock" id="q-answer-lock">Read the question and the
          agent’s answer first — you can respond in <b id="q-answer-lock-s">${Math.round(ANSWER_LOCK_MS / 1000)}</b>s.</p>` : ''}
        <div class="q-options${locked ? ' is-locked' : ''}" id="q-find-answer">
          ${options.map(opt => `
            <label class="q-opt q-opt-rich">
              <input type="radio" name="q-find-answer" value="${esc(opt)}"${locked ? ' disabled' : ''}>
              <span class="q-opt-body"><span>${labelFor(opt)}</span></span>
            </label>`).join('')}
        </div>`;
}

/**
 * The participant's Find task: read the answer, pick one, then point at what supports it.
 *
 * Up to three stages, and V2 can be told to ask for only the first of them — see the Study settings
 * tab in Admin, and window.StudySession.studyFlags for why the switches are read once at the start
 * of a run rather than per task. V1's protocol is fixed: its data is already collected, and a flag
 * that reached it would change what its rows mean.
 *
 * THE TIMER IS A HARD CUTOFF IN V2. app/instrument.js explains why the countdown was built soft;
 * that is still true of V1 and of the Guide instrument, which is why the cutoff lives here rather
 * than in TaskTimer. At 00:00 the participant is pushed back to the verdict and given
 * VERDICT_GRACE_MS to give one; a task that runs those out is submitted with no verdict at all,
 * which is a third outcome and is stored as one.
 *
 * AND THE VERDICT IS LOCKED FOR THE FIRST FEW SECONDS (ANSWER_LOCK_MS). Yes/No is one click away
 * from the moment the task opens, and a participant who wants to be finished can answer before the
 * page has finished rendering — producing a row that looks like a judgment and is a coin flip. The
 * lock costs an honest participant seconds they were going to spend reading anyway.
 */
function renderFindQuestions(task, canned, answer, arm, cites, groundTruth) {
  const { idx, queue } = S.state;
  // Find V1 asks which answer was found. Find V2 asks for a verdict on the
  // displayed agent claim, whose researcher-authored key may be true or false.
  // The rest of the task — evidence picking and its separate timer — stays on
  // the shared path so V2 differs only where the protocol intentionally differs.
  const yesNo = task?.studyVersion === 'find-v2';
  const flags = IS_FIND_V2 ? S.studyFlags() : { collectEvidence: true, collectFollowup: true };
  const askEvidence = !!flags.collectEvidence;
  const options = yesNo ? ['yes', 'no'] : window.FindTask.answerOptions(task);
  const hops = window.FindTask.evidencePrompts(task);
  const startedAt = Date.now();
  let choiceElapsed = null;
  let supportStartedAt = null;
  let answerTimer = null;
  let submitted = false;
  let clocks = null;              // the opening lock and the hard cutoff — see verdictClocks
  const picked = [null, null];    // one evidence selection per hop

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">🔍 ${yesNo ? 'Check the claim' : 'Find the answer'}</span></div>
    <div class="q-progress${S.state.dryRun ? ' is-dry-run' : ''}">${esc(progressText() || `Task ${idx + 1}/${queue.length}`)}</div>
    <div class="q-body">
      <div class="q-task-card" id="q-task-card">
        ${window.TaskTimer.html()}
        <div class="q-task-label">Question</div>
        ${questionHtml(task.question)}
      </div>
      ${IS_FIND_V2 ? conditionBannerHtml(arm, 'find') + groupChipHtml() : ''}

      ${answerCardHtml(answer, arm)}

      <div class="q-card">
        <div class="q-card-head"><span class="q-badge">Q1</span>
          <p class="q-text">${yesNo ? 'Does the agent’s answer correctly answer the question?' : 'Select the answer you found:'}${window.QForm.requiredMark()}</p></div>
        ${verdictOptionsHtml(options, opt => (yesNo
          ? `<b>${opt === 'yes' ? 'Yes' : 'No'}</b><small>${opt === 'yes'
            ? 'The agent’s answer is correct.' : 'The agent’s answer is not correct.'}</small>`
          : esc(opt)))}
      </div>

      ${askEvidence ? `
      <div id="q-support-stage" hidden>
        ${hops.map((hop, i) => `
          <div class="q-card" id="q-hop-card-${i}">
            <div class="q-card-head"><span class="q-badge">Q${i + 2}</span>
              <p class="q-text">${esc(hop.prompt)}${window.QForm.requiredMark()}</p></div>
            <p class="q-sub" id="q-hop-hint-${i}">${hop.kind === 'image'
              ? 'Click the image in the page on the left.'
              : 'Click the sentence or paragraph in the page on the left.'}</p>
            <div class="q-picked" id="q-picked-${i}">Nothing selected yet.</div>
            <button class="q-btn" data-pick-hop="${i}">${hop.kind === 'image'
              ? '🖼 Pick evidence' : '✏️ Pick evidence'}</button>
          </div>`).join('')}
      </div>` : ''}

      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions">
        <button class="q-btn q-btn-primary" id="q-find-next"${askEvidence ? '' : ' hidden'}${IS_FIND_V2 ? ' disabled' : ''}>Next →</button>
        <button class="q-btn q-btn-primary" id="q-find-submit"${askEvidence ? ' hidden' : ''}${IS_FIND_V2 ? ' disabled' : ''}>Submit →</button>
      </div>
      ${previewNavHtml()}
    </div>`;

  bindFindAnswerChips(canned, arm, cites);

  const $q = (id) => questionPane.querySelector(`#${id}`);
  const errorEl = $q('q-error-msg');
  const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearError = () => { errorEl.hidden = true; };
  const verdictValue = () => clocks.verdict();

  clocks = verdictClocks({
    pane: questionPane,
    radioName: 'q-find-answer',
    showError,
    clearError,
    liveButton: () => (askEvidence ? $q('q-find-next') : $q('q-find-submit')),
    // The evidence stage is past the verdict, and the grace only guards the verdict.
    onExpire: () => {
      const stage = $q('q-support-stage');
      if (stage) stage.hidden = true;
    },
    submit: (answerValue) => { void finish(answerValue); },
  });

  // One countdown for the whole task — see window.TaskTimer in app/instrument.js for the three-minute
  // budget. It ticks four times a second rather than once because the opening lock and the grace are
  // both counted in it, and a second's lag on either reads as a frozen page.
  answerTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    window.TaskTimer.paint(questionPane, elapsed);
    clocks.tick(elapsed);
  }, 250);

  // The same contract mountInstrument returns, in the same slot: whatever is mounted in the question
  // pane knows how to stop itself, and detachQuestionPane is what asks it to.
  S.state.detachInstrument = () => {
    clearInterval(answerTimer);
    stopPicking(document.getElementById('find-page'));
  };

  // ── Picking evidence in the page ──
  // The snapshot is same-origin, so a click inside it can be read. That is the whole reason the
  // snapshot exists rather than a screenshot: the participant points at the real thing.
  let pickingHop = null;
  const frame = () => document.getElementById('find-page');

  const setPicked = (hop, value, label) => {
    picked[hop] = value;
    const box = $q(`q-picked-${hop}`);
    if (box) {
      box.textContent = label;
      box.classList.add('is-picked');
    }
    window.QForm.markMissing($q(`q-hop-card-${hop}`), false);
    window.QForm.refreshError();
  };


  // The hint under each question doubles as that question's feedback line, so a click that could
  // not be read is answered where the participant is already looking rather than in a shared error
  // bar at the bottom of the pane.
  const hintText = hops.map((hop, i) => $q(`q-hop-hint-${i}`)?.textContent || '');
  const setHint = (hop, message) => {
    const el = $q(`q-hop-hint-${hop}`);
    if (!el) return;
    el.textContent = message == null ? hintText[hop] : message;
    el.classList.toggle('is-warn', message != null);
  };

  const disarm = (btn, hop) => {
    btn.classList.remove('is-picking');
    btn.textContent = btn.dataset.idleText || 'Pick evidence';
    setHint(hop, null);
    if (pickingHop === hop) pickingHop = null;
  };

  questionPane.querySelectorAll('[data-pick-hop]').forEach(btn => {
    btn.dataset.idleText = btn.textContent;
    btn.onclick = async () => {
      const hop = Number(btn.dataset.pickHop);
      const kind = hops[hop].kind;
      // Whatever was armed before is not armed now, and its card should stop saying it is.
      questionPane.querySelectorAll('[data-pick-hop]').forEach(b => {
        if (b !== btn) disarm(b, Number(b.dataset.pickHop));
      });
      pickingHop = hop;
      btn.classList.add('is-picking');
      btn.textContent = kind === 'image' ? 'Click image evidence' : 'Click sentence evidence';
      setHint(hop, null);

      const armPicking = () => startPicking(
        frame(),
        kind,
        (value, label) => {
          setPicked(hop, value, label);
          disarm(btn, hop);
        },
        (why) => setHint(hop, why),
      );

      // A frame that has left the snapshot cannot be read from, and used to fail here in silence:
      // the button lit up, nothing in the page responded, and only a reload brought it back.
      if (armPicking()) return;
      btn.textContent = 'Restoring the page…';
      await restoreSnapshot(frame(), canned, arm);
      if (armPicking()) {
        btn.textContent = kind === 'image' ? 'Click image evidence' : 'Click sentence evidence';
        return;
      }
      disarm(btn, hop);
      showError('The page could not be reopened for picking. Please reload this tab and start the '
        + 'task again.');
    };
  });

  /** Q1, which both live buttons need and neither should word differently. */
  const requireVerdict = () => {
    const sel = questionPane.querySelector('input[name="q-find-answer"]:checked');
    if (sel) return sel;
    window.QForm.flagMissing([$q('q-find-answer')]);
    showError(yesNo
      ? 'Please answer the highlighted question: is the agent’s answer correct?'
      : 'Please answer the highlighted question: which answer did you find?');
    return null;
  };

  /**
   * The one exit from this task. `answerValue` is null only for a timed-out verdict.
   *
   * An unanswered evidence hop is dropped rather than sent as a blank, and findScores stays null
   * unless every hop was actually picked: a scored zero and a question that was never asked must not
   * arrive in the dataset looking the same.
   */
  const finish = async (answerValue) => {
    if (submitted) return;
    submitted = true;
    clearInterval(answerTimer);
    stopPicking(frame());
    // The deciding half of the split, for any route that did not bank it: a verdict given but never
    // advanced past — the cutoff caught it, or there was no evidence stage to advance to. The cutoff
    // is the last moment that choice can be said to have been made.
    if (answerValue != null && choiceElapsed == null) choiceElapsed = Math.max(0, Date.now() - startedAt);
    const complete = askEvidence && picked.every(Boolean);
    await submitFindResult(task, {
      answer: answerValue,
      claimText: answer,
      answerElapsed: Math.max(0, Date.now() - startedAt),
      answerChoiceMs: choiceElapsed,
      findSupportingMs: askEvidence && supportStartedAt != null
        ? Math.max(0, Date.now() - supportStartedAt) : null,
      evidenceResponses: askEvidence
        ? picked.map((v, i) => (v ? { hop: i + 1, prompt: hops[i].prompt, kind: hops[i].kind, ...v } : null))
          .filter(Boolean)
        : [],
      findScores: complete ? scoreFindEvidence(picked, groundTruth) : null,
      interactionSummary: taskInteractionSummary(),
    });
  };

  $q('q-find-next').onclick = () => {
    window.QForm.clearMissing(questionPane);
    if (!requireVerdict()) return;
    clearError();

    choiceElapsed = Math.max(0, Date.now() - startedAt);
    supportStartedAt = Date.now();
    $q('q-support-stage').hidden = false;
    $q('q-find-next').hidden = true;
    const submit = $q('q-find-submit');
    submit.hidden = false;
    submit.disabled = false;
    // The chip keeps counting down from startedAt: the evidence stage spends the same three
    // minutes, and supportStartedAt still splits the two halves in the recorded timings.
    $q('q-support-stage').scrollIntoView({ block: 'nearest' });
  };

  $q('q-find-submit').onclick = async () => {
    window.QForm.clearMissing(questionPane);
    if (!requireVerdict()) return;
    // EVERY hop, not just one. A half-answered pair cannot be reconstructed afterwards, and a
    // participant who could submit with one blank would do it without noticing.
    if (askEvidence) {
      const blanks = picked.map((v, i) => (v ? null : $q(`q-hop-card-${i}`)));
      const missing = picked.findIndex(v => !v);
      if (missing >= 0) {
        window.QForm.flagMissing(blanks);
        return showError(`Please answer the highlighted question — ${hops[missing].kind === 'image'
          ? 'pick the image in the page' : 'pick the passage in the page'}.`);
      }
    }
    clearError();
    clocks.settle();
    await finish(verdictValue());
  };

  window.Tutorial?.onTaskRendered(task);

  bindPreviewNav();
}

/**
 * The V2 Guide task: read what the agent did, then say whether it finished the job.
 *
 * A LIGHT TWO-STAGE QUESTION. V1's instrument (app/instrument.js) asks the verdict, what kind of
 * outcome problem it was, and which error types occurred at which steps — a taxonomy that takes
 * most of the time limit. V2 asks the same binary verdict and offers optional step marks. It
 * deliberately does not grow back toward the problem/error-type taxonomy.
 *
 * THE VERDICT COVERS BOTH WAYS A RUN FAILS, which is why the wording names them. A run can fall
 * short of the job, or it can finish and misdescribe what it saw — and the second is the item the
 * grounding condition exists to measure, because only the trajectory exposes it. Asked as "did the
 * agent complete the task?", a participant had no way to know that a fluent, confident, fabricated
 * answer was a No, so the question served that item worst of all. It is still ONE verdict: adding a
 * second question would have measured nothing here, since every live run keyed correct and every
 * run keyed incorrect both claim completion, putting a second key on the diagonal for all of them.
 *
 * WHY it failed is not asked. The recorder already wrote it down, so app/find_v2_guide_key.js reads
 * it off guide_ground_truth and the row carries it. WHERE it failed is asked directly as step
 * marks, because those are the participant localization measure this flow now records.
 *
 * The left pane leads with the reasoning trail and folds the journey away beneath it, which is the
 * one place this differs from what V1 participants saw — see the layout options on mountStimulus.
 */
async function showGuideV2Task(task, arm) {
  let record = null;
  try {
    record = await dataSource(task).getGuideTrajectory(task.id);
  } catch (e) {
    console.error('[study] could not load the guide trajectory:', e);
  }

  if (!record) {
    // Skip rather than strand: one unreadable stimulus must not end the session, and a row that was
    // never shown must not be recorded as an answer.
    console.warn('[study] skipping a guide task that could not be loaded:', task.id);
    S.state.idx++;
    if (!window.STUDY_SOURCE) S.saveLocal();
    return showTask();
  }

  const mount = renderGuideV2Shell();
  window.Stimulus.mountStimulus(record, arm, mount, {
    trailFirst: true,
    // OPEN. The journey is the record — every action, checkable against the page it was taken on —
    // and folding it put the one piece of evidence behind a click that many participants never made.
    // What the fold was protecting against was a long list pushing the answer off screen; with the
    // reasoning trail no longer above it, that is no longer the shape of the pane.
    journeyCollapsed: false,
    // THE SAME FLAG FOR THE PRACTICE AND THE REAL TASK. This renderer serves both, so the
    // walkthrough cannot teach a screen the study then withholds — which is the one thing a practice
    // run must not do.
    highlightMilestones: S.studyFlags().flagMilestones,
    // THE TRAIL IS OFF BY DEFAULT. It is the agent's own story about the run, written afterwards,
    // and putting it above the record asks a participant to disconfirm a confident claim rather than
    // to check one. The journey, the two page states and the answer are what remains.
    sections: { trail: S.studyFlags().showReasoningTrail },
    // THE WALK, AND HOW LONG ONE OF ITS PAGES TAKES TO COME UP. Offered in both arms — it is a
    // constant of the study rather than part of what separates them; see the note above
    // `allowBrowseSim` in app/stimulus.js. The delay is a study variable: it sets the cost of going
    // to look, which is what the measure is about.
    allowBrowseSim: S.studyFlags().allowBrowseSim,
    browseSimDelayMs: S.studyFlags().browseSimDelayMs,
  });
  renderGuideV2Questions(task, record, arm);
}

/**
 * The step-level answer key when one has been authored.
 *
 * Ground truth lives in `guide_ground_truth.errors[].steps` on the task, but not every imported run
 * has been localized yet. An absent/empty list therefore means "not scored yet", never "the
 * participant should select no steps". Keeping that distinction is what lets older result rows be
 * rescored later from their saved `marked_wrong_steps` after the researcher fills the key in.
 */
function guideGroundTruthSteps(record) {
  const errors = Array.isArray(record?.guide_ground_truth?.errors)
    ? record.guide_ground_truth.errors : [];
  return Array.from(new Set(errors.flatMap(error => Array.isArray(error?.steps)
    ? error.steps : (error?.step == null ? [] : [error.step]))
    .map(Number).filter(step => Number.isInteger(step) && step >= 0))).sort((a, b) => a - b);
}

/** Score a step selection only when this failed run already has a step-level key. */
function guideStepScores(record, markedSteps, verdict) {
  if (verdict !== 'no') return null;       // the localization question was not asked
  const truth = guideGroundTruthSteps(record);
  if (!truth.length) return null;          // the researcher can author this later
  const marked = Array.from(new Set((markedSteps || []).map(Number)
    .filter(step => Number.isInteger(step) && step >= 0)));
  const truthSet = new Set(truth);
  const hits = marked.filter(step => truthSet.has(step)).length;
  return {
    precision: marked.length ? hits / marked.length : 0,
    recall: hits / truth.length,
    exact: marked.length === truth.length && marked.every(step => truthSet.has(step)),
  };
}

/**
 * Make the trajectory itself the localization control.
 *
 * The renderer owns the numbered rows and their screenshots, so duplicating a bank of step buttons
 * in the question pane would make the participant look back and forth between two copies. These
 * small toggles live on the rows and are available from the moment the journey appears, so a
 * participant can mark a problem while they are inspecting it rather than first committing a
 * verdict and retracing their work. They return a sorted list ready for Supabase.
 */
function bindGuideStepMarkers(onChange) {
  const buttons = Array.from(stimulusPane.querySelectorAll('.tv-mark-wrong'));
  const selected = new Set();
  let disabled = false;

  const values = () => Array.from(selected).sort((a, b) => a - b);
  const paint = () => {
    buttons.forEach(button => {
      const step = Number(button.dataset.markStep);
      const on = selected.has(step);
      button.hidden = false;
      button.disabled = disabled;
      button.setAttribute('aria-pressed', String(on));
      button.querySelector('.tv-mark-label').textContent = on ? 'Marked wrong' : 'Mark wrong';
      button.querySelector('.tv-mark-plus').textContent = on ? '✓' : '+';
      button.closest('.tv-journey-row')?.classList.toggle('is-marked-wrong', on);
    });
    onChange?.(values());
  };

  const cleanups = buttons.map(button => {
    const click = (event) => {
      // The containing row opens its screenshot. This click means "mark", not "open".
      event.stopPropagation();
      const step = Number(button.dataset.markStep);
      if (!Number.isFinite(step)) return;
      if (selected.has(step)) selected.delete(step);
      else selected.add(step);
      paint();
    };
    button.addEventListener('click', click);
    return () => button.removeEventListener('click', click);
  });

  paint();
  return {
    values,
    clear() { selected.clear(); paint(); },
    setDisabled(next) { disabled = !!next; paint(); },
    destroy() {
      cleanups.forEach(cleanup => cleanup());
    },
  };
}

/** The question pane for a Guide task: verdict plus optional step localization. */
function renderGuideV2Questions(task, record, arm) {
  const { idx, queue } = S.state;
  const goal = task?.goal || task?.question || record?.goal || record?.title || '';
  const answerText = record?.arms?.[arm]?.answer || record?.arms?.grounding?.answer || '';
  const startedAt = Date.now();
  let answerTimer = null;
  let verdictChoiceMs = null;
  let submitted = false;
  let clocks = null;

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">📘 Review the task</span></div>
    <div class="q-progress${S.state.dryRun ? ' is-dry-run' : ''}">${esc(progressText() || `Task ${idx + 1}/${queue.length}`)}</div>
    <div class="q-body">
      <div class="q-task-card" id="q-task-card">
        ${window.TaskTimer.html()}
        <div class="q-task-label">The task the agent was given</div>
        ${questionHtml(goal)}
      </div>
      ${conditionBannerHtml(arm, 'guide')}${groupChipHtml()}

      <div class="q-card">
        <div class="q-card-head"><span class="q-badge">Q1</span>
          <p class="q-text">Did the agent successfully complete the task?${window.QForm.requiredMark()}</p></div>
        ${verdictOptionsHtml(['yes', 'no'], opt => (opt === 'yes'
          ? '<b>Yes</b><small>It did the whole job, and its answer matches what it actually did.</small>'
          : '<b>No</b><small>It did not finish the job, <b>or</b> its answer claims something that did not happen.</small>'))}
      </div>

      <div class="q-card q-guide-localize" id="q-guide-localize" hidden>
        <div class="q-card-head"><span class="q-badge">Q2</span>
          <p class="q-text">Which step or steps went wrong? <span class="q-sub">Optional</span></p></div>
        <p class="q-sub">If you can identify them, select <b>Mark wrong</b> beside the relevant steps in <b>View Journey</b>.</p>
        <p class="q-guide-step-status" id="q-guide-step-status" aria-live="polite">No steps marked yet.</p>
      </div>

      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions">
        <button class="q-btn q-btn-primary" id="q-find-submit"${IS_FIND_V2 ? ' disabled' : ''}>Submit →</button>
      </div>
      ${previewNavHtml()}
    </div>`;

  const $q = (id) => questionPane.querySelector(`#${id}`);
  const errorEl = $q('q-error-msg');
  const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearError = () => { errorEl.hidden = true; };
  const stepMarkers = bindGuideStepMarkers((steps) => {
    const status = $q('q-guide-step-status');
    if (status) status.textContent = steps.length
      ? `${steps.length === 1 ? 'Step' : 'Steps'} ${steps.join(', ')} marked wrong.`
      : 'No steps marked yet.';
  });

  const finish = async (answerValue) => {
    if (submitted) return;
    submitted = true;
    clearInterval(answerTimer);
    const answerElapsed = Math.max(0, Date.now() - startedAt);
    // A timed-out participant may still have marked steps before choosing a verdict. Preserve what
    // they actually did; only an explicit Yes clears the contradictory localization response.
    const markedWrongSteps = answerValue === 'yes' ? [] : stepMarkers.values();
    stepMarkers.setDisabled(true);
    await submitGuideV2Result(task, {
      answer: answerValue,
      claimText: answerText,
      markedWrongSteps,
      stepScores: guideStepScores(record, markedWrongSteps, answerValue),
      // Read off the record that is on screen, not off the queue: `guide_ground_truth` rides along
      // with the trajectory fetch, and the classification has to describe the run as it was shown.
      failureMode: window.FindV2GuideKey.failureMode(record?.guide_ground_truth, task?.agentCompleted),
      answerElapsed,
      answerChoiceMs: answerValue == null ? null : (verdictChoiceMs ?? answerElapsed),
      // Step marking now overlaps verdict formation by design, so there is no honest separate
      // localization duration. Total and verdict time remain recorded; the dedicated field is null.
      localizationElapsed: null,
      interactionSummary: withBrowseSim(taskInteractionSummary()),
    });
  };

  clocks = verdictClocks({
    pane: questionPane,
    radioName: 'q-find-answer',
    showError,
    clearError,
    liveButton: () => $q('q-find-submit'),
    submit: (answerValue) => { void finish(answerValue); },
  });

  answerTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    window.TaskTimer.paint(questionPane, elapsed);
    clocks.tick(elapsed);
  }, 250);

  S.state.detachInstrument = () => {
    clearInterval(answerTimer);
    stepMarkers.destroy();
  };

  questionPane.querySelectorAll('input[name="q-find-answer"]').forEach(input => {
    input.addEventListener('change', () => {
      if (verdictChoiceMs == null) verdictChoiceMs = Math.max(0, Date.now() - startedAt);
      const localizing = input.checked && input.value === 'no';
      $q('q-guide-localize').hidden = !localizing;
      if (!localizing) {
        stepMarkers.clear();
      }
    });
  });

  $q('q-find-submit').onclick = async () => {
    window.QForm.clearMissing(questionPane);
    const sel = questionPane.querySelector('input[name="q-find-answer"]:checked');
    if (!sel) {
      window.QForm.flagMissing([$q('q-find-answer')]);
      return showError('Please answer the highlighted question: did the agent successfully complete the task?');
    }
    clearError();
    clocks.settle();
    await finish(sel.value);
  };

  // The walkthrough's orientation card, above the question it is about. The Find half already had
  // this; the Guide half is the one where knowing what "View Journey" is worth opening matters most.
  window.Tutorial?.onTaskRendered(task);

  bindPreviewNav();
}

/** Record the Guide result, then move on. The follow-up is the same one Find asks. */
async function submitGuideV2Result(task, payload) {
  const askFollowup = !!S.studyFlags().collectFollowup;

  const finishTask = async (confidence, helpfulness, notes) => {
    // A practice task is answered in full and then goes nowhere: no row, no write, no idx++. Same
    // rule the Find half follows in submitFindResult.
    if (S.state.tutorial?.active) return window.Tutorial.finishPracticeTask(task, payload);

    const row = S.buildGuideResultRow({ task, payload, confidence, helpfulness, notes });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();
    await saveStudyResult(row, { guide: true });
    showTask();
  };

  if (!askFollowup) return finishTask(null, null, null);

  questionPane.innerHTML = postTaskQuestionsHtml('q-guide-done');
  document.getElementById('q-guide-done').onclick = async () => {
    const done = document.getElementById('q-guide-done');
    if (done.dataset.submitted === 'true') return;
    const conf = questionPane.querySelector('input[name="q-conf"]:checked');
    const help = questionPane.querySelector('input[name="q-help"]:checked');
    const err = document.getElementById('q-error-msg');
    if (!conf || !help) {
      window.QForm.clearMissing(questionPane);
      window.QForm.flagMissing([conf ? null : document.getElementById('q-conf'),
        help ? null : document.getElementById('q-help')]);
      err.textContent = 'Please answer the highlighted question(s).';
      err.hidden = false;
      return;
    }
    done.dataset.submitted = 'true';
    done.disabled = true;
    await finishTask(conf.value, help.value, postTaskNotes());
  };
}

function normalizeEvidenceText(value) {
  return cleanEvidenceSentenceText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A sentence with its reference markers taken off, so a pick and the key compare as prose.
 *
 * WIKIPEDIA'S MARKERS COME IN MORE THAN ONE SHAPE. `[1]` and `[nb1]` are the obvious ones, but the
 * footnote form is `[nb 1]` and `[note 3]` — a SPACE between the label and the number — and missing
 * that space cost a whole task: MUFC-V1's accepted span was transcribed clean while the page hands
 * back "…in 2025[nb 1] – the club was served…", so the two strings differed by four characters in
 * the middle and the substring test in evidenceMatches() could not see past it. Every participant
 * who picked the right sentence was scored wrong.
 *
 * The rule stops at markers that CONTAIN A NUMBER. Stripping bare bracketed words as well would
 * also eat editorial insertions that are part of the sentence — "‘cleaner energy technology or
 * [build] spaceships’" is a real accepted span in this study — and those carry meaning.
 *
 * Both sides of every comparison run through here (groundTruthText and pickedEvidenceText both go
 * via normalizeEvidenceText), so loosening this can only ever make a pick and its key agree where
 * they already said the same thing.
 */
function cleanEvidenceSentenceText(value) {
  return String(value || '')
    .replace(/\[\s*(?:[a-z]+\s*)?\d+\s*\]/gi, ' ')
    .replace(/^\s*\d+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function groundTruthText(hit) {
  return normalizeEvidenceText(hit?.text || hit?.source_text || hit?.source_anchor?.quote || hit?.quote || hit?.label);
}

function pickedEvidenceText(pick) {
  return normalizeEvidenceText(pick?.text || pick?.source_text || pick?.source_anchor?.quote || pick?.label);
}

function evidenceMatches(picked, truth) {
  if (!picked || !truth) return false;
  return picked === truth || picked.includes(truth) || truth.includes(picked);
}

function scoreFindEvidence(picked, groundTruth) {
  const hops = groundTruth?.hops;
  if (!hops || typeof hops !== 'object') {
    return { precision: null, recall: null, exact: null, hopExact: null };
  }
  const expected = Object.keys(hops).sort((a, b) => Number(a) - Number(b));
  if (!expected.length) return { precision: null, recall: null, exact: null, hopExact: null };

  const hopExact = {};
  let correct = 0;
  expected.forEach(key => {
    const idx = Number(key) - 1;
    const pickText = pickedEvidenceText(picked[idx]);
    const accepted = (Array.isArray(hops[key]) ? hops[key] : [])
      .map(groundTruthText)
      .filter(Boolean);
    const ok = !!pickText && accepted.some(truth => evidenceMatches(pickText, truth));
    hopExact[key] = ok;
    if (ok) correct++;
  });

  const pickedCount = picked.filter(Boolean).length;
  return {
    precision: pickedCount ? correct / pickedCount : null,
    recall: correct / expected.length,
    exact: correct === expected.length && pickedCount === expected.length,
    hopExact,
  };
}

/**
 * The snapshot's document, or null if the frame is no longer showing the snapshot.
 *
 * A frame that has navigated to a real site is cross-origin, and every read of contentDocument
 * throws — which is why this is the one accessor everything else goes through.
 */
function snapshotDoc(frame) {
  try {
    const doc = frame?.contentDocument;
    if (!doc?.body) return null;
    // SAME-ORIGIN IS NOT ENOUGH, which is what this used to test. Most links in a captured page are
    // relative, and srcdoc resolves them against THIS site — so a click on one does not go
    // cross-origin and throw, it lands the frame on the study host's own 404 page, which is
    // same-origin, has a body, and reads as a perfectly good document. Everything downstream then
    // believed the snapshot was still there: picking armed, the participant clicked in the page,
    // and nothing happened — no error, no recovery, and no way on but a reload. Only a document
    // this file mounted and stamped counts.
    return doc.documentElement?.dataset?.pgSnapshot === '1' ? doc : null;
  } catch (e) {
    return null;
  }
}

/**
 * NOTHING INSIDE THE SNAPSHOT MAY NAVIGATE IT.
 *
 * The snapshot is a real captured page, links and all, mounted with srcdoc so it shares this
 * origin — which is the only reason it can be highlighted and picked in at all. One click on a link
 * inside it and the frame is on the live site: cross-origin, unreadable, and every later
 * contentDocument read throws. The visible symptom was a Pick evidence button that did nothing at
 * all, for the rest of the task, because startPicking bailed on that throw and said nothing. A
 * reload put the snapshot back, which is exactly why reloading "fixed" it.
 *
 * Clicks are killed on the capture phase, so this runs before the picking handler and before the
 * browser's default. Picking still works because it reads the click rather than following it.
 */
function sealSnapshot(frame) {
  const doc = snapshotDoc(frame);
  if (!doc || doc.__pgSealed) return;
  doc.__pgSealed = true;
  doc.addEventListener('click', (e) => {
    const link = e.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    // In-page anchors are harmless and are sometimes the only way to reach the evidence.
    if (href.startsWith('#')) return;
    e.preventDefault();
  }, true);
  doc.addEventListener('submit', (e) => e.preventDefault(), true);
}

/**
 * Put the snapshot back after the frame has left it, and hand back the document.
 *
 * Belt to sealSnapshot's braces: a navigation this file did not anticipate (a meta refresh, a
 * middle-click, a frame busted by something in the captured markup) leaves the participant stuck on
 * a screen whose questions cannot be answered, and the task is unrecoverable without a reload that
 * loses the timers. Rebuilding from the html already in hand costs one frame load.
 */
function restoreSnapshot(frame, canned, arm) {
  return new Promise((resolve) => {
    const html = frame?.__pgSnapshotHtml;
    if (!frame || !html) return resolve(null);
    mountSnapshot(frame, html, canned, arm, () => resolve(snapshotDoc(frame)));
  });
}

/** How long to keep watching for the snapshot's document before giving up on it. */
const SNAPSHOT_ADOPT_TIMEOUT_MS = 20000;

/**
 * Put the snapshot in the frame and TAKE OWNERSHIP OF IT AS SOON AS IT EXISTS.
 *
 * NOT on the frame's load event, which is what this used to wait for. A captured page is 5–8MB with
 * a hundred inlined images, so `load` fires seconds after the parser has already put the page on
 * screen — and for those seconds the participant could read, scroll and click a page that had not
 * been sealed, grounded or instrumented yet. Every one of those is now installed on the first
 * document the frame produces, which is the one the participant is looking at.
 *
 * Adoption happens ONCE per mount. The first document with a body of its own is the snapshot
 * (about:blank has a body too, and it is empty); it is stamped, and snapshotDoc trusts nothing that
 * is not. `load` is still listened for, because a document that appears only after all its images
 * are in is one the poll may never have seen.
 */
function mountSnapshot(frame, html, canned, arm, onAdopted) {
  if (!frame) return;
  // Kept so the frame can be rebuilt if it ever ends up somewhere else: see sealSnapshot.
  frame.__pgSnapshotHtml = html;
  frame.__pgAdopted = false;
  // WHAT IS IN THE FRAME RIGHT NOW IS NOT THE SNAPSHOT. Assigning srcdoc starts a navigation; it
  // does not finish one, so for the next tick contentDocument is still the document being replaced
  // — on a restore, the very page the participant got stranded on. Adopting it would stamp the
  // wreck as the snapshot and leave nothing able to tell the difference.
  let previousDoc = null;
  try { previousDoc = frame.contentDocument; } catch (e) { /* already gone cross-origin */ }
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    frame.removeEventListener('load', onLoad);
    onAdopted?.(ok);
  };
  function onLoad() {
    if (adoptSnapshot(frame, canned, arm, previousDoc)) finish(true);
    groundSnapshot(frame, canned, arm);
  }
  // One listener per mount: a restore that stacked another one would re-adopt on every later load.
  if (frame.__pgAdoptListener) frame.removeEventListener('load', frame.__pgAdoptListener);
  frame.__pgAdoptListener = onLoad;
  frame.addEventListener('load', onLoad);
  frame.srcdoc = html;

  const startedAt = Date.now();
  const poll = () => {
    const adopted = adoptSnapshot(frame, canned, arm, previousDoc);
    // The frame is pickable the moment it is adopted, so a caller waiting on a restore is told then
    // rather than after the last image arrives.
    if (adopted) finish(true);
    // TWO MOMENTS, NOT ONE. Sealing wants the FIRST document there is; grounding wants the WHOLE of
    // it — marking citations against a document still being parsed would highlight only the part
    // that had arrived, and silently under-ground the arm the study is measuring. So the poll
    // continues after adoption until the parser is done.
    if (adopted && groundSnapshot(frame, canned, arm)) return;
    if (Date.now() - startedAt > SNAPSHOT_ADOPT_TIMEOUT_MS) {
      // Give up rather than poll forever, and say so: a caller waiting on a restore that will never
      // land needs to be told, not left holding a button that says "Restoring the page…".
      finish(false);
      if (adopted) console.warn('[study] the snapshot never finished loading; it is sealed and '
        + 'pickable but may not be fully grounded.');
      return;
    }
    setTimeout(poll, 50);
  };
  poll();
}

/**
 * Claim the document in the frame as the snapshot: stamp it, seal it, instrument it.
 *
 * SEALED BEFORE ANYTHING ELSE, and before grounding in particular — see groundSnapshot. The seal is
 * the part a participant cannot recover from losing, so nothing that is allowed to fail runs first.
 */
function adoptSnapshot(frame, canned, arm, previousDoc) {
  if (!frame || frame.__pgAdopted) return true;
  let doc;
  try { doc = frame.contentDocument; } catch (e) { return false; }
  if (!doc?.body || !doc.body.childElementCount) return false;
  if (previousDoc && doc === previousDoc) return false;

  frame.__pgAdopted = true;
  frame.__pgGrounded = false;
  try { doc.documentElement.dataset.pgSnapshot = '1'; } catch (e) { /* ignore */ }
  sealSnapshot(frame);
  taskTelemetry?.addIframe(frame);
  return true;
}

/**
 * Mark the citations, once the document is all there. Returns whether that is done with.
 *
 * Grounding walks markup this code did not write and can throw on it. When it did, and this ran
 * before the seal, the seal was never installed and the page stayed live for the rest of the task —
 * so it is deliberately the LAST thing to happen to a snapshot and the only one allowed to fail.
 */
function groundSnapshot(frame, canned, arm) {
  if (!frame || frame.__pgGrounded) return true;
  const doc = snapshotDoc(frame);
  // PARSED IS ENOUGH — 'interactive', not 'complete'. Every citation is matched against the DOM, and
  // the DOM is finished at 'interactive'; 'complete' additionally waits for a hundred inlined images
  // to decode and for whatever remote ones a capture kept to answer, which is a long time to show a
  // grounded participant an ungrounded page.
  if (!doc || doc.readyState === 'loading') return false;
  frame.__pgGrounded = true;
  try {
    applyFindGrounding(frame, canned, arm);
  } catch (e) {
    console.error('[study] the snapshot could not be grounded; it is still sealed and pickable', e);
  }
  return true;
}

/**
 * Let the participant click something inside the snapshot.
 *
 * Hover outlines what would be picked and a click takes it. Paragraph picking walks up to the
 * nearest block so a click on one word selects the sentence it is in rather than the word — the
 * question asks which passage, and a one-word answer could not be scored against a ground truth
 * written as sentences.
 *
 * Returns whether picking was actually armed, so a caller can tell "the participant is now picking"
 * apart from "there was nothing to pick in" instead of leaving a dead button on screen. `onMiss` is
 * called when a click lands somewhere no passage can be read from; picking stays armed.
 */
function startPicking(frame, kind, onPick, onMiss) {
  const doc = snapshotDoc(frame);
  if (!doc) return false;
  stopPicking(frame);

  if (!doc.getElementById('pg-pick-style')) {
    const style = doc.createElement('style');
    style.id = 'pg-pick-style';
    style.textContent = `
      .pg-pickable{outline:2px dashed #7857ff!important;outline-offset:2px;cursor:pointer!important;
        background:rgba(120,87,255,.10)!important}
      .pg-pickable-text{cursor:pointer!important}
      .pg-picked{outline:3px solid #168f5a!important;outline-offset:2px;
        background:rgba(22,143,90,.14)!important}
      .pg-pick-preview-box{position:absolute!important;z-index:2147483646!important;
        pointer-events:none!important;border-radius:3px!important;
        background:rgba(120,87,255,.14)!important;outline:2px dashed #7857ff!important;
        outline-offset:2px!important}
      .pg-pick-sentence-hit{position:absolute!important;z-index:2147483645!important;
        box-sizing:border-box!important;border-radius:3px!important;cursor:pointer!important;
        background:rgba(120,87,255,.04)!important;outline:1px solid rgba(120,87,255,.18)!important;
        outline-offset:1px!important;appearance:none!important;-webkit-appearance:none!important;
        margin:0!important;font:inherit!important}
      .pg-pick-sentence-hit.pg-pick-sentence-hover{background:rgba(120,87,255,.18)!important;
        outline:2px dashed #7857ff!important;outline-offset:2px!important}
      .pg-picked-sentence{border-radius:3px!important;padding:1px 3px!important;margin:0 1px!important;
        background:rgba(22,143,90,.22)!important;outline:2px solid #168f5a!important;
        outline-offset:2px!important}`;
    doc.head?.appendChild(style);
  }

  const SEL = kind === 'image' ? 'img' : 'p, li, figcaption, blockquote, h1, h2, h3, td, th';
  const TEXT_OVERLAY_SEL = 'p, li, figcaption, blockquote, h1, h2, h3';
  let hovered = null;
  let moveFrame = 0;
  let lastMove = null;

  function findImageTarget(target) {
    if (!target) return null;
    if (target.tagName === 'IMG') return target;
    if (target.closest) {
      const parentImg = target.closest('img');
      if (parentImg) return parentImg;
      const container = target.closest('a, figure, .thumb, .thumbinner, .media, [class*="image" i], [class*="thumb" i], [data-pageguide-styled], .pageguide-highlight-imgwrap');
      if (container) {
        const childImg = container.querySelector('img');
        if (childImg) return childImg;
      }
    }
    return null;
  }

  const over = (e) => {
    const el = kind === 'image' ? findImageTarget(e.target) : e.target.closest?.('td, th');
    if (el === hovered) return;
    hovered?.classList.remove('pg-pickable');
    hovered = el;
    hovered?.classList.add('pg-pickable');
  };
  const move = (e) => {
    if (kind === 'image') return;
    lastMove = { target: e.target, x: e.clientX, y: e.clientY };
    if (moveFrame) return;
    moveFrame = doc.defaultView.requestAnimationFrame(() => {
      moveFrame = 0;
      const ev = lastMove;
      if (!ev) return;
      const block = ev.target.closest?.(TEXT_OVERLAY_SEL);
      clearPickPreview(doc);
      if (!block) return;
      const pickedPassage = sentencePickFromClick(doc, block, ev.x, ev.y);
      if (pickedPassage?.range) wrapPickPreviewSentence(doc, pickedPassage.range);
    });
  };
  // NO CLICK IS EVER SWALLOWED. Every path out of here either takes a pick or says why it could
  // not: a click that quietly did nothing was indistinguishable from a broken button, and the
  // participant's only move was to press Pick evidence again and get the same nothing.
  const miss = (e, why) => {
    e.preventDefault();
    e.stopPropagation();
    onMiss?.(why);
  };
  const click = (e) => {
    const sentenceHit = kind === 'image' ? null : e.target.closest?.('.pg-pick-sentence-hit');
    const pickedFromHit = sentenceHit?.__pgPickSentence || null;
    const el = kind === 'image'
      ? findImageTarget(e.target)
      : (pickedFromHit?.block || e.target.closest?.(SEL) || nearestTextBlock(e.target, SEL, e.clientX, e.clientY));
    if (!el) {
      return miss(e, kind === 'image'
        ? 'That is not an image. Click one of the pictures in the page.'
        : 'There is no text there. Click a sentence in the page.');
    }
    e.preventDefault();
    e.stopPropagation();
    clearPickedPassage(doc);
    el.classList.remove('pg-pickable', 'pg-pickable-text');
    hovered = null;
    const pickedPassage = kind === 'image' ? null : (pickedFromHit || tableCellPick(el) || sentencePickFromClick(doc, el, e.clientX, e.clientY));
    if (kind !== 'image' && !pickedPassage?.range && !pickedPassage?.cell) {
      return miss(e, 'Could not read a sentence there. Try clicking nearer the middle of one.');
    }
    if (pickedPassage?.range) wrapPickedSentence(doc, pickedPassage.range);
    else el.classList.add('pg-picked');
    const text = kind === 'image'
      ? imagePickLabel(el)
      : pickedPassage.text;
    const locator = pickLocator(el, pickedPassage);
    onPick(
      {
        text: text.slice(0, 600),
        tag: el.tagName.toLowerCase(),
        granularity: kind === 'image' ? 'image' : (pickedPassage?.cell ? 'table-cell' : 'sentence'),
        locator,
      },
      pickDisplayLabel(text, locator, kind)
    );
    stopPicking(frame);
  };

  doc.addEventListener('mouseover', over, true);
  doc.addEventListener('mousemove', move, true);
  doc.addEventListener('click', click, true);
  doc.__pgPick = { over, move, click, cancel: () => {
    if (moveFrame) doc.defaultView.cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    lastMove = null;
  } };
  return true;
}

/**
 * The block a click meant, when the click did not land on one.
 *
 * A captured page is full of text that lives in none of the tags the picker looks for: infobox
 * `div`s, bare `span`s inside a caption, a stray text node between paragraphs. Requiring an exact
 * hit on `p`/`li`/`td` made those regions silently unpickable, which reads as a broken button
 * rather than as "not that bit".
 *
 * UNDER THE POINTER, NOT MERELY NEARBY. The candidate has to be one the click actually landed
 * inside — searching a container for its first text block would answer a click on the page
 * background with the first paragraph of the document, which is worse than refusing: it is a
 * confident wrong pick, recorded as if the participant had chosen it.
 */
function nearestTextBlock(target, selector, x, y) {
  if (!target || target.nodeType !== 1) return null;
  const hit = (el) => {
    if (!el || !normText(el.textContent || '').length) return false;
    const r = el.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  let el = target;
  for (let hops = 0; el && el.nodeType === 1 && hops < 8; hops++, el = el.parentElement) {
    const own = el.closest?.(selector);
    if (own && hit(own)) return own;
    const inside = Array.from(el.querySelectorAll?.(selector) || []).find(hit);
    if (inside) return inside;
    if (el.tagName === 'BODY' || el.tagName === 'HTML') break;
  }
  return null;
}

function pickDisplayLabel(text, locator, kind) {
  const main = text ? text.slice(0, 120) + (text.length > 120 ? '...' : '') : `(${kind})`;
  if (kind === 'image') return main;
  if (locator?.table?.columnText) return main;
  if (locator?.pageIndex != null) return `${main} | page index ${locator.pageIndex}`;
  return main;
}

function pickLocator(el, passage) {
  const row = el.closest?.('tr');
  const cell = el.closest?.('td, th');
  const block = el.closest?.('p, li, figcaption, blockquote, h1, h2, h3, td, th') || el;
  return {
    pageIndex: closestPageIndex(el),
    cssPath: cssPathForPick(el),
    blockTag: block?.tagName?.toLowerCase() || '',
    blockText: normText(block?.textContent || '').slice(0, 600),
    sentenceStart: passage?.start ?? null,
    sentenceEnd: passage?.end ?? null,
    table: row ? {
      rowIndex: Array.from(row.parentElement?.children || []).indexOf(row),
      cellIndex: cell ? Array.from(row.children || []).indexOf(cell) : null,
      rowText: normText(row.textContent || '').slice(0, 600),
      columnText: cell ? normText(cell.textContent || '').slice(0, 300) : '',
    } : null,
  };
}

function closestPageIndex(el) {
  const indexed = el.closest?.('[data-pg-index]');
  const value = indexed?.getAttribute?.('data-pg-index');
  return value == null || value === '' ? null : Number(value);
}

function cssPathForPick(el) {
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== cur.ownerDocument.body && parts.length < 8) {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    const same = parent ? Array.from(parent.children).filter(c => c.tagName === cur.tagName) : [];
    const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : '';
    parts.unshift(`${tag}${nth}`);
    cur = parent;
  }
  return parts.join(' > ');
}

function imagePickLabel(img) {
  if (!img) return '';
  const figure = img.closest?.('figure, .thumb, [class*="figure" i], [class*="image" i]');
  const caption = figure?.querySelector?.('figcaption, .thumbcaption, [class*="caption" i]');
  const candidates = [
    caption?.textContent,
    img.getAttribute?.('alt'),
    img.getAttribute?.('title'),
    img.getAttribute?.('aria-label'),
    figure?.textContent,
  ].map(v => String(v || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(v => !/^\(?img\)?$/i.test(v));
  if (candidates.length) return candidates[0];
  const src = img.currentSrc || img.getAttribute?.('src') || '';
  const file = src.split('/').pop()?.split(/[?#]/)[0] || '';
  return file ? decodeURIComponent(file).replace(/[_-]+/g, ' ').trim() : 'Selected image';
}

function tableCellPick(el) {
  const cell = el.closest?.('td, th');
  if (!cell) return null;
  const text = normText(cell.textContent || '');
  return text ? { text, range: null, start: null, end: null, cell: true } : null;
}

function clearPickedPassage(doc) {
  clearPickPreview(doc);
  clearPickSentenceOverlays(doc);
  doc.querySelectorAll('.pg-picked, .pg-pickable-text').forEach(n => n.classList.remove('pg-picked', 'pg-pickable-text'));
  doc.querySelectorAll('.pg-picked-sentence').forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize?.();
  });
}

function clearPickPreview(doc) {
  doc.querySelectorAll('.pg-pick-preview-box').forEach(mark => mark.remove());
}

function clearPickSentenceOverlays(doc) {
  doc.querySelectorAll('.pg-pick-sentence-hit').forEach(mark => mark.remove());
}

function clearSentenceHitHover(doc) {
  doc.querySelectorAll('.pg-pick-sentence-hover').forEach(mark => mark.classList.remove('pg-pick-sentence-hover'));
}

function setSentenceHitHover(doc, group) {
  if (!group) return;
  doc.querySelectorAll(`.pg-pick-sentence-hit[data-pg-sentence-group="${group}"]`)
    .forEach(mark => mark.classList.add('pg-pick-sentence-hover'));
}

function buildPickSentenceOverlays(doc, target) {
  clearPickSentenceOverlays(doc);
  const scrollX = doc.defaultView?.scrollX || 0;
  const scrollY = doc.defaultView?.scrollY || 0;
  let groupIndex = 0;
  const blocks = typeof target === 'string'
    ? Array.from(doc.querySelectorAll(target))
    : (target ? [target] : []);
  blocks.forEach(block => {
    sentencePicksInBlock(doc, block).forEach(pick => {
      const group = `s${++groupIndex}`;
      const rects = Array.from(pick.range.getClientRects())
        .filter(rect => rect.width >= 2 && rect.height >= 2);
      rects.forEach(rect => {
        const hit = doc.createElement('button');
        hit.type = 'button';
        hit.className = 'pg-pick-sentence-hit';
        hit.dataset.pgSentenceGroup = group;
        hit.setAttribute('aria-label', pick.text);
        hit.__pgPickSentence = { ...pick, block, group };
        hit.setAttribute('style', [
          `left:${Math.max(0, rect.left + scrollX - 2)}px`,
          `top:${Math.max(0, rect.top + scrollY - 2)}px`,
          `width:${rect.width + 4}px`,
          `height:${rect.height + 4}px`,
          'border:0!important',
          'padding:0!important',
        ].join(';'));
        doc.body.appendChild(hit);
      });
    });
  });
}

function sentencePickFromClick(doc, block, x, y) {
  const caret = caretFromPoint(doc, x, y);
  if (!caret?.node || !block.contains(caret.node)) return sentencePickFromBlock(doc, block);
  const nodes = textNodesIn(block);
  const hit = textOffsetInNodes(nodes, caret.node, caret.offset);
  if (hit == null) return sentencePickFromBlock(doc, block);
  return sentencePickAtOffset(doc, nodes, hit);
}

function caretFromPoint(doc, x, y) {
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  return null;
}

function sentencePickFromBlock(doc, block) {
  return sentencePickAtOffset(doc, textNodesIn(block), 0);
}

function sentencePicksInBlock(doc, block) {
  const nodes = textNodesIn(block);
  const full = nodes.map(n => n.nodeValue || '').join('');
  const picks = [];
  let start = 0;
  while (start < full.length) {
    while (start < full.length && /\s/.test(full[start])) start++;
    if (start >= full.length) break;
    let end = sentenceEndAfter(full, start);
    while (end > start && /\s/.test(full[end - 1])) end--;
    const text = cleanEvidenceSentenceText(full.slice(start, end));
    if (text) picks.push({ text, range: rangeForTextOffsets(doc, nodes, start, end), start, end });
    start = Math.max(end + 1, start + 1);
  }
  return picks;
}

function sentencePickAtOffset(doc, nodes, offset) {
  const full = nodes.map(n => n.nodeValue || '').join('');
  if (!full.trim()) return null;
  const hit = Math.max(0, Math.min(offset, full.length));
  let start = sentenceStartBefore(full, hit);
  let end = sentenceEndAfter(full, hit);
  start = skipLeadingCitationMarkers(full, start);
  while (end > start && /\s/.test(full[end - 1])) end--;
  if (end <= start) return null;
  const range = rangeForTextOffsets(doc, nodes, start, end);
  const text = cleanEvidenceSentenceText(full.slice(start, end));
  return text ? { text, range, start, end } : null;
}

function sentenceStartBefore(text, offset) {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i > 0) {
    if (isSentenceBoundaryAt(text, i - 1)) return sentenceBoundaryEnd(text, i - 1);
    i--;
  }
  return 0;
}

function sentenceEndAfter(text, offset) {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i < text.length) {
    if (isSentenceBoundaryAt(text, i)) return sentenceBoundaryEnd(text, i);
    i++;
  }
  return text.length;
}

function isSentenceBoundaryAt(text, i) {
  const ch = text[i];
  if (!/[.!?]/.test(ch)) return false;
  if (ch === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) return false;
  let j = i + 1;
  while (j < text.length && /["')\]]/.test(text[j])) j++;
  while (j < text.length && /\[\s*(?:[a-z]+)?\d+\s*\]/i.test(text.slice(j, j + 12))) {
    const m = text.slice(j).match(/^\[\s*(?:[a-z]+)?\d+\s*\]/i);
    if (!m) break;
    j += m[0].length;
  }
  return j >= text.length || /\s/.test(text[j]);
}

function sentenceBoundaryEnd(text, i) {
  let j = i + 1;
  while (j < text.length && /["')\]]/.test(text[j])) j++;
  while (j < text.length) {
    const m = text.slice(j).match(/^\[\s*(?:[a-z]+)?\d+\s*\]/i);
    if (!m) break;
    j += m[0].length;
  }
  while (j < text.length && /\s/.test(text[j])) j++;
  return j;
}

function skipLeadingCitationMarkers(text, start) {
  let i = start;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const m = text.slice(i).match(/^(?:\[\s*(?:[a-z]+)?\d+\s*\]|\d+\]\s*)/i);
    if (!m) return i;
    i += m[0].length;
  }
  return i;
}

function textNodesIn(root) {
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function textOffsetInNodes(nodes, target, offset) {
  let total = 0;
  for (const node of nodes) {
    if (node === target) return total + offset;
    total += (node.nodeValue || '').length;
  }
  return null;
}

function rangeForTextOffsets(doc, nodes, start, end) {
  const range = doc.createRange();
  let total = 0;
  let started = false;
  for (const node of nodes) {
    const len = (node.nodeValue || '').length;
    if (!started && start <= total + len) {
      range.setStart(node, Math.max(0, start - total));
      started = true;
    }
    if (started && end <= total + len) {
      range.setEnd(node, Math.max(0, end - total));
      return range;
    }
    total += len;
  }
  const last = nodes[nodes.length - 1];
  if (last) {
    if (!started) range.setStart(last, last.nodeValue.length);
    range.setEnd(last, last.nodeValue.length);
  }
  return range;
}

function wrapPickedSentence(doc, range) {
  const mark = doc.createElement('span');
  mark.className = 'pg-picked-sentence';
  try {
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  } catch (e) {
    const parent = range.commonAncestorContainer?.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    parent?.classList?.add('pg-picked');
  }
}

function wrapPickPreviewSentence(doc, range) {
  const scrollX = doc.defaultView?.scrollX || 0;
  const scrollY = doc.defaultView?.scrollY || 0;
  Array.from(range.getClientRects()).forEach(rect => {
    if (rect.width < 2 || rect.height < 2) return;
    const box = doc.createElement('div');
    box.className = 'pg-pick-preview-box';
    box.setAttribute('style', [
      `left:${rect.left + scrollX}px`,
      `top:${rect.top + scrollY}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
    ].join(';'));
    doc.body.appendChild(box);
  });
}

function stopPicking(frame) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.__pgPick) return;
  if (doc.__pgPick.cancel) doc.__pgPick.cancel();
  doc.removeEventListener('mouseover', doc.__pgPick.over, true);
  if (doc.__pgPick.move) doc.removeEventListener('mousemove', doc.__pgPick.move, true);
  doc.removeEventListener('click', doc.__pgPick.click, true);
  doc.querySelectorAll('.pg-pickable, .pg-pickable-text').forEach(n => n.classList.remove('pg-pickable', 'pg-pickable-text'));
  clearPickPreview(doc);
  clearPickSentenceOverlays(doc);
  delete doc.__pgPick;
}

function adminFindGroundTruthHtml(groundTruth, task) {
  if (groundTruth?.error) {
    return adminGroundTruthShell(`<div class="admin-gt-empty">Could not load Find ground truth for ${esc(task?.id || '')}: ${esc(groundTruth.error)}</div>`);
  }
  const hops = groundTruth?.hops && typeof groundTruth.hops === 'object' ? groundTruth.hops : null;
  const keys = hops ? Object.keys(hops).sort((a, b) => Number(a) - Number(b)) : [];
  const body = keys.length ? keys.map(key => {
    const rows = Array.isArray(hops[key]) ? hops[key] : [];
    return `
      <div class="admin-gt-hop">
        <div class="admin-gt-label">Hop ${esc(key)}</div>
        ${rows.length ? rows.map(r => `
          <div class="admin-gt-quote">${esc(r?.text || r?.answer || JSON.stringify(r))}</div>`).join('')
        : '<div class="admin-gt-empty">No accepted span recorded.</div>'}
      </div>`;
  }).join('') : `<div class="admin-gt-empty">No Find ground truth row matched task id ${esc(task?.id || '')}.</div>`;
  return adminGroundTruthShell(body);
}

function adminGuideGroundTruthHtml(record) {
  const gt = record?.ground_truth;
  if (!gt) return adminGroundTruthShell('<div class="admin-gt-empty">No Guide ground truth recorded for this trajectory.</div>');
  const correctness = gt.correctness === 'success' ? 'Yes — completed the task'
    : gt.correctness === 'failure' ? 'No — did not complete the task'
    : gt.no_error ? 'Yes — no error'
    : 'Not set';
  const problems = Array.isArray(gt.problems) ? gt.problems : [];
  const errors = Array.isArray(gt.errors) ? gt.errors : [];
  const body = `
    <div class="admin-gt-row"><b>Completed?</b> ${esc(correctness)}</div>
    ${problems.length ? `
      <div class="admin-gt-label">Problem</div>
      ${problems.map(p => `<div class="admin-gt-pill">${esc(guideProblemLabel(p))}</div>`).join('')}` : ''}
    ${gt.problem ? `<div class="admin-gt-quote">${esc(gt.problem)}</div>` : ''}
    <div class="admin-gt-label">Errors</div>
    ${gt.no_error ? '<div class="admin-gt-pill">No error — agent did this correctly</div>' : ''}
    ${errors.length ? errors.map(e => `
      <div class="admin-gt-quote">
        <b>${esc(guideErrorLabel(e?.type))}</b>
        ${Array.isArray(e?.steps) && e.steps.length ? ` · steps ${esc(e.steps.join(', '))}` : ''}
      </div>`).join('') : (!gt.no_error ? '<div class="admin-gt-empty">No localized errors recorded.</div>' : '')}`;
  return adminGroundTruthShell(body);
}

function adminGroundTruthShell(body) {
  return `
    <div class="admin-ground-truth">
      <div class="admin-grounding-title">Ground truth</div>
      ${body}
    </div>`;
}

function guideProblemLabel(id) {
  const t = (window.GUIDE_PROBLEM_TYPES || []).find(x => x.id === id);
  return t?.label || id || 'Unknown problem';
}

function guideErrorLabel(id) {
  const t = (window.GUIDE_ERROR_TYPES || []).find(x => x.id === id);
  return t?.label || id || 'Unknown error';
}

/**
 * THE REFERENCE PANEL — every citation in this answer, whether it actually finds anything in the
 * page, and one click to re-link the ones that do not.
 *
 * The old workflow for checking grounding was to click each chip in turn and watch what lit up in
 * the snapshot; a reference that silently resolved to nothing looked identical to one nobody had
 * tried yet. Worse, a reference that resolved to the WRONG paragraph looked exactly like a correct
 * one. This lists them all with the tier that answered, so "solid", "probably fine" and "guessed" are
 * distinguishable without clicking anything.
 *
 * V2 ONLY. V1's grounding is reviewed through publish.mjs and its material is already collected;
 * pointing a live editor at it would let a re-link change what its recorded rows meant.
 */
const LINK_TIERS = {
  exact: { label: 'Exact', cls: 'is-exact', note: 'structural match, text unchanged' },
  moved: { label: 'Moved', cls: 'is-moved', note: 'page edited around it; quote still inside' },
  text: { label: 'By text', cls: 'is-text', note: 'matched the paragraph text, not a saved position' },
  search: { label: 'Guessed', cls: 'is-search', note: 'found only by hunting for the phrase' },
  none: { label: 'Not found', cls: 'is-none', note: 'nothing in the page matched — re-link it' },
};

/** How each citation in this answer currently resolves against the mounted snapshot. */
function citationLinkReport(doc, answer, anchors) {
  const cites = parseFindCitations(answer);
  const list = Array.isArray(anchors) ? anchors.slice() : [];
  return cites.map((cite, i) => {
    const key = citationAnchorKey(cite.index, cite.text);
    const at = list.findIndex(a => citationAnchorKey(a?.index, a?.quote) === key);
    const found = at >= 0 ? list.splice(at, 1)[0] : null;
    let tier = 'none';
    if (doc) {
      if (found) tier = resolveCitationAnchorTiered(doc, found).tier;
      if (tier === 'none' && findElementContaining(doc, normText(cite.text))) tier = 'search';
    }
    return { n: i + 1, index: cite.index, quote: cite.text, anchored: !!found, tier };
  });
}

function referencePanelHtml(report, orphans) {
  return `
    <div class="admin-links">
      <div class="admin-grounding-title">References in this answer</div>
      <p class="q-sub">Click <b>Re-link</b>, then click the exact sentence or caption in the page on
        the left. A reference saved this way records where the passage <em>is</em>, not just what it
        says, so it keeps resolving when the wording around it shifts.</p>
      <p class="q-sub"><b>Delete</b> takes the reference out of the agent's answer as well as
        forgetting where it pointed, and the ones after it renumber. That edits the text a
        participant reads, so nothing is written until you press <b>Save references</b>.</p>
      ${report.length ? `<ol class="admin-link-list">${report.map(item => {
        const tier = LINK_TIERS[item.tier] || LINK_TIERS.none;
        return `
        <li class="admin-link-row" data-link-n="${item.n}">
          <div class="admin-link-main">
            <span class="admin-link-n">[${item.n}]</span>
            <span class="admin-link-quote">${esc(item.quote)}</span>
          </div>
          <div class="admin-link-meta">
            <span class="admin-link-tier ${tier.cls}" title="${esc(tier.note)}">${tier.label}</span>
            ${item.anchored ? '' : '<span class="admin-link-tier is-none">No saved position</span>'}
            <button type="button" class="q-btn admin-link-pick" data-relink="${item.n - 1}">Re-link</button>
            <button type="button" class="q-btn admin-link-show" data-showlink="${item.n - 1}">Show</button>
            <button type="button" class="q-btn admin-link-drop" data-dropcite="${item.n}"
              title="Remove this reference from the answer and forget its saved position">Delete</button>
          </div>
        </li>`;
      }).join('')}</ol>` : '<p class="q-sub">This answer has no citation markers.</p>'}
      ${orphans.length ? `<p class="admin-link-orphans"><b>${orphans.length} saved reference${
        orphans.length === 1 ? '' : 's'} no longer match any citation.</b> This happens when an
        answer's wording is edited without re-picking — the reference is kept, not deleted, so it can
        be re-attached rather than quietly lost.</p>` : ''}
      <div class="q-actions">
        <button type="button" class="q-btn q-btn-primary" id="admin-links-save" disabled>Save references</button>
        <a class="q-btn" href="index.html">Back to Admin</a>
      </div>
      <div class="admin-grounding-status" id="admin-links-status"></div>
    </div>`;
}

/**
 * Run `fn` once the snapshot frame has a readable document.
 *
 * mountSnapshot writes through srcdoc, so the frame is same-origin but not immediately populated.
 * Polling briefly beats a load listener here because the frame may already be loaded by the time
 * this is called, in which case the event never fires again and the panel would report every
 * reference as missing forever.
 */
function whenSnapshotReady(fn, tries = 40) {
  const frame = document.getElementById('find-page');
  let doc = null;
  try { doc = frame?.contentDocument; } catch (e) { doc = null; }
  if (doc?.body?.childElementCount) return fn();
  if (tries <= 0) return fn();
  setTimeout(() => whenSnapshotReady(fn, tries - 1), 100);
}

function adminGroundingReviewHtml(task, canned, arm, cites, hasPage) {
  if (arm === 'nongrounding') return '';
  const answer = canned?.answer_display || canned?.answer_raw || '';
  const evKeys = Array.from(new Set((canned?.evidence || []).map(e => String(e?.key || '').trim()).filter(Boolean)));
  const citeOptions = cites.map((c, i) =>
    `<option value="cite:${i}">Citation ${i + 1} · ${esc(c.text).slice(0, 80)}</option>`).join('');
  const evOptions = evKeys.map(key =>
    `<option value="ev:${esc(key)}">Evidence · ${esc(key)}</option>`).join('');
  return `
    <div class="admin-grounding">
      <div class="admin-grounding-title">Review grounding</div>
      <label class="admin-answer-edit">
        <span>Answer text</span>
        <textarea id="admin-answer-editor" rows="7">${esc(answer)}</textarea>
      </label>
      <div class="q-actions">
        <button type="button" class="q-btn" id="admin-apply-answer">Apply answer edit</button>
      </div>
      <div class="admin-new-evidence">
        <input id="admin-evidence-key" class="admin-inline-input" placeholder="evidence key">
        <input id="admin-evidence-note" class="admin-inline-input" placeholder="evidence note">
      </div>
      <div class="q-actions">
        <button type="button" class="q-btn" id="admin-add-evidence">Add/update evidence and insert marker</button>
      </div>
      <label class="admin-task-jump">
        <span>Grounding item</span>
        <select id="admin-grounding-target">${citeOptions}${evOptions}</select>
      </label>
      <div class="q-actions">
        <button type="button" class="q-btn" id="admin-pick-text"${hasPage ? '' : ' disabled'}>Pick exact text</button>
        <button type="button" class="q-btn" id="admin-pick-image"${hasPage && evOptions ? '' : ' disabled'}>Pick image</button>
      </div>
      <div class="admin-grounding-status" id="admin-grounding-status">No repair selected.</div>
      <div class="q-actions">
        <button type="button" class="q-btn q-btn-primary" id="admin-save-grounding" disabled>Save to database</button>
        <button type="button" class="q-btn" id="admin-download-grounding" disabled>Download patch</button>
      </div>
    </div>`;
}

/**
 * The reference panel, wired up.
 *
 * SAVING IS THE CAREFUL PART. A re-link must change one anchor and nothing else, so:
 *
 *   • the answer text is never rewritten. Re-linking says where a phrase LIVES IN THE PAGE, not what
 *     the agent said — touching the wording here would silently alter the thing participants judge.
 *   • the anchor is matched by `index:quote`, replaced in place if it exists and appended if not,
 *     so re-linking twice does not leave two anchors racing for the same citation.
 *   • ORPHANS ARE KEPT. An anchor whose citation no longer appears is left in the array rather than
 *     pruned. Pruning is what made this feel unreliable: edit an answer's wording in the claim
 *     editor and its references were dropped on the next save, with nothing said.
 *   • only this ONE VARIANT's citation_anchors are written. The other three are re-sent exactly as
 *     they were loaded, because the save RPC takes a whole claim and a partial one would blank them.
 */
function bindReferencePanel(task, canned, arm, baseline, painted) {
  const list = document.getElementById('admin-links-save')?.closest('.admin-links');
  if (!list) return;
  const status = document.getElementById('admin-links-status');
  const save = document.getElementById('admin-links-save');
  const frame = () => document.getElementById('find-page');
  // The answer is EDITABLE HERE NOW, which it deliberately was not before — see Delete below. It is
  // held locally and only written on Save, so a mis-click is undone by leaving the screen.
  let answer = canned?.answer_display || canned?.answer_raw || '';

  // THE ANSWER AS IT WAS WHEN THE SCREEN OPENED, threaded through every re-bind.
  //
  // repaint() rebuilds this panel and binds it again, so each delete leaves the Save button living
  // in a NEWER closure than the delete that enabled it. Recomputing this from `canned` there would
  // set it to the already-edited text, making `answer !== answerAtLoad` false on the very save that
  // needs to be true — the anchors would be written, the marker would stay in the answer, and the
  // reference would be back on the next load. Which is exactly how it behaved.
  const answerAtLoad = typeof baseline === 'string' ? baseline : answer;
  let anchors = Array.isArray(canned?.citation_anchors) ? canned.citation_anchors.slice() : [];
  let dirty = false;

  const setStatus = (msg, good = false) => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('is-good', !!good);
  };

  const repaint = () => {
    let doc = null;
    try { doc = frame()?.contentDocument; } catch (e) { doc = null; }
    const cites = parseFindCitations(answer);
    const report = citationLinkReport(doc, answer, anchors);
    const keys = new Set(cites.map(c => citationAnchorKey(c.index, c.text)));
    const orphans = anchors.filter(a => !keys.has(citationAnchorKey(a?.index, a?.quote)));
    const holder = document.createElement('div');
    holder.innerHTML = referencePanelHtml(report, orphans);
    list.replaceWith(holder.firstElementChild);

    // The answer card too, so the chips renumber in front of the researcher rather than only after a
    // reload. renderAnswer counts chips positionally, so deleting [2] leaves [1] and [2] with no
    // renumbering pass anywhere — but only if what is on screen is re-rendered from the new text.
    const card = questionPane.querySelector('.find-answer');
    if (card) card.innerHTML = renderFindAnswer(answer, arm);
    bindFindAnswerChips({ ...canned, answer_display: answer, answer_raw: answer, citation_anchors: anchors },
      arm, parseFindCitations(answer));

    bindReferencePanel(task, { ...canned, answer_display: answer, answer_raw: answer, citation_anchors: anchors },
      arm, answerAtLoad, true);
    if (dirty) {
      const again = document.getElementById('admin-links-save');
      if (again) again.disabled = false;
      setStatus(answer !== answerAtLoad
        ? 'Unsaved changes to the answer and its references. Save references to write them.'
        : 'Unsaved re-links. Save references to write them.', true);
    }
  };

  list.querySelectorAll('[data-relink]').forEach(button => {
    button.onclick = () => {
      const i = Number(button.dataset.relink);
      const cite = parseFindCitations(answer)[i];
      if (!cite) return;
      list.querySelectorAll('[data-relink]').forEach(b => b.classList.remove('is-picking'));
      button.classList.add('is-picking');
      setStatus(`Click the passage in the page that supports [${i + 1}] “${cite.text.slice(0, 70)}”.`);
      startAdminTextSelection(frame(), ({ anchor: picked }) => {
        // The anchor keeps the citation's OWN quote, not the words that happened to be selected: the
        // quote is what the marker says and what the chip shows, while the selection only says where
        // to look. Letting the selection overwrite the quote would rewrite the answer by side effect.
        const next = { ...picked, index: cite.index, quote: cite.text };
        const key = citationAnchorKey(cite.index, cite.text);
        const at = anchors.findIndex(a => citationAnchorKey(a?.index, a?.quote) === key);
        if (at >= 0) anchors[at] = next; else anchors.push(next);
        dirty = true;
        button.classList.remove('is-picking');
        repaint();
      });
    };
  });

  /**
   * Remove one reference: the marker in the answer AND the anchor that says where it pointed.
   *
   * BOTH, because either alone leaves a contradiction. Dropping the anchor but keeping the marker
   * leaves a citation that resolves nowhere; dropping the marker but keeping the anchor leaves a
   * saved position for a citation nobody can see — which is the orphan state this panel already
   * warns about, and creating more of them by hand is not an improvement.
   *
   * The number on the button is POSITIONAL — the same count renderAnswer uses — so deleting [2] is
   * "remove the second citation in the text" and everything after it renumbers by itself.
   */
  list.querySelectorAll('[data-dropcite]').forEach(button => {
    button.onclick = () => {
      // WRAPPED, because this is the one handler here that can fail silently. It rewrites the answer
      // and repaints two panels, and a throw inside an onclick goes to the console and nowhere the
      // researcher is looking — leaving a button that visibly does nothing. Any failure is put on
      // the status line instead, where the rest of this panel already reports itself.
      try {
        const n = Number(button.dataset.dropcite);
        const cites = parseFindCitations(answer);
        const cite = cites[n - 1];
        if (!cite) {
          return setStatus(`Cannot remove [${n}]: this answer has ${cites.length} reference${
            cites.length === 1 ? '' : 's'}. Reload the page and try again.`);
        }
        if (typeof window.FindCitations?.removeAt !== 'function') {
          return setStatus('This page is running an older app/find_citations.js. Hard-reload (Cmd+Shift+R) and try again.');
        }
        dropCitation(n, cite);
      } catch (e) {
        console.error('[study] could not delete the reference:', e);
        setStatus(`Could not delete that reference: ${e?.message || e}`);
      }
    };
  });

  function dropCitation(n, cite) {
    const next = window.FindCitations.removeAt(answer, n);
    if (next === answer) return setStatus('That reference could not be removed from the answer.');
    answer = next;
    // Only the anchor for THIS citation goes. anchorsForAnswer would also sweep away every orphan in
    // one move, and orphans are kept on purpose so a re-worded answer can be re-attached.
    const key = citationAnchorKey(cite.index, cite.text);
    anchors = anchors.filter(a => citationAnchorKey(a?.index, a?.quote) !== key);
    dirty = true;
    repaint();
    setStatus(`Removed [${n}] “${cite.text.slice(0, 60)}”. Save references to write it.`, true);
  }

  list.querySelectorAll('[data-showlink]').forEach(button => {
    button.onclick = () => {
      const i = Number(button.dataset.showlink);
      const chip = document.querySelector(`.find-cite[data-cite-n="${i + 1}"]`);
      if (chip) chip.click();
      else setStatus('That citation has no chip in the answer above.');
    };
  });

  if (save) {
    save.onclick = async () => {
      save.disabled = true;
      setStatus('Saving references…');
      try {
        // The answer text is sent ONLY if a delete changed it. A plain re-link keeps passing null,
        // so the one edit that can alter what participants read stays something you have to ask for.
        const edited = answer !== answerAtLoad ? answer : null;
        await saveVariantAnchors(task, arm, anchors, edited);
        if (edited != null) { canned.answer_display = answer; canned.answer_raw = answer; }
        dirty = false;
        setStatus(edited != null ? 'Answer and references saved.' : 'References saved.', true);
      } catch (e) {
        save.disabled = false;
        setStatus(`Not saved: ${e?.message || e}`);
      }
    };
  }

  // PAINT ONCE THE PAGE IS ACTUALLY THERE.
  //
  // showFindTask draws this panel before the snapshot frame has a document, so citationLinkReport
  // gets a null doc and every row reports "Not found" — including references that resolve perfectly.
  // The call site says a repaint was meant to follow ("the panel is only honest if the page it is
  // reporting on is actually there"), but binding handlers is all that ever happened, so the first
  // honest report only appeared once something else triggered a repaint. A reference read Exact
  // after you clicked it and Not found on a fresh load, which is the opposite of useful.
  //
  // Guarded by `painted` so the repaint that follows cannot re-enter this and loop.
  if (!painted) {
    let ready = null;
    try { ready = frame()?.contentDocument?.body; } catch (e) { ready = null; }
    if (ready) repaint();
  }
}

/**
 * Write one variant's citation_anchors back.
 *
 * Through a dedicated RPC that touches only that one path in the jsonb — not through saveClaim,
 * which would read and rewrite the claim's eight-megabyte captured page to change a few hundred
 * bytes, and would restore the question and all four answers from whatever copy this tab loaded
 * however long ago.
 *
 * The password comes from this tab's sessionStorage, which is why the editor navigates here in the
 * SAME TAB rather than opening a new one: sessionStorage survives a same-tab navigation, so the
 * researcher is not asked to log in twice to finish one edit.
 */
async function saveVariantAnchors(task, arm, anchors, answerText = null) {
  const key = window.FindV2Variants.KEYS.includes(S.state.variantKey)
    ? S.state.variantKey
    : window.FindV2Variants.variantKey(task?.claimCorrect !== false, arm);
  let password = '';
  try { password = sessionStorage.getItem('pageguide_find_v2_admin_password') || ''; } catch (e) { password = ''; }
  if (!password) throw new Error('This tab has no admin password. Open Admin on the welcome screen, then use “Check & fix references”.');
  await DB.saveVariantAnchors(password, task.id, key, anchors, answerText);
}

function bindAdminGroundingReview(task, canned, arm, cites) {
  if (!S.state.adminReview || arm === 'nongrounding' || !canned) return;
  const target = document.getElementById('admin-grounding-target');
  const pickText = document.getElementById('admin-pick-text');
  const pickImage = document.getElementById('admin-pick-image');
  const save = document.getElementById('admin-save-grounding');
  const download = document.getElementById('admin-download-grounding');
  const status = document.getElementById('admin-grounding-status');
  const editor = document.getElementById('admin-answer-editor');
  const applyAnswer = document.getElementById('admin-apply-answer');
  const evidenceKey = document.getElementById('admin-evidence-key');
  const evidenceNote = document.getElementById('admin-evidence-note');
  const addEvidence = document.getElementById('admin-add-evidence');
  if (!target || !status) return;

  let draft = null;
  const frame = () => document.getElementById('find-page');
  const setStatus = (msg, good = false) => {
    status.textContent = msg;
    status.classList.toggle('is-good', !!good);
  };
  const markDraftReady = (msg) => {
    save.disabled = false;
    download.disabled = false;
    setStatus(msg, true);
  };
  const ensureDraft = () => draft || (draft = {
    answer_raw: canned.answer_raw || canned.answer_display || '',
    answer_display: canned.answer_display || canned.answer_raw || '',
    citation_anchors: Array.isArray(canned.citation_anchors) ? cloneJSON(canned.citation_anchors) : [],
    evidence: Array.isArray(canned.evidence) ? cloneJSON(canned.evidence) : [],
  });
  const refreshFromDraft = () => {
    const d = ensureDraft();
    canned.answer_raw = d.answer_raw;
    canned.answer_display = d.answer_display;
    canned.citation_anchors = d.citation_anchors;
    canned.evidence = d.evidence;
    renderAdminAnswerPreview(canned, arm);
    rebuildAdminGroundingTarget(target, d);
    rerenderFindGrounding(frame(), canned, arm);
  };

  if (applyAnswer) applyAnswer.onclick = () => {
    const d = ensureDraft();
    d.answer_display = editor?.value || '';
    d.answer_raw = d.answer_display;
    d.citation_anchors = anchorsForAnswer(d.answer_raw, d.citation_anchors);
    refreshFromDraft();
    markDraftReady('Answer text updated. Save when the preview looks right.');
  };

  if (addEvidence) addEvidence.onclick = () => {
    const key = slugEvidenceKey(evidenceKey?.value);
    if (!key) return setStatus('Give the new evidence a short key.');
    const d = ensureDraft();
    const note = String(evidenceNote?.value || '').trim() || key;
    let item = d.evidence.find(e => String(e?.key || '').trim() === key);
    if (!item) {
      item = { key, note, source_kind: 'text', source_text: '', source_anchor: null, marks: { annotations: [], region_bbox: null } };
      d.evidence.push(item);
    } else {
      item.note = note;
    }
    insertAtTextareaCursor(editor, `[ev:${key}]`);
    d.answer_display = editor?.value || '';
    d.answer_raw = d.answer_display;
    refreshFromDraft();
    target.value = `ev:${key}`;
    markDraftReady(`Evidence ${key} added. Pick exact text or image for it.`);
  };

  pickText.onclick = () => {
    const selected = selectedAdminTarget(target.value);
    if (!selected) return setStatus('Choose a citation or evidence item before picking text.');
    setStatus('Select the exact text in the page.');
    startAdminTextSelection(frame(), ({ text, anchor }) => {
      const d = ensureDraft();
      if (selected.kind === 'cite') {
        const before = parseFindCitations(d.answer_raw || d.answer_display);
        d.answer_raw = replaceCitationQuote(d.answer_raw, selected.value, text);
        d.answer_display = replaceCitationQuote(d.answer_display, selected.value, text);
        if (editor) editor.value = d.answer_display || d.answer_raw;
        d.citation_anchors = replaceCitationAnchor(d.answer_raw, d.citation_anchors, selected.value, anchor, before[selected.value]);
        refreshFromDraft();
        markDraftReady(`Citation ${selected.value + 1} will use: ${text.slice(0, 140)}${text.length > 140 ? '...' : ''}`);
      } else {
        const item = d.evidence.find(e => String(e?.key || '').trim() === selected.value);
        if (!item) return setStatus(`Could not find evidence item ${selected.value}.`);
        item.source_kind = 'text';
        item.source_text = text;
        item.source_anchor = Object.assign({}, anchor, { quote: text });
        item.shot = null;
        item.marks = { annotations: [], region_bbox: null };
        refreshFromDraft();
        markDraftReady(`Evidence ${selected.value} will use text: ${text.slice(0, 140)}${text.length > 140 ? '...' : ''}`);
      }
    });
  };

  pickImage.onclick = () => {
    const selected = selectedAdminTarget(target.value);
    const key = selected?.kind === 'ev' ? selected.value : '';
    if (!key) return setStatus('Choose saved evidence before picking an image.');
    setStatus('Click the exact image in the page.');
    startAdminImageSelection(frame(), ({ imageId, label }) => {
      const d = ensureDraft();
      const item = d.evidence.find(e => String(e?.key || '').trim() === key);
      if (!item) return setStatus(`Could not find evidence item ${key}.`);
      item.source_image_id = imageId;
      item.source_kind = 'image';
      item.source_text = '';
      item.source_anchor = null;
      item.marks = Object.assign({ annotations: [], region_bbox: { x: 0, y: 0, w: 1, h: 1 } }, item.marks || {}, {
        source_image_id: imageId,
      });
      refreshFromDraft();
      markDraftReady(`Evidence ${key} will use ${label || imageId}.`);
    });
  };

  save.onclick = async () => {
    if (!draft) return;
    save.disabled = true;
    setStatus('Saving grounding...');
    try {
      await DB.updateCannedResponseGrounding(task.id, arm, draft);
      setStatus('Saved to the database.', true);
    } catch (e) {
      save.disabled = false;
      setStatus('Database save did not land. Start `node scripts/publish.mjs --serve`, paste its admin token, then save again.');
      console.warn('[admin] grounding save failed:', e);
    }
  };

  download.onclick = () => {
    if (!draft) return;
    downloadJSON({
      task_id: task.id,
      condition: arm,
      patch: draft,
    }, `review_grounding_${task.id}_${arm}.json`);
    setStatus('Patch downloaded. Apply it with: node scripts/publish.mjs --apply-review-patch <file>');
  };
}

function selectedAdminTarget(value, kind = null) {
  const [got, ...rest] = String(value || '').split(':');
  if (kind && got !== kind) return null;
  if (got !== 'cite' && got !== 'ev') return null;
  return { kind: got, value: got === 'cite' ? Number(rest.join(':')) : rest.join(':') };
}

function startAdminTextSelection(frame, onPick) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;
  stopAdminSelection(frame);
  ensureAdminPickStyle(doc);

  const done = () => {
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = normText(sel.toString());
    if (!text) return;
    const range = sel.getRangeAt(0);
    const el = adminRangeElement(range);
    if (!el) return;
    const anchor = buildCitationAnchor(el, null, text);
    clearAdminPicked(doc);
    el.classList.add('pg-admin-context');
    wrapAdminPickedText(doc, range);
    stopAdminSelection(frame);
    onPick({ text, anchor });
  };
  doc.addEventListener('mouseup', done, true);
  doc.__pgAdminPick = { done };
}

function startAdminImageSelection(frame, onPick) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;
  stopAdminSelection(frame);
  ensureAdminPickStyle(doc);
  let hovered = null;
  const over = (e) => {
    const img = e.target.closest?.('img');
    if (img === hovered) return;
    hovered?.classList.remove('pg-admin-pickable');
    hovered = img;
    hovered?.classList.add('pg-admin-pickable');
  };
  const click = (e) => {
    const img = e.target.closest?.('img');
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    clearAdminPicked(doc);
    img.classList.add('pg-admin-picked');
    stopAdminSelection(frame);
    onPick({ imageId: imageIdForAdminPick(doc, img), label: img.getAttribute('alt') || img.currentSrc || '' });
  };
  doc.addEventListener('mouseover', over, true);
  doc.addEventListener('click', click, true);
  doc.__pgAdminPick = { over, click };
}

function stopAdminSelection(frame) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.__pgAdminPick) return;
  if (doc.__pgAdminPick.done) doc.removeEventListener('mouseup', doc.__pgAdminPick.done, true);
  if (doc.__pgAdminPick.over) doc.removeEventListener('mouseover', doc.__pgAdminPick.over, true);
  if (doc.__pgAdminPick.click) doc.removeEventListener('click', doc.__pgAdminPick.click, true);
  doc.querySelectorAll('.pg-admin-pickable').forEach(n => n.classList.remove('pg-admin-pickable'));
  delete doc.__pgAdminPick;
}

function clearAdminPicked(doc) {
  doc.querySelectorAll('.pg-admin-picked, .pg-admin-context')
    .forEach(n => n.classList.remove('pg-admin-picked', 'pg-admin-context'));
  doc.querySelectorAll('.pg-admin-picked-exact').forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize?.();
  });
}

function ensureAdminPickStyle(doc) {
  if (doc.getElementById('pg-admin-pick-style')) return;
  const style = doc.createElement('style');
  style.id = 'pg-admin-pick-style';
  style.textContent = `
    .pg-admin-pickable{outline:3px dashed #168f5a!important;outline-offset:3px;cursor:pointer!important}
    .pg-admin-context{background:rgba(120,87,255,.14)!important;outline:3px solid #7857ff!important;outline-offset:2px!important}
    .pg-admin-picked{outline:4px solid #168f5a!important;outline-offset:3px!important}
    .pg-admin-picked-exact{background:rgba(22,143,90,.28)!important;outline:2px solid #168f5a!important;
      outline-offset:2px!important;border-radius:3px!important;padding:1px 3px!important;margin:0 1px!important}`;
  doc.head?.appendChild(style);
}

function wrapAdminPickedText(doc, range) {
  const mark = doc.createElement('span');
  mark.className = 'pg-admin-picked-exact';
  try {
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  } catch (e) {
    const el = adminRangeElement(range);
    el?.classList?.add('pg-admin-picked');
  }
}

function adminRangeElement(range) {
  let node = range.commonAncestorContainer;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const el = node?.nodeType === 1 ? node : null;
  return el?.closest?.('p, li, figcaption, blockquote, h1, h2, h3, td, th, span, a') || el;
}

/**
 * WHERE AN ELEMENT IS, structurally: its index among its parent's children, up to <body>.
 *
 * The snapshot is a fixed document — captured once, stored once, served byte-identical to every
 * participant — so a structural address computed when a researcher clicks a paragraph lands on that
 * same paragraph for everybody afterwards. That is a far stronger guarantee than the text
 * comparison this used to rely on alone, which had to hold 400 characters equal across a
 * re-serialization to find anything at all.
 *
 * It is stored ALONGSIDE the text, never instead of it: a path is exact until the page is
 * re-captured and then it is worthless, whereas text survives a re-capture and is merely fuzzy. Each
 * covers the other's failure, which is why resolveCitationAnchor tries them in that order.
 */
function elementPath(el) {
  const path = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== 'BODY') {
    const parent = node.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return path;
}

function elementAtPath(doc, path) {
  if (!Array.isArray(path) || !path.length) return null;
  let node = doc.body;
  for (const i of path) {
    const next = node?.children?.[i];
    if (!next) return null;
    node = next;
  }
  return node || null;
}

/**
 * A cheap fingerprint of the block's text, so a path can be TRUSTED rather than merely followed.
 *
 * Without it a stale path resolves to whatever now sits at that position and marks it confidently —
 * the worst outcome available, because a wrong highlight looks exactly like a right one. With it,
 * a path that lands somewhere the text no longer matches is demoted rather than believed.
 */
function textFingerprint(value) {
  const text = normText(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${h.toString(36)}`;
}

function buildCitationAnchor(el, index, quote) {
  const tag = el.tagName;
  const text = anchorTextOf(el);
  const blockText = normText(el.textContent);
  const needle = normText(quote);
  return {
    index,
    quote,
    tag,
    text,
    ordinal: citationAnchorOrdinal(el, tag, text),
    truncated: semanticTextOf(el).length > PG_ANCHOR_TEXT_MAX,
    // The structural address, and enough to tell whether it still points at what it pointed at.
    path: elementPath(el),
    fingerprint: textFingerprint(el.textContent),
    // Where the phrase sits inside the block. Recorded so a re-link knows which occurrence was
    // meant when the same words appear twice in one paragraph — a substring search cannot.
    offset: needle ? blockText.indexOf(needle) : -1,
    length: needle.length,
  };
}

function citationAnchorOrdinal(el, tag, text) {
  let n = 0;
  const all = el.ownerDocument.getElementsByTagName(tag);
  for (let i = 0; i < all.length; i++) {
    if (all[i] === el) return n;
    if (anchorTextOf(all[i]) === text) n++;
  }
  return n;
}

function replaceCitationQuote(answer, ordinal, quote) {
  let n = 0;
  const safeQuote = String(quote || '').replace(/"/g, "'");
  return String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (m, index) =>
    n++ === ordinal ? `[${index}:"${safeQuote}"]` : m);
}

function replaceCitationAnchor(answer, anchors, ordinal, anchor, previous) {
  const cites = parseFindCitations(answer);
  const cite = cites[ordinal];
  if (!cite) return anchors || [];
  const copy = Array.isArray(anchors) ? anchors.slice() : [];
  const oldKey = previous ? citationAnchorKey(previous.index, previous.text) : null;
  const oldPos = oldKey
    ? copy.findIndex(a => citationAnchorKey(a?.index, a?.quote) === oldKey)
    : -1;
  const next = Object.assign({}, anchor, { index: cite.index, quote: cite.text });
  if (oldPos >= 0) copy[oldPos] = next;
  const nextKey = citationAnchorKey(next.index, next.quote);
  return copy.filter((a, i) => i === oldPos || citationAnchorKey(a?.index, a?.quote) !== nextKey)
    .concat(oldPos >= 0 ? [] : [next]);
}

function renderAdminAnswerPreview(canned, arm) {
  const answer = canned?.answer_display || canned?.answer_raw || '';
  const answerEl = questionPane.querySelector('.find-answer');
  if (!answerEl) return;
  answerEl.innerHTML = answer
    ? renderFindAnswer(answer, arm)
    : '<em class="q-sub">No answer was recorded for this task in this arm.</em>';
  bindFindAnswerChips(canned, arm, parseFindCitations(answer));
}

function rebuildAdminGroundingTarget(select, draft) {
  if (!select) return;
  const old = select.value;
  const cites = parseFindCitations(draft.answer_display || draft.answer_raw);
  const evKeys = Array.from(new Set((draft.evidence || []).map(e => String(e?.key || '').trim()).filter(Boolean)));
  select.innerHTML = cites.map((c, i) =>
    `<option value="cite:${i}">Citation ${i + 1} · ${esc(c.text).slice(0, 80)}</option>`).join('')
    + evKeys.map(key => `<option value="ev:${esc(key)}">Evidence · ${esc(key)}</option>`).join('');
  if (Array.from(select.options).some(o => o.value === old)) select.value = old;
  const imageButton = document.getElementById('admin-pick-image');
  if (imageButton) imageButton.disabled = !evKeys.length;
}

function anchorsForAnswer(answer, anchors) {
  const needed = new Set(parseFindCitations(answer).map(c => citationAnchorKey(c.index, c.text)));
  return (Array.isArray(anchors) ? anchors : [])
    .filter(a => needed.has(citationAnchorKey(a?.index, a?.quote)));
}

function slugEvidenceKey(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function insertAtTextareaCursor(textarea, text) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const spacer = before && !/\s$/.test(before) ? ' ' : '';
  textarea.value = before + spacer + text + after;
  const pos = (before + spacer + text).length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
}

function imageIdForAdminPick(doc, img) {
  const stamped = String(img.dataset?.pgImageId || '').trim();
  if (stamped) return stamped;
  const images = contentImagesForEvidence(doc);
  const idx = images.indexOf(img);
  return idx >= 0 ? `page_image_${idx + 1}` : 'viewport';
}

function contentImagesForEvidence(doc) {
  const NOISE = /logo|icon|avatar|sprite|badge|thumb|advert|\bads?\b|banner|sponsor|placeholder/i;
  return Array.from(doc.querySelectorAll('img')).filter(img => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 100 || h < 100) return false;
    return !NOISE.test(`${img.getAttribute('src') || ''} ${img.getAttribute('alt') || ''} ${img.className || ''}`);
  });
}

function rerenderFindGrounding(frame, canned, arm) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;
  doc.querySelectorAll('.pageguide-highlight').forEach(el => {
    if (el.tagName === 'SPAN') el.replaceWith(doc.createTextNode(el.textContent || ''));
    else el.classList.remove('pageguide-highlight');
  });
  doc.querySelectorAll('.pageguide-context').forEach(el => el.classList.remove('pageguide-context'));
  // AND THE ATTRIBUTE, not just the classes. markElement sets `data-pageguide-styled` alongside
  // .pageguide-context, and only the class was ever taken off again — so one fallback left the
  // attribute on the element permanently, flattenSubtreeWithMap skipped that block from then on, and
  // every later attempt to mark the quote inside it failed the same way. The bug re-armed itself.
  doc.querySelectorAll('[data-pageguide-styled]').forEach(el => {
    el.removeAttribute('data-pageguide-styled');
    if (el.dataset) delete el.dataset.pgCite;
  });
  doc.body.normalize();
  doc.querySelectorAll('.pageguide-highlight-imgwrap').forEach(wrap => {
    const img = wrap.querySelector('img');
    if (img) wrap.replaceWith(img);
  });
  doc.querySelectorAll('.pg-annots, .pg-annot-note').forEach(el => el.remove());
  clearAdminPicked(doc);
  doc.querySelectorAll('[data-pg-evidence-key]').forEach(el => { delete el.dataset.pgEvidenceKey; });
  applyFindGrounding(frame, canned, arm);
}

const POST_TASK_CONFIDENCE = [
  ['very', 'Very confident'],
  ['somewhat', 'Somewhat confident'],
  ['notsure', 'Not sure'],
  ['guessed', 'Mostly guessing'],
];

const POST_TASK_HELPFULNESS = [
  ['very', 'Very useful'],
  ['somewhat', 'Somewhat useful'],
  ['notmuch', 'Slightly useful'],
  ['notatall', 'Not useful'],
];

function postTaskQuestionsHtml(doneId) {
  const opt = (name, value, label) =>
    `<label class="q-opt q-post-opt"><input type="radio" name="${name}" value="${value}"><span>${label}</span></label>`;
  return `
    <div class="q-head"><span class="q-title">Task follow-up</span></div>
    <div class="q-body q-post-body">
      <section class="q-post-section">
        <div class="q-post-section-head">
          <span class="q-badge">1</span>
          <p class="q-text">How confident are you in the answer you selected?${window.QForm.requiredMark()}</p>
        </div>
        <div class="q-options q-post-options" id="q-conf">
          ${POST_TASK_CONFIDENCE.map(([v, l]) => opt('q-conf', v, l)).join('')}
        </div>
      </section>
      <section class="q-post-section">
        <div class="q-post-section-head">
          <span class="q-badge">2</span>
          <p class="q-text">How useful was the information shown for checking this task?${window.QForm.requiredMark()}</p>
        </div>
        <div class="q-options q-post-options" id="q-help">
          ${POST_TASK_HELPFULNESS.map(([v, l]) => opt('q-help', v, l)).join('')}
        </div>
      </section>
      <!-- OPTIONAL, and last. The scales say how confident and how useful; they cannot say WHICH
           part helped, and "the screenshots settled it but the trail contradicted them" is the
           sentence that explains a whole cell of the results. Optional because a required box gets
           "n/a" typed into it, which is worse than empty. -->
      <section class="q-post-section">
        <div class="q-post-section-head">
          <span class="q-badge q-badge-quiet">3</span>
          <p class="q-text">Anything worth noting? <span class="q-sub">optional</span></p>
        </div>
        <p class="q-sub q-post-note-hint">What helped you decide, what got in the way, or anything
          that felt off. A few words is plenty.</p>
        <textarea class="q-field q-post-note" id="q-notes" rows="3"
          placeholder="e.g. the screenshots settled it — or, nothing here told me what the agent clicked"></textarea>
      </section>
      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions"><button class="q-btn q-btn-primary" id="${doneId}">Next task →</button></div>
    </div>`;
}

/**
 * What the participant typed in the optional note, trimmed, or null.
 *
 * Null rather than '' so an untouched box is distinguishable from one someone deliberately cleared —
 * and so a column of empty strings does not read as "everyone had nothing to say".
 */
function postTaskNotes() {
  const value = (document.getElementById('q-notes')?.value || '').trim();
  return value ? value.slice(0, 2000) : null;
}

/**
 * Record the Find result, then move on. Mirrors the guide half's post-task questions.
 *
 * V2 can be told not to ask them at all (Admin → Study settings), in which case the three columns
 * they fill are stored null and the run goes straight to the next claim. Both routes end in the same
 * finishTask, so the practice-task branch and the double-submit guard cannot drift apart.
 */
async function submitFindResult(task, payload) {
  const askFollowup = IS_FIND_V2 ? !!S.studyFlags().collectFollowup : true;

  const finishTask = async (confidence, helpfulness, notes) => {
    // A practice task is answered in full — including these two, which are asked after every real
    // task — and then goes nowhere: no row, no push, no idx++.
    if (S.state.tutorial?.active) return window.Tutorial.finishPracticeTask(task, payload);

    const row = S.buildFindResultRow({ task, payload, confidence, helpfulness, notes });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();
    await saveStudyResult(row);
    showTask();
  };

  if (!askFollowup) return finishTask(null, null, null);

  questionPane.innerHTML = postTaskQuestionsHtml('q-find-done');

  document.getElementById('q-find-done').onclick = async () => {
    const done = document.getElementById('q-find-done');
    if (done.dataset.submitted === 'true') return;
    const conf = questionPane.querySelector('input[name="q-conf"]:checked');
    const help = questionPane.querySelector('input[name="q-help"]:checked');
    const err = document.getElementById('q-error-msg');
    if (!conf || !help) {
      window.QForm.clearMissing(questionPane);
      window.QForm.flagMissing([conf ? null : document.getElementById('q-conf'),
        help ? null : document.getElementById('q-help')]);
      err.textContent = 'Please answer the highlighted question(s).';
      err.hidden = false;
      return;
    }
    done.dataset.submitted = 'true';
    done.disabled = true;
    await finishTask(conf.value, help.value, postTaskNotes());
  };
}

const RESULT_BACKUP_KEY = IS_FIND_V2
  ? 'pageguide_find_v2_pending_results'
  : 'pageguide_web_pending_results';

async function saveStudyResult(row, { guide = false } = {}) {
  // Belt and braces on the tutorial: the practice paths already return before building a row, and a
  // practice answer that reached study_task_results_v2 would be indistinguishable from a real one.
  //
  // A TEST RUN is the same argument made about a whole session. It answers real tasks on the real
  // screens, so its rows are perfectly well-formed — which is exactly why they must not be written:
  // nothing in the row would say it came from a rehearsal. Logged instead, so a researcher checking
  // that the right thing WOULD have been saved can still see it.
  if (window.STUDY_SOURCE || S.state.adminReview || S.state.dryRun || S.state.tutorial?.active) {
    if (S.state.dryRun) console.log('[test run] not saved:', row);
    return { ok: true, skipped: true };
  }
  try {
    // Find and Guide results are separate tables with separate shapes. Routed on an explicit flag
    // rather than sniffed from the row's columns: a misrouted row inserts cleanly into the wrong
    // table and is only noticed at analysis.
    const saved = guide ? await DB.insertGuideResult(row) : await DB.insertStudyResult(row);
    if (!saved) throw new Error('Supabase insert returned no confirmation.');
    console.info('[study] task result saved', {
      session_id: row.session_id,
      participant_id: row.participant_id,
      task_index: row.task_index,
      task_type: row.task_type,
      answer: row.answer,
      time_ms: row.time_ms,
    });
    return { ok: true };
  } catch (e) {
    rememberPendingResult(row, e);
    console.error('[study] task result was not saved to Supabase; kept pending locally', {
      error: e?.message || String(e),
      row,
    });
    return { ok: false, error: e };
  }
}

function rememberPendingResult(row, error) {
  try {
    const pending = JSON.parse(localStorage.getItem(RESULT_BACKUP_KEY) || '[]');
    pending.push({
      saved_at: new Date().toISOString(),
      error: error?.message || String(error || ''),
      row,
    });
    localStorage.setItem(RESULT_BACKUP_KEY, JSON.stringify(pending.slice(-100)));
  } catch (e) {
    console.warn('[study] could not keep pending result backup:', e);
  }
}

function pendingResultCount() {
  return pendingResultsForCurrentRun().length;
}

function pendingResultsForCurrentRun() {
  try {
    const pending = JSON.parse(localStorage.getItem(RESULT_BACKUP_KEY) || '[]');
    if (!Array.isArray(pending)) return [];
    const currentKeys = new Set((S.state.results || []).map(row => String(row?.result_key || '')).filter(Boolean));
    const runId = String(S.state.runId || '');
    const sessionId = S.state.sessionId == null ? '' : String(S.state.sessionId);
    return pending.filter(item => {
      const row = item?.row || {};
      if (row.result_key && currentKeys.has(String(row.result_key))) return true;
      if (runId && String(row.client_run_id || '') === runId) return true;
      if (sessionId && String(row.session_id || '') === sessionId) return true;
      return false;
    });
  } catch (e) {
    return [];
  }
}

/** The citation and evidence chips inside a rendered answer. Shared by review and participant. */
function bindFindAnswerChips(canned, arm, cites) {
  const answerEl = questionPane.querySelector('.find-answer');
  if (answerEl && cites.length) {
    answerEl.classList.add('pageguide-clickable');
    answerEl.title = 'Click to show the cited phrases';
    answerEl.onclick = (e) => {
      if (e.target.closest('.find-cite')) return;
      answerEl.classList.toggle('citations-expanded');
      // Expanding reveals the cited phrases behind the [N] chips — a way of consulting the
      // references that involves no chip click at all, so counting only chips would miss it.
      if (e.isTrusted && answerEl.classList.contains('citations-expanded')) {
        window.StudyTelemetry.reference('expand', '', 'click');
      }
    };
  }

  questionPane.querySelectorAll('.find-ev').forEach(chip => {
    chip.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = (canned?.evidence || [])
        .find(ev => String(ev?.key || '').trim().toLowerCase() === chip.dataset.evKey.trim().toLowerCase());
      if (e.isTrusted) window.StudyTelemetry.reference('evidence', chip.dataset.evKey, 'click');
      const f = document.getElementById('find-page');
      if (f && item) focusEvidenceItem(f, item);
      openEvidenceLightbox(item, chip.dataset.evKey);
    };
  });

  // Hover names it, click goes to it — the two gestures the panel already gives a citation.
  questionPane.querySelectorAll('.find-cite').forEach(chip => {
    const frame = () => document.getElementById('find-page');
    // A hover counts only once it has been HELD. Sweeping the pointer across a line of prose crosses
    // every chip in it, and counting those would report a participant as having checked references
    // they never looked at.
    let dwell = null;
    chip.onmouseenter = (e) => {
      const f = frame();
      if (f) focusFindCitation(f, chip.dataset.citeText || '', false);
      chip.classList.add('find-cite-active');
      if (!e?.isTrusted) return;
      clearTimeout(dwell);
      dwell = setTimeout(() => {
        window.StudyTelemetry.reference('cite', chip.dataset.citeN || '', 'hover');
      }, REFERENCE_DWELL);
    };
    chip.onmouseleave = () => {
      clearTimeout(dwell);
      dwell = null;
      const f = frame();
      if (!chip.dataset.pinned) chip.classList.remove('find-cite-active');
      try { if (f && !chip.dataset.pinned) clearFindFocus(f.contentDocument); } catch (e) {}
    };
    chip.onclick = (e) => {
      // NOT synthetic clicks. The admin reference panel's Show button calls .click() on a chip, and
      // without this a researcher checking their own references would inflate the participant number.
      if (e?.isTrusted) window.StudyTelemetry.reference('cite', chip.dataset.citeN || '', 'click');
      const f = frame();
      if (!f) return;
      questionPane.querySelectorAll('.find-cite').forEach(c => {
        delete c.dataset.pinned;
        c.classList.remove('find-cite-active');
      });
      chip.dataset.pinned = '1';
      chip.classList.add('find-cite-active');
      focusFindCitation(f, chip.dataset.citeText || '', true);
    };
  });
}

/**
 * Pull the grounding markers out of a recorded answer.
 *
 * Two kinds, both produced by the extension and both meaningful here:
 *   [N:"quoted text"]  a citation — N indexes the element on the page, and the QUOTED TEXT is what
 *                      was said there. The text is what survives; see markFindCitations.
 *   [ev:key]           saved visual evidence, matched against canned.evidence by key.
 */
function parseFindCitations(answer) {
  return window.FindCitations.parse(answer);
}

function linkedFindEvidence(answer, evidence) {
  const linked = new Set(window.FindCitations.evidenceKeys(answer));
  if (!linked.size) return [];
  return (Array.isArray(evidence) ? evidence : [])
    .filter(item => linked.has(String(item?.key || '').trim()));
}

/**
 * The answer with its markers turned into chips — what the extension shows, rather than the raw
 * "[43:\"El pedante\"]" a participant should never see.
 *
 * The non-grounded arm gets the markers STRIPPED instead: that arm is defined by their absence, and
 * a raw marker left in the prose would be worse than either — it would tell a non-grounded
 * participant that something was cited while giving them no way to check it.
 */
function renderFindAnswer(answer, arm) {
  // One renderer, shared with the Admin editor's preview — see app/find_citations.js.
  return window.FindCitations.renderAnswer(answer, arm);
}

/** The shared renderer (app/markdown.js) — one renderer for the stimulus, Find and the editor. */
function renderMarkdown(escaped) {
  return window.StudyMarkdown.render(escaped);
}

/**
 * Mark what the answer cited, inside the snapshot, for the grounded arm only.
 *
 * This is what the whole snapshot exists for: the frame is same-origin, so its document can be
 * walked and marked. Matching is on the QUOTED TEXT from each [N:"…"] marker, not on the index N —
 * an index only means anything if the page is re-indexed exactly as it was at record time, and one
 * lazy image or one A/B variant moves every index. The quoted sentence is the stable handle.
 *
 * Image claims should be backed by explicit [ev:key] markers. Numbered citations resolve to text
 * or captions only; if the only match is an image alt, the replay leaves the page unmarked rather
 * than boxing a whole figure that the final answer did not explicitly link as visual evidence.
 *
 * The non-grounded arm gets nothing. That is the arm.
 */
/**
 * Remove the PageGuide markup the capture baked in.
 *
 * A snapshot is sometimes taken while a highlight is live on the page, and the marks travel into the
 * stored HTML: HARRY-v1 arrived with `data-pageguide-styled` sitting on the very paragraph its
 * citation points at, plus a leftover `<span style="border-radius:3px;padding:1px 4px">` where a
 * highlight used to be.
 *
 * That is not cosmetic. flattenSubtreeWithMap SKIPS every text node inside `[data-pageguide-styled]`
 * — a sensible guard against re-marking text this session already marked, but it cannot tell our
 * mark from the recorder's. With the attribute pre-set on the paragraph, the flattened text came out
 * EMPTY, the quote could never be found, and marking fell through to tinting the whole block. Which
 * is exactly what a reviewer saw: a paragraph washed purple and no keyword inside it.
 *
 * Cleared here, before applyFindGrounding runs, so replay always starts from an unmarked page.
 */
function stripCapturedPageGuideMarks(doc) {
  if (!doc?.body) return;
  doc.querySelectorAll('[data-pageguide-styled]').forEach(el => {
    el.removeAttribute('data-pageguide-styled');
    if (el.dataset) delete el.dataset.pgCite;
  });
  doc.querySelectorAll('.pageguide-highlight, .pageguide-context, .pageguide-preview-target')
    .forEach(el => {
      // A leftover wrapper span carries no meaning of its own — unwrap it so the text it holds
      // rejoins its neighbours and a quote spanning it is one run again.
      if (el.tagName === 'SPAN' && el.classList.contains('pageguide-highlight')) {
        el.replaceWith(doc.createTextNode(el.textContent || ''));
        return;
      }
      el.classList.remove('pageguide-highlight', 'pageguide-context', 'pageguide-preview-target');
    });
  doc.body.normalize();
}

function cleanupFindSnapshotObstructions(doc) {
  if (!doc?.body || doc.getElementById('pg-snapshot-cleanup-style')) return;
  const style = doc.createElement('style');
  style.id = 'pg-snapshot-cleanup-style';
  style.textContent = `
    html, body { overflow: auto !important; }
    .pg-hidden-snapshot-obstruction { display: none !important; }`;
  doc.head?.appendChild(style);

  const win = doc.defaultView;
  const viewportW = win?.innerWidth || doc.documentElement?.clientWidth || 0;
  const viewportH = win?.innerHeight || doc.documentElement?.clientHeight || 0;
  if (!win || !viewportW || !viewportH) return;

  const promoText = /\b(donate|newsletter|subscribe|subscription|support us|support our|sign up)\b/i;
  const candidates = Array.from(doc.body.querySelectorAll('*'));
  for (const el of candidates) {
    if (!(el instanceof win.HTMLElement)) continue;
    const computed = win.getComputedStyle(el);
    if (computed.position !== 'fixed' && computed.position !== 'sticky') continue;
    const text = normText(el.textContent || '');
    if (!promoText.test(text)) continue;
    const rect = el.getBoundingClientRect();
    const largeEnough = rect.width >= viewportW * 0.35 && rect.height >= Math.max(70, viewportH * 0.08);
    const blocksReadingArea = rect.top >= viewportH * 0.35 || rect.bottom >= viewportH * 0.8;
    if (largeEnough && blocksReadingArea) {
      el.classList.add('pg-hidden-snapshot-obstruction');
    }
  }
}

function applyFindGrounding(frame, canned, arm) {
  let doc;
  try { doc = frame.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;
  cleanupFindSnapshotObstructions(doc);
  stripCapturedPageGuideMarks(doc);

  if (arm === 'nongrounding') return;
  const answer = canned?.answer_display || canned?.answer_raw || '';
  const cites = parseFindCitations(answer);
  const linkedEvidence = linkedFindEvidence(answer, canned?.evidence);
  const hasEvidenceMarks = linkedEvidence.some(hasPageLinkedEvidence);
  if (!cites.length && !hasEvidenceMarks) return;

  // THE EXTENSION'S OWN STYLING, copied from content/content.css rather than approximated. A
  // participant who saw the live page in the extension and the snapshot here must be looking at the
  // same thing: the same tint on a cited phrase, the same outline on a cited picture, and the same
  // "PageGuide highlight" badge when one is pointed at. A second visual language for the same idea
  // would be one more difference between the arms that nobody is measuring.
  // The flag the review-only rules below hang off. Set on the snapshot's own root, so it travels
  // with the document rather than depending on anything in the host page.
  if (S.state.adminReview) doc.documentElement?.classList.add('pg-admin-review');

  const style = doc.createElement('style');
  style.textContent = `
    .pageguide-highlight {
      background-color: color-mix(in srgb, #7857ff 16%, transparent);
      border-radius: 3px; padding: 1px 3px; margin: 0 1px;
      scroll-margin: 90px;
    }
    .pageguide-context {
      background-color: color-mix(in srgb, #7857ff 10%, transparent);
      border-radius: 4px;
      scroll-margin: 90px;
    }
    [data-pageguide-styled] { position: relative; }
    [data-pageguide-styled]:hover,
    .pageguide-preview-target {
      outline: 2px solid #7857ff !important;
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(120,87,255,.14), 0 12px 32px rgba(120,87,255,.22) !important;
      background-color: color-mix(in srgb, #7857ff 38%, transparent);
    }
    /* The badge the live page shows, to the pixel: same words, same pill, same dot. */
    [data-pageguide-styled]:hover::after,
    .pageguide-preview-target::after {
      content: 'PageGuide highlight';
      position: absolute; left: 0; bottom: calc(100% + 8px);
      z-index: 2147483647;
      padding: 6px 9px 6px 24px;
      border: 1px solid rgba(155,132,255,.36);
      border-radius: 999px;
      background:
        radial-gradient(circle at 12px 50%, transparent 0 3px, #b89cff 3px 5px, transparent 5px),
        rgba(32,26,55,.96);
      color: #fff;
      box-shadow: 0 14px 34px rgba(50,35,100,.25);
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space: nowrap;
      pointer-events: none;
    }
    /* ── Review mode only: tell the keyword apart from its sentence ──────────────────────────
       The two marks nest — .pageguide-context washes the block a citation sits in, and
       .pageguide-highlight wraps the exact quoted phrase inside it. At 10% and 16% they are six
       points apart and the inner one sits ON the outer one, so a researcher re-linking a reference
       cannot see where the sentence ends and the keyword begins. That matters here in a way it does
       not for a participant: re-linking is the act of confirming that THIS phrase is the one the
       citation points at.
       Scoped to .pg-admin-review, and applied to nothing a participant ever loads, because the tint
       above is copied from the extension's content.css on purpose — a participant who saw the live
       page and one who sees this snapshot have to be looking at the same thing, and the arms differ
       by grounding alone. */
    .pg-admin-review .pageguide-context {
      background-color: color-mix(in srgb, #7857ff 8%, transparent);
      outline: 1px dashed color-mix(in srgb, #7857ff 52%, transparent);
      outline-offset: 3px;
    }
    /* The UNDERLINE does the work, not the tint. A fill dark enough to be unmistakable is also dark
       enough to fight the text it sits under, and this text is the thing being read. A light wash
       plus a solid rule under the phrase separates it from its sentence at a glance and still leaves
       the words the darkest thing in the line.
       No font-weight change either: reflowing a paragraph to emphasise part of it moves everything
       after it, and the reviewer is comparing this layout with the page they recorded. */
    .pg-admin-review .pageguide-highlight {
      background-color: color-mix(in srgb, #7857ff 22%, transparent);
      box-shadow: inset 0 -2px 0 color-mix(in srgb, #5b3fd6 75%, transparent);
    }
    /* The keyword still wins when it is also the thing just pointed at — otherwise clicking Show on
       a reference makes it lighter than it was a moment ago, which reads as losing the selection. */
    .pg-admin-review .pageguide-highlight.pageguide-preview-target,
    .pg-admin-review .pageguide-highlight[data-pageguide-styled]:hover {
      background-color: color-mix(in srgb, #7857ff 34%, transparent);
      box-shadow: inset 0 -2px 0 #5b3fd6;
    }

    /* A cited picture is outlined rather than tinted — a tint over an engraving hides the engraving,
       which is the thing being asked about. */
    .pageguide-highlight-img {
      outline: 2px solid #7857ff; outline-offset: 3px; border-radius: 2px; scroll-margin: 90px;
    }
    /* The wrapper must lay out like the image it holds, or marking one would reflow the article. */
    .pageguide-highlight-imgwrap { display: inline-block; position: relative; max-width: 100%; line-height: 0; }
    .pageguide-highlight-imgwrap > img { display: block; max-width: 100%; }`;
  doc.head?.appendChild(style);

  // The locators the recorder resolved on the live page, keyed by the full citation marker. Absent
  // on responses banked before anchoring existed — those fall through to text search.
  const anchorsByMarker = new Map();
  (Array.isArray(canned?.citation_anchors) ? canned.citation_anchors : [])
    .forEach(a => {
      if (!a || a.index == null) return;
      const markerKey = citationAnchorKey(a.index, a.quote);
      if (!anchorsByMarker.has(markerKey)) anchorsByMarker.set(markerKey, []);
      anchorsByMarker.get(markerKey).push(a);
    });

  // ONE INDEX, ONE ELEMENT. Two citations can share an index — the same paragraph quoted twice —
  // and they must land on the same place, because they ARE the same place: [N] means element N.
  //
  // Resolved independently they can disagree, and did. With the anchor missing, each fell back to
  // text search on its own quote: "Foundation series" is short enough to hit an image caption,
  // while "extend the human species' reach." is rare enough to hit nothing. Same target, two
  // different answers, and one of them confidently wrong.
  //
  // So the first citation to resolve an index decides it, and the rest of that index reuse the
  // element rather than searching again for their own wording.
  const resolvedByIndex = new Map();
  cites.forEach(cite => {
    const key = Number(cite.index);
    const already = resolvedByIndex.get(key);
    const anchor = takeCitationAnchor(anchorsByMarker, cite.index, cite.text);
    const el = markFindCitation(doc, cite.text, cite.index, anchor, already);
    if (el && !already) resolvedByIndex.set(key, el);
  });
  drawTextEvidenceMarks(doc, linkedEvidence);
  drawEvidenceMarks(doc, linkedEvidence);
}

function drawTextEvidenceMarks(doc, evidence) {
  const items = (Array.isArray(evidence) ? evidence : []).filter(e => e?.source_anchor || e?.source_text);
  items.forEach(item => {
    const text = normText(item.source_text || item.source_anchor?.quote || '');
    if (!text) return;
    let el = item.source_anchor ? resolveCitationAnchor(doc, item.source_anchor) : null;
    if (!el) el = findElementBySemanticText(doc, text) || findElementContaining(doc, text.slice(0, Math.min(40, text.length)));
    if (!el) return;
    const marked = markCitationElement(el, text);
    const target = marked || el;
    target.dataset.pgEvidenceKey = item.key || '';
  });
}

function hasPageLinkedEvidence(item) {
  if (!item) return false;
  if (item.source_anchor || item.source_text) return true;
  return item.source_kind === 'image' && item.source_image_id
    && (item?.marks?.annotations?.length || item?.marks?.region_bbox);
}

/**
 * Draw the saved evidence annotations onto the picture they were drawn on.
 *
 * This is what the extension shows and the site was missing. Evidence for an image claim is not
 * "highlight the whole image" — it is a labelled ellipse round the spaceman, a box round the
 * lettering, an arrow to what it is reaching for. Marking the element instead pointed at the right
 * picture while saying nothing about WHERE in it, which for a question like "what is the spaceman
 * doing to the ship?" is most of the answer withheld.
 *
 * Coordinates are normalized (0..1) to the source image, so they survive the snapshot being shown
 * at any width — which is why they can be replayed here at all.
 */
function drawEvidenceMarks(doc, evidence) {
  // ANNOTATIONS **OR** A REGION. Most recorded evidence has no drawn shapes at all: the model
  // reports what it saw and where, and gv2BuildFindEvidence stores that as `region_bbox` with a
  // `note`, leaving `annotations` empty. PEDANT-V1, MUFC-V1 and TREE-V1 are all of this kind —
  // {x:0, y:0, w:1, h:1}, meaning "this whole picture", with the note explaining what to look at.
  //
  // Filtering on annotations alone dropped every one of them, so the [ev:key] chip appeared in the
  // answer with nothing on the page to match it, while the extension drew the box and label for the
  // same record. That difference between what the researcher approved and what a participant sees
  // is the thing this whole replay exists to prevent.
  const items = (Array.isArray(evidence) ? evidence : [])
    .filter(e => e?.source_kind === 'image' && e?.source_image_id)
    .filter(e => e?.marks?.annotations?.length || e?.marks?.region_bbox);
  if (!items.length) return;

  // "page_image_N" is the Nth image AS THE RECORDER COUNTED THEM, so the same rule has to be used
  // here or the annotation lands on a different picture. The recorder's rule is
  // GV2_FIND_MEDIA_MIN_PX / GV2_FIND_MEDIA_NOISE (content/utils.js): at least 100px on both sides,
  // and not something whose URL or alt marks it as chrome. Guessing at ">= 200px" put Tesla's
  // page_image_6 on the wrong image entirely.
  const NOISE = /logo|icon|avatar|sprite|badge|thumb|advert|\bads?\b|banner|sponsor|placeholder/i;
  const contentImages = Array.from(doc.querySelectorAll('img')).filter(img => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if ((w > 0 || h > 0) && (w < 100 || h < 100)) return false;
    return !NOISE.test(`${img.getAttribute('src') || ''} ${img.getAttribute('alt') || ''} ${img.className || ''}`);
  });

  const skipped = [];
  items.forEach(item => {
    const id = String(item.source_image_id || '');
    if (!id || id === 'viewport') { skipped.push(item.key || '?'); return; }

    const stamped = doc.querySelector(`[data-pg-image-id="${CSS.escape(id)}"]`);
    const digits = id.match(/(\d+)$/)?.[1];
    const img = stamped || (digits ? contentImages[Number(digits) - 1] : null);
    if (!img) { skipped.push(item.key || id); return; }

    const draw = () => overlayAnnotations(doc, img, item.marks.annotations, item.key, item.marks);
    draw();
    if (!img.complete) {
      img.addEventListener('load', draw, { once: true });
    }
  });

  // Said out loud rather than swallowed. An [ev:key] chip in the answer with no mark on the page is
  // a broken promise to the participant, and silently drawing nothing is how it went unnoticed.
  if (skipped.length) {
    console.warn('[study] evidence marks that could not be placed:', skipped.join(', '),
      '— re-capture the page in the extension so the images carry data-pg-image-id stamps.');
  }
}

/**
 * Position an SVG over one image and draw its marks into it.
 *
 * `marks` carries the region fallback: when the model reported WHERE it looked but drew no shapes,
 * the region is the evidence and the note is what it says. That is the common case, not the edge —
 * see drawEvidenceMarks.
 */
function overlayAnnotations(doc, img, annotations, key, marks) {
  const host = img.parentElement?.classList.contains('pageguide-highlight-imgwrap')
    ? img.parentElement
    : (() => { markImage(img, key || ''); return img.parentElement; })();
  if (!host || host.querySelector('.pg-annots')) return;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'pg-annots');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('style',
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible');

  // The region, when there are no shapes to draw. Outlined and labelled with the note, matching
  // what pageguideShowEvidenceAnnotations does on the live page for exactly this case — the
  // researcher approved that rendering, so a participant must get the same one.
  const shapes = Array.isArray(annotations) ? annotations : [];
  const region = marks?.region_bbox;

  // COORDINATE SPACE. Annotation coordinates are fractions of the CAPTURED AREA, not of the image —
  // the same space `region_bbox` is expressed in, which is where the image sits inside that capture.
  // Drawing them straight onto the image put every mark in the wrong place at the wrong scale.
  //
  // SVSF-V1 is the proof: region_bbox is {x:0.598, w:0.402} — the cover occupies the right 40% of
  // the capture, because the shot took in both book covers. Its "spaceman" ellipse is at x=0.803,
  // which is 80% across the CAPTURE and (0.803-0.598)/0.402 = 51% across the COVER. Drawn raw it
  // landed at 80% of the cover; drawn through the region it lands where the recorder drew it.
  //
  // A region of {0,0,1,1} — the whole-image case — makes this the identity, so items captured on
  // the image alone are unaffected.
  const usable = region && Number.isFinite(region.w) && Number.isFinite(region.h)
    && region.w > 0 && region.h > 0;
  const fx = (x) => (usable ? ((Number(x) || 0) - (region.x || 0)) / region.w : (Number(x) || 0));
  const fy = (y) => (usable ? ((Number(y) || 0) - (region.y || 0)) / region.h : (Number(y) || 0));
  const fw = (w) => (usable ? (Number(w) || 0) / region.w : (Number(w) || 0));
  const fh = (h) => (usable ? (Number(h) || 0) / region.h : (Number(h) || 0));

  if (!shapes.length && usable) {
    // The region maps to the whole image by definition, so it is drawn as the full frame.
    const r = doc.createElementNS(NS, 'rect');
    r.setAttribute('x', 0);
    r.setAttribute('y', 0);
    r.setAttribute('width', 100);
    r.setAttribute('height', 100);
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', '#ff2d78');
    r.setAttribute('stroke-width', '0.8');
    r.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(r);
    // The note IS the evidence here — without it the box says "look at this picture" and no more.
    //
    // Drawn as HTML rather than SVG <text>, unlike the shape labels above. This svg is
    // preserveAspectRatio="none" so that a normalized bbox lands correctly on any aspect ratio,
    // and that same stretch distorts glyphs horizontally — survivable for a one-word tag, not for
    // a full sentence. HTML also wraps, which SVG text does not, and these notes are sentences.
    const label = String(marks.note || '').trim();
    if (label) {
      const bar = doc.createElement('div');
      bar.className = 'pg-annot-note';
      bar.textContent = label;
      bar.setAttribute('style', [
        // The region IS the image after the transform above, so the note sits at its top-left.
        'position:absolute', 'left:0', 'top:0', 'max-width:100%',
        'background:#ff2d78', 'color:#fff',
        'font:700 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        'padding:4px 8px', 'border-radius:4px',
        'pointer-events:none', 'z-index:2',
      ].join(';'));
      host.appendChild(bar);
    }
  }

  shapes.forEach(a => {
    const colour = a.color || '#ff2d78';
    if (a.type === 'ellipse' && a.bbox) {
      const e = doc.createElementNS(NS, 'ellipse');
      e.setAttribute('cx', (fx(a.bbox.x) + fw(a.bbox.w) / 2) * 100);
      e.setAttribute('cy', (fy(a.bbox.y) + fh(a.bbox.h) / 2) * 100);
      e.setAttribute('rx', (fw(a.bbox.w) / 2) * 100);
      e.setAttribute('ry', (fh(a.bbox.h) / 2) * 100);
      e.setAttribute('fill', 'none');
      e.setAttribute('stroke', colour);
      e.setAttribute('stroke-width', '0.6');
      e.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(e);
      if (a.label) svg.appendChild(_annotLabel(doc, NS, fx(a.bbox.x) * 100, fy(a.bbox.y) * 100 - 2, a.label, colour));
    } else if ((a.type === 'box' || a.type === 'rect') && a.bbox) {
      const r = doc.createElementNS(NS, 'rect');
      r.setAttribute('x', fx(a.bbox.x) * 100);
      r.setAttribute('y', fy(a.bbox.y) * 100);
      r.setAttribute('width', fw(a.bbox.w) * 100);
      r.setAttribute('height', fh(a.bbox.h) * 100);
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', colour);
      r.setAttribute('stroke-width', '0.6');
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(r);
      if (a.label) svg.appendChild(_annotLabel(doc, NS, fx(a.bbox.x) * 100, fy(a.bbox.y) * 100 - 2, a.label, colour));
    } else if (a.type === 'arrow' && a.from && a.to) {
      const l = doc.createElementNS(NS, 'line');
      l.setAttribute('x1', fx(a.from.x) * 100); l.setAttribute('y1', fy(a.from.y) * 100);
      l.setAttribute('x2', fx(a.to.x) * 100);   l.setAttribute('y2', fy(a.to.y) * 100);
      l.setAttribute('stroke', colour);
      l.setAttribute('stroke-width', '0.8');
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(l);
      if (a.label) svg.appendChild(_annotLabel(doc, NS, fx(a.to.x) * 100, fy(a.to.y) * 100 - 2, a.label, colour));
    }
  });

  host.appendChild(svg);
}

/** A label chip on an annotation, in the annotation's own colour. */
function _annotLabel(doc, NS, x, y, text, colour) {
  const g = doc.createElementNS(NS, 'g');
  const t = doc.createElementNS(NS, 'text');
  t.setAttribute('x', x);
  t.setAttribute('y', Math.max(2, y));
  t.setAttribute('fill', '#fff');
  t.setAttribute('font-size', '2.6');
  t.setAttribute('font-weight', '700');
  t.setAttribute('paint-order', 'stroke');
  t.setAttribute('stroke', colour);
  t.setAttribute('stroke-width', '2.2');
  t.setAttribute('stroke-linejoin', 'round');
  t.textContent = text;
  g.appendChild(t);
  return g;
}

const PG_ANCHOR_TEXT_MAX = 400;

/** Curly quotes, odd spacing and non-breaking spaces all differ between a recorded quote and the
 *  page it came from. Compare on a normalized form so they stop mattering. */
function normText(v) {
  return String(v == null ? '' : v)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * normText, plus a map from each character of the normalized output back to its index in the raw
 * input.
 *
 * markText finds a quote by searching the NORMALIZED text of a DOM text node, then has to wrap the
 * match in a Range against that node's RAW text. Collapsed whitespace and a trimmed leading run both
 * change the string's length, so an offset that is correct in the normalized string lands on the
 * wrong character once applied to the raw one \u2014 MORE wrong the further into the node the match sits,
 * because every collapsed run before it has shifted things left. On a caption whose source text
 * starts with leading whitespace (common in scraped/rendered HTML), this put the wrap several
 * characters before where the quote actually starts, splicing the end of one phrase into the middle
 * of another \u2014 visually two captions overlaid on each other.
 *
 * `map[i]` is the raw index that produced the i-th character of the normalized string, so a match at
 * normalized [hit, hit+len) becomes the raw range [map[hit], map[hit+len-1]+1).
 */
function normTextWithMap(v) {
  const raw = String(v == null ? '' : v);
  const n = raw.length;
  let start = 0;
  while (start < n && /\s/.test(raw[start])) start++;
  let end = n;
  while (end > start && /\s/.test(raw[end - 1])) end--;

  let text = '';
  const map = [];
  let inWhitespaceRun = false;
  for (let i = start; i < end; i++) {
    let ch = raw[i];
    if (ch === '\u2018' || ch === '\u2019') ch = "'";
    else if (ch === '\u201c' || ch === '\u201d') ch = '"';
    else if (ch === '\u00a0') ch = ' ';
    if (/\s/.test(ch)) {
      if (inWhitespaceRun) continue;           // collapse this run to the one space already emitted
      inWhitespaceRun = true;
      ch = ' ';
    } else {
      inWhitespaceRun = false;
    }
    text += ch;
    map.push(i);
  }
  return { text, map };
}

function citationAnchorKey(index, quote) {
  return `${Number(index)}:${normText(quote)}`;
}

function takeCitationAnchor(map, index, quote) {
  const list = map.get(citationAnchorKey(index, quote));
  return list && list.length ? list.shift() : null;
}

/**
 * Mark one cited passage inside the snapshot.
 *
 * The hard case is a CAPTION. A cited image carries text like "Title page engraving from Francesco
 * Belo's El pedante (1538)", and a caption is almost always split across elements — the play title
 * sits in its own <em> or <a>, so no single text node holds the whole string and an exact match
 * finds nothing. That is why this falls back to progressively shorter prefixes and then marks the
 * CONTAINING ELEMENT rather than a sub-range: the goal is to show the participant where the claim
 * came from, and the whole caption is a better answer than nothing.
 *
 * Whatever matches, a picture beside it is outlined too — for an image citation the picture is the
 * evidence, and highlighting only its caption would point next to the thing rather than at it.
 */
function markFindCitation(doc, text, index, anchor, settled) {
  const needle = normText(text);

  // 0. ALREADY SETTLED. Another citation with this same index resolved into the same page element.
  // Reuse that sentence/list item as the search context, not the first inline phrase that happened
  // to be highlighted there. Otherwise two citations in one bullet — "Mark Stevens" and
  // "S-Cubed Capital" — both end up attached to the first span.
  if (settled) {
    if (normText(settled.dataset?.pgCite).toLowerCase() === needle.toLowerCase()) return settled;
    const root = citationReuseRoot(settled, needle);
    return markCitationElement(root, needle || String(index)) || root;
  }

  // 0a. THE RECORDED LOCATOR, when the response carries one. Resolved on the live page at the moment
  // the answer was banked, while the index that issued `index` was still installed — see
  // content/functions/citation_anchors.js. Preferred over the stamped anchor because it travels with
  // the ANSWER rather than with one capture: it resolves against a snapshot taken at any time,
  // including snapshots captured before anchoring existed, and re-capturing cannot strip it off.
  if (anchor && anchor.tag && anchor.text) {
    const located = resolveCitationAnchor(doc, anchor);
    // THE QUOTE MUST BE IN IT. An anchor derived through a stale index resolves perfectly and points
    // at the wrong paragraph — SVSF-V1's [70] landed on "The novels are genuinely extraordinary…",
    // which does not contain "Book covers: Isaac Asimov's…" anywhere. The recorder validates this
    // now too, but rows published before it did are already in the database, and a locator beats
    // every fallback below — so an unchecked bad one wins outright and silently.
    if (located && anchorHoldsQuote(located, needle)) {
      markCitationElement(located, needle || String(index));
      return located;
    }
    // A saved locator is the authoritative address for this citation. If it fails, the old numeric
    // index is too stale to trust; fall through to quote/semantic search instead of marking the
    // wrong element confidently.
    index = null;
  }

  // 0b. THE STAMPED ANCHOR, when the snapshot has one. `[69:"…"]` means element 69 in the page index
  // at record time, and the capture writes that index onto the element (_pgStampAnchors,
  // content/functions/page_snapshot.js). Exact, so none of the guessing below is needed — and the
  // guessing is what put "Foundation series" on the wrong paragraph. Everything after this is the
  // fallback for snapshots captured before stamping existed.
  if (index != null) {
    const anchored = doc.querySelector(`[data-pg-index="${CSS.escape(String(index))}"]`);
    if (anchored) { markCitationElement(anchored, needle || String(index)); return anchored; }
  }

  if (needle.length < 4) return null;       // too short to match uniquely; a false hit is worse

  // 1. The whole quote inside one text node — the clean case, marked precisely.
  //
  // Returns the inline mark. Same-index sibling citations climb back to a containing sentence with
  // citationReuseRoot rather than reusing this exact phrase.
  const hit = markText(doc, needle);
  if (hit) return hit;

  // 1b. The quote crosses an inline tag (a link, an <em>, ...) and so matches no single text node —
  // see markTextAcrossNodes. Tried before the prefix/whole-element fallback below, which is what
  // used to tint an entire paragraph for a quote that only meant one sentence in it.
  const crossNode = markTextAcrossNodes(doc.body, needle);
  if (crossNode) return crossNode;

  // 2. A prefix inside one text node. Long enough to stay distinctive, short enough to survive the
  //    markup that split the caption up.
  for (const len of [40, 25, 15]) {
    if (needle.length <= len) continue;
    const el = findElementContaining(doc, needle.slice(0, len));
    if (el) return markMatchedFragmentOrContext(el, needle, needle.slice(0, len));
  }

  // 3. An image whose alt text carries the quote. Prefer nearby caption text; do not outline the
  // image itself for an ordinary numbered citation.
  const img = Array.from(doc.querySelectorAll('img'))
    .find(i => normText(i.getAttribute('alt')).includes(needle.slice(0, 25)));
  if (img) return markImageCitationText(img, needle);

  const semantic = findElementBySemanticText(doc, needle);
  if (semantic) { markCitationElement(semantic, needle); return semantic; }
  return null;
}

/**
 * Mark a resolved citation. The locator may name a paragraph or caption, but the quote should still
 * light up as the phrase the answer cited. Whole-element tint is only the fallback.
 */
function markCitationElement(el, needle) {
  if (!el || el.nodeType !== 1) return null;
  if (el.matches?.('img')) return markImageCitationText(el, needle);
  if (el.matches?.('figure')) {
    const caption = el.querySelector?.('figcaption, [class*="caption" i]');
    if (caption) {
      const marked = markCitationElement(caption, needle);
      if (marked) return marked;
    }
    return null;
  }
  if (needle && normText(needle).length >= 4) {
    const mark = markText(el.ownerDocument, needle, el) || markTextAcrossNodes(el, needle);
    if (mark) {
      // THE BLOCK GETS THE WASH TOO, not just the phrase. These were either/or: mark the exact quote
      // and the surrounding sentence stayed plain, or fail and tint the whole block. Both together is
      // what a reviewer re-linking actually needs — the wash says "the citation resolved to here",
      // the darker phrase says "and this is the part it points at".
      //
      // The class alone, without markElement's data-pageguide-styled: that attribute is what draws
      // the hover outline and the "PageGuide highlight" badge, and putting it on the whole paragraph
      // would make the badge fire anywhere in it and swallow the phrase inside its own hover state.
      el.classList.add('pageguide-context');
      return mark;
    }
  }
  markElement(el, needle);
  return el;
}

function markImageCitationText(img, needle) {
  const figure = img.closest?.('figure');
  const caption = figure?.querySelector?.('figcaption, [class*="caption" i]')
    || img.parentElement?.querySelector?.('figcaption, [class*="caption" i]');
  if (!caption) return null;
  return markCitationElement(caption, needle);
}

function markMatchedFragmentOrContext(el, needle, fragment) {
  const mark = markText(el.ownerDocument, fragment, el) || markTextAcrossNodes(el, fragment);
  if (mark) {
    mark.dataset.pgCite = needle;
    return mark;
  }
  markElement(el, needle);
  return el;
}

function citationReuseRoot(el, needle) {
  if (!el || el.nodeType !== 1) return el;
  const q = normText(needle).toLowerCase();
  if (!q) return el;
  let cur = el;
  while (cur && cur !== el.ownerDocument.body) {
    const text = normText(cur.textContent).toLowerCase();
    if (text.includes(q.length > 40 ? q.slice(0, 40) : q)) {
      if (/^(P|LI|FIGCAPTION|BLOCKQUOTE|TD|TH|H1|H2|H3)$/.test(cur.tagName)) return cur;
    }
    cur = cur.parentElement;
  }
  return el;
}

/**
 * Does this element actually carry the quoted text?
 *
 * Mirrors `_pgAnchorHolds` in content/functions/citation_anchors.js, including its 40-character
 * prefix rule: a citation's quote is the model's rendering of what it read and may end in an
 * ellipsis or clip a trailing clause, so demanding the whole string rejects good matches.
 */
function anchorHoldsQuote(el, quote) {
  const q = normText(quote).toLowerCase();
  if (!q) return true;                       // nothing to disprove
  const hay = semanticTextOf(el).toLowerCase();
  return hay.includes(q.length > 40 ? q.slice(0, 40) : q);
}

function anchorTextOf(el) {
  const ownText = normText(el?.textContent);
  return (ownText || semanticTextOf(el)).slice(0, PG_ANCHOR_TEXT_MAX);
}

function semanticTextOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const bits = [normText(el.textContent)];
  const attrs = ['aria-label', 'title', 'alt'];
  const addAttrs = (node) => attrs.forEach((name) => {
    const value = node.getAttribute?.(name);
    if (value) bits.push(normText(value));
  });
  addAttrs(el);
  el.querySelectorAll?.('[aria-label], [title], [alt]').forEach(addAttrs);
  return normText(bits.filter(Boolean).join(' '));
}

function citationEvidenceElement(el, quote) {
  if (!el || el.nodeType !== 1) return el;
  if (normText(el.textContent)) return el;
  let cur = el.parentElement;
  let best = el;
  while (cur && cur !== el.ownerDocument.body) {
    if (!anchorHoldsQuote(cur, quote)) break;
    const text = normText(cur.textContent);
    if (text && text.length <= 600) {
      best = cur;
      if (/^(TD|TH|LI|P|FIGCAPTION|FIGURE|TR)$/.test(cur.tagName)) return cur;
    }
    cur = cur.parentElement;
  }
  return best;
}

/**
 * Find the element a recorded locator names, or null.
 *
 * Counts (tag, flattened text) occurrences the same way the recorder did — see `_pgAnchorOrdinal`
 * in content/functions/citation_anchors.js. The two must agree exactly, which is why both walk the
 * whole document in order and both compare COLLAPSED textContent rather than text nodes:
 *
 *   • flattening is what makes "<i>Foundation</i> series" match the quote "Foundation series",
 *     which no text-node search can do;
 *   • the ordinal is what separates the inner "El pedante" from the caption that contains it,
 *     which no substring search can do.
 *
 * Null is a normal outcome — a locator from a differently-pruned capture may not resolve — and the
 * caller falls through to text search rather than marking nothing.
 */
function resolveCitationAnchor(doc, anchor) {
  return resolveCitationAnchorTiered(doc, anchor).el;
}

/**
 * The same resolution, saying WHICH tier answered.
 *
 * The tier is not decoration. "This citation resolves, and it resolves exactly" and "this citation
 * resolves, by guessing from a phrase" are different facts about the study's material, and only the
 * first is worth trusting. The reference panel in review mode prints it so a researcher can see at a
 * glance which links are solid and which want re-picking — previously the only way to find a bad
 * link was to click every chip and watch what lit up.
 *
 *   exact   — the structural path landed and the text there is unchanged. Believe it.
 *   moved   — the path landed somewhere the text differs, but the quote is still inside it. The
 *             page was edited around it; still almost certainly right.
 *   text    — no usable path; found by matching the whole block's text and counting ordinals.
 *             This is what every anchor written before paths existed has to use.
 *   search  — found only by hunting for the phrase. Bounded, and the weakest tier.
 *   none    — nothing matched. Better than marking the wrong thing.
 */
function resolveCitationAnchorTiered(doc, anchor) {
  const quote = normText(anchor?.quote || '');

  // 1/2. The structural address, verified against the fingerprint rather than trusted blindly.
  const byPath = elementAtPath(doc, anchor?.path);
  if (byPath) {
    const same = anchor.fingerprint && textFingerprint(byPath.textContent) === anchor.fingerprint;
    if (same) return { el: citationEvidenceElement(byPath, quote), tier: 'exact' };
    if (quote && normText(byPath.textContent).includes(quote)) {
      return { el: citationEvidenceElement(byPath, quote), tier: 'moved' };
    }
  }

  // 3. The original comparison. Both this and the text search below flatten textContent rather than
  // walking text nodes, because "<i>Foundation</i> series" has to match the quote "Foundation
  // series", which no text-node search can do; and the ordinal is what separates an inner phrase
  // from the caption that contains it, which no substring search can do.
  const want = String(anchor?.text || '');
  if (want && anchor?.tag) {
    const all = doc.getElementsByTagName(anchor.tag);
    const matches = [];
    for (let i = 0; i < all.length; i++) {
      const t = anchorTextOf(all[i]);
      // A truncated locator kept only the first PG_ANCHOR_TEXT_MAX characters, so prefix is the only
      // comparison it supports; an untruncated one must match whole, or "El pedante" would match the
      // caption that merely starts with it.
      if (anchor.truncated ? t.startsWith(want) : t === want) matches.push(all[i]);
    }
    // Out of range means the snapshot and the recording disagree about the page — fall through to
    // the phrase search rather than marking a confidently wrong element.
    const el = matches[anchor.ordinal] || (matches.length === 1 ? matches[0] : null);
    if (el) return { el: citationEvidenceElement(el, quote), tier: 'text' };
  }

  return { el: null, tier: 'none' };
}

/**
 * The smallest element whose own text contains `fragment`, or null.
 *
 * BOUNDED, and that is the point. A quote that is not in the page verbatim — "Foundation series"
 * where the page writes "*Foundation* series", split by an <em> — falls through to searching whole
 * elements, and the smallest element containing a common word like "Foundation" can still be an
 * entire section. Marking that says "the evidence is somewhere in these six paragraphs", which
 * looks like a confident answer and is not one. A missing highlight is better than a wrong one, so
 * a candidate more than ~6× the fragment is refused.
 */
function findElementContaining(doc, fragment) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (normText(node.nodeValue).includes(fragment)) return node.parentElement;
  }
  const maxLength = Math.max(160, fragment.length * 6);
  const candidates = Array.from(doc.querySelectorAll('figcaption, p, li, td, span, h1, h2, h3'))
    .filter(el => normText(el.textContent).includes(fragment))
    .filter(el => normText(el.textContent).length <= maxLength);
  return candidates.sort((a, b) =>
    normText(a.textContent).length - normText(b.textContent).length)[0] || null;
}

function findElementBySemanticText(doc, fragment) {
  const q = normText(fragment);
  if (q.length < 4) return null;
  const probe = (q.length > 40 ? q.slice(0, 40) : q).toLowerCase();
  const matches = [];
  const all = doc.body ? doc.body.getElementsByTagName('*') : [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el.querySelector?.('[aria-label], [title], [alt]') && !el.matches?.('[aria-label], [title], [alt]')) continue;
    const t = semanticTextOf(el);
    const lower = t.toLowerCase();
    if (!lower.includes(probe)) continue;
    const exact = lower === probe;
    if (!exact && t.length > Math.max(600, q.length * 8)) continue;
    matches.push({ el, len: t.length, exact });
  }
  matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.len - b.len);
  const best = matches[0]?.el || null;
  return best ? citationEvidenceElement(best, q) : null;
}

/**
 * Highlight a text element. Visual evidence is drawn only from explicit [ev:key] links.
 *
 * A caption is rarely a sibling of its image. On this page the marked text is a <p> inside
 * .essay__image__caption, and the <img> lives two levels further up in .essay__center-content —
 * so checking only the parent or a <figure> finds nothing. The walk climbs until an ancestor
 * contains an image, which is what "the picture this caption belongs to" actually means in markup.
 *
 * BOUNDED at four levels on purpose: keep climbing and every caption eventually reaches <body>,
 * where it would confidently outline the site's logo.
 */
function markElement(el, needle) {
  el.classList.add('pageguide-context');
  el.setAttribute('data-pageguide-styled', '');
  el.dataset.pgCite = needle;
}

/**
 * Mark a cited image — via a WRAPPER, because an image cannot carry the badge itself.
 *
 * ::before and ::after do not render on replaced elements, and <img> is one. The badge is a
 * ::after, so putting the class on the image gives an outline and no label: the picture is pointed
 * at with nothing saying why, which is the one thing the badge exists to say. Wrapping the image in
 * an inline-block span gives the pseudo-element something it can actually attach to.
 */
function markImage(img, needle) {
  if (img.parentElement?.classList.contains('pageguide-highlight-imgwrap')) return;  // already marked
  const doc = img.ownerDocument;
  const wrap = doc.createElement('span');
  wrap.className = 'pageguide-highlight-imgwrap pageguide-highlight-img';
  wrap.setAttribute('data-pageguide-styled', '');
  wrap.dataset.pgCite = needle;
  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(img);
}

/**
 * Point at a citation inside the snapshot — the panel's own gesture.
 *
 * Mirrors pageguidePreviewIndex in the extension: the cited thing is scrolled into view and given
 * `.pageguide-preview-target`, which is what draws the outline and the "PageGuide highlight" badge.
 * Same class, same CSS, so it reads as the identical affordance rather than a lookalike.
 *
 * @param {boolean} sticky - true on click (stays until the next one), false on hover (transient)
 */
function focusFindCitation(frame, text, sticky = true) {
  let doc;
  try { doc = frame.contentDocument; } catch (e) { return; }
  if (!doc) return;

  const needle = normText(text).toLowerCase();
  const marks = Array.from(doc.querySelectorAll('[data-pageguide-styled]'));

  // EXACT FIRST. One citation's text is often a substring of another's: "El pedante" is the play,
  // and it also appears inside "Title page engraving from Francesco Belo's El pedante (1538)". A
  // substring search in document order therefore sent the chip for the play to the picture of its
  // title page — the wrong evidence, pointed at confidently. Each mark records the exact quote it
  // was created for, so that is what is matched on before anything looser is tried.
  const target = bestCitationFocusTarget(marks, needle);
  if (!target) return;

  clearFindFocus(doc);
  target.classList.add('pageguide-preview-target');
  // block:'start', not 'center'. A cited engraving is often taller than the frame, and centring a
  // tall element puts its TOP off-screen — which is precisely where the "PageGuide highlight" badge
  // sits, so the label naming the thing would be the one part scrolled out of view. 'start' plus
  // the 90px scroll-margin in the injected CSS leaves exactly enough room above it for the badge.
  // NO SMOOTH BEHAVIOUR. Inside a srcdoc iframe, scrollIntoView({behavior:'smooth'}) silently does
  // nothing at all — measured: 0px moved with smooth, 394px with the default. It fails without an
  // error, so the chip appears to do nothing and the citation is never reached. An instant jump
  // that works beats an animation that does not.
  if (sticky) target.scrollIntoView({ block: 'start' });
}

function bestCitationFocusTarget(marks, needle) {
  const probe = needle.slice(0, 40);
  const candidates = [];
  marks.forEach(el => {
    const cite = normText(el.dataset.pgCite).toLowerCase();
    const text = normText(el.textContent).toLowerCase();
    if (cite === needle) candidates.push({ el, rank: 0, len: text.length || cite.length });
    else if (cite && cite.includes(probe)) candidates.push({ el, rank: 1, len: text.length || cite.length });
    else if (probe && text.includes(probe)) candidates.push({ el, rank: 2, len: text.length });
  });
  candidates.sort((a, b) => a.rank - b.rank || a.len - b.len);
  return candidates[0]?.el || null;
}

function focusEvidenceItem(frame, item) {
  let doc;
  try { doc = frame.contentDocument; } catch (e) { return; }
  if (!doc) return;
  const key = String(item?.key || '');
  const text = normText(item?.source_text || item?.source_anchor?.quote || '').toLowerCase();
  const marks = Array.from(doc.querySelectorAll('[data-pageguide-styled]'));
  const target = marks.find(el => String(el.dataset.pgEvidenceKey || '') === key)
    || (text ? marks.find(el => normText(el.dataset.pgCite).toLowerCase() === text) : null)
    || (text ? marks.find(el => normText(el.textContent).toLowerCase().includes(text.slice(0, 40))) : null);
  if (!target) return;
  clearFindFocus(doc);
  target.classList.add('pageguide-preview-target');
  target.scrollIntoView({ block: 'start' });
}

/** Only one thing is ever pointed at, so the badge cannot appear twice at once. */
function clearFindFocus(doc) {
  if (!doc) return;
  doc.querySelectorAll('.pageguide-preview-target')
    .forEach(el => el.classList.remove('pageguide-preview-target'));
}

/** Wrap the first occurrence of `needle` in a highlight. Returns whether it matched. */
function markText(doc, needle, root = doc.body) {
  const walker = doc.createTreeWalker(root || doc.body, NodeFilter.SHOW_TEXT);
  const target = normText(needle).toLowerCase();
  let node;
  while ((node = walker.nextNode())) {
    // Search the NORMALIZED text, but a Range needs RAW offsets — normTextWithMap keeps the two in
    // sync (see its comment) so the wrap lands on the actual quote instead of drifting onto
    // whatever the raw text happens to have at that character count.
    const { text: normed, map } = normTextWithMap(node.nodeValue);
    const hit = normed.toLowerCase().indexOf(target);
    if (hit < 0 || !target.length) continue;
    const range = doc.createRange();
    range.setStart(node, map[hit]);
    range.setEnd(node, map[hit + target.length - 1] + 1);
    const mark = doc.createElement('span');
    mark.className = 'pageguide-highlight';
    mark.setAttribute('data-pageguide-styled', '');
    mark.dataset.pgCite = needle;
    try { range.surroundContents(mark); } catch (e) { return null; }  // spans elements: leave it
    // The MARK is returned, not just success: a sibling citation with the same index needs the
    // element this landed in, so it can reuse it rather than searching again for its own wording.
    // Still truthy, so callers that only asked "did it match?" are unaffected.
    return mark;
  }
  return null;
}

/**
 * Flatten every text node under `root` into one string, mapping each character back to the
 * (node, offset) that produced it — the same idea as normTextWithMap, extended across an entire
 * subtree instead of one text node. Mirrors _pgFlattenTextWithMap in the extension's
 * content/functions/highlight.js; the two must agree, or a locator anchored on the live page and a
 * mark drawn from it here would disagree about which characters the quote covers.
 */
function flattenSubtreeWithMap(root) {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  const map = [];
  let node;
  let inWhitespaceRun = false;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('[data-pageguide-styled]')) continue;
    const value = node.nodeValue || '';
    for (let i = 0; i < value.length; i++) {
      let ch = value[i];
      if (ch === '‘' || ch === '’') ch = "'";
      else if (ch === '“' || ch === '”') ch = '"';
      else if (ch === ' ') ch = ' ';
      if (/\s/.test(ch)) {
        if (inWhitespaceRun) continue;
        inWhitespaceRun = true;
        ch = ' ';
      } else {
        inWhitespaceRun = false;
      }
      text += ch;
      map.push({ node, offset: i });
    }
  }
  return { text, map };
}

/**
 * Wrap `needle` inside `root` even when it spans SIBLING text nodes separated by an inline tag —
 * markText only ever searches one text node, so a quote like "near aphelion and in conjunction
 * with the Sun" (which crosses the <a>aphelion</a> and <a>conjunction</a> links) matches nothing
 * there. Without this, markCitationElement's only remaining move was markElement — tinting the
 * WHOLE resolved element, which for a snapshot's paragraph is not one sentence but the entire
 * paragraph, visually swallowing any other citation already precisely highlighted inside it.
 */
function markTextAcrossNodes(root, needle) {
  if (!root) return null;
  const target = normText(needle).toLowerCase();
  if (!target) return null;
  const { text, map } = flattenSubtreeWithMap(root);
  if (!map.length) return null;
  const hit = text.toLowerCase().indexOf(target);
  if (hit < 0) return null;
  const doc = root.ownerDocument || document;

  // ONE WRAP PER TEXT NODE, not one Range around the lot.
  //
  // This function exists for quotes that cross an inline tag, and it used to build a single Range
  // over the whole phrase and call surroundContents on it — which throws InvalidStateError for
  // exactly that case, because such a range partially selects the element it crosses. So the one
  // function written to handle spanning quotes failed on every spanning quote, silently, and the
  // caller fell back to tinting the whole paragraph. "he opposes <span>Snape</span>" is the shape:
  // the phrase ends inside a sibling element, so nothing was ever marked and there was no keyword
  // for the reviewer to see.
  //
  // Splitting the hit into one run per text node gives each wrap a range that lies wholly inside a
  // single Text node, which surroundContents accepts. The phrase ends up as several adjacent marks
  // that read as one highlight.
  const runs = [];
  for (let i = hit; i < hit + target.length; i++) {
    const pos = map[i];
    if (!pos) return null;
    const last = runs[runs.length - 1];
    // `>=` rather than `===`: normText collapses runs of whitespace, so two kept characters in the
    // same node can sit either side of a gap. Covering the gap keeps the mark contiguous instead of
    // striping the phrase with unhighlighted spaces.
    if (last && last.node === pos.node && pos.offset >= last.end) last.end = pos.offset + 1;
    else runs.push({ node: pos.node, start: pos.offset, end: pos.offset + 1 });
  }

  // BACK TO FRONT. Wrapping splits the text node it lands in, so doing the later runs first leaves
  // every earlier offset still pointing where it did when the map was built.
  let firstMark = null;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    const range = doc.createRange();
    try {
      range.setStart(run.node, run.start);
      range.setEnd(run.node, run.end);
    } catch (e) { continue; }
    const mark = doc.createElement('span');
    mark.className = 'pageguide-highlight';
    mark.setAttribute('data-pageguide-styled', '');
    mark.dataset.pgCite = needle;
    try { range.surroundContents(mark); } catch (e) { continue; }
    firstMark = mark;
  }
  // The first mark in document order — the loop runs backwards, so the last one assigned is runs[0].
  // Callers use it to scroll to the quote and to reuse the element for a sibling citation.
  return firstMark;
}

/**
 * The saved evidence crop, full size.
 *
 * Mirrors openMemoryShotLightbox in the panel: the picture, what it was saved as, and the note that
 * says why it backs the claim. An evidence marker whose crop never made it says so rather than
 * opening an empty box — a chip that does nothing reads as broken, not as empty.
 */
function openEvidenceLightbox(item, key) {
  document.getElementById('find-ev-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'find-ev-lightbox';
  overlay.className = 'ev-lightbox';
  const textEvidence = normText(item?.source_text || item?.source_anchor?.quote || '');
  overlay.innerHTML = `
    <div class="ev-dialog" role="dialog" aria-modal="true" aria-label="Saved evidence">
      <div class="ev-head">
        <span>📎 Saved evidence${key ? ` — ${esc(key)}` : ''}</span>
        <button type="button" class="ev-close" aria-label="Close">×</button>
      </div>
      ${item?.shot
        ? `<img src="data:image/jpeg;base64,${item.shot}" alt="${esc(item.note || key || 'evidence')}">`
        : textEvidence
          ? `<blockquote class="ev-quote">${esc(textEvidence)}</blockquote>`
          : '<p class="ev-empty">No image or text span was saved with this evidence.</p>'}
      ${item?.note ? `<div class="ev-note">${esc(item.note)}</div>` : ''}
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.ev-close')) overlay.remove();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(overlay);
}

/** Minimal escaping for the Find preview; the stimulus pane has its own for the guide half. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function downloadJSON(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Stepping through a test run ──────────────────────────────────────────────────────────────────
// WHY THIS IS NOT THE ADMIN REVIEW NAV. Review mode renders its Prev/Next inside the question pane,
// which it owns — it draws no questions and no timer, so there is room. A test run is the real
// study: the pane belongs to the instrument, is rebuilt on every task, and a button inside it would
// be wiped by the next render and would sit among the questions being rehearsed. So this is a bar
// of its own, fixed and outside both panes, exactly like the walkthrough's.
//
// GOING BACK THROWS THE ANSWER AWAY. Nothing here is written, so the only copy of a test answer is
// the row in `results`, and re-answering task 3 after stepping back to it would leave two rows for
// task 3 in the download. Truncating to the task being returned to keeps `results` reading as what
// it is: the answers to tasks 1..idx.

let dryNav = null;

function dryRunNavLabel() {
  const { queue, idx } = S.state;
  const total = Array.isArray(queue) ? queue.length : 0;
  if (idx >= total) return 'Test run · finished';
  const task = queue[idx];
  const type = task?.taskType === 'find' ? 'Find' : 'Guide';
  const arm = S.taskArm ? S.taskArm(task) : '';
  return `Test run · Task ${idx + 1} of ${total} · ${type}${arm ? ` · ${arm}` : ''}`;
}

function renderDryRunNav() {
  const { queue, idx } = S.state;
  const total = Array.isArray(queue) ? queue.length : 0;
  // Not during the walkthrough: it has a bar of its own, in the same place, saying where in the
  // practice you are. Two of them would disagree about what "Task 1" means.
  if (!S.state.dryRun || S.state.tutorial?.active || !total) return removeDryRunNav();
  if (!dryNav) {
    dryNav = document.createElement('div');
    dryNav.className = 'dry-nav';
    document.body.appendChild(dryNav);
  }
  dryNav.innerHTML = `
    <span class="dry-nav-dot" aria-hidden="true"></span>
    <span class="dry-nav-label">${esc(dryRunNavLabel())}</span>
    <button type="button" class="dry-nav-btn" id="dry-prev" title="The task before this one"
      ${idx === 0 ? 'disabled' : ''}>‹</button>
    <button type="button" class="dry-nav-btn" id="dry-next" title="Skip to the next task"
      ${idx >= total ? 'disabled' : ''}>›</button>`;
  document.getElementById('dry-prev').onclick = () => goDryRunTask(S.state.idx - 1);
  document.getElementById('dry-next').onclick = () => goDryRunTask(S.state.idx + 1);
}

function goDryRunTask(next) {
  const total = (S.state.queue || []).length;
  const idx = Math.max(0, Math.min(total, next));
  S.state.idx = idx;
  // Forward past an unanswered task leaves `results` alone — it is already shorter than idx, and a
  // skipped task simply has no row. Back trims, so the answer being redone is not counted twice.
  if (S.state.results.length > idx) S.state.results = S.state.results.slice(0, idx);
  S.saveLocal();
  showTask();
}

function removeDryRunNav() {
  dryNav?.remove();
  dryNav = null;
}

/** Prev/Next/Exit, for paging through the material without answering anything. */
/**
 * ← → across the queue, for an `admin` dry run only.
 *
 * A researcher checking what a slot actually deals needs to go BACKWARDS and to skip a task without
 * answering it — neither of which the study allows, and rightly: a participant gets one pass and a
 * three-minute cutoff, and a screen that let them wander would not be measuring the same thing.
 *
 * So this appears for the `admin` id and nothing else. `test` deliberately does not get it: a test
 * run exists to rehearse the real flow, and a rehearsal with extra buttons is not one. Neither id
 * writes a session or a result row — see StudySession.isDryRunId.
 */
function previewNavHtml() {
  if (!S.state.previewNav || S.state.adminReview) return '';
  const queue = Array.isArray(S.state.queue) ? S.state.queue : [];
  const here = queue[S.state.idx];
  const kind = here?.taskType === 'guide' ? 'Guide' : 'Find';
  return `
    <div class="preview-nav">
      <span class="preview-nav-label">Admin preview · ${esc(kind)} ${S.state.idx + 1} of ${queue.length}
        · nothing is recorded</span>
      <div class="preview-nav-buttons">
        <button type="button" class="q-btn" id="preview-prev"${S.state.idx === 0 ? ' disabled' : ''}>←</button>
        <button type="button" class="q-btn" id="preview-next"${
          S.state.idx >= queue.length - 1 ? ' disabled' : ''}>→</button>
      </div>
    </div>`;
}

/**
 * Move without answering. The task's own interval is torn down first — showTask builds a new one,
 * and two live clocks would both tick the same pane.
 */
function bindPreviewNav() {
  if (!S.state.previewNav || S.state.adminReview) return;
  const go = (delta) => {
    const queue = Array.isArray(S.state.queue) ? S.state.queue : [];
    const next = S.state.idx + delta;
    if (next < 0 || next >= queue.length) return;
    try { S.state.detachInstrument?.(); } catch (e) { /* already gone */ }
    S.state.detachInstrument = null;
    S.state.idx = next;
    showTask();
  };
  const prev = document.getElementById('preview-prev');
  const next = document.getElementById('preview-next');
  if (prev) prev.onclick = () => go(-1);
  if (next) next.onclick = () => go(1);
}

function adminNavHtml() {
  if (!S.state.adminReview) return '';
  const queue = Array.isArray(S.state.queue) ? S.state.queue : [];
  const here = queue[S.state.idx];
  return `
    ${here && here.inStudy !== true ? `<p class="admin-held-out">Held out of the study —
      no participant is dealt this one. Reviewing it changes nothing; use <b>Edit Find task</b> or
      <b>Edit trajectory</b> to put it back.</p>` : ''}
    <label class="admin-task-jump">
      <span>Jump to task</span>
      <select id="admin-task-jump">
        ${queue.map((task, i) => `
          <option value="${i}"${i === S.state.idx ? ' selected' : ''}>
            ${esc(adminTaskLabel(task, i, queue.length))}
          </option>`).join('')}
      </select>
    </label>
    <div class="q-actions">
      <button class="q-btn" id="admin-prev"${S.state.idx === 0 ? ' disabled' : ''}>← Prev</button>
      <button class="q-btn q-btn-primary" id="admin-next">Next →</button>
    </div>
    <div class="q-actions"><button class="q-btn" id="admin-quit">Leave review</button></div>`;
}

function bindAdminNav() {
  if (!S.state.adminReview) return;
  const jump = document.getElementById('admin-task-jump');
  const prev = document.getElementById('admin-prev');
  const next = document.getElementById('admin-next');
  const quit = document.getElementById('admin-quit');
  if (jump) jump.onchange = () => {
    const idx = Number(jump.value);
    if (!Number.isFinite(idx)) return;
    S.state.idx = Math.max(0, Math.min((S.state.queue || []).length - 1, idx));
    S.saveReview();
    showTask();
  };
  if (prev) prev.onclick = () => { S.state.idx = Math.max(0, S.state.idx - 1); S.saveReview(); showTask(); };
  if (next) next.onclick = () => { S.state.idx++; S.saveReview(); showTask(); };
  if (quit) quit.onclick = () => { S.clearReview(); location.href = 'find-v1.html'; };
}

/**
 * What a task is called in the jump list.
 *
 * THE QUESTION, not just the id. A Find task's id carries a hint of its content ("MUFC-V1-TEXT"),
 * but a guide id is a timestamp and a random suffix — `gv2-ed05972e-i5fi3b` says nothing about which
 * run it is, so finding a particular task meant opening them one at a time. The goal is the thing a
 * reviewer is actually looking for, so it goes in the label; the id stays because it is what the
 * editor and the database call it.
 */
function adminTaskLabel(task, i, total) {
  const id = task?.id || `Task ${i + 1}`;
  const type = task?.taskType === 'find' ? 'Find' : 'Guide';
  const question = String(task?.question || task?.goal || task?.title || '').replace(/\s+/g, ' ').trim();
  const short = question.length > 70 ? `${question.slice(0, 69)}…` : question;
  // Which pool it came from, in the dropdown itself: a review queue can now mix live and held-out
  // stimuli, and once the walkthrough starts the two are indistinguishable.
  const pool = task?.inStudy === true ? '' : ' · HELD OUT';
  return `${i + 1}/${total} · ${type} · ${id}${pool}${short ? ` — ${short}` : ''}`;
}

/**
 * The two post-task questions, asked after every submitted task.
 *
 * Kept on the same screen rather than a page of their own: they are about the task just finished,
 * and a participant who has navigated away from it is answering from memory.
 */
function askPostQuestions(task, record, timings) {
  questionPane.innerHTML = postTaskQuestionsHtml('q-done');

  document.getElementById('q-done').onclick = async () => {
    const done = document.getElementById('q-done');
    if (done.dataset.submitted === 'true') return;
    const conf = questionPane.querySelector('input[name="q-conf"]:checked');
    const help = questionPane.querySelector('input[name="q-help"]:checked');
    const err = document.getElementById('q-error-msg');
    if (!conf || !help) {
      window.QForm.clearMissing(questionPane);
      window.QForm.flagMissing([conf ? null : document.getElementById('q-conf'),
        help ? null : document.getElementById('q-help')]);
      err.textContent = 'Please answer the highlighted question(s).';
      err.hidden = false;
      return;
    }
    done.dataset.submitted = 'true';
    done.disabled = true;

    // Practice answers stop here — see submitFindResult for why.
    if (S.state.tutorial?.active) return window.Tutorial.finishPracticeTask(task, timings);

    const row = S.buildResultRow({
      task,
      record,
      timings: Object.assign({}, timings, { interactionSummary: taskInteractionSummary() }),
      confidence: conf.value,
      helpfulness: help.value,
      notes: postTaskNotes(),
    });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();

    // ADMIN REVIEW WRITES NOTHING. A reviewer clicking through sixteen tasks to check wording would
    // otherwise leave sixteen rows indistinguishable from a participant who answered impossibly
    // fast, and no column would say otherwise.
    if (S.state.adminReview) {
      console.log('[admin] would have saved:', row);
    } else {
      // Written now rather than batched at the end: a participant who closes the tab three tasks in
      // should leave three rows behind, not none. A failed write keeps the local copy, which the
      // final screen can still export.
      await saveStudyResult(row);
    }

    showTask();
  };
}

/**
 * The post-study questionnaire, asked once at the very end.
 *
 * Committed here rather than in app/config.js, which is gitignored: a deployment cloned fresh would
 * lose the survey entirely and nobody would notice, because a missing final step looks exactly like
 * a finished study. A deployment that needs a different form can still override it from config
 * without touching this file.
 */
const POST_SURVEY_URL = window.STUDY_CONFIG?.POST_SURVEY_URL
  || 'https://docs.google.com/forms/d/e/1FAIpQLSforUWSqdA0imJlvaJnV_5RE0xoAV-CDDntlUpkbjr_5hYtmw/viewform';

/** The same form, told to render without Google's page chrome, for the inline frame. */
function postSurveyEmbedUrl(url) {
  return `${url}${url.includes('?') ? '&' : '?'}embedded=true`;
}

/**
 * The Find V2 questionnaire, asked once at the very end.
 *
 * ITS OWN FORM, not V1's. The two studies ask different things and their responses go to different
 * sheets; pointing V2 at V1's form would mix them with nothing in either to say which study a row
 * came from. Overridable from app/find_v2_config.js for a deployment that needs a different one.
 *
 * THE LONG URL, NOT THE forms.gle SHORT LINK it was given as. The short link is a 302 to exactly
 * this address, and a redirect does not carry a query string forward — so `?embedded=true` appended
 * to the short form would be dropped and the frame would render with Google's full page chrome
 * inside it. Resolved once, here, rather than at load in every participant's browser.
 */
const FIND_V2_SURVEY_URL = window.FIND_V2_CONFIG?.POST_SURVEY_URL
  || 'https://docs.google.com/forms/d/e/1FAIpQLSejro1c_gTdmCpBgjeDosaAilNviUkxVXlOW8l_2dW9CwuN5w/viewform';

/** Find V2's own ending: the same two panes, with the questionnaire where the material was. */
function finishFindV2({ preview = false } = {}) {
  const pending = preview ? 0 : pendingResultCount();
  const answered = preview
    ? (Array.isArray(S.state.queue) ? S.state.queue.length : 0)
    : S.state.results.length;
  const dry = !!S.state.dryRun;

  // A REHEARSAL MUST NOT BE ABLE TO SUBMIT THE REAL FORM. The questionnaire is live, and a response
  // sent from a test run, a review walk or a preview of this screen is a row in the sheet that
  // nothing marks as not-a-participant — and it cannot be told apart afterwards. Those three get the
  // LINK, so the form can still be read, and no frame to submit from. This is the same rule V1's
  // finish() follows, for the same reason.
  const review = !preview && (!!S.state.adminReview || dry);
  const linkOnly = preview || review;

  const surveyHead = `
    ${preview ? `<p class="q-survey-preview">Preview of the final screen — the form linked below is
      the REAL questionnaire. Read it, do not submit it.</p>` : ''}
    ${review ? `<p class="q-survey-preview">${dry
      ? 'Test run — nothing you answered was saved. The questionnaire below is the real one: do not submit it.'
      : 'Review mode — the questionnaire below is the real one: do not submit it.'}</p>` : ''}
    <header class="q-survey-head">
      <p class="welcome-eyebrow">PageGuide · Find V2</p>
      <h1 class="q-survey-title">✅ Last step — a short survey</h1>
      <p class="q-survey-lead">You checked ${answered} agent claim${answered === 1 ? '' : 's'}. Thank
        you. Please fill in the questionnaire ${linkOnly ? 'linked below' : 'below'} to complete the
        study — it is the last thing we need from you.</p>
      <a class="q-btn q-btn-primary q-btn-link q-survey-open" href="${esc(FIND_V2_SURVEY_URL)}"
        target="_blank" rel="noopener noreferrer">Open the survey in a new tab ↗</a>
    </header>`;

  stimulusPane.innerHTML = linkOnly
    ? `<div class="q-survey-stage find-v2-finish">${surveyHead}
        <div class="tv-done">${dry
          ? 'Test run: nothing from it was saved, and the survey is not embedded so this screen cannot leave a real response. Use the button above to read it.'
          : 'The survey is not embedded here, so checking this screen cannot leave a real response. Use the button above to read it.'}</div>
      </div>`
    : `<div class="q-survey-stage">${surveyHead}
        <iframe class="q-survey" title="Post-study questionnaire"
          src="${esc(postSurveyEmbedUrl(FIND_V2_SURVEY_URL))}"></iframe>
      </div>`;

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">✅ All done</span></div>
    <div class="q-body">
      ${pending ? `<p class="q-error-msg">${pending} result${pending === 1 ? '' : 's'} did not reach
        Supabase. Download the backup below and send it to the researcher.</p>` : ''}
      <p class="q-sub">${linkOnly
        ? 'Participants see the questionnaire in the left pane.'
        : 'Your judgments were saved after each claim. Once you have submitted the form on the left you can close this tab.'}</p>
      <p class="q-sub">Find V2 is stored separately from the original PageGuide study.</p>
      <div class="q-actions">
        <button class="q-btn" id="q-download">⬇ Download my Find V2 responses</button>
        <a class="q-btn q-btn-link" href="index.html">Return to Find V2</a>
      </div>
    </div>`;

  document.getElementById('q-download').onclick = () => {
    const blob = new Blob([JSON.stringify({
      study_version: 'find-v2',
      participant_id: S.state.participantId,
      session_id: S.state.sessionId,
      results: S.state.results,
      pending_results: pendingResultsForCurrentRun(),
    }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `find_v2_${S.state.participantId || 'anonymous'}_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (!preview) S.clearLocal();
}

/**
 * The end of the study — and, with `{ preview: true }`, the same screen opened on its own.
 *
 * A PREVIEW MUST NOT TOUCH A RUN. It is reached by URL, which means it can be opened in a tab where
 * a participant is midway through the real study, so it clears no local state and writes nothing;
 * the only difference it makes to the page is what is drawn on it.
 */
function finish({ preview = false } = {}) {
  detachQuestionPane();
  stopTaskTelemetry();
  if (IS_FIND_V2) return finishFindV2({ preview });
  // Kept on the final screen, with only ‹ live: a test run that reaches the end and finds no way
  // back to task 8 has to be restarted from the welcome screen to look at it again.
  if (!preview) renderDryRunNav();
  const pending = preview ? 0 : pendingResultCount();
  // In a preview there are no results to count, and "you have finished all 0 tasks" reads as a bug
  // in the screen being checked. The queue length is what a real run would have shown.
  const answered = preview
    ? (Array.isArray(S.state.queue) && S.state.queue.length) || 8
    : S.state.results.length;
  // A REVIEW WALK ends here incidentally, and an embedded live form at the end of it is one scroll
  // from a response that nothing marks as not-a-participant — so the walk gets the link only. A
  // PREVIEW is the opposite: it was opened to look at this screen, so it shows the real thing, with
  // a banner saying not to submit it.
  // A DRY RUN GETS THE LINK, NOT THE FORM, for the same reason a review walk does: the questionnaire
  // is live, and a real response submitted from a rehearsal is a row in the survey that nothing
  // marks as not-a-participant. The banner above it says which kind of run this was.
  const review = !preview && (!!S.state.adminReview || !!S.state.dryRun);

  // THE SURVEY GOES IN THE LEFT PANE, where the material was. The right pane is 420px wide because
  // it stands in for the extension's side panel, and a Likert grid folded into 420px is a column of
  // wrapped radio labels nobody can compare across. The left pane is the width the study spent on
  // things that have to be READ, and by this screen there is no material left to put in it.
  // The heading rides ABOVE the frame rather than only in the right pane. What a participant looks
  // at on this screen is the left pane — it is where every task put the thing to do — and an
  // instruction they have to find in the other column is one they read after wondering why the
  // study is showing them a Google form.
  const surveyHead = `
    ${preview ? `<p class="q-survey-preview">Preview of the final screen — the form below is the
      REAL questionnaire. Read it, do not submit it.</p>` : ''}
    ${!preview && S.state.dryRun ? `<p class="q-survey-preview">Test run — none of these eight
      answers was saved. The questionnaire linked below is the real one: do not submit it.</p>` : ''}
    <header class="q-survey-head">
      <h1 class="q-survey-title">✅ Last step — a short survey</h1>
      <p class="q-survey-lead">You have finished all ${answered} tasks. Thank you.
        Please fill in the questionnaire below to complete the study — it is the last thing we need
        from you.</p>
      <a class="q-btn q-btn-primary q-btn-link q-survey-open" href="${esc(POST_SURVEY_URL)}"
        target="_blank" rel="noopener noreferrer">Open the survey in a new tab ↗</a>
    </header>`;

  stimulusPane.innerHTML = review
    ? `<div class="q-survey-stage">${surveyHead}
        <div class="tv-done">${S.state.dryRun && !S.state.adminReview
          ? `Test run: nothing from it was saved, and the survey is not embedded so this screen
             cannot leave a real response. Use the button above to read it.`
          : `Review mode: the survey is not embedded, so checking this screen
             cannot leave a real response. Use the button above to read it.`}</div>
      </div>`
    : `<div class="q-survey-stage">${surveyHead}
        <iframe class="q-survey" title="Post-study questionnaire"
          src="${esc(postSurveyEmbedUrl(POST_SURVEY_URL))}"></iframe>
      </div>`;

  // The right pane stops carrying the instruction and keeps only what the left one should not: the
  // warning about writes that did not land, and the export that answers it. Saying the same thing in
  // both columns would make the participant read the screen twice to find out it said one thing.
  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">✅ All done</span></div>
    <div class="q-body">
      ${pending ? `<p class="q-error-msg">Some task results did not reach the database yet (${pending}). Use the download button and send the file to the researcher.</p>` : ''}
      <p class="q-sub">${review
        ? 'Participants see the questionnaire in the left pane.'
        : 'Once you have submitted the form on the left you can close this tab.'}</p>
      <div class="q-actions">
        <button class="q-btn" id="q-download">⬇ Download my responses</button>
      </div>
      ${preview ? '<div class="q-actions"><a class="q-btn q-btn-link" href="find-v1.html">← Back to admin</a></div>' : ''}
    </div>`;

  document.getElementById('q-download').onclick = () => {
    const pendingRows = pendingResultsForCurrentRun();
    const blob = new Blob([JSON.stringify({
      participant_id: S.state.participantId,
      session_id: S.state.sessionId,
      results: S.state.results,
      pending_results: Array.isArray(pendingRows) ? pendingRows : [],
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study_${S.state.participantId || 'anon'}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // A preview clears nothing: it can be opened in a tab where somebody is midway through the real
  // study, and wiping their local run to look at a screen would end their session.
  if (!window.STUDY_SOURCE && !preview) S.clearLocal();
}

boot();
