// The task screen driver: walk the queue, one trajectory at a time.
//
// Fetches each trajectory only when it is reached. The list query deliberately omits `arms` — a
// nine-step run carries ~1.5MB of base64 screenshots, so pulling the whole bank up front to build a
// queue would cost tens of megabytes before the first question is on screen.

const stimulusPane = document.getElementById('stimulus-pane');
const questionPane = document.getElementById('question-pane');
const S = window.StudySession;

// The data source, chosen once. demo.html sets window.STUDY_SOURCE to a local fixture bank before
// this file loads, so the demo walks THIS code — the same queue, timers, validation and scoring a
// participant gets — rather than a parallel implementation that could drift from it.
const DB = window.STUDY_SOURCE || window.StudyDB;

function panelMessage(html) {
  questionPane.innerHTML = `<div class="q-body">${html}</div>`;
}

async function boot() {
  // In-memory state wins when it is already populated. That is how the demo hands its fixture queue
  // over without going near localStorage — which matters, because the demo and a real run would
  // otherwise share one storage key, and opening the demo would silently discard the progress of a
  // participant who was midway through the actual study.
  const seeded = S.state.participantId && Array.isArray(S.state.queue) && S.state.queue.length;
  const saved = seeded ? S.state : S.loadLocal();
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
    location.replace('index.html');
    return;
  }
  Object.assign(S.state, saved);
  await showTask();
}

async function showTask() {
  const { queue, idx, arm } = S.state;
  if (idx >= queue.length) return finish();

  const task = queue[idx];
  panelMessage('<p class="q-text">Loading the next task…</p>');

  let record = null;
  try {
    record = await DB.getStudyTrajectory(task.id);
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
    goal: record.goal || record.title || '',
    onSubmit: (timings) => askPostQuestions(task, record, timings),
  });
  questionPane.scrollTop = 0;
}

/**
 * The two post-task questions, asked exactly as the extension asks them.
 *
 * Kept on the same screen rather than a page of their own: they are about the task just finished,
 * and a participant who has navigated away from it is answering from memory.
 */
function askPostQuestions(task, record, timings) {
  const opt = (name, value, label) =>
    `<label class="q-opt"><input type="radio" name="${name}" value="${value}"><span>${label}</span></label>`;

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">Quick questions</span></div>
    <div class="q-body">
      <p class="q-text">How confident are you in your answer?</p>
      <div class="q-options" id="q-conf">
        ${opt('q-conf', 'very', '😎 Very confident')}
        ${opt('q-conf', 'somewhat', '🙂 Somewhat confident')}
        ${opt('q-conf', 'notsure', '😐 Not sure')}
        ${opt('q-conf', 'guessed', '🤷 Just guessing')}
      </div>
      <p class="q-text" style="margin-top:16px;">How helpful was what you were shown?</p>
      <div class="q-options" id="q-help">
        ${opt('q-help', 'very', '⭐⭐⭐ Very helpful')}
        ${opt('q-help', 'somewhat', '⭐⭐ Somewhat helpful')}
        ${opt('q-help', 'notmuch', '⭐ Not very helpful')}
        ${opt('q-help', 'notatall', 'Not helpful at all')}
      </div>
      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions"><button class="q-btn q-btn-primary" id="q-done">Next task →</button></div>
    </div>`;

  document.getElementById('q-done').onclick = async () => {
    const conf = questionPane.querySelector('input[name="q-conf"]:checked');
    const help = questionPane.querySelector('input[name="q-help"]:checked');
    const err = document.getElementById('q-error-msg');
    if (!conf || !help) {
      err.textContent = 'Please answer both questions.';
      err.hidden = false;
      return;
    }

    const row = S.buildResultRow({
      task, record, timings, confidence: conf.value, helpfulness: help.value,
    });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE) S.saveLocal();   // a demo leaves no trace in the participant's storage

    // Written now rather than batched at the end: a participant who closes the tab three tasks in
    // should leave three rows behind, not none. A failed write keeps the local copy, which the
    // final screen can still export.
    try {
      await DB.insertStudyResult(row);
    } catch (e) {
      console.warn('[study] result kept locally only:', e);
    }

    showTask();
  };
}

function finish() {
  stimulusPane.innerHTML = '<div class="tv-done">Thank you — that was the last task.</div>';
  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">✅ All done</span></div>
    <div class="q-body">
      <p class="q-text">You have finished all ${S.state.results.length} tasks. Thank you.</p>
      <p class="q-sub">You can close this tab. If the researcher asked for a copy of your responses,
        use the button below.</p>
      <div class="q-actions">
        <button class="q-btn" id="q-download">⬇ Download my responses</button>
      </div>
    </div>`;

  document.getElementById('q-download').onclick = () => {
    const blob = new Blob([JSON.stringify(S.state.results, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study_${S.state.participantId || 'anon'}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!window.STUDY_SOURCE) S.clearLocal();
}

boot();
