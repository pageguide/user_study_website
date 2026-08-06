// The task screen driver: walk the queue, one trajectory at a time.
//
// Fetches each trajectory only when it is reached. The list query deliberately omits `arms` — a
// nine-step run carries ~1.5MB of base64 screenshots, so pulling the whole bank up front to build a
// queue would cost tens of megabytes before the first question is on screen.

const stimulusPane = document.getElementById('stimulus-pane');
const questionPane = document.getElementById('question-pane');
const S = window.StudySession;
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
    started_at: Date.now(),
  };
  const cleanups = [];
  const scrollTimers = new WeakMap();
  const onScroll = (target) => {
    if (!target) return;
    if (!scrollTimers.has(target)) summary.scroll_count++;
    clearTimeout(scrollTimers.get(target));
    scrollTimers.set(target, setTimeout(() => scrollTimers.delete(target), 500));
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
      add(doc, 'click', () => { summary.website_click_count++; }, true);
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
        active_ms: Math.max(0, Date.now() - summary.started_at),
      };
    },
    stop() {
      cleanups.splice(0).forEach(fn => {
        try { fn(); } catch (e) { /* ignore */ }
      });
    },
  };
}

function taskInteractionSummary() {
  return taskTelemetry ? taskTelemetry.snapshot() : null;
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
      note: 'no screenshots for the agent\'s steps',
      hint: 'This task deliberately shows no step screenshots: the agent\'s actions are described in '
        + 'words only, and there is nothing to hover or click. Nothing is missing or broken — that is '
        + 'the condition. The before and after pictures of the page are still shown, as they are in '
        + 'every task. Judge from what is here, and if you cannot tell what happened, say so.',
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
      note: 'no evidence is marked on the page',
      hint: 'This task deliberately marks no evidence: the agent\'s answer is text only, and nothing '
        + 'on the page is highlighted for you. Nothing is missing or broken — that is the condition. '
        + 'The page itself is still there to read. If you cannot tell what the answer was based on, '
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

// Delegated from the pane, which outlives every shell rebuild — the banner itself is re-rendered
// for each task, so binding it per render would stack listeners.
stimulusPane.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-condition-hint]');
  if (!btn) return;
  const hint = btn.parentElement.querySelector('.tv-condition-hint');
  if (!hint) return;
  hint.hidden = !hint.hidden;
  btn.setAttribute('aria-expanded', hint.hidden ? 'false' : 'true');
  btn.classList.toggle('is-open', !hint.hidden);
});

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
    location.replace('index.html');
    return;
  }
  Object.assign(S.state, saved);
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
  detachQuestionPane();
  startTaskTelemetry(task);
  const arm = S.taskArm ? S.taskArm(task) : S.conditionLabel(task?.arm || S.state.arm);
  panelMessage('<p class="q-text">Loading the next task…</p>');
  if (task.taskType === 'find') return showFindTask(task);

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
  let canned = null;
  let page = null;
  let groundTruth = null;
  try {
    canned = await dataSource(task).getCannedResponse(task.id, arm);
  } catch (e) {
    console.warn('[study] no recorded answer for', task.id, e.message);
  }
  try {
    groundTruth = await loadFindGroundTruth(task);
  } catch (e) {
    console.warn('[study] could not load ground truth for', task.id, e.message);
    groundTruth = { error: e?.message || String(e), task_id: task.id };
  }
  try {
    const source = dataSource(task);
    if (source.getTaskPage) page = await source.getTaskPage(task.id, task.url);
  } catch (e) {
    console.warn('[study] no captured page for', task.id, e.message);
  }

  const answer = canned?.answer_display || canned?.answer_raw || '';

  stimulusPane.innerHTML = `
    <header class="tv-head">
      <div class="tv-head-main">
        <div class="tv-kicker">Task</div>
        <h1 class="tv-goal">${esc(task.question || task.title || '')}</h1>
        ${conditionBannerHtml(arm, 'find')}
      </div>
    </header>
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
    const frame = document.getElementById('find-page');
    frame.srcdoc = page.html;
    frame.addEventListener('load', () => {
      taskTelemetry?.addIframe(frame);
      applyFindGrounding(frame, canned, arm);
    }, { once: true });
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
        <p class="q-text">${esc(task.question || '')}</p>
        ${answerCardHtml(answer, arm)}
        ${adminFindGroundTruthHtml(groundTruth, task)}
        ${adminGroundingReviewHtml(task, canned, arm, cites, !!page?.html)}
        <p class="q-sub">Review mode — participant answers are not recorded.</p>
        ${adminNavHtml()}
      </div>`;
    bindFindAnswerChips(canned, arm, cites);
    bindAdminGroundingReview(task, canned, arm, cites);
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
    <div class="q-card" style="margin-top:12px;">
      <div class="q-card-head"><span class="q-badge">A</span>
        <p class="q-text">The agent's answer${arm === 'nongrounding' ? ' (non-grounded)' : ''}</p></div>
      <div class="find-answer">${answer
        ? renderFindAnswer(answer, arm)
        : '<em class="q-sub">No answer was recorded for this task in this arm.</em>'}</div>
    </div>`;
}

/**
 * The participant's Find task: read the answer, pick one, then point at what supports it.
 *
 * Two stages, two timers, and no way past either without answering — see the header of
 * app/find_task.js for why both of those matter.
 */
function renderFindQuestions(task, canned, answer, arm, cites, groundTruth) {
  const { idx, queue } = S.state;
  const options = window.FindTask.answerOptions(task);
  const hops = window.FindTask.evidencePrompts(task);
  const startedAt = Date.now();
  let choiceElapsed = null;
  let supportStartedAt = null;
  let answerTimer = null;
  let supportTimer = null;
  const picked = [null, null];   // one evidence selection per hop

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">🔍 Find the answer</span></div>
    <div class="q-progress">${esc(progressText() || `Task ${idx + 1}/${queue.length}`)}</div>
    <div class="q-body">
      <div class="q-task-card">
        <div class="q-timers">
          <div class="q-timer-chip">
            <span class="q-timer-label" id="q-timer-label">Answer time</span>
            <span class="q-timer" id="q-timer">00:00</span>
          </div>
        </div>
        ${esc(task.question || '')}
      </div>

      ${answerCardHtml(answer, arm)}

      <div class="q-card">
        <div class="q-card-head"><span class="q-badge">Q1</span>
          <p class="q-text">Select the answer you found:${window.QForm.requiredMark()}</p></div>
        <div class="q-options" id="q-find-answer">
          ${options.map((opt, i) => `
            <label class="q-opt q-opt-rich">
              <input type="radio" name="q-find-answer" value="${esc(opt)}">
              <span class="q-opt-body"><span>${esc(opt)}</span></span>
            </label>`).join('')}
        </div>
      </div>

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
      </div>

      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions">
        <button class="q-btn q-btn-primary" id="q-find-next">Next →</button>
        <button class="q-btn q-btn-primary" id="q-find-submit" hidden>Submit →</button>
      </div>
    </div>`;

  bindFindAnswerChips(canned, arm, cites);

  const $q = (id) => questionPane.querySelector(`#${id}`);
  const errorEl = $q('q-error-msg');
  const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearError = () => { errorEl.hidden = true; };

  answerTimer = setInterval(() => {
    $q('q-timer').textContent = fmtClock(Date.now() - startedAt);
  }, 1000);

  // The same contract mountInstrument returns, in the same slot: whatever is mounted in the question
  // pane knows how to stop itself, and detachQuestionPane is what asks it to.
  S.state.detachInstrument = () => {
    clearInterval(answerTimer);
    clearInterval(supportTimer);
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


  questionPane.querySelectorAll('[data-pick-hop]').forEach(btn => {
    btn.dataset.idleText = btn.textContent;
    btn.onclick = () => {
      pickingHop = Number(btn.dataset.pickHop);
      const kind = hops[pickingHop].kind;
      questionPane.querySelectorAll('[data-pick-hop]').forEach(b => {
        b.classList.remove('is-picking');
        if (b.dataset.idleText) b.textContent = b.dataset.idleText;
      });
      btn.classList.add('is-picking');
      btn.textContent = kind === 'image' ? 'Click image evidence' : 'Click sentence evidence';
      startPicking(frame(), kind, (value, label) => {
        setPicked(pickingHop, value, label);
        btn.classList.remove('is-picking');
        btn.textContent = btn.dataset.idleText || 'Pick evidence';
        pickingHop = null;
      });
    };
  });

  $q('q-find-next').onclick = () => {
    window.QForm.clearMissing(questionPane);
    const sel = questionPane.querySelector('input[name="q-find-answer"]:checked');
    if (!sel) {
      window.QForm.flagMissing([$q('q-find-answer')]);
      return showError('Please answer the highlighted question: which answer did you find?');
    }
    clearError();

    choiceElapsed = Math.max(0, Date.now() - startedAt);
    supportStartedAt = Date.now();
    $q('q-support-stage').hidden = false;
    $q('q-find-next').hidden = true;
    $q('q-find-submit').hidden = false;
    clearInterval(answerTimer); answerTimer = null;
    $q('q-timer-label').textContent = 'Evidence time';
    $q('q-timer').textContent = '00:00';
    supportTimer = setInterval(() => {
      $q('q-timer').textContent = fmtClock(Date.now() - supportStartedAt);
    }, 1000);
    $q('q-support-stage').scrollIntoView({ block: 'nearest' });
  };

  $q('q-find-submit').onclick = async () => {
    // EVERY hop, not just one. A half-answered pair cannot be reconstructed afterwards, and a
    // participant who could submit with one blank would do it without noticing.
    window.QForm.clearMissing(questionPane);
    const blanks = picked.map((v, i) => (v ? null : $q(`q-hop-card-${i}`)));
    const missing = picked.findIndex(v => !v);
    if (missing >= 0) {
      window.QForm.flagMissing(blanks);
      return showError(`Please answer the highlighted question — ${hops[missing].kind === 'image'
        ? 'pick the image in the page' : 'pick the passage in the page'}.`);
    }
    clearError();

    clearInterval(answerTimer);
    clearInterval(supportTimer);
    stopPicking(frame());

    const sel = questionPane.querySelector('input[name="q-find-answer"]:checked');
    await submitFindResult(task, {
      answer: sel.value,
      answerElapsed: Math.max(0, Date.now() - startedAt),
      answerChoiceMs: choiceElapsed,
      findSupportingMs: supportStartedAt == null ? null : Math.max(0, Date.now() - supportStartedAt),
      evidenceResponses: picked.map((v, i) => ({ hop: i + 1, prompt: hops[i].prompt, kind: hops[i].kind, ...v })),
      findScores: scoreFindEvidence(picked, groundTruth),
      interactionSummary: taskInteractionSummary(),
    });
  };

  window.Tutorial?.onTaskRendered(task);
}

function normalizeEvidenceText(value) {
  return cleanEvidenceSentenceText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanEvidenceSentenceText(value) {
  return String(value || '')
    .replace(/\[\s*(?:[a-z]+)?\d+\s*\]/gi, ' ')
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

/** mm:ss, matching the extension's clock. */
function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Let the participant click something inside the snapshot.
 *
 * Hover outlines what would be picked and a click takes it. Paragraph picking walks up to the
 * nearest block so a click on one word selects the sentence it is in rather than the word — the
 * question asks which passage, and a one-word answer could not be scored against a ground truth
 * written as sentences.
 */
function startPicking(frame, kind, onPick) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;
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

  const over = (e) => {
    const el = kind === 'image' ? e.target.closest?.(SEL) : e.target.closest?.('td, th');
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
  const click = (e) => {
    const sentenceHit = kind === 'image' ? null : e.target.closest?.('.pg-pick-sentence-hit');
    const pickedFromHit = sentenceHit?.__pgPickSentence || null;
    const el = kind === 'image'
      ? e.target.closest?.(SEL)
      : (pickedFromHit?.block || e.target.closest?.(SEL));
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    clearPickedPassage(doc);
    el.classList.remove('pg-pickable', 'pg-pickable-text');
    hovered = null;
    const pickedPassage = kind === 'image' ? null : (pickedFromHit || tableCellPick(el) || sentencePickFromClick(doc, el, e.clientX, e.clientY));
    if (kind !== 'image' && !pickedPassage?.range && !pickedPassage?.cell) {
      return;
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

function buildCitationAnchor(el, index, quote) {
  const tag = el.tagName;
  const text = anchorTextOf(el);
  return {
    index,
    quote,
    tag,
    text,
    ordinal: citationAnchorOrdinal(el, tag, text),
    truncated: semanticTextOf(el).length > PG_ANCHOR_TEXT_MAX,
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

/** Record the Find result, then move on. Mirrors the guide half's post-task questions. */
async function submitFindResult(task, payload) {
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

    // A practice task is answered in full — including these two, which are asked after every real
    // task — and then goes nowhere: no row, no push, no idx++.
    if (S.state.tutorial?.active) return window.Tutorial.finishPracticeTask(task, payload);

    const row = S.buildFindResultRow({
      task, payload, confidence: conf.value, helpfulness: help.value, notes: postTaskNotes(),
    });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();
    await saveStudyResult(row);
    showTask();
  };
}

const RESULT_BACKUP_KEY = 'pageguide_web_pending_results';

async function saveStudyResult(row) {
  // Belt and braces on the tutorial: the practice paths already return before building a row, and a
  // practice answer that reached study_task_results_v2 would be indistinguishable from a real one.
  if (window.STUDY_SOURCE || S.state.adminReview || S.state.tutorial?.active) {
    return { ok: true, skipped: true };
  }
  try {
    const saved = await DB.insertStudyResult(row);
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
    };
  }

  questionPane.querySelectorAll('.find-ev').forEach(chip => {
    chip.onclick = () => {
      const item = (canned?.evidence || [])
        .find(ev => String(ev?.key || '').trim().toLowerCase() === chip.dataset.evKey.trim().toLowerCase());
      const f = document.getElementById('find-page');
      if (f && item?.source_kind === 'text') focusEvidenceItem(f, item);
      openEvidenceLightbox(item, chip.dataset.evKey);
    };
  });

  // Hover names it, click goes to it — the two gestures the panel already gives a citation.
  questionPane.querySelectorAll('.find-cite').forEach(chip => {
    const frame = () => document.getElementById('find-page');
    chip.onmouseenter = () => {
      const f = frame();
      if (f) focusFindCitation(f, chip.dataset.citeText || '', false);
      chip.classList.add('find-cite-active');
    };
    chip.onmouseleave = () => {
      const f = frame();
      if (!chip.dataset.pinned) chip.classList.remove('find-cite-active');
      try { if (f && !chip.dataset.pinned) clearFindFocus(f.contentDocument); } catch (e) {}
    };
    chip.onclick = () => {
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
  const out = [];
  String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (m, index, text) => {
    out.push({ index: Number(index), text });
    return m;
  });
  return out;
}

function linkedFindEvidence(answer, evidence) {
  const linked = new Set();
  String(answer || '').replace(/\[ev:([^\]]+)\]/g, (m, key) => {
    const clean = String(key || '').trim();
    if (clean) linked.add(clean);
    return m;
  });
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
  const raw = String(answer || '');
  if (arm === 'nongrounding') {
    return renderMarkdown(esc(window.stripNonGroundingMarkers
      ? window.stripNonGroundingMarkers(raw)
      : raw.replace(/\[\d+:"[^"]*"\]/g, '').replace(/\s*\[ev:[^\]]+\]/g, '').replace(/\s+([.,;:!?])/g, '$1')));
  }

  let n = 0;
  let e = 0;
  const withChips = esc(raw)
    // The extension's own markup (parseCitations, sidepanel/panel.js): the cited PHRASE, then a
    // superscript index. The phrase is hidden until the answer is expanded — that is what clicking
    // an answer does in the panel, and it is why a citation reads as "[1]" until asked.
    // esc() has already turned the quotes into &quot;, so the pattern matches the escaped form.
    .replace(/\[(\d+):&quot;([\s\S]*?)&quot;\]/g, (m, index, text) => {
      n++;
      return `<span class="find-cite" data-cite-text="${text}" data-cite-n="${n}"
        title="Show this on the page"
        ><span class="citation-text">${text}</span><sup class="citation-index">[${n}]</sup></span>`;
    })
    // [ev:key] is SAVED VISUAL EVIDENCE: a crop of the region the claim rests on, taken at record
    // time. Its `note` is a description rather than a quotation, so it cannot be found in the page
    // by text — the crop itself is the evidence, and opening it is the only thing that reliably
    // shows what was meant. Rendered as its own numbered series, so it is not mistaken for a
    // citation into the page.
    .replace(/\[ev:([^\]]+)\]/g, (m, key) => {
      e++;
      return `<button type="button" class="find-ev" data-ev-key="${key}"
        title="Open the saved evidence for this claim">📎<sup class="citation-index">[E${e}]</sup></button>`;
    });

  return renderMarkdown(withChips);
}

/**
 * The markdown an answer is written in, as the panel renders it.
 *
 * An agent's answer contains **bold** — "the planet name … is **Jupiter**" — and shown raw those
 * asterisks are visible noise in the middle of the sentence a participant is being asked to judge.
 * Bold first, then single-asterisk italics, in that order: doing italics first would eat one
 * asterisk from every pair and turn **Jupiter** into *Jupiter*.
 *
 * Runs on ALREADY-ESCAPED text, so the only tags in the result are the ones added here.
 */
function renderMarkdown(escaped) {
  return String(escaped || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
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
    if (w < 100 || h < 100) return false;
    return !NOISE.test(`${img.getAttribute('src') || ''} ${img.getAttribute('alt') || ''} ${img.className || ''}`);
  });

  const skipped = [];
  items.forEach(item => {
    const id = String(item.source_image_id || '');

    // VIEWPORT EVIDENCE CANNOT BE PLACED, and must not be guessed at.
    //
    // Its bbox is a fraction of the browser viewport at record time, offset into DOCUMENT space
    // (gv2EvidenceDocRect, content/functions/highlight.js) — not a fraction of any image. The
    // snapshot reflows at a different width, so those coordinates point somewhere else entirely.
    //
    // The old rule fell through to `contentImages[n - 1]` with n defaulting to 1, because
    // "viewport" has no trailing digits — so every viewport item was drawn confidently over the
    // FIRST picture on the page. That is a wrong answer presented as a right one, which is worse
    // than an absent mark: a participant has no way to tell it is wrong, and the citation text
    // beside it makes it look corroborated.
    if (!id || id === 'viewport') { skipped.push(item.key || '?'); return; }

    // The stamped id first: it came from gv2BuildFindImageCatalog, which is the same function that
    // wrote source_image_id — so the two cannot disagree. Counting images here has to guess at the
    // recorder's filtering rule, and guessing put Tesla's page_image_6 on a different picture.
    const stamped = doc.querySelector(`[data-pg-image-id="${CSS.escape(id)}"]`);
    const digits = id.match(/(\d+)$/)?.[1];
    // No stamp and no number is not "image 1", it is unknown. Same reasoning as above.
    const img = stamped || (digits ? contentImages[Number(digits) - 1] : null);
    if (!img) { skipped.push(item.key || id); return; }
    overlayAnnotations(doc, img, item.marks.annotations, item.key, item.marks);
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
    if (mark) return mark;
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
  const want = String(anchor.text || '');
  if (!want) return null;
  const all = doc.getElementsByTagName(anchor.tag);
  const matches = [];
  for (let i = 0; i < all.length; i++) {
    const t = anchorTextOf(all[i]);
    // A truncated locator kept only the first PG_ANCHOR_TEXT_MAX characters, so prefix is the only
    // comparison it supports; an untruncated one must match whole, or "El pedante" would match the
    // caption that merely starts with it.
    if (anchor.truncated ? t.startsWith(want) : t === want) matches.push(all[i]);
  }
  if (!matches.length) return null;
  // Out of range means the snapshot and the recording disagree about the page — better to fall
  // through to text search than to mark a confidently wrong element.
  const el = matches[anchor.ordinal] || (matches.length === 1 ? matches[0] : null);
  return el ? citationEvidenceElement(el, anchor?.quote || '') : null;
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
  const startPos = map[hit];
  const endPos = map[hit + target.length - 1];
  if (!startPos || !endPos) return null;
  const doc = root.ownerDocument || document;
  const range = doc.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset + 1);
  const mark = doc.createElement('span');
  mark.className = 'pageguide-highlight';
  mark.setAttribute('data-pageguide-styled', '');
  mark.dataset.pgCite = needle;
  try { range.surroundContents(mark); } catch (e) { return null; }  // malformed/overlapping markup
  return mark;
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

/** Prev/Next/Exit, for paging through the material without answering anything. */
function adminNavHtml() {
  if (!S.state.adminReview) return '';
  const queue = Array.isArray(S.state.queue) ? S.state.queue : [];
  return `
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
  if (quit) quit.onclick = () => { S.clearReview(); location.href = 'index.html'; };
}

function adminTaskLabel(task, i, total) {
  const id = task?.id || `Task ${i + 1}`;
  const type = task?.taskType === 'find' ? 'Find' : 'Guide';
  return `${i + 1}/${total} · ${id} · ${type}`;
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

function finish() {
  detachQuestionPane();
  stopTaskTelemetry();
  const pending = pendingResultCount();
  stimulusPane.innerHTML = '<div class="tv-done">Thank you — that was the last task.</div>';
  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">✅ All done</span></div>
    <div class="q-body">
      <p class="q-text">You have finished all ${S.state.results.length} tasks. Thank you.</p>
      ${pending ? `<p class="q-error-msg">Some task results did not reach the database yet (${pending}). Use the download button and send the file to the researcher.</p>` : ''}
      <p class="q-sub">You can close this tab. If the researcher asked for a copy of your responses,
        use the button below.</p>
      <div class="q-actions">
        <button class="q-btn" id="q-download">⬇ Download my responses</button>
      </div>
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

  if (!window.STUDY_SOURCE) S.clearLocal();
}

boot();
