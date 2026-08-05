// The Find task, as a participant answers it.
// ==========================================
// A port of the extension's Answer screen (renderTaskPlayback → renderFindAnswer, sidepanel/study.js)
// onto the snapshot. The participant reads the agent's recorded answer, then does two things that
// are timed separately:
//
//   Q1  — pick the answer they found. Answerable from the agent's answer alone.
//   Q2/3 — point at what supports it, IN THE PAGE. Needs the material.
//
// The split is the measurement: `answer_multiple_choice_ms` is deciding, and
// `find_supporting_answer_ms` is hunting. Grounding should help the second far more than the first,
// and averaging them together hides exactly that.
//
// NOTHING CAN BE SKIPPED. Every stage refuses to advance until it is answered, because a blank is
// not a finding — it is a row that has to be dropped at analysis, and a participant who could skip
// would produce them without ever meaning to.

/** Fisher–Yates, matching _shuffleStudyOptions in the extension. */
function shuffleOptions(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Which arm a task belongs to, from its `type` ("FIND × TEXT" / "FIND X VISUAL"). Casing varies. */
function findTaskArm(task) {
  const type = String(task?.type || '').toUpperCase();
  if (type.includes('VISUAL')) return 'visual';
  if (type.includes('TEXT')) return 'text';
  return null;
}

/**
 * The two supporting questions, and what each is answered with.
 *
 * Both conditions ask for a sentence on hop 1; they diverge on hop 2, because a FIND × VISUAL
 * item's second hop lives in a picture rather than in prose — so that hop asks for the image and is
 * answered by clicking one, not by picking a paragraph.
 */
const EVIDENCE_PROMPTS_BY_ARM = {
  text: [
    { prompt: 'What sentence gives you the answer to the first part?', kind: 'paragraph' },
    { prompt: 'What sentence gives you the answer to the second part?', kind: 'paragraph' },
  ],
  visual: [
    { prompt: 'Choose the evidence that helps answer the first part', kind: 'paragraph' },
    { prompt: 'Choose the image that helps answer the question', kind: 'image' },
  ],
};
const EVIDENCE_PROMPTS_DEFAULT = [
  { prompt: 'Which paragraph supports the first part of the question?', kind: 'paragraph' },
  { prompt: 'Which paragraph supports the final answer?', kind: 'paragraph' },
];

function evidencePrompts(task) {
  const arm = findTaskArm(task);
  return (arm && EVIDENCE_PROMPTS_BY_ARM[arm]) || EVIDENCE_PROMPTS_DEFAULT;
}

/**
 * The answer options: the right one plus its distractors, shuffled.
 *
 * Shuffled per render, so position carries no information — an answer that were always third would
 * be findable without reading the page, which is the one thing this question must not allow.
 */
function answerOptions(task) {
  const correct = String(task?.answer || '').trim();
  const distractors = (Array.isArray(task?.distractors) ? task.distractors : [])
    .map(d => String(d || '').trim())
    .filter(Boolean);
  const all = [correct, ...distractors].filter(Boolean);
  return shuffleOptions(all);
}

window.FindTask = {
  shuffleOptions,
  findTaskArm,
  evidencePrompts,
  answerOptions,
  EVIDENCE_PROMPTS_BY_ARM,
};
