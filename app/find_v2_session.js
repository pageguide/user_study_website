// Isolated session/result model for Find V2.
// The storage key and row shape are different from V1, so opening V2 cannot
// resume, overwrite, or clear an in-progress original PageGuide study.

(function () {
  const SESSION_KEY = 'pageguide_find_v2_session';
  const SESSION_VERSION = 1;

  const state = {
    participantId: '',
    arm: 'grounding',
    sessionId: null,
    runId: '',
    assignmentIndex: null,
    assignmentSlot: null,
    conditionOrder: '',
    // 'A' (text) or 'B' (visual) — the round-robin group this sitting was dealt.
    group: '',
    // Review mode only: a researcher checking one claim's references on the real task screen.
    adminReview: false,
    // An `admin` dry run: the real study, walked with ← → and recorded nowhere.
    previewNav: false,
    variantKey: '',
    queue: [],
    idx: 0,
    results: [],
    startedAt: 0,
    detachInstrument: null,
    dryRun: false,
    studyVersion: 'find-v2',
    // Snapshotted from the server AT START, not read live per task. A run must
    // keep the protocol it began with: an admin flipping a switch mid-session
    // would otherwise change what task 4 asks compared with task 3 of the same
    // participant, and the two would be indistinguishable in the results.
    flags: { collectEvidence: false, collectFollowup: false, taskLimitSeconds: 120 },
  };

  /** The protocol switches for THIS run, normalized — booleans boolean, the limit in range. */
  function studyFlags() {
    const f = state.flags || {};
    const seconds = Number(f.taskLimitSeconds);
    return {
      collectEvidence: !!f.collectEvidence,
      collectFollowup: !!f.collectFollowup,
      // Clamped to the same bounds the settings column enforces. A run resumed from a session saved
      // before the limit existed has no value here and gets the current default, which is right:
      // there is no recorded limit to honour, so honouring today's is the only honest option.
      taskLimitSeconds: Number.isFinite(seconds) ? Math.min(900, Math.max(30, Math.round(seconds))) : 120,
      // Absent means off, for a resumed run as for a fresh one.
      showGroupChip: f.showGroupChip === true,
      // Absent means on: the flag predates nothing, and a run resumed from a session saved before
      // the setting existed should look like the study looks now.
      flagMilestones: f.flagMilestones !== false,
      // Absent means off, for a resumed run as for a fresh one.
      showReasoningTrail: f.showReasoningTrail === true,
    };
  }

  // `test` and `admin`, either case, optionally with a slot number: test-3, Admin_1, ADMIN.
  // Both are dry runs — no session row, no result rows — so a researcher can walk the real study
  // without leaving data that looks exactly like a participant's.
  const DRY_RUN_ID = /^(test|admin)(?:[-_ ]?(\d+))?$/i;

  function isDryRunId(id) {
    return DRY_RUN_ID.test(String(id || '').trim());
  }

  /**
   * An `admin` dry run, which additionally gets ← → to walk the queue.
   *
   * Separate from `test` on purpose. A test run is meant to be indistinguishable from a real sitting
   * — that is what makes it a rehearsal — so it keeps the one-way flow and the three-minute cutoff.
   * `admin` is for LOOKING at the four tasks a slot deals, which needs to go backwards and needs to
   * skip a task without answering it. Naming the two differently keeps a rehearsal honest.
   */
  function isPreviewId(id) {
    return /^admin(?:[-_ ]?\d+)?$/i.test(String(id || '').trim());
  }

  function dryRunSlot(id) {
    const match = DRY_RUN_ID.exec(String(id || '').trim());
    return match && match[2] ? Number(match[2]) : 0;
  }

  function conditionLabel(arm) {
    return arm === 'nongrounding' ? 'nongrounding' : 'grounding';
  }

  function taskArm(task) {
    return conditionLabel(task?.arm || state.arm);
  }

  function resolveArm() {
    return 'grounding';
  }

  function saveLocal() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        sessionVersion: SESSION_VERSION,
        studyVersion: 'find-v2',
        participantId: state.participantId,
        arm: state.arm,
        sessionId: state.sessionId,
        runId: state.runId,
        assignmentIndex: state.assignmentIndex,
        assignmentSlot: state.assignmentSlot,
        conditionOrder: state.conditionOrder,
        group: state.group,
        queue: state.queue,
        idx: state.idx,
        results: state.results,
        startedAt: state.startedAt,
        dryRun: !!state.dryRun,
        flags: studyFlags(),
      }));
    } catch (e) { /* a private window may reject persistence */ }
  }

  function validParticipantSession(saved) {
    if (!saved || saved.adminReview) return false;
    if (saved.sessionVersion !== SESSION_VERSION || saved.studyVersion !== 'find-v2') return false;
    if (!saved.participantId || !Array.isArray(saved.queue) || !saved.queue.length) return false;
    // A queue must also carry the dealt variant. A run saved before the four
    // authored answers existed has an arm but no correctness key, and resuming
    // it would score verdicts against a claim property rather than against the
    // answer that was actually shown.
    if (!saved.queue.every(task => task?.studyVersion === 'find-v2'
      && (task.arm === 'grounding' || task.arm === 'nongrounding')
      && typeof task.claimCorrect === 'boolean'
      && window.FindV2Variants.KEYS.includes(task.variantKey))) return false;
    if (saved.assignmentSlot == null) return false;
    return Number.isInteger(saved.idx) && saved.idx >= 0 && saved.idx <= saved.queue.length;
  }

  function loadLocal() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!validParticipantSession(value)) return null;
      // A run saved before the flags existed resumes as verdict-only rather
      // than as `undefined`-only. It is not added to validParticipantSession:
      // rejecting those sessions would throw away work in progress to gain
      // nothing the fallback does not already give.
      value.flags = {
        collectEvidence: !!value.flags?.collectEvidence,
        collectFollowup: !!value.flags?.collectFollowup,
        taskLimitSeconds: Number(value.flags?.taskLimitSeconds) || 120,
        // CARRIED, NOT DEFAULTED. The queue was dealt when the run started and is saved with it, so
        // this changes nothing about what is played — but it is the only record of WHICH DESIGN a
        // half-finished run belongs to, and the welcome screen says so before offering to resume it.
        // A run saved before the setting existed has none, and reads as unknown rather than as the
        // current default: it was dealt under the old three-cell queue by definition.
        queueDesign: value.flags?.queueDesign || '',
        showGroupChip: value.flags?.showGroupChip === true,
        flagMilestones: value.flags?.flagMilestones !== false,
        showReasoningTrail: value.flags?.showReasoningTrail === true,
      };
      return value;
    } catch (e) { return null; }
  }

  function clearLocal() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  // ── Review mode ──────────────────────────────────────────────────────────
  //
  // A researcher opening one claim on the real task screen to check and re-link its references. It
  // was stubbed out while V2 was Find-only and there was nothing to review with; the reference
  // editor needs it, because picking a passage means clicking the actual snapshot, and the snapshot
  // only exists on the task page.
  //
  // ITS OWN KEY, in sessionStorage rather than localStorage. Two consequences, both deliberate:
  // entering review never touches `pageguide_find_v2_session`, so a participant midway through the
  // real study on this machine is undisturbed; and it dies with the tab, so a review session cannot
  // be resumed weeks later into a claim that has since been rewritten.
  const REVIEW_KEY = 'pageguide_find_v2_review';

  function saveReview() {
    try {
      sessionStorage.setItem(REVIEW_KEY, JSON.stringify({
        sessionVersion: SESSION_VERSION,
        studyVersion: 'find-v2',
        adminReview: true,
        participantId: state.participantId || 'admin-review',
        variantKey: state.variantKey || '',
        queue: state.queue,
        idx: state.idx,
        results: [],
        startedAt: state.startedAt || Date.now(),
      }));
    } catch (e) { /* a private window may reject persistence */ }
  }

  function loadReview() {
    try {
      const value = JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null');
      if (!value || !value.adminReview) return null;
      if (value.studyVersion !== 'find-v2') return null;
      if (!Array.isArray(value.queue) || !value.queue.length) return null;
      return value;
    } catch (e) { return null; }
  }

  function clearReview() {
    try { sessionStorage.removeItem(REVIEW_KEY); } catch (e) { /* ignore */ }
  }

  function newRunId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `find-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function resultKey(task) {
    const run = state.sessionId || state.runId || state.participantId || 'anonymous';
    return [run, 'find-v2', task?.id || 'claim', state.idx]
      .map(value => String(value).replace(/:/g, '_')).join(':');
  }

  function interactionColumns(summary) {
    const count = key => summary && Number.isFinite(Number(summary[key]))
      ? Math.round(Number(summary[key])) : null;
    return {
      scroll_user_count: count('scroll_count'),
      ctrl_f_count: count('ctrl_f_count'),
      text_select_count: count('text_select_count'),
      click_count: count('click_count'),
      mouse_move_px: count('mouse_move_px'),
      // THE MANIPULATION CHECK. Did the participant open any of the evidence the grounded arm is
      // defined by? Null when there is no telemetry at all, and 0 when there is — a grounded
      // participant who opened nothing had the chance, and that is the finding rather than a gap.
      // `condition` already says whether references were on offer, so analysis splits on that.
      reference_click_count: count('reference_click_count'),
      reference_hover_count: count('reference_hover_count'),
      reference_distinct_count: count('reference_distinct_count'),
      // The one genuine null here: no first open happened, and 0 would read as "opened one instantly".
      reference_first_ms: count('reference_first_ms'),
    };
  }

  function buildFindResultRow({ task, payload, confidence, helpfulness, notes }) {
    // NULL, not false, when the timer ran out before a choice. Coercing an
    // unanswered task to "No" would score it against the claim and quietly
    // count a participant who never answered as having been right half the
    // time. buildFindResultRow is the only place that could make that mistake.
    const verdict = payload.answer == null
      ? null
      : String(payload.answer).toLowerCase() === 'yes';
    // The key is the correctness of the variant this participant was dealt, not
    // a property of the claim row: the same row is shown correct to one slot and
    // incorrect to the next.
    const expected = task?.claimCorrect === true;
    const arm = taskArm(task);
    const variantKey = window.FindV2Variants.KEYS.includes(task?.variantKey)
      ? task.variantKey
      : window.FindV2Variants.variantKey(expected, arm);
    return {
      result_key: resultKey(task),
      client_run_id: state.runId || null,
      session_id: state.sessionId,
      participant_id: state.participantId,
      claim_id: task?.id || '',
      task_index: state.idx,
      question_index: state.results.length,
      task_style: task?.style || 'find_text',
      condition: arm,
      variant_key: variantKey,
      question: task?.question || '',
      claim_text_snapshot: payload.claimText || '',
      claim_correct_snapshot: expected,
      participant_verdict: verdict,
      verdict_correct: verdict == null ? null : verdict === expected,
      verdict_timed_out: verdict == null,
      answer_time_ms: payload.answerElapsed,
      verdict_time_ms: payload.answerChoiceMs,
      evidence_time_ms: payload.findSupportingMs,
      evidence_responses: payload.evidenceResponses || [],
      score_evidence_precision: payload.findScores?.precision ?? null,
      score_evidence_recall: payload.findScores?.recall ?? null,
      score_evidence_exact: payload.findScores?.exact ?? null,
      score_evidence_hop_exact: payload.findScores?.hopExact ?? null,
      confidence: confidence || null,
      helpfulness: helpfulness || null,
      notes: notes || null,
      interaction_summary: payload.interactionSummary || null,
      ...interactionColumns(payload.interactionSummary),
    };
  }

  /**
   * One Guide judgment, for pageguide_guide_v2_results.
   *
   * The Guide task in V2 asks for a verdict and step-level localization. Steps can be marked while
   * the journey is reviewed; a No verdict makes at least one mark required. The selected numbers
   * are stored in their own `marked_wrong_steps` column rather than squeezed into V1's
   * `guide_errors` taxonomy: V2 asks where, but does not ask the participant to classify an error
   * type. Problem/type scores therefore stay null. Step scores are filled only when the task already
   * carries `guide_ground_truth.errors[].steps`; selections remain stored and can be rescored later
   * for tasks whose step key is authored afterwards.
   *
   * `answer_correct_snapshot` is the key AS IT STOOD when this participant was shown the run. The
   * key is authored in Admin and can be revised, and a verdict is only interpretable against the
   * judgement that was live at the time. `failure_mode` is snapshotted for exactly the same reason:
   * it is read off `guide_ground_truth`, which Admin can edit, so joining for it at analysis time
   * would describe the run as it is now rather than as it was judged.
   */
  function buildGuideResultRow({ task, payload, confidence, helpfulness, notes }) {
    const verdict = payload.answer == null
      ? null
      : String(payload.answer).toLowerCase() === 'yes';
    const expected = typeof task?.agentCompleted === 'boolean' ? task.agentCompleted : null;
    return {
      result_key: resultKey(task),
      client_run_id: state.runId || null,
      session_id: state.sessionId,
      participant_id: state.participantId,
      task_id: task?.id || '',
      task_index: state.idx,
      question_index: state.results.length,
      task_style: task?.style || 'guide_text',
      // Guide is grounded-only for now. Stored rather than assumed so a later
      // non-grounded arm does not need the column backfilled.
      condition: taskArm(task),
      variant_key: window.FindV2Variants.variantKey(expected !== false, taskArm(task)),
      goal: task?.goal || task?.question || '',
      answer_text_snapshot: payload.claimText || '',
      answer_correct_snapshot: expected,
      // WHY this run is keyed incorrect — none / misreported / incomplete / could_not_complete /
      // unspecified. NULL, not 'unspecified', when the task carried no key at all: "keyed incorrect
      // and nobody wrote down why" and "never keyed" are different facts, and only one of them is a
      // gap in the authoring. See app/find_v2_guide_key.js.
      failure_mode: window.FindV2GuideKey.FAILURE_MODES.includes(payload.failureMode)
        ? payload.failureMode : null,
      guide_answer_correct: verdict,
      marked_wrong_steps: Array.from(new Set((payload.markedWrongSteps || [])
        .map(Number).filter(step => Number.isInteger(step) && step >= 0))).sort((a, b) => a - b),
      verdict_timed_out: verdict == null,
      score_verdict_correct: verdict == null || expected == null ? null : verdict === expected,
      score_step_precision: payload.stepScores?.precision ?? null,
      score_step_recall: payload.stepScores?.recall ?? null,
      score_step_exact: payload.stepScores?.exact ?? null,
      time_ms: payload.answerElapsed,
      answer_time_ms: payload.answerElapsed,
      verdict_time_ms: payload.answerChoiceMs,
      localization_time_ms: payload.localizationElapsed ?? null,
      confidence: confidence || null,
      helpfulness: helpfulness || null,
      notes: notes || null,
      interaction_summary: payload.interactionSummary || null,
      ...interactionColumns(payload.interactionSummary),
    };
  }

  window.StudySession = {
    state,
    SESSION_VERSION,
    isDryRunId,
    isPreviewId,
    dryRunSlot,
    studyFlags,
    conditionLabel,
    taskArm,
    resolveArm,
    saveLocal,
    loadLocal,
    clearLocal,
    saveReview,
    loadReview,
    clearReview,
    REVIEW_KEY,
    validParticipantSession,
    newRunId,
    buildFindResultRow,
    buildGuideResultRow,
    // V1's taxonomy instrument (app/instrument.js → askPostQuestions) builds its row through here.
    // V2's Guide task asks a verdict plus step-only localization and goes through
    // buildGuideResultRow, so reaching this means the full V1 taxonomy instrument was mounted —
    // worth a named error rather than an undefined-is-not-a-function three frames deeper.
    buildResultRow() {
      throw new Error('Find V2 Guide tasks do not use the taxonomy instrument; see buildGuideResultRow.');
    },
  };
}());
