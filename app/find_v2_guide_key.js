// Why a Guide run is keyed incorrect — derived from the recorder's own ground truth.
//
// The Guide task asks ONE question and stores ONE verdict. But the runs it is asked about fail two
// different ways, and the difference is the interesting one:
//
//   MISREPORTED — the answer claims something the run does not support. The agent looked, and then
//                 said a number, a name or an outcome that the steps behind it do not show. Only the
//                 trajectory reveals it, which is precisely what the grounding condition varies.
//   INCOMPLETE  — the job was only part done. Visible in the outcome itself; a participant does not
//                 have to reconstruct what the agent saw to catch it.
//
// Splitting accuracy by those two costs the participant nothing, because the recorder already wrote
// the reason down. Asking them a second question to recover it would have cost a question and, on
// the current pool, measured nothing: every live run keyed correct also claims completion, and every
// run keyed incorrect also claims completion, so a second "does the answer match?" key would have
// landed on the diagonal for all eleven.
//
// SHARED, and loaded by both study.html and index.html on purpose. The player snapshots the mode
// onto each result row and Admin renders it on each card; a second copy of this mapping would be a
// second thing to get wrong, and the two would disagree silently.

(function () {
  const FAILURE_MODES = ['none', 'misreported', 'incomplete', 'could_not_complete', 'unspecified'];

  const FAILURE_LABELS = {
    none: 'Completed',
    misreported: 'Misreported',
    incomplete: 'Incomplete',
    could_not_complete: 'Could not complete',
    unspecified: 'Incorrect · reason not recorded',
  };

  const FAILURE_NOTES = {
    none: 'keyed as having done the job',
    misreported: 'the answer claims something the run does not support — only the trajectory shows it',
    incomplete: 'only part of the job was done',
    could_not_complete: 'did not finish, and said so',
    unspecified: 'keyed incorrect, but the recorder wrote no problem type',
  };

  // Wider than GUIDE_PROBLEM_TYPES declares. vendor/guide_trajectories.js lists three ids, and a
  // fourth — `wrong_result` — is present in the data anyway, so it is mapped here rather than
  // falling through to "reason not recorded" and hiding a run that has one.
  const MISREPORTED = ['hallucinated_result', 'wrong_result'];

  /**
   * Whether the ground truth itself says the run succeeded.
   *
   * TWO DIALECTS ARE LIVE, and neither is going away on its own: runs migrated from V1 by
   * scripts/migrate_guide_v2.mjs carry `correctness: 'success' | 'failure'`, while runs saved by the
   * extension recorder carry `correct: boolean`. Reading only one of them silently misclassifies
   * half the pool, so both are read, and neither is preferred over the authored answer key.
   */
  function groundTruthSucceeded(gt) {
    const g = gt && typeof gt === 'object' ? gt : {};
    if (typeof g.correct === 'boolean') return g.correct;
    if (g.correctness === 'success') return true;
    if (g.correctness === 'failure') return false;
    return null;
  }

  function problemsOf(gt) {
    const g = gt && typeof gt === 'object' ? gt : {};
    return Array.isArray(g.problems) ? g.problems.map(p => String(p || '').trim()).filter(Boolean) : [];
  }

  /**
   * Which of the five buckets this run is in.
   *
   * `agentCompleted` is the AUTHORED ANSWER KEY and outranks the ground truth, because it is what
   * the participant's verdict is actually scored against. A run keyed as completed is `none` even
   * when its recorded problems disagree — the disagreement is a reason to re-key it in Admin, not a
   * reason for this function to overrule the key and quietly score against something else.
   *
   * MISREPORTED WINS over incomplete when both are present. A run whose answer misdescribes what
   * happened is a misreporting item regardless of what else went wrong, because misreporting is the
   * thing the grounding condition exists to catch — and `ms9j3200`, which carries
   * ["wrong_result", "incomplete"], is exactly that run.
   */
  function failureMode(groundTruth, agentCompleted) {
    // Nothing has been keyed yet, so there is no failure to classify and no honest way to guess one.
    if (typeof agentCompleted !== 'boolean') return null;
    if (agentCompleted) return 'none';

    const problems = problemsOf(groundTruth);
    if (problems.some(p => MISREPORTED.includes(p))) return 'misreported';
    if (problems.includes('incomplete')) return 'incomplete';
    if (problems.includes('could_not_complete')) return 'could_not_complete';
    return 'unspecified';
  }

  function label(mode) {
    return FAILURE_LABELS[mode] || '';
  }

  function note(mode) {
    return FAILURE_NOTES[mode] || '';
  }

  window.FindV2GuideKey = {
    FAILURE_MODES, FAILURE_LABELS, FAILURE_NOTES, MISREPORTED,
    groundTruthSucceeded, problemsOf, failureMode, label, note,
  };
}());
