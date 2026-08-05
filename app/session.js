// The study site — the session.
// =============================
// Owns the queue, the arm, and the result rows. The two panes know nothing about each other or
// about Supabase; this is what joins them.

const SESSION_KEY = 'pageguide_web_study_session';

const state = {
  participantId: '',
  arm: 'grounding',
  sessionId: null,
  queue: [],
  idx: 0,
  results: [],
  startedAt: 0,
  detachInstrument: null,
};

/**
 * Which arm this participant is in.
 *
 * A participant must never choose their own condition, so 'ask' exists for pilots and debugging
 * only. 'url' is the default because it lets assignment be decided when recruiting — the link you
 * send IS the assignment — which keeps a record of it outside the browser.
 */
function resolveArm(params) {
  const mode = (window.STUDY_CONFIG || {}).ARM_ASSIGNMENT || 'url';
  const fromUrl = params.get('arm');
  if (fromUrl === 'grounding' || fromUrl === 'nongrounding') return fromUrl;
  if (mode === 'random') return Math.random() < 0.5 ? 'grounding' : 'nongrounding';
  return 'grounding';
}

/** The label written to `condition`, matching what the extension records for the same arm. */
function conditionLabel(arm) {
  return arm === 'nongrounding' ? 'nongrounding' : 'grounding';
}

// ── Persistence across a reload ──
// A participant who refreshes mid-study should not restart it. Results already written to Supabase
// stay written; this only restores where they were.
function saveLocal() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      participantId: state.participantId, arm: state.arm, sessionId: state.sessionId,
      idx: state.idx, results: state.results, queue: state.queue,
    }));
  } catch (e) { /* private mode, quota — not worth failing the study over */ }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearLocal() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

/**
 * Build one result row.
 *
 * The field names are the extension's, exactly — this row goes into the same study_task_results
 * table, and a web run has to be indistinguishable from an extension run once it is in there.
 * Scored client-side with the vendored _scoreGuideAnswer so the measure is computed by the same
 * code on both sides.
 */
function buildResultRow({ task, record, timings, confidence, helpfulness }) {
  const scored = window._scoreGuideAnswer(timings.guideAnswer, record?.ground_truth) || {};
  const score = (key) => (scored[key] === undefined ? null : scored[key]);
  const questionIndex = state.results.filter(r => r.task_type === 'guide').length;

  return {
    session_id: state.sessionId,
    participant_id: state.participantId,
    block_index: 0,
    task_index: state.idx,
    question_index: questionIndex,
    task_type: 'guide',
    condition: conditionLabel(state.arm),
    time_ms: timings.answerElapsed,
    notes_time_ms: null,
    answer_time_ms: timings.answerElapsed,
    answer_multiple_choice_ms: timings.answerChoiceMs,
    find_supporting_answer_ms: timings.findSupportingMs,

    guide_answer_correct: timings.guideAnswer.correct,
    guide_answer_problems: timings.guideAnswer.problems || [],
    guide_answer_problem: timings.guideAnswer.problem || '',
    guide_errors: timings.guideAnswer.errors || [],

    score_verdict_correct: score('verdict_correct'),
    score_problem_precision: score('problem_precision'),
    score_problem_recall: score('problem_recall'),
    score_problem_exact: score('problem_exact'),
    score_type_precision: score('type_precision'),
    score_type_recall: score('type_recall'),
    score_step_precision: score('step_precision'),
    score_step_recall: score('step_recall'),
    score_step_exact: score('step_exact'),
    score_no_error_agreement: score('no_error_agreement'),

    evidence_responses: [],
    answer: null,
    answer_correct: null,
    question_or_task: record?.goal || task.goal || '',
    confidence: confidence || null,
    helpfulness: helpfulness || null,
    chat_turn_count: 0,
    chat_transcript: [],
    user_hidden_selectors: null,
    guide_screenshot: null,

    // Behaviour counts come from a content script watching the live page. A website cannot observe
    // the participant's other tabs, so these stay at their defaults for web rows rather than being
    // invented. Worth knowing before mixing the two sources in an analysis that uses them.
    scroll_user_count: 0,
    scroll_agent_count: 0,
    ctrl_f_count: 0,
    text_select_count: 0,
    click_count: 0,
    mouse_move_px: 0,
    agent_think_ms: null,
    page_visit_count: 0,
    page_visit_urls: null,

    task_data: { id: task.id, condition: task.condition || '', source: 'pageguide-web' },
  };
}

window.StudySession = { state, resolveArm, conditionLabel, saveLocal, loadLocal, clearLocal, buildResultRow };
