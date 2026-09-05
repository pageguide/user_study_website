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
    flags: {
      collectEvidence: false, collectFollowup: false, taskLimitSeconds: 180,
      allowBrowseSim: true, browseSimDelayMs: 500,
    },
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
      taskLimitSeconds: Number.isFinite(seconds) ? Math.min(900, Math.max(30, Math.round(seconds))) : 180,
      // Absent means off, for a resumed run as for a fresh one.
      showGroupChip: f.showGroupChip === true,
      // Absent means on: the flag predates nothing, and a run resumed from a session saved before
      // the setting existed should look like the study looks now.
      flagMilestones: f.flagMilestones !== false,
      // Absent means off, for a resumed run as for a fresh one.
      showReasoningTrail: f.showReasoningTrail === true,
      // Absent means on, matching the column default: a run resumed from a session saved before the
      // simulator existed is a run under the old protocol, but the flag is about what the page
      // OFFERS rather than about what was recorded, so it follows the study rather than the save.
      allowBrowseSim: f.allowBrowseSim !== false,
      // Clamped to the same bounds the column enforces, and defaulting the way the column does. A
      // run resumed from a session saved before the setting existed gets today's value: there is no
      // recorded delay to honour, so honouring the current one is the only honest option — the same
      // reasoning as the per-task limit above.
      browseSimDelayMs: Number.isFinite(Number(f.browseSimDelayMs))
        ? Math.min(5000, Math.max(0, Math.round(Number(f.browseSimDelayMs))))
        : 500,
      // NOT snapshotted in spirit, even though it rides in the same object: the final screen is
      // reached once, at the end, and the form it should open is whichever one is current then. A
      // run resumed days later must not post to a form that has since been replaced.
      postSurveyUrl: String(f.postSurveyUrl || '').trim(),
      // CARRIED, not dropped. saveLocal writes `flags: studyFlags()`, so anything this function
      // omits is gone from the saved run — and the welcome screen reads `saved.flags.queueDesign` to
      // decide whether a resumed run was dealt under the design now set. Omitting it made every
      // saved run look stale, which put the "discard your answers" button in front of every
      // participant who reloaded mid-sitting.
      queueDesign: String(f.queueDesign || ''),
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
        taskLimitSeconds: Number(value.flags?.taskLimitSeconds) || 180,
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

  /**
   * The task clock, CAPPED AT THE LIMIT.
   *
   * A task is budgeted `taskLimitSeconds`, and past that the participant is shown the verdict and
   * the task waits for them — for as long as they take. What that waiting measures is not reading:
   * it is a coffee, a phone call, a tab left open over lunch. One 40-minute row of that moves a
   * condition's mean by more than every real difference the study is powered to find, and the
   * obvious defences are both worse — dropping the row throws away a real verdict, and winsorising
   * after the fact is a decision made on the data rather than before it.
   *
   * So the recorded time is `min(elapsed, limit)`, which is a rule fixed in advance and the same one
   * for every row: "this task took at least the whole budget".
   *
   * NOTHING IS LOST. The true elapsed time goes into `interaction_summary.time`, alongside the limit
   * it was capped against, so the overrun is still analysable and a later reanalysis can undo this
   * entirely. What the column holds is the analysis-ready number; what the jsonb holds is what
   * happened.
   */
  function taskClock(payload) {
    const raw = Number(payload?.answerElapsed);
    const limit = Number(studyFlags().taskLimitSeconds) * 1000;
    if (!Number.isFinite(raw) || !Number.isFinite(limit) || limit <= 0) {
      return { ms: payload?.answerElapsed ?? null, at: value => value, over: 0 };
    }
    return {
      ms: Math.min(raw, limit),
      // Every other measure taken from the same start is clamped to the same ceiling, so a
      // verdict cannot be recorded as having been reached after the task it belongs to ended.
      at: value => (Number.isFinite(Number(value)) ? Math.min(Number(value), limit) : value),
      over: Math.max(0, raw - limit),
      raw,
      limit,
    };
  }

  /** The interaction summary, with the true clock folded in when the cap actually bit. */
  function summaryWithClock(summary, clock) {
    if (!clock.over) return summary || null;
    return Object.assign({}, summary || null, {
      time: {
        elapsed_ms: Math.round(clock.raw),
        recorded_ms: Math.round(clock.ms),
        limit_ms: Math.round(clock.limit),
        over_ms: Math.round(clock.over),
      },
    });
  }

  function buildFindResultRow({ task, payload, confidence, helpfulness, notes }) {
    // NULL, not false, when the timer ran out before a choice. Coercing an
    // unanswered task to "No" would score it against the claim and quietly
    // count a participant who never answered as having been right half the
    // time. buildFindResultRow is the only place that could make that mistake.
    const verdict = payload.answer == null
      ? null
      : String(payload.answer).toLowerCase() === 'yes';
    const clock = taskClock(payload);
    const summary = summaryWithClock(payload.interactionSummary, clock);
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
      answer_time_ms: clock.ms,
      verdict_time_ms: clock.at(payload.answerChoiceMs),
      // NOT capped: this is the duration of a stage that starts after the verdict, not an offset
      // from the task's own start, so the task ceiling is not its ceiling.
      evidence_time_ms: payload.findSupportingMs,
      evidence_responses: payload.evidenceResponses || [],
      score_evidence_precision: payload.findScores?.precision ?? null,
      score_evidence_recall: payload.findScores?.recall ?? null,
      score_evidence_exact: payload.findScores?.exact ?? null,
      score_evidence_hop_exact: payload.findScores?.hopExact ?? null,
      confidence: confidence || null,
      helpfulness: helpfulness || null,
      notes: notes || null,
      interaction_summary: summary,
      ...interactionColumns(summary),
    };
  }

  /**
   * One Guide judgment, for pageguide_guide_v2_results.
   *
   * The Guide task in V2 asks for a verdict and offers optional step-level localization. Steps can
   * be marked while the journey is reviewed, but a No verdict can also be submitted with no marks.
   * The selected numbers are stored in their own `marked_wrong_steps` column rather than squeezed
   * into V1's `guide_errors` taxonomy: V2 asks where, but does not ask the participant to classify
   * an error type. Problem/type scores therefore stay null. Step scores are filled only when the
   * task already carries `guide_ground_truth.errors[].steps`; selections remain stored and can be
   * rescored later for tasks whose step key is authored afterwards.
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
    const clock = taskClock(payload);
    const summary = summaryWithClock(payload.interactionSummary, clock);
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
      // The goal AS SHOWN — see the note on `goalText` in app/study.js. Falls back to the queue
      // snapshot for a caller that does not supply one, so an older payload still records something.
      goal: payload.goalText || task?.goal || task?.question || '',
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
      time_ms: clock.ms,
      answer_time_ms: clock.ms,
      verdict_time_ms: clock.at(payload.answerChoiceMs),
      // NOT capped, like evidence_time_ms above: step marking happens after the verdict and is
      // timed from its own start.
      localization_time_ms: payload.localizationElapsed ?? null,
      confidence: confidence || null,
      helpfulness: helpfulness || null,
      notes: notes || null,
      interaction_summary: summary,
      ...interactionColumns(summary),
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
