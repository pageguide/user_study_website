// Editing a recorded trajectory — the pure half.
// ==============================================
// Turning a clean run into one that contains an error, without re-recording it. A study needs runs
// that went wrong to measure whether grounding helps somebody FIND where they went wrong, and a
// pool of successful runs cannot measure that at any sample size.
//
// The one edit this makes is CLONE A STEP. Repeating an action is a real agent failure and already
// a first-class error type in the study's vocabulary — "loop / no progress, stuck without
// advancing" (GUIDE_ERROR_TYPES, vendor/guide_trajectories.js) — so a cloned step is not a fake
// error, it is that error, built from the run's own material. The clone carries the original's
// screenshot, which is what a stuck agent would actually have shown: the same page, again.
//
// STEP NUMBERS ARE REFERENCES, NOT LABELS. `n` is what a participant reads and what their answer
// names ("it went wrong at step 6"), and four other structures point at it:
//
//     answer_evidence[].step      trail.milestones[].step
//     answer_segments[].step      ground_truth.errors[].steps
//
// Insert a step in the middle and every one of those pointing past the insertion is now off by one.
// Renumbering the steps alone would leave the evidence attached to the wrong action and the ground
// truth blaming the wrong step — the trajectory would look fine and score wrong. So the remap is
// the substance of this file, and every reference moves together or the edit is not applied.

/** Deep copy through JSON — the structures here are plain data, screenshots included. */
function cloneDeep(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Where a step number lands after `count` steps are inserted directly after step `afterN`.
 *
 * Steps at or before the insertion keep their number; everything after shifts by the count. The
 * cloned steps themselves occupy afterN+1 … afterN+count.
 */
function shiftStepRef(n, afterN, count) {
  const value = Number(n);
  if (!Number.isFinite(value)) return n;
  return value > afterN ? value + count : value;
}

/** The shape every step carries, so a hand-written one is indistinguishable from a recorded one. */
function makeStep({ instruction = '', action = '', target_text = '', url = '', screenshot = null } = {}) {
  return { n: 0, instruction, action, target_text, url, screenshot };
}

/**
 * Put `newSteps` into an arm directly after step `afterN`, remapping every reference.
 *
 * `afterN = 0` inserts at the very front — there is no step 0, and "before the first step" is a
 * real place to add one.
 *
 * Returns a NEW arm; the input is not touched.
 */
function insertArmSteps(arm, afterN, newSteps) {
  const source = arm || {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const after = Number(afterN);
  const index = after === 0 ? -1 : steps.findIndex(s => Number(s?.n) === after);
  if (index < 0 && after !== 0) throw new Error(`No step ${afterN} to insert after.`);
  const added = (Array.isArray(newSteps) ? newSteps : [newSteps]).map(cloneDeep);
  if (!added.length) return cloneDeep(source);
  const times = added.length;

  const nextSteps = steps.slice(0, index + 1).concat(added, steps.slice(index + 1))
    // Numbered by POSITION, always — the same rule _renumberGuideSteps applies in the recorder.
    .map((step, i) => Object.assign(cloneDeep(step), { n: i + 1 }));

  const remap = (n) => shiftStepRef(n, after, times);
  const next = Object.assign(cloneDeep(source), { steps: nextSteps });

  if (Array.isArray(next.answer_evidence)) {
    next.answer_evidence = next.answer_evidence.map(e =>
      (e && e.step != null ? Object.assign({}, e, { step: remap(e.step) }) : e));
  }
  if (Array.isArray(next.answer_segments)) {
    next.answer_segments = next.answer_segments.map(s =>
      (s && s.step != null ? Object.assign({}, s, { step: remap(s.step) }) : s));
  }
  if (Array.isArray(next.trail?.milestones)) {
    next.trail = Object.assign({}, next.trail, {
      milestones: next.trail.milestones.map(m =>
        (m && m.step != null ? Object.assign({}, m, { step: remap(m.step) }) : m)),
    });
  }
  return next;
}

/**
 * Clone step `afterN` `count` times, immediately after itself.
 *
 * The clones are identical to the original INCLUDING its screenshot — that is the point of a loop,
 * the agent doing the same thing again on the same page.
 */
function cloneArmStep(arm, afterN, count = 1) {
  const steps = Array.isArray(arm?.steps) ? arm.steps : [];
  const original = steps.find(s => Number(s?.n) === Number(afterN));
  if (!original) throw new Error(`No step ${afterN} to clone.`);
  const times = Math.max(1, Number(count) || 1);
  return insertArmSteps(arm, afterN, Array.from({ length: times }, () => cloneDeep(original)));
}

/**
 * Where a step number lands after step `removedN` is deleted.
 *
 * Later steps close up by one. A reference AT the deleted step has nowhere of its own to go, so it
 * falls back to the step before it — which for a duplicate is the original it was cloned from, the
 * nearest thing to what it meant. Returns null only for a reference to step 1 when step 1 is the
 * one deleted, and the caller decides what a homeless reference is worth.
 */
function shiftStepRefOnRemove(n, removedN) {
  const value = Number(n);
  if (!Number.isFinite(value)) return n;
  if (value > removedN) return value - 1;
  if (value < removedN) return value;
  return removedN > 1 ? removedN - 1 : null;
}

/**
 * Delete one step from an arm, remapping every reference.
 *
 * Refuses to empty the run: a trajectory with no steps is not a shorter run, it is a broken record,
 * and there is nothing a participant could be asked to judge.
 */
function removeArmStep(arm, n) {
  const source = arm || {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const target = Number(n);
  if (!steps.some(s => Number(s?.n) === target)) throw new Error(`No step ${n} to remove.`);
  if (steps.length <= 1) throw new Error('A trajectory needs at least one step.');

  const nextSteps = steps.filter(s => Number(s?.n) !== target)
    .map((step, i) => Object.assign(cloneDeep(step), { n: i + 1 }));
  const remap = (v) => shiftStepRefOnRemove(v, target);
  const next = Object.assign(cloneDeep(source), { steps: nextSteps });

  // A reference that lands nowhere is dropped rather than left pointing at a step that no longer
  // exists — a milestone whose step is gone renders as a row that previews nothing, which reads as
  // a broken page rather than as a deleted step.
  if (Array.isArray(next.answer_evidence)) {
    next.answer_evidence = next.answer_evidence
      .map(e => (e && e.step != null ? Object.assign({}, e, { step: remap(e.step) }) : e))
      .filter(e => !(e && e.step === null));
  }
  if (Array.isArray(next.answer_segments)) {
    next.answer_segments = next.answer_segments
      .map(s => (s && s.step != null ? Object.assign({}, s, { step: remap(s.step) }) : s))
      .filter(s => !(s && s.step === null));
  }
  if (Array.isArray(next.trail?.milestones)) {
    next.trail = Object.assign({}, next.trail, {
      milestones: next.trail.milestones
        .map(m => (m && m.step != null ? Object.assign({}, m, { step: remap(m.step) }) : m))
        .filter(m => !(m && m.step === null)),
    });
  }
  return next;
}

/**
 * The same removal over a ground truth.
 *
 * The deleted step is struck from every error's step list rather than slid onto its neighbour: an
 * error says WHERE the run went wrong, and moving that claim to a step the researcher never blamed
 * would put words in their mouth. An error left with no steps is dropped, because "something went
 * wrong, nowhere" is exactly the half-answer _guideGroundTruthProblem refuses to score.
 */
function removeGroundTruthStep(groundTruth, removedN) {
  const gt = cloneDeep(groundTruth) || {};
  if (Array.isArray(gt.errors)) {
    gt.errors = gt.errors
      .map(e => Object.assign({}, e, {
        steps: (Array.isArray(e?.steps) ? e.steps : [])
          .filter(n => Number(n) !== Number(removedN))
          .map(n => (Number(n) > Number(removedN) ? Number(n) - 1 : Number(n))),
      }))
      .filter(e => e.steps.length);
    gt.no_error = !gt.errors.length;
  }
  return gt;
}

/**
 * Change what one step says, or the picture behind it. No renumbering — nothing moves.
 *
 * `undefined` means leave the field alone and `null` means clear it, because "no new screenshot was
 * chosen" and "take the screenshot away" are different intentions and a single falsy check would
 * carry out the second every time somebody meant the first.
 */
function updateArmStep(arm, n, patch) {
  const source = arm || {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const index = steps.findIndex(s => Number(s?.n) === Number(n));
  if (index < 0) throw new Error(`No step ${n} to edit.`);
  const next = cloneDeep(source);
  const step = next.steps[index];
  Object.keys(patch || {}).forEach(key => {
    if (patch[key] !== undefined) step[key] = patch[key];
  });
  return next;
}

/**
 * Edit a step across the record.
 *
 * The INSTRUCTION belongs to both arms — it is what the agent did, and the arms have to be the same
 * run. The SCREENSHOT belongs only to the grounded one: being unable to check an action against the
 * page it happened on is the whole definition of the other arm.
 */
function updateRecordStep(record, n, { instruction, screenshot } = {}) {
  const next = cloneDeep(record) || {};
  next.arms = next.arms || {};
  if (!next.arms.grounding) throw new Error('This trajectory has no grounded arm to edit.');
  if (instruction !== undefined && !String(instruction).trim()) {
    throw new Error('A step needs something to say.');
  }
  next.arms.grounding = updateArmStep(next.arms.grounding, n, { instruction, screenshot });
  if (next.arms.nongrounding) {
    next.arms.nongrounding = updateArmStep(next.arms.nongrounding, n, { instruction });
  }
  return next;
}

/** Delete a step across the whole record — both arms and the ground truth. */
function removeRecordStep(record, n) {
  const next = cloneDeep(record) || {};
  next.arms = next.arms || {};
  if (!next.arms.grounding) throw new Error('This trajectory has no grounded arm to edit.');
  next.arms.grounding = removeArmStep(next.arms.grounding, n);
  if (next.arms.nongrounding) {
    next.arms.nongrounding = removeArmStep(next.arms.nongrounding, n);
  }
  next.ground_truth = removeGroundTruthStep(next.ground_truth, n);
  return next;
}

/** The same remap over a ground truth, whose errors name the steps they happened at. */
function shiftGroundTruthSteps(groundTruth, afterN, count) {
  const gt = cloneDeep(groundTruth) || {};
  if (Array.isArray(gt.errors)) {
    gt.errors = gt.errors.map(e => Object.assign({}, e, {
      steps: (Array.isArray(e?.steps) ? e.steps : []).map(n => shiftStepRef(n, afterN, count)),
    }));
  }
  return gt;
}

/**
 * Clone a step across the whole record — both arms and the ground truth, in one move.
 *
 * BOTH ARMS OR NEITHER. The arms have to be the same run or nothing measured across them compares,
 * so a step added to one and not the other would silently make the conditions different tasks. A
 * null non-grounded arm is left null on purpose: it is derived from the grounded one by
 * _stripGuideArm at render, so it inherits the edit rather than needing its own.
 */
function cloneRecordStep(record, afterN, count = 1) {
  const next = cloneDeep(record) || {};
  const times = Math.max(1, Number(count) || 1);
  next.arms = next.arms || {};
  if (!next.arms.grounding) throw new Error('This trajectory has no grounded arm to edit.');
  next.arms.grounding = cloneArmStep(next.arms.grounding, afterN, times);
  if (next.arms.nongrounding) {
    next.arms.nongrounding = cloneArmStep(next.arms.nongrounding, afterN, times);
  }
  next.ground_truth = shiftGroundTruthSteps(next.ground_truth, afterN, times);
  return next;
}

/**
 * Add a written step to the record — same insert, but the action is one you describe rather than
 * one the run already contains.
 *
 * THE NON-GROUNDED ARM GETS THE STEP WITHOUT ITS SCREENSHOT. That arm is defined by having no
 * picture to check an action against (_stripGuideArm), so carrying the image across would hand one
 * condition the very thing the other is denied — and it would be this edit, not the study design,
 * that decided it.
 */
function addRecordStep(record, afterN, step) {
  const next = cloneDeep(record) || {};
  next.arms = next.arms || {};
  if (!next.arms.grounding) throw new Error('This trajectory has no grounded arm to edit.');
  const built = makeStep(step);
  if (!String(built.instruction || '').trim()) throw new Error('Give the step something to say.');
  next.arms.grounding = insertArmSteps(next.arms.grounding, afterN, [built]);
  if (next.arms.nongrounding) {
    next.arms.nongrounding = insertArmSteps(next.arms.nongrounding, afterN,
      [Object.assign({}, built, { screenshot: null })]);
  }
  next.ground_truth = shiftGroundTruthSteps(next.ground_truth, afterN, 1);
  return next;
}

// ── The answer and what backs it ─────────────────────────────────────────────

/** Every [ev:key] marker in a piece of prose, in the order it reads. */
function answerMarkers(text) {
  const out = [];
  String(text || '').replace(/\[ev:\s*([^\]]+)\]/gi, (m, key) => {
    out.push(String(key).trim());
    return m;
  });
  return out;
}

/**
 * Set the agent's answer.
 *
 * BOTH ARMS, because the answer is what the agent reported and that does not change with the
 * condition — only whether the evidence behind it can be opened. The non-grounded copy has its
 * markers stripped, which is what _stripGuideArm does at render time; writing it here keeps a
 * stored non-grounded arm from drifting out of step with the grounded one.
 */
function setAnswer(record, text) {
  const next = cloneDeep(record) || {};
  next.arms = next.arms || {};
  if (!next.arms.grounding) throw new Error('This trajectory has no grounded arm to edit.');
  const answer = String(text == null ? '' : text);
  next.arms.grounding = Object.assign({}, next.arms.grounding, { answer });
  if (next.arms.nongrounding) {
    next.arms.nongrounding = Object.assign({}, next.arms.nongrounding, {
      answer: answer.replace(/\s*\[ev:[^\]]+\]/gi, '').replace(/\s+([.,;:!?])/g, '$1'),
    });
  }
  return next;
}

/** Add a piece of evidence, or replace the one already under that key. */
function upsertEvidence(record, { key, note, screenshot, step } = {}) {
  const next = cloneDeep(record) || {};
  const arm = next.arms?.grounding;
  if (!arm) throw new Error('This trajectory has no grounded arm to edit.');
  const clean = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) throw new Error('Evidence needs a short key — letters, digits and underscores.');
  arm.answer_evidence = Array.isArray(arm.answer_evidence) ? arm.answer_evidence : [];
  const found = arm.answer_evidence.find(e => String(e?.key || '').trim().toLowerCase() === clean);
  const target = found || { key: clean };
  if (note !== undefined) target.note = String(note || '');
  if (screenshot !== undefined) target.screenshot = screenshot;
  if (step !== undefined) target.step = step;
  if (!found) arm.answer_evidence.push(target);
  return next;
}

/**
 * Drop a piece of evidence, and the markers that pointed at it.
 *
 * The marker goes with it. Left behind it would render as nothing — chipify drops a marker whose
 * evidence is missing — so the answer would silently lose a citation while still claiming one in
 * its source, and the next person to edit that text would be reading a lie.
 */
function removeEvidence(record, key) {
  const next = cloneDeep(record) || {};
  const clean = String(key || '').trim().toLowerCase();
  ['grounding', 'nongrounding'].forEach(side => {
    const arm = next.arms?.[side];
    if (!arm) return;
    if (Array.isArray(arm.answer_evidence)) {
      arm.answer_evidence = arm.answer_evidence
        .filter(e => String(e?.key || '').trim().toLowerCase() !== clean);
    }
    if (Array.isArray(arm.answer_segments)) {
      arm.answer_segments = arm.answer_segments
        .filter(s => String(s?.key || '').trim().toLowerCase() !== clean);
    }
    if (typeof arm.answer === 'string') {
      arm.answer = arm.answer
        .replace(new RegExp(`\\s*\\[ev:\\s*${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'gi'), '')
        .replace(/\s+([.,;:!?])/g, '$1');
    }
  });
  return next;
}

/**
 * What does not line up between the answer and its evidence.
 *
 * Two failures, and they look identical on the rendered page — nothing shown — which is why they
 * are worth naming here: a marker with no evidence silently loses a citation, and evidence with no
 * marker is a screenshot nobody can reach.
 */
function answerEvidenceReport(record) {
  const arm = record?.arms?.grounding || {};
  const items = Array.isArray(arm.answer_evidence) ? arm.answer_evidence : [];
  const keys = new Set(items.map(e => String(e?.key || '').trim().toLowerCase()).filter(Boolean));
  const used = answerMarkers(arm.answer).map(k => k.toLowerCase());
  const usedSet = new Set(used);
  return {
    shown: used.filter(k => keys.has(k)).length,
    danglingMarkers: Array.from(new Set(used.filter(k => !keys.has(k)))),
    unusedEvidence: items
      .map(e => String(e?.key || '').trim())
      .filter(k => k && !usedSet.has(k.toLowerCase())),
    withoutShot: items.filter(e => !e?.screenshot).map(e => String(e?.key || '')),
  };
}

/**
 * Record which steps went wrong, and how.
 *
 * Writes the whole answer to Q2 at once — the error list AND the `no_error` flag that contradicts
 * it. Setting one without the other is how a ground truth ends up saying "nothing went wrong" over
 * a list of things that did, which `_guideGroundTruthProblem` cannot score and quietly drops.
 */
function setGroundTruthErrors(groundTruth, errors) {
  const gt = cloneDeep(groundTruth) || {};
  const list = (Array.isArray(errors) ? errors : [])
    .map(e => ({
      type: String(e?.type || '').trim(),
      steps: Array.from(new Set((Array.isArray(e?.steps) ? e.steps : []).map(Number).filter(Number.isFinite)))
        .sort((a, b) => a - b),
    }))
    .filter(e => e.type && e.steps.length);
  gt.errors = list;
  gt.no_error = !list.length;
  return gt;
}

/**
 * What is still wrong with this ground truth, in the recorder's own words, or null.
 *
 * Mirrors _guideGroundTruthProblem (vendor/guide_trajectories.js) so the editor refuses to publish
 * exactly what the scorer refuses to score, plus the one case that function misses: a run marked
 * FAILED with no error localized. That combination is why gv2-msf5mo9m-qm5brt scored as an
 * error-free run for every participant who saw it.
 */
function groundTruthProblem(gt) {
  const t = gt || {};
  if (!t.correctness) return 'No verdict recorded — say whether the agent succeeded.';
  if (t.correctness === 'failure' && !(t.problems || []).length) {
    return 'Marked as failed, but no problem is recorded.';
  }
  if (!t.no_error && !(t.errors || []).length) {
    return 'No answer to “which error” — add an error, or tick “No error”.';
  }
  if ((t.errors || []).some(e => !(Array.isArray(e.steps) && e.steps.length))) {
    return 'An error has no step recorded — say where it happened.';
  }
  if (t.correctness === 'failure' && t.no_error) {
    return 'Marked as failed but carrying no error — a run that failed went wrong somewhere, '
      + 'and localization cannot be scored until it says where.';
  }
  return null;
}

window.TrajectoryEdit = {
  makeStep,
  insertArmSteps,
  cloneArmStep,
  cloneRecordStep,
  addRecordStep,
  updateArmStep,
  updateRecordStep,
  answerMarkers,
  setAnswer,
  upsertEvidence,
  removeEvidence,
  answerEvidenceReport,
  removeArmStep,
  removeRecordStep,
  shiftStepRefOnRemove,
  shiftStepRef,
  shiftGroundTruthSteps,
  setGroundTruthErrors,
  groundTruthProblem,
};
