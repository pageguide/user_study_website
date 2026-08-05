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

/**
 * The condition, and there are exactly two of it: `grounding` | `nongrounding`.
 *
 * Matches studyConditionLabel in the extension byte for byte. Nothing about WHICH CLIENT produced
 * the row belongs in this column — that is a different fact, and it lives in task_data.source.
 * Mixing the two is how the same two conditions ended up recorded under five different strings.
 */
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

const REVIEW_KEY = 'pageguide_web_study_review';

/**
 * The admin review session, kept apart from the participant's.
 *
 * sessionStorage under its OWN key, for two reasons: it must survive the navigation from the
 * welcome screen to the task screen, and it must not touch `pageguide_web_study_session` — a
 * reviewer opening review mode would otherwise discard the progress of a participant midway
 * through the real study on the same machine.
 */
function saveReview() {
  try {
    sessionStorage.setItem(REVIEW_KEY, JSON.stringify({
      participantId: state.participantId, arm: state.arm, queue: state.queue,
      idx: state.idx, results: state.results, adminReview: true,
    }));
  } catch (e) { /* ignore */ }
}

function loadReview() {
  try {
    const raw = sessionStorage.getItem(REVIEW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearReview() {
  try { sessionStorage.removeItem(REVIEW_KEY); } catch (e) { /* ignore */ }
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

/**
 * One Find result row.
 *
 * Same table and same field names as the guide half and the extension, so a Find run on the web is
 * one row among the rest rather than a separate dataset. `answer_correct` is graded here the way
 * _gradeFindAnswer does it in the extension: a case- and space-insensitive comparison against the
 * task's recorded answer, because the option text is what the participant clicked and the task file
 * is what it must match.
 */
function buildFindResultRow({ task, payload, confidence, helpfulness }) {
  const questionIndex = state.results.filter(r => r.task_type === 'find').length;
  const chosen = String(payload.answer || '').trim().toLowerCase();
  const correct = String(task?.answer || '').trim().toLowerCase();

  return {
    session_id: state.sessionId,
    participant_id: state.participantId,
    block_index: 0,
    task_index: state.idx,
    question_index: questionIndex,
    task_type: 'find',
    condition: conditionLabel(state.arm),
    time_ms: payload.answerElapsed,
    notes_time_ms: null,
    answer_time_ms: payload.answerElapsed,
    // The split that makes the two halves of a Find task measurable separately: deciding, then
    // hunting. Grounding should help the second far more than the first.
    answer_multiple_choice_ms: payload.answerChoiceMs,
    find_supporting_answer_ms: payload.findSupportingMs,

    guide_answer_correct: null,
    guide_answer_problems: null,
    guide_answer_problem: null,
    guide_errors: null,
    score_verdict_correct: null,
    score_problem_precision: null,
    score_problem_recall: null,
    score_problem_exact: null,
    score_type_precision: null,
    score_type_recall: null,
    score_step_precision: null,
    score_step_recall: null,
    score_step_exact: null,
    score_no_error_agreement: null,

    evidence_responses: payload.evidenceResponses || [],
    answer: payload.answer,
    answer_correct: !!correct && chosen === correct,
    question_or_task: task?.question || '',
    confidence: confidence || null,
    helpfulness: helpfulness || null,
    chat_turn_count: 0,
    chat_transcript: [],
    user_hidden_selectors: null,
    guide_screenshot: null,

    scroll_user_count: 0,
    scroll_agent_count: 0,
    ctrl_f_count: 0,
    text_select_count: 0,
    click_count: 0,
    mouse_move_px: 0,
    agent_think_ms: null,
    page_visit_count: 0,
    page_visit_urls: null,

    task_data: { id: task?.id, type: task?.type || '', url: task?.url || '', source: 'pageguide-web' },
  };
}

window.StudySession = {
  buildFindResultRow,
  state, resolveArm, conditionLabel, saveLocal, loadLocal, clearLocal, buildResultRow,
  saveReview, loadReview, clearReview,
};
