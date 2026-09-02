// The four authored agent answers a Find V2 claim carries, and the rule that
// decides which one a participant is dealt.
//
// V1 had one recorded answer per task and derived the non-grounded arm from it
// by stripping citation markers. V2 authors all four cells by hand —
// correct/incorrect x grounded/non-grounded — because an incorrect answer is
// not a correct answer with the references removed, and a non-grounded answer
// is not a grounded one with the brackets deleted. The wording of each cell is
// a study variable, so each cell is written rather than computed.
//
// Loaded by the adapter, the welcome screen and the session model, all three of
// which must agree on the key names, or a participant is scored against a
// variant they were not shown.

(function () {
  const KEYS = [
    'correct_grounding',
    'correct_nongrounding',
    'incorrect_grounding',
    'incorrect_nongrounding',
  ];

  const LABELS = {
    correct_grounding: 'Correct · Grounded',
    correct_nongrounding: 'Correct · Non-grounded',
    incorrect_grounding: 'Incorrect · Grounded',
    incorrect_nongrounding: 'Incorrect · Non-grounded',
  };

  const MODES = ['balanced', 'always_correct', 'always_incorrect'];

  function condition(value) {
    return value === 'nongrounding' ? 'nongrounding' : 'grounding';
  }

  function variantKey(correct, arm) {
    return `${correct ? 'correct' : 'incorrect'}_${condition(arm)}`;
  }

  function parseKey(key) {
    return {
      correct: String(key || '').startsWith('correct_'),
      condition: String(key || '').endsWith('_nongrounding') ? 'nongrounding' : 'grounding',
    };
  }

  function correctnessMode(value) {
    return MODES.includes(value) ? value : 'balanced';
  }

  /** One variant out of a claim row, normalized to the shape the player reads. */
  function variantOf(row, key) {
    const all = row && typeof row.answer_variants === 'object' && row.answer_variants
      ? row.answer_variants : {};
    const one = all[key] && typeof all[key] === 'object' ? all[key] : {};
    return {
      answer_text: String(one.answer_text || ''),
      citation_anchors: Array.isArray(one.citation_anchors) ? one.citation_anchors : [],
      evidence: Array.isArray(one.evidence) ? one.evidence : [],
    };
  }

  /** Which of the four cells this row could actually be played in. */
  function authored(row) {
    const out = {};
    KEYS.forEach(key => { out[key] = !!variantOf(row, key).answer_text; });
    // A row saved before the four-variant editor has one answer in the legacy
    // columns. Treat it as authoring the grounded cell of its old key, so an
    // un-migrated project still plays rather than showing a blank answer.
    if (!KEYS.some(key => out[key]) && String(row?.answer_text || '')) {
      out[row?.claim_correct === false ? 'incorrect_grounding' : 'correct_grounding'] = true;
    }
    return out;
  }

  function hasEitherArm(map, correct) {
    return !!(map[variantKey(correct, 'grounding')] || map[variantKey(correct, 'nongrounding')]);
  }

  /**
   * The variant for one task in one sitting.
   *
   * `rotation` is (assignment slot + position in the queue). Taking it mod 4
   * walks correct/grounded -> correct/non-grounded -> incorrect/grounded ->
   * incorrect/non-grounded: the arm flips every task and the correctness key
   * flips every second task, so a queue is balanced within a participant and
   * four consecutive slots cover every cell of every claim.
   *
   * A pinned `correctness_mode`, or a claim missing one side entirely, moves the
   * correctness half only. The arm half stays on the rotation so the grounded /
   * non-grounded split — the comparison the study is actually built on — is not
   * disturbed by an authoring gap.
   */
  function deal(task, rotation) {
    const cell = ((Number(rotation) % 4) + 4) % 4;
    const arm = cell % 2 === 0 ? 'grounding' : 'nongrounding';
    let correct = cell < 2;

    const mode = correctnessMode(task?.correctnessMode);
    if (mode === 'always_correct') correct = true;
    if (mode === 'always_incorrect') correct = false;

    const map = task?.authoredVariants || {};
    if (Object.values(map).some(Boolean) && !hasEitherArm(map, correct) && hasEitherArm(map, !correct)) {
      correct = !correct;
    }
    return { arm, correct, key: variantKey(correct, arm) };
  }

  /**
   * The text and references to show, with the fallbacks that keep a
   * half-authored claim readable instead of blank.
   *
   * Falling back across the grounding axis is safe in one direction only in
   * practice: the shared renderer strips citation markers in the non-grounded
   * arm, so a grounded text shown non-grounded loses its references as intended,
   * while a non-grounded text shown grounded simply has none to show. Both beat
   * an empty answer card, and `fallbackFrom` says which happened so the editor
   * can warn before a claim goes live.
   */
  function resolve(row, correct, arm) {
    const wanted = variantKey(correct, arm);
    const exact = variantOf(row, wanted);
    if (exact.answer_text) return { key: wanted, fallbackFrom: null, ...exact };

    const sameKey = variantKey(correct, arm === 'grounding' ? 'nongrounding' : 'grounding');
    const same = variantOf(row, sameKey);
    if (same.answer_text) return { key: wanted, fallbackFrom: sameKey, ...same };

    const legacyMatches = (row?.claim_correct === true) === (correct === true);
    if (legacyMatches && String(row?.answer_text || '')) {
      return {
        key: wanted,
        fallbackFrom: 'legacy',
        answer_text: String(row.answer_text),
        citation_anchors: Array.isArray(row.citation_anchors) ? row.citation_anchors : [],
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
      };
    }
    return { key: wanted, fallbackFrom: 'missing', answer_text: '', citation_anchors: [], evidence: [] };
  }

  window.FindV2Variants = {
    KEYS, LABELS, MODES,
    condition, variantKey, parseKey, correctnessMode, variantOf, authored, deal, resolve,
  };
}());
