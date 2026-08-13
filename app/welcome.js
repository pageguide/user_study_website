// The welcome screen: identify the participant, build the queue, open the study.
//
// The queue is built HERE rather than on the task screen so a misconfiguration is discovered before
// a participant has been told the study is starting — "there are no tasks" is a far better thing to
// find on this page than after the first click.

const status = document.getElementById('welcome-status');
const startBtn = document.getElementById('start-btn');
const countEl = document.getElementById('welcome-count');
const idInput = document.getElementById('participant-id');
const idToggle = document.getElementById('participant-id-toggle');
const idField = document.getElementById('participant-id-field');
const adminBtn = document.getElementById('admin-btn');
const adminPanel = document.getElementById('admin-panel');

function say(msg, tone = '') {
  status.textContent = msg || '';
  status.className = `welcome-status${tone ? ' welcome-status-' + tone : ''}`;
}

let queue = [];

if (idToggle && idField && idInput) {
  idToggle.onclick = () => {
    idField.hidden = false;
    idToggle.hidden = true;
    idInput.focus();
  };
}

const STYLE_ORDER = [
  { id: 'find_text', label: 'Find x Text' },
  { id: 'find_visual', label: 'Find x Visual' },
  { id: 'guide_text', label: 'Guide x Text' },
  { id: 'guide_visual', label: 'Guide x Visual' },
];

/**
 * Both halves, in the order a participant walks them: Find questions first, then the guide
 * trajectories. Same order the extension builds (_buildTaskQueue → trajectories appended), so a
 * web run and an extension run are the same sequence.
 */
async function buildQueue() {
  const out = [];
  try {
    const tasks = await window.StudyDB.listStudyTasks();
    // answer + distractors ride along: they are what Q1's options are built from, and fetching the
    // task again at question time would be a second round trip for data already in hand.
    tasks.forEach(t => out.push({
      taskType: 'find', id: t.id, title: t.title, question: t.question,
      url: t.url, type: t.type, answer: t.answer, distractors: t.distractors,
      style: studyStyle({ taskType: 'find', type: t.type, title: t.title, question: t.question }),
    }));
  } catch (e) {
    console.warn('[study] no Find tasks:', e.message);
  }
  try {
    const trajectories = await window.StudyDB.listStudyTrajectories();
    trajectories.forEach(t => out.push({
      taskType: 'guide', id: t.id, goal: t.goal, title: t.title, condition: t.condition,
      style: studyStyle({ taskType: 'guide', condition: t.condition, title: t.title, goal: t.goal }),
    }));
  } catch (e) {
    console.warn('[study] no guide trajectories:', e.message);
  }
  return out;
}

function studyStyle(item) {
  const text = `${item?.type || ''} ${item?.condition || ''} ${item?.title || ''} ${item?.goal || ''} ${item?.question || ''}`.toUpperCase();
  const mode = text.includes('VISUAL') ? 'visual' : (text.includes('TEXT') ? 'text' : '');
  if (item?.taskType === 'find') return mode === 'visual' ? 'find_visual' : (mode === 'text' ? 'find_text' : '');
  if (item?.taskType === 'guide') return mode === 'visual' ? 'guide_visual' : (mode === 'text' ? 'guide_text' : '');
  return '';
}

function styleBuckets(list) {
  const buckets = Object.fromEntries(STYLE_ORDER.map(s => [s.id, []]));
  list.forEach(item => {
    if (buckets[item.style]) buckets[item.style].push(item);
  });
  return buckets;
}

function missingStyles(buckets) {
  return STYLE_ORDER.filter(style => !buckets[style.id]?.length).map(style => style.label);
}

function withArm(item, arm, order) {
  return Object.assign({}, item, { arm, assignedOrder: order });
}

/**
 * The eight tasks one participant walks, and the order they walk them in.
 *
 * WHICH task is in WHICH arm comes from the slot: grounded is drawn at `n`, non-grounded at `n + 1`.
 * The offset is what stops a participant meeting the same task twice — once with grounding and once
 * without, where the second encounter would be a memory test rather than a measurement. Rotating `n`
 * across participants is what puts every task through both arms over the sample.
 *
 * WHEN each arm is seen is counterbalanced here, and it did not used to be. This returned all four
 * grounded tasks and then all four non-grounded ones, which left condition perfectly confounded with
 * position: every practice effect — a participant getting quicker as the interface stops being new —
 * and every fatigue effect landed entirely on the non-grounded half. A non-grounded half that came
 * out slower could not be told apart from a first half that was slower because it came first.
 *
 * So the arms INTERLEAVE, a style at a time, and which arm leads each pair alternates by slot. The
 * interleave evens out the drift within a session; the alternation stops "grounded goes first"
 * from being true of every participant. The slot is already the counterbalancing handle, so neither
 * needs any state that is not here.
 */
function buildRoundRobinQueue(list, slot) {
  const buckets = styleBuckets(list);
  const missing = missingStyles(buckets);
  if (missing.length) throw new Error(`Missing published study questions for: ${missing.join(', ')}.`);
  const n = Math.max(0, Number(slot) || 0);
  // Kept in step with the condition_order label built by claim_study_assignment
  // (supabase_results_v2.sql) — the same `slot % 2` rule names the layout there.
  const arms = n % 2 === 0
    ? ['grounding', 'nongrounding']
    : ['nongrounding', 'grounding'];

  const queue = [];
  STYLE_ORDER.forEach(style => {
    const bucket = buckets[style.id];
    const byArm = {
      grounding: bucket[n % bucket.length],
      nongrounding: bucket[(n + 1) % bucket.length],
    };
    // assignedOrder is the position the participant actually meets it in, so it stays usable as a
    // covariate for the very order effect the interleave exists to spread.
    arms.forEach(arm => queue.push(withArm(byArm[arm], arm, queue.length)));
  });
  return queue;
}

window.__studyDebugBuckets = async function __studyDebugBuckets() {
  const list = await buildQueue();
  const buckets = styleBuckets(list);
  return {
    total: list.length,
    styles: Object.fromEntries(Object.entries(buckets).map(([key, rows]) => [
      key,
      rows.map(row => ({ id: row.id, taskType: row.taskType, type: row.type, condition: row.condition, style: row.style })),
    ])),
    missing: missingStyles(buckets),
  };
};

async function init() {
  if (window.__configMissing || !window.StudyDB.supabaseConfigured()) {
    startBtn.disabled = true;
    say('This site is not configured yet: copy app/config.example.js to app/config.js and fill in '
      + 'your Supabase URL and anon key.', 'bad');
    return;
  }
  try {
    queue = await buildQueue();
  } catch (e) {
    startBtn.disabled = true;
    say(`Could not load the tasks: ${e.message}`, 'bad');
    return;
  }
  if (!queue.length) {
    startBtn.disabled = true;
    say('Nothing has been published yet. From the extension\'s recorders, press ⬆ Publish find and '
      + '⬆ Publish guide with the publish helper running.', 'bad');
    return;
  }
  const buckets = styleBuckets(queue);
  const missing = missingStyles(buckets);
  if (missing.length) {
    startBtn.disabled = true;
    say(`Missing published study questions for: ${missing.join(', ')}.`, 'bad');
    return;
  }
  startBtn.disabled = false;
  countEl.textContent = '8 questions: 4 grounded · 4 non-grounded · about 16 minutes';

  if (window.StudyAdmin.isAdmin()) showAdminPanel();
}

// ── Admin ──
// A reviewer's door. It grants no privilege over the data — the stimuli it reads are anon-readable
// to every visitor — so its one real power is to NOT write, which is exactly what a reviewer
// clicking through sixteen tasks needs. See app/admin.js on why the password is a speed bump.

function adminEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showAdminPanel() {
  const o = window.StudyAdmin.adminOptions();
  // THE TABS ARE THE PERMISSION. A narrow password does not merely hide the other tab — the tab
  // strip is built from what the role may open, and the branch below is chosen from the same list.
  // That matters because `tab` is remembered in sessionStorage: an earlier full unlock leaves
  // `tab: 'review'` sitting there, and a hide-only version would drop the next, narrower unlock
  // straight into the recorder.
  const allowed = window.StudyAdmin.adminTabs();
  if (!allowed.length) return showAdminLogin();
  const tab = allowed.includes(o.tab) ? o.tab : allowed[0];
  const label = {
    review: 'Review tasks', viz: 'Visualizations',
    edit: 'Edit trajectory', findtask: 'Edit Find task',
  };
  const title = allowed.length > 1 ? 'Admin' : label[tab];
  const warn = tab === 'viz' ? 'read-only — results dashboard'
    : tab === 'findtask' ? 'writes the stimuli — changes what participants are shown'
      : 'review mode writes nothing';

  adminPanel.hidden = false;
  adminPanel.innerHTML = `
    <div class="admin-title">🔓 ${adminEsc(title)} <span class="admin-warn">${warn}</span></div>
    ${allowed.length > 1 ? `<div class="admin-tabs" id="admin-tabs">
      ${allowed.map(id => `
        <button class="admin-tab${tab === id ? ' admin-tab-on' : ''}" data-admin-tab="${id}">${label[id]}</button>`).join('')}
    </div>` : ''}
    <div id="admin-content"></div>`;

  adminPanel.querySelectorAll('[data-admin-tab]').forEach(b => {
    b.onclick = () => {
      window.StudyAdmin.setAdminOptions({ tab: b.dataset.adminTab });
      showAdminPanel();
    };
  });

  if (tab === 'viz') {
    showAdminVisualizations();
    return;
  }
  if (tab === 'edit') {
    showTrajectoryEditor();
    return;
  }
  if (tab === 'findtask') {
    showFindTaskEditor();
    return;
  }
  showAdminReviewControls();
}

function showAdminReviewControls() {
  const o = window.StudyAdmin.adminOptions();
  const content = document.getElementById('admin-content');
  content.innerHTML = `
    <label class="welcome-label">Which tasks?</label>
    <div class="admin-row" id="admin-half">
      ${[['all', 'Everything'], ['find', '🔍 Find only'], ['guide', '📘 Guide only']].map(([id, label]) => `
        <button class="admin-chip${o.half === id ? ' admin-chip-on' : ''}" data-half="${id}">${label}</button>`).join('')}
    </div>
    <label class="welcome-label">Which arm?</label>
    <div class="admin-row" id="admin-arm">
      ${[['grounding', 'Grounded'], ['nongrounding', 'Non-grounded']].map(([id, label]) => `
        <button class="admin-chip${o.arm === id ? ' admin-chip-on' : ''}" data-arm="${id}">${label}</button>`).join('')}
    </div>
    <button class="welcome-btn" id="admin-go">Review →</button>
    <div class="admin-row">
      <button class="admin-chip" id="admin-tutorial">▶ Preview the walkthrough</button>
      <button class="admin-chip" id="admin-endscreen">🏁 View the end screen</button>
    </div>
    <button class="admin-exit" id="admin-exit">Leave admin mode</button>`;

  content.querySelectorAll('[data-half]').forEach(b => {
    b.onclick = () => { window.StudyAdmin.setAdminOptions({ half: b.dataset.half }); showAdminPanel(); };
  });
  content.querySelectorAll('[data-arm]').forEach(b => {
    b.onclick = () => { window.StudyAdmin.setAdminOptions({ arm: b.dataset.arm }); showAdminPanel(); };
  });
  // The walkthrough on its own, so its wording can be checked without claiming a round-robin slot —
  // the one thing "Review →" cannot do, since it needs published tasks and this needs none.
  document.getElementById('admin-tutorial').onclick = () => {
    location.href = 'study.html?tutorial=preview';
  };
  // The screen a participant reaches after the eighth task — the thank-you and the questionnaire —
  // without answering eight tasks to get to it. Needs no session for the same reason the walkthrough
  // preview does not: nothing on it is drawn from the run.
  document.getElementById('admin-endscreen').onclick = () => {
    location.href = 'study.html?finish=preview';
  };
  document.getElementById('admin-exit').onclick = () => {
    window.StudyAdmin.revokeAdmin();
    adminPanel.hidden = true;
    adminPanel.innerHTML = '';
  };
  document.getElementById('admin-go').onclick = () => {
    const opts = window.StudyAdmin.adminOptions();
    const filtered = window.StudyAdmin.filterQueueByHalf(queue, opts.half);
    if (!filtered.length) { say(`Nothing published for "${opts.half}".`, 'bad'); return; }
    Object.assign(window.StudySession.state, {
      // A reviewer is not a participant. The id says so in the data too, in case a write ever slips
      // through a future change — it should be obvious in the table, not inferred.
      participantId: 'ADMIN-REVIEW',
      sessionId: null,
      arm: opts.arm,
      queue: filtered,
      idx: 0,
      results: [],
      adminReview: true,
    });
    window.StudySession.saveReview();
    location.href = 'study.html';
  };
}

let adminVizRows = [];
/** When adminVizRows last came off the wire, so the pane can prove it is current. */
let vizLoadedAt = null;
/** task_id → how many pictures its material holds. Empty until the image_count columns exist. */
let taskImageCounts = new Map();
/** task_id → {citations, evidence} in the grounded agent answer. Empty until the pane loads. */
let taskReferenceCounts = new Map();

/**
 * Which tasks each card counts, when the answer should not rest on all of them.
 *
 * Keyed by facet; a facet absent from here uses every task it has, which is the default and the
 * honest one. This exists because a task can be broken in a way the numbers cannot see — a
 * mis-annotated ground truth, a question two participants read differently, a page that changed
 * under the study — and the choice to drop it belongs to the researcher, not to a heuristic.
 *
 * Held in memory only. A filter that survived a reload would silently keep excluding a task long
 * after the reason was forgotten, and every number on the card would quietly be about a different
 * study than the one it names. The banner on the card says when one is active for the same reason.
 */
const facetTaskFilters = new Map();   // facetKey -> Set(task_id)
const facetPickerOpen = new Set();

/**
 * Tasks a facet leaves out unless somebody ticks them back on, and why.
 *
 * EVERY ENTRY CARRIES ITS REASON, in a `why` short enough to print on the card. That is the whole
 * design: this is the researcher's call rather than a heuristic — nothing in the numbers says a
 * duplicate goal or an awkward annotation is wrong to count — so the alternative to writing the
 * reason down is a filter somebody ticked once and nobody can account for a month later.
 *
 * The card still SAYS it is doing this. The "Counting 5 of 8 tasks" banner and its "Use all tasks"
 * button are the same ones a hand-made filter raises, so a default exclusion is exactly as visible
 * and as reversible as a manual one. It is a default, not a lock.
 */
const FACET_TASK_EXCLUSIONS = {
  // MARS-v1 is the study's clearest disputed key. Four of its sixteen answers are wrong and all four
  // are the SAME wrong answer — "18" where the key says "20". Four people arriving independently at
  // one number is not four mistakes; it is a question the page supports two readings of, and until
  // the key is settled the task measures the disagreement rather than the condition.
  //
  // MUFC-V1-TEXT is the same Wikipedia article as MUFC-V1 in Find × Visual — one snapshot, asked
  // twice (see getTaskPage in app/supabase.js, which serves them from a single captured page). A
  // participant who drew both read that article twice, and the second reading is not a cold one, so
  // counting it here mixes a re-read into a facet whose whole measure is time to locate.
  find_text: {
    ids: ['MARS-v1', 'MUFC-V1-TEXT'],
    why: 'a disputed answer key, and the page already read in Find × Visual',
  },

  // WHAT IS LEFT IS FOUR GOALS, RECORDED ONCE EACH: Austin hotels (gv2-ed05972e-i5fi3b), the
  // Business/Movies/Technology search (gv2-ed35d549-ct71ub), the shopping cart (gv2-ms9hwloh-15fuvy)
  // and the Marry Me Chicken recipe (gv2-ms9j3200-u0i9nm). Three of the four dropped runs are second
  // recordings of goals still counted:
  //
  //     gv2-ms9iw0pq-5kj5zr   "three 4-star hotels in Austin"     also gv2-ed05972e-i5fi3b
  //     gv2-msf5mo9m-qm5brt   "Business, Movies and Technology"   also gv2-ed35d549-ct71ub
  //     gv2-msf02a2n-88li4p   "top 3 attractions for New York"    also gv2-ed05a7b6-kk24zp
  //
  // Counting both copies of a goal weights it double against the goals recorded once, so the mean
  // stops being a mean over the card's questions. gv2-msf5mo9m-qm5brt is worse than redundant: three
  // non-grounded runs and no grounded one, so every row it contributes can only move one arm.
  //
  // THE FOURTH IS THE WHOLE NEW YORK GOAL. Both of its recordings are dropped, so unlike the others
  // this removes a question from the card rather than a duplicate of one. That is the researcher's
  // call and nothing in the data forces it — if you are reading this wanting to know why, the answer
  // is not here, and it should be: put it in this comment when you know it.
  guide_text: {
    ids: ['gv2-ed05a7b6-kk24zp', 'gv2-ms9iw0pq-5kj5zr', 'gv2-msf02a2n-88li4p', 'gv2-msf5mo9m-qm5brt'],
    why: 'three duplicate re-recordings, plus both recordings of the New York goal',
  },

  // gv2-msf1pyqv-omt0hz — the Tampa run — is the only trajectory in this facet whose ground truth
  // blames ONE STEP UNDER TWO ERROR TYPES: loop at 2,3,4,8,9 and mismatch at 4,10, so step 4 is
  // named twice. Step recall counts `type:step` pairs, which makes (loop,4) and (mismatch,4) two
  // separate things to find — so a participant who sees that step 4 went wrong and attributes it to
  // one of the two is scored as having missed the other. Nobody can score full recall on that run
  // without naming both types for the same step, and no other run in the facet asks that.
  guide_visual: {
    ids: ['gv2-msf1pyqv-omt0hz'],
    why: 'a run whose ground truth blames one step under two error types, so no participant can '
      + 'score it in full',
  },
};

function facetKey(spec) {
  return `${spec.taskType}_${spec.style}`;
}

/**
 * The task ids a facet counts right now, or null for "all of them".
 *
 * THREE STATES, NOT TWO. A facet is either using its default (no entry in facetTaskFilters, so the
 * exclusions above apply), or carrying an explicit choice somebody made with the tick boxes. That
 * explicit choice includes "actually, all of them" — which is why "Use all tasks" writes a full set
 * rather than deleting the entry. Deleting it would hand the card straight back to the defaults, so
 * the button would appear to do nothing on exactly the facet that has any.
 */
function chosenTasksFor(key, facetRows) {
  if (facetTaskFilters.has(key)) return facetTaskFilters.get(key);
  const excluded = FACET_TASK_EXCLUSIONS[key]?.ids;
  if (!excluded || !excluded.length) return null;
  const ids = Array.from(new Set(facetRows.map(r => String(r.task_id || '')).filter(Boolean)));
  const kept = ids.filter(id => !excluded.includes(id));
  // Nothing to drop — a deployment whose pool no longer holds these ids gets the honest default.
  return kept.length === ids.length ? null : new Set(kept);
}


/**
 * A number, or null if there isn't one. NULL AND '' ARE NOT ZERO.
 *
 * `Number(null)` is 0 in JavaScript, and `Number.isFinite(0)` is true, so the obvious version of
 * this let every unrecorded score into the averages as a zero. It mattered most where nulls are
 * legitimate: a Guide row on which the participant correctly said "no error" has nothing to
 * localize, so score_type_recall and score_step_recall are null — and a perfect judgment was being
 * averaged in as 0% localization. Guide × Text read "0% → 11% (n 8 vs 9)" when the rows that
 * actually carry the measure say "0% → 20% (n 1 vs 5)": a different number, and an n far below
 * MIN_CELL_N that the card should be refusing to draw a conclusion from.
 *
 * A missing measurement has to leave the average rather than land in it, or "we did not record
 * this" and "they scored nothing" become the same reading.
 */
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function avgValues(values) {
  const vals = values.map(num).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function avg(rows, key) {
  return avgValues(rows.map(r => r?.[key]));
}

function boolRate(rows, keyOrFn) {
  const vals = rows.map(r => typeof keyOrFn === 'function' ? keyOrFn(r) : r?.[keyOrFn])
    .filter(v => v === true || v === false);
  if (!vals.length) return null;
  return vals.filter(Boolean).length / vals.length;
}

/**
 * A rate as a percentage, to two decimals.
 *
 * TWO DECIMALS BECAUSE THE CELLS ARE SMALL. At n = 20–39 rows, one answer is worth 2.5 to 5 points,
 * so a rounded "60% → 64%" and the true "60.00% → 64.29%" differ by less than the weight of a
 * single participant — and rounding invites the reader to treat a four-point gap as a finding when
 * it is one row. The counts and the interval printed beside it say the same thing; this stops the
 * headline number from being the one figure on the card that hides its own precision.
 *
 * Chart AXES do not use this — see pctAxis. A tick reading "50.00%" is two decimals of nothing.
 */
function pct(value) {
  return value == null ? 'No data' : `${(value * 100).toFixed(2)}%`;
}

/** The same rate for an axis tick, where the decimals are noise: "0%", "50%", "100%". */
function pctAxis(value) {
  return value == null ? 'No data' : `${Math.round(value * 100)}%`;
}

function oneDecimal(value) {
  return value == null ? 'No data' : String(Math.round(value * 10) / 10);
}

function seconds(value) {
  return value == null ? 'No data' : `${Math.round(value / 1000)}s`;
}

function points(value) {
  // One decimal, not two: this is a GAP between two percentages, and it is quoted in sentences
  // ("11.1 pts better") where a second decimal is noise. It also sets the chart's flatness test —
  // a delta that prints as 0.0 pts is called "no change" rather than given a direction.
  return value == null ? 'No data' : `${(value * 100).toFixed(1)} pts`;
}

/**
 * The style a result row belongs to: text or visual.
 *
 * `task_style` is written by the site as `guide_text` / `find_visual` / … and is the answer whenever
 * it is there. It is often NOT there: a database that predates the column rejects the whole row for
 * it, so insertStudyResult drops it and saves the answer without it (see supabase.js). Every such
 * row is still classifiable, because the stimulus it came from carries the condition — which is what
 * the second lookup does, against the same list the queue was built from.
 *
 * The guesses after that are last resorts, and they are why the guide half read "Unlabeled" while
 * the find half did not: a Find id says TEXT in it and Find evidence says `image`, but a guide
 * trajectory id (`gv2-msf0vpxs-qucehj`) says nothing at all.
 */
function taskStyle(row) {
  const explicit = String(row?.task_style || '').toLowerCase();
  if (explicit.includes('visual')) return 'visual';
  if (explicit.includes('text')) return 'text';

  const fromStimulus = String(stimulusStyleById().get(String(row?.task_id || '')) || '');
  if (fromStimulus.includes('visual')) return 'visual';
  if (fromStimulus.includes('text')) return 'text';

  const id = String(row?.task_id || '').toLowerCase();
  if (id.includes('text')) return 'text';
  const evidence = Array.isArray(row?.evidence_responses) ? row.evidence_responses : [];
  if (evidence.some(e => String(e?.kind || '').toLowerCase() === 'image')) return 'visual';
  if (row?.task_type === 'find' && evidence.length) return 'text';
  return 'unknown';
}

/**
 * task_id → style, from the stimulus lists the welcome screen already fetched to build the queue.
 * No extra request: `queue` is in memory by the time anyone can open the dashboard.
 */
let stimulusStyleCache = null;

function stimulusStyleById() {
  if (stimulusStyleCache && stimulusStyleCache.size) return stimulusStyleCache;
  stimulusStyleCache = new Map();
  (Array.isArray(queue) ? queue : []).forEach(item => {
    if (item?.id && item?.style) stimulusStyleCache.set(String(item.id), item.style);
  });
  return stimulusStyleCache;
}

/** Rows saved before the column existed, and therefore leaning on the fallback above. */
function rowsMissingStyle(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => !String(r?.task_style || '').trim()).length;
}

function answerCorrect(row) {
  if (row?.task_type === 'find') return row.score_answer_correct;
  if (row?.task_type === 'guide') return row.score_verdict_correct;
  return null;
}

/**
 * The two timed stages of a task, and the whole of it.
 *
 * JUDGE is `answer_multiple_choice_ms` — deciding the answer from what the agent reported.
 * LOCATE is `find_supporting_answer_ms` — then pointing at what backs it, in the page.
 *
 * The split IS the measurement: grounding should help the second far more than the first, and a
 * single combined duration hides exactly that. app/find_task.js says the same thing from the
 * recording side, which is why the two are timed apart in the first place.
 *
 * BEWARE THE COLUMN CALLED `answer_time_ms`. It is not the answering stage — it is the whole task,
 * and it duplicates `time_ms` byte for byte on every row. The answering STAGE is
 * `answer_multiple_choice_ms`. Reading the obvious-looking column would silently report the total
 * as if it were one half of itself.
 *
 * Total is summed from the two stages rather than read off `time_ms`, so it can never disagree with
 * the parts printed beside it. It is null unless BOTH stages are present: a total missing one of
 * its halves is just the other half wearing a bigger label.
 */
/**
 * The passive traces of HOW a task was worked, not just how long it took.
 *
 * Time says a task was hard; these say what the participant did about it. Scrolling and Ctrl-F are
 * hunting — a reader who cannot see where the answer is goes looking for it — so grounding should
 * bring them DOWN even where it does not move the clock. That makes them the measure most likely to
 * show an effect the timings are too noisy to carry.
 *
 * `column` is the flat copy, preferred when present; the jsonb is the fallback for rows written
 * before those columns existed. Reading only one of the two would quietly drop half the study.
 */
const BEHAVIOR_METRICS = [
  { key: 'scroll_count', column: 'scroll_user_count', label: 'Scrolls', short: 'scrolls' },
  { key: 'ctrl_f_count', column: 'ctrl_f_count', label: 'Ctrl-F', short: 'Ctrl-F uses' },
  { key: 'text_select_count', column: 'text_select_count', label: 'Selections', short: 'text selections' },
  { key: 'click_count', column: 'click_count', label: 'Clicks', short: 'clicks' },
  { key: 'mouse_move_px', column: 'mouse_move_px', label: 'Mouse travel', short: 'mouse travel' },
];

/**
 * The two post-task scales, as numbers: what the participant SAID about a task.
 *
 * 4 is the good end of both — very confident, very useful — and 1 the bad end, matching the order
 * the options are shown in (POST_TASK_CONFIDENCE / POST_TASK_HELPFULNESS, app/study.js). Averaging
 * these ASSUMES THE STEPS ARE EVEN, which an ordinal scale cannot promise: the distance from "very"
 * to "somewhat" is not measurably the distance from "not sure" to "mostly guessing". The mean is
 * printed as x.x/4 rather than as a percentage so it keeps saying which scale it came off, and it
 * belongs beside the behavioural counts — what someone felt, next to what they did.
 *
 * Unanswered is null, not zero. Both questions are required, so a null here is a row written before
 * the question existed, and scoring it as "no confidence at all" would invent the worst answer on
 * the scale for a participant who was never asked.
 */
const SELF_REPORT_METRICS = [
  {
    field: 'confidence',
    label: 'Confidence',
    short: 'confidence in their own answer',
    values: { very: 4, somewhat: 3, notsure: 2, guessed: 1 },
  },
  {
    field: 'helpfulness',
    label: 'Usefulness',
    short: 'usefulness of what was shown',
    values: { very: 4, somewhat: 3, notmuch: 2, notatall: 1 },
  },
];

function selfReportValue(row, metric) {
  const key = String(row?.[metric.field] || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(metric.values, key) ? metric.values[key] : null;
}

/** A point on a four-point scale, said as one — never as a bare number or a percentage. */
function scaleOf4(value) {
  return value == null ? 'No data' : `${value.toFixed(1)}/4`;
}

function behaviorValue(row, key, column) {
  const flat = column ? num(row?.[column]) : null;
  return flat == null ? num(row?.interaction_summary?.[key]) : flat;
}

/** Pixels of pointer travel, in a unit a person can hold in their head. */
function pixels(value) {
  if (value == null) return 'No data';
  return value >= 10000 ? `${(value / 1000).toFixed(1)}k px` : `${Math.round(value)} px`;
}

function judgeTime(row) { return num(row?.answer_multiple_choice_ms); }
function locateTime(row) { return num(row?.find_supporting_answer_ms); }
function totalTime(row) {
  const judge = judgeTime(row);
  const locate = locateTime(row);
  return judge == null || locate == null ? null : judge + locate;
}

/**
 * F1 over one precision/recall pair — the harmonic mean, not the arithmetic one.
 *
 * WHY HARMONIC. An unweighted mean of the two rates scores a lopsided answer the same as an even
 * one: blaming nine steps to catch the two real ones is recall 1.00 and precision 0.22, which the
 * arithmetic mean calls 0.61 and F1 calls 0.36. The whole point of the measure is that whichever
 * rate is worse drags the number down, so it cannot be won by over-claiming.
 *
 * A NULL PRECISION IS A ZERO, NOT AN UNKNOWN, and this is the one thing here that must not be got
 * wrong. _setScore returns `answer.size ? hit / answer.size : null` (vendor/guide_trajectories.js),
 * so precision is null exactly when the participant PREDICTED NOTHING — which is 70 of 130 guide
 * rows for types and 86 for steps, not an edge case. Undefined precision therefore always means
 * zero true positives, and the F1 of zero true positives is 0. Returning null instead would drop
 * most of the guide data out of its own average without a word.
 *
 * Null recall is the opposite case and IS an unknown: it means the ground truth had nothing to
 * find, so there is no question for this row to have answered. That row leaves the average, and on
 * the guide side evidenceQuality catches it with the no-error branch below.
 */
function f1(precision, recall) {
  const r = num(recall);
  if (r == null) return null;
  const p = num(precision);
  if (p == null || p + r === 0) return 0;
  // Clamped because score_step_precision divides an occurrence count by a set size, so a step
  // listed twice under one type can push it over 1 — nothing in the data does today, but this
  // number is now a headline and a quality above 100% would be read as a bug in the dashboard.
  return Math.min(1, Math.max(0, (2 * p * r) / (p + r)));
}

/**
 * Did the participant place the failure correctly — INCLUDING placing it nowhere?
 *
 * Find is F1 over the passages they picked. Guide is the mean of two F1s — over the error types
 * they named, and over the steps they blamed — because those are two different claims measured
 * against two different denominators, and pooling them into one ratio would hide which of the two
 * a facet is actually failing at.
 *
 * FIND'S F1 IS ITS PRECISION AND ITS RECALL, on every row collected so far. Q1b will not submit
 * without a pick for both hops, so picks-made equals hops-expected and the two rates are equal by
 * construction. The formula is written as F1 anyway: it is what the measure IS, and it starts to
 * differ the moment a hop can be skipped or a hop can take more than one passage.
 *
 * A run that contains no error has no denominator on either side, and three of the five Guide × Text
 * runs contain none. Scored on the F1s alone those rows drop out and the facet decides a verdict
 * from 2 rows against 7 — so a run with nothing to localize is scored on the judgment it DOES
 * afford: saying "no error" when there was none is a correct placement and counts in full; claiming
 * one that was not there counts as zero. That is what `no_error_agreement` already records.
 *
 * KNOW WHAT THIS POOLS. A binary "correctly saw nothing wrong" and a partial F1 are not the same
 * difficulty, so a facet whose runs are mostly error-free scores high on the easy half. That is only
 * safe while both arms draw the same mix of runs — and on Guide × Text they currently do not. Read
 * that facet with the task pool in view, not as a clean arm comparison.
 */
function evidenceQuality(row) {
  if (row?.task_type === 'find') {
    return f1(row.score_evidence_precision, row.score_evidence_recall);
  }
  if (row?.task_type === 'guide') {
    const balanced = avgValues([
      f1(row.score_type_precision, row.score_type_recall),
      f1(row.score_step_precision, row.score_step_recall),
    ]);
    if (balanced != null) return balanced;
    const agreed = row.score_no_error_agreement;
    return agreed == null ? null : (agreed ? 1 : 0);
  }
  return null;
}

function rowsFor(rows, filters) {
  const q = String(filters.search || '').trim().toLowerCase();
  // Computed over the WHOLE set that was handed in, before any other filter narrows it: whether a
  // sitting finished all eight tasks is a fact about the sitting, not about the slice being read.
  const finished = filters.completeOnly ? completeSessionKeys(rows) : null;
  return rows.filter(row => {
    if (finished && !finished.has(sessionKey(row))) return false;
    if (filters.taskType !== 'all' && row.task_type !== filters.taskType) return false;
    if (filters.condition !== 'all' && row.condition !== filters.condition) return false;
    if (filters.style !== 'all' && taskStyle(row) !== filters.style) return false;
    if (filters.participant !== 'all' && String(row.participant_id) !== filters.participant) return false;
    if (!q) return true;
    return [row.participant_id, row.task_id, row.task_type, row.condition, row.question_or_task]
      .some(v => String(v || '').toLowerCase().includes(q));
  });
}

function currentVizFilters() {
  return {
    taskType: document.getElementById('viz-filter-task')?.value || 'all',
    condition: document.getElementById('viz-filter-condition')?.value || 'all',
    style: document.getElementById('viz-filter-style')?.value || 'all',
    participant: document.getElementById('viz-filter-participant')?.value || 'all',
    search: document.getElementById('viz-filter-search')?.value || '',
    completeOnly: vizCompleteOnly,
  };
}

/**
 * Keep only the sittings that got all the way through — the button next to the filters.
 *
 * Most of the noise in this table is abandonment: a session row is written the instant Start is
 * pressed, so someone who answers two tasks and closes the tab leaves two real rows behind. Those
 * rows are not wrong, but they are a different population from the people who finished, and they
 * land unevenly across the arms (whoever quits early quits during whichever tasks came first),
 * which is exactly the shape that moves a mean without meaning anything.
 *
 * Held in memory only, like the per-card task filters: a filter that survived a reload would keep
 * silently excluding people long after the reason was forgotten.
 */
let vizCompleteOnly = false;

const TASKS_PER_SESSION = 8;

/**
 * One study sitting, as a key. Mirrors participantCount: session_id when the assignment RPC
 * answered, client_run_id for a row written when it did not, and null for neither — a row with no
 * key cannot be shown to belong to a finished sitting, so completeOnly drops it.
 */
function sessionKey(row) {
  if (row?.session_id != null) return `s${row.session_id}`;
  if (row?.client_run_id) return `r${row.client_run_id}`;
  return null;
}

/**
 * The sittings with all eight tasks answered.
 *
 * Counts DISTINCT task_id per session, not rows: a task retried or written twice would otherwise
 * push an unfinished sitting over the line.
 */
function completeSessionKeys(rows) {
  const tasks = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const key = sessionKey(row);
    const task = String(row?.task_id || '').trim();
    if (!key || !task) return;
    if (!tasks.has(key)) tasks.set(key, new Set());
    tasks.get(key).add(task);
  });
  return new Set(Array.from(tasks).filter(([, t]) => t.size >= TASKS_PER_SESSION).map(([key]) => key));
}

/** All sittings present in a set of rows, finished or not. */
function allSessionKeys(rows) {
  return new Set((Array.isArray(rows) ? rows : []).map(sessionKey).filter(Boolean));
}

/* One question per block, and every block compares the same two things in the same order:
   non-grounded on the left, grounded on the right. Colors are fixed to the condition so a
   filter never repaints a series. Validated as a categorical pair against the white card. */
const VIZ_INK = {
  grounded: '#2a78d6',
  nongrounded: '#eb6834',
  groundedSoft: 'rgba(42, 120, 214, 0.3)',
  nongroundedSoft: 'rgba(235, 104, 52, 0.3)',
  judge: '#86b6ef',
  locate: '#1c5cab',
  rule: '#c3c2b7',
  grid: '#e1e0d9',
  muted: '#898781',
  good: '#006300',
  bad: '#c0392f',
  surface: '#ffffff',
};

/* Below this many rows in a cell we show the marks but refuse to draw a conclusion from
   them: hollow dots, and the verdict degrades to "not enough yet". */
const MIN_CELL_N = 3;

const VIZ_STYLES = ['text', 'visual', 'unknown'];
const VIZ_STYLE_LABEL = { text: 'Text', visual: 'Visual', unknown: 'Unlabeled' };

function conditionRows(rows, condition) {
  return rows.filter(r => r.condition === condition);
}

/**
 * How many PEOPLE are behind a set of rows, counted by distinct session_id.
 *
 * The `n` on a card counts ROWS, and rows are not participants: one sitting writes eight of them,
 * so "n 8 vs 9" can be nine people or it can be two. Both numbers are worth showing and they answer
 * different questions — n says how much the average rests on, participants says how far it
 * generalises.
 *
 * session_id is the right key because it is one study sitting, which is what a participant is here.
 * participant_id is not: it is optional and nearly every row carries the default `anon`, so counting
 * it would report one participant for the whole study. client_run_id is the fallback for a row
 * written when the assignment RPC was unreachable and no session row exists.
 */
function participantCount(rows) {
  return allSessionKeys(rows).size;
}

/* Booleans count as 1/0 so accuracy and duration go through the same path. */
function metricValues(rows, metricFn) {
  return rows
    .map(metricFn)
    .map(v => (v === true ? 1 : v === false ? 0 : num(v)))
    .filter(v => v != null);
}

function cellFor(rows, metricFn) {
  const values = metricValues(rows, metricFn);
  return { mean: avgValues(values), n: values.length, values, rows: rows.length };
}

/* The study asks four separate questions — Find x Text, Find x Visual, Guide x Text,
   Guide x Visual — so style is a row here, not a filter you have to remember to set. */
function facetCells(rows, metricFn) {
  const cells = [];
  ['find', 'guide'].forEach(taskType => {
    VIZ_STYLES.forEach(style => {
      const facet = rows.filter(r => r.task_type === taskType && taskStyle(r) === style);
      if (!facet.length) return;
      cells.push({
        key: `${taskType}-${style}`,
        label: `${taskType === 'find' ? 'Find' : 'Guide'} · ${VIZ_STYLE_LABEL[style]}`,
        grounded: cellFor(conditionRows(facet, 'grounding'), metricFn),
        nongrounded: cellFor(conditionRows(facet, 'nongrounding'), metricFn),
      });
    });
  });
  return cells;
}

function pooledCells(rows, metricFn) {
  return {
    grounded: cellFor(conditionRows(rows, 'grounding'), metricFn),
    nongrounded: cellFor(conditionRows(rows, 'nongrounding'), metricFn),
  };
}

function cellsAreThin(cells) {
  if (!cells.length) return true;
  return cells.some(c => c.grounded.n < MIN_CELL_N || c.nongrounded.n < MIN_CELL_N);
}

function thinnestCell(cells) {
  return cells.reduce((min, c) => Math.min(min, c.grounded.n, c.nongrounded.n), Infinity);
}

function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  return (Math.ceil((value / magnitude) * 2) / 2) * magnitude;
}

function emptySvg(width, height, message) {
  return `<svg class="viz-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${adminEsc(message)}">
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="viz-svg-label">${adminEsc(message)}</text>
  </svg>`;
}

function legendHtml(items) {
  return `<div class="viz-legend">${items.map(i => `<span><i style="background:${i.color}"></i>${adminEsc(i.label)}</span>`).join('')}</div>`;
}

/* The hover payload travels as JSON on the mark's hit target and is turned into DOM with
   textContent at read time — task ids and titles are participant-facing data, never markup. */
function tipData(payload) {
  return `data-tip="${adminEsc(JSON.stringify(payload))}" tabindex="0" role="button"`;
}

/* One row per facet: the two dots are the two conditions and the rule between them IS the
   effect. Individual rows sit behind the means as faint dots, so two lucky trials can never
   look like a finding. */
function svgDumbbell(cells, opts = {}) {
  const fmt = opts.format || oneDecimal;
  /* Values are read one at a time and want precision; the axis is read as a scale and wants none. */
  const axisFmt = opts.axisFormat || fmt;
  /* A gap between two percentages is percentage points, and saying "25%" for it invites the
     reader to hear "a quarter better" when it means "one trial in four". */
  const deltaFmt = opts.deltaFormat || fmt;
  const words = opts.deltaWords || ['better', 'worse'];
  const betterLower = opts.betterLower !== false;
  const width = 620;
  const rowH = 48;
  const top = 14;
  const left = 128;
  const right = 122;
  const innerW = width - left - right;
  const height = top + Math.max(1, cells.length) * rowH + 30;
  if (!cells.length) return emptySvg(width, 160, 'No rows match this filter');

  const observed = cells.flatMap(c => [c.grounded.mean, c.nongrounded.mean, ...c.grounded.values, ...c.nongrounded.values])
    .filter(v => v != null);
  const max = opts.max ?? niceMax(Math.max(...observed, 0));
  const xOf = (v) => left + Math.min(1, Math.max(0, v / max)) * innerW;
  const ticks = [0, max / 2, max];
  const baseline = top + cells.length * rowH;

  const dot = (cell, color, soft, y) => {
    if (cell.mean == null) return '';
    const thin = cell.n < MIN_CELL_N;
    const raws = cell.values.map(v => `<circle cx="${xOf(v).toFixed(1)}" cy="${y}" r="2.5" fill="${soft}"></circle>`).join('');
    return `${raws}<circle class="viz-mark" cx="${xOf(cell.mean).toFixed(1)}" cy="${y}" r="6.5" fill="${thin ? VIZ_INK.surface : color}" stroke="${thin ? color : VIZ_INK.surface}" stroke-width="2"></circle>`;
  };

  return `<svg class="viz-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${adminEsc(opts.aria || 'Grounded versus non-grounded by task facet')}">
    ${ticks.map(t => `<line x1="${xOf(t).toFixed(1)}" y1="${top}" x2="${xOf(t).toFixed(1)}" y2="${baseline}" stroke="${VIZ_INK.grid}" stroke-width="1"></line>
      <text x="${xOf(t).toFixed(1)}" y="${baseline + 18}" text-anchor="middle" class="viz-svg-label">${adminEsc(axisFmt(t))}</text>`).join('')}
    ${cells.map((cell, i) => {
      const y = top + i * rowH + rowH / 2;
      const g = cell.grounded;
      const ng = cell.nongrounded;
      const both = g.mean != null && ng.mean != null;
      const delta = both ? g.mean - ng.mean : null;
      /* A difference that rounds away at the chart's own precision is not a direction. */
      const flat = delta != null && deltaFmt(Math.abs(delta)) === deltaFmt(0);
      const good = delta == null || flat ? null : betterLower ? delta < 0 : delta > 0;
      const thin = g.n < MIN_CELL_N || ng.n < MIN_CELL_N;
      const deltaText = delta == null
        ? 'no pair'
        : flat
          ? 'no change'
          : `${deltaFmt(Math.abs(delta))} ${good ? words[0] : words[1]}`;
      const tip = {
        title: cell.label,
        rows: [
          { color: VIZ_INK.nongrounded, value: ng.mean == null ? 'no rows' : fmt(ng.mean), label: `Non-grounded · mean of ${ng.n}${ng.n < MIN_CELL_N ? ' · thin' : ''}` },
          { color: VIZ_INK.grounded, value: g.mean == null ? 'no rows' : fmt(g.mean), label: `Grounded · mean of ${g.n}${g.n < MIN_CELL_N ? ' · thin' : ''}` },
        ],
        foot: delta == null
          ? 'Needs rows in both conditions to compare.'
          : `${deltaText} with grounding${thin ? ` · under ${MIN_CELL_N} rows in a cell, so treat it as noise` : ''}`,
      };
      return `<g class="viz-row">
        <rect class="viz-hit" x="0" y="${top + i * rowH}" width="${width}" height="${rowH}" ${tipData(tip)} aria-label="${adminEsc(`${cell.label}: ${deltaText}`)}"></rect>
        ${both ? `<line x1="${xOf(ng.mean).toFixed(1)}" y1="${y}" x2="${xOf(g.mean).toFixed(1)}" y2="${y}" stroke="${VIZ_INK.rule}" stroke-width="2"></line>` : ''}
        ${dot(ng, VIZ_INK.nongrounded, VIZ_INK.nongroundedSoft, y)}
        ${dot(g, VIZ_INK.grounded, VIZ_INK.groundedSoft, y)}
        <text x="${left - 12}" y="${y - 3}" text-anchor="end" class="viz-svg-value">${adminEsc(cell.label)}</text>
        <text x="${left - 12}" y="${y + 12}" text-anchor="end" class="viz-svg-label">n ${ng.n} vs ${g.n}</text>
        <text x="${width - 6}" y="${y - 3}" text-anchor="end" class="viz-svg-value">${adminEsc(`${ng.mean == null ? '—' : fmt(ng.mean)} → ${g.mean == null ? '—' : fmt(g.mean)}`)}</text>
        <text x="${width - 6}" y="${y + 12}" text-anchor="end" class="viz-svg-label" fill="${thin || good == null ? VIZ_INK.muted : good ? VIZ_INK.good : VIZ_INK.bad}">${adminEsc(thin ? `${deltaText} · thin` : deltaText)}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

/* Judging the claim and hunting for the evidence are different costs, and grounding is
   only supposed to move the second one. Stacking them keeps the total honest. */
function svgTimeSplit(cells) {
  /* Wider viewBox than the dumbbells because this one sits in a full-width card: matching the
     rendered width keeps its type the same size as everything around it. */
  const width = 1040;
  const rowH = 32;
  const top = 12;
  const left = 260;
  const right = 96;
  const innerW = width - left - right;
  const height = top + Math.max(1, cells.length) * rowH + 28;
  if (!cells.length) return emptySvg(width, 160, 'No rows match this filter');
  const max = niceMax(Math.max(...cells.map(c => (c.judge || 0) + (c.locate || 0)), 0));
  const wOf = (v) => Math.max(0, (v || 0) / max) * innerW;
  const baseline = top + cells.length * rowH;
  return `<svg class="viz-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Time split between judging and locating evidence">
    ${[0, max / 2, max].map(t => `<line x1="${(left + wOf(t)).toFixed(1)}" y1="${top}" x2="${(left + wOf(t)).toFixed(1)}" y2="${baseline}" stroke="${VIZ_INK.grid}" stroke-width="1"></line>
      <text x="${(left + wOf(t)).toFixed(1)}" y="${baseline + 18}" text-anchor="middle" class="viz-svg-label">${adminEsc(seconds(t))}</text>`).join('')}
    ${cells.map((cell, i) => {
      const y = top + i * rowH + 6;
      const judgeW = wOf(cell.judge);
      const locateW = Math.max(0, wOf(cell.locate) - 2);
      const total = (cell.judge || 0) + (cell.locate || 0);
      const share = total ? Math.round((cell.locate / total) * 100) : null;
      const tip = {
        title: cell.label,
        rows: [
          { color: VIZ_INK.judge, value: seconds(cell.judge), label: 'Judging the claim (Q1a)' },
          { color: VIZ_INK.locate, value: seconds(cell.locate), label: 'Locating the evidence (Q1b)' },
        ],
        foot: share == null ? 'No timing recorded.' : `${seconds(total)} total · ${share}% of it spent locating`,
      };
      return `<g class="viz-row">
        <rect class="viz-hit" x="0" y="${top + i * rowH}" width="${width}" height="${rowH}" ${tipData(tip)} aria-label="${adminEsc(`${cell.label}: ${seconds(total)} total`)}"></rect>
        <rect x="${left}" y="${y}" width="${judgeW.toFixed(1)}" height="15" rx="3" fill="${VIZ_INK.judge}"></rect>
        <rect x="${(left + judgeW + 2).toFixed(1)}" y="${y}" width="${locateW.toFixed(1)}" height="15" rx="3" fill="${VIZ_INK.locate}"></rect>
        <text x="${left - 10}" y="${y + 12}" text-anchor="end" class="viz-svg-label">${adminEsc(cell.label)}</text>
        <text x="${width - 6}" y="${y + 12}" text-anchor="end" class="viz-svg-value">${adminEsc(seconds(total))}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

function verdictHtml(rows) {
  const speedCells = facetCells(rows, r => r.find_supporting_answer_ms);
  const pooledSpeed = pooledCells(rows, r => r.find_supporting_answer_ms);
  const pooledAccuracy = pooledCells(rows, answerCorrect);
  const sessions = new Set(rows.map(r => r.session_id || r.client_run_id || r.participant_id).filter(Boolean)).size;
  const telemetry = rows.length ? rows.filter(r => r.interaction_summary).length / rows.length : null;

  const speedDelta = pooledSpeed.grounded.mean == null || pooledSpeed.nongrounded.mean == null
    ? null : pooledSpeed.grounded.mean - pooledSpeed.nongrounded.mean;
  const accuracyDelta = pooledAccuracy.grounded.mean == null || pooledAccuracy.nongrounded.mean == null
    ? null : pooledAccuracy.grounded.mean - pooledAccuracy.nongrounded.mean;
  const thin = cellsAreThin(speedCells);
  const thinnest = speedCells.length ? thinnestCell(speedCells) : 0;

  const headline = thin || speedDelta == null
    ? 'Not enough rows to call it'
    : `${seconds(Math.abs(speedDelta))} ${speedDelta < 0 ? 'faster' : 'slower'} to verify with grounding`;
  const support = thin || speedDelta == null
    ? `Every Find/Guide × Text/Visual cell needs ${MIN_CELL_N}+ rows per condition; the thinnest has ${thinnest}.`
    : accuracyDelta == null
      ? 'No scored answers in both conditions yet, so the accuracy side is still open.'
      : Math.abs(accuracyDelta) < 0.05
        ? `Accuracy is flat (${points(Math.abs(accuracyDelta))} apart), so the time difference is the whole story.`
        : accuracyDelta > 0
          ? `Accuracy is up ${points(accuracyDelta)} with grounding.`
          : `Accuracy also drops ${points(Math.abs(accuracyDelta))} with grounding.`;

  return `<div class="viz-verdict${thin ? ' viz-verdict-thin' : ''}">
    <span>Grounded vs non-grounded · time to locate the evidence</span>
    <strong>${adminEsc(headline)}</strong>
    <p>${adminEsc(support)}</p>
    <small>${rows.length} rows · ${sessions} session${sessions === 1 ? '' : 's'} · answer accuracy ${adminEsc(pct(boolRate(rows, answerCorrect)))} · telemetry ${adminEsc(pct(telemetry))}</small>
  </div>`;
}

/**
 * THE FOUR QUESTIONS THIS STUDY WAS RUN TO ANSWER, answered.
 *
 * The charts below show every cell and let somebody read a shape; this reads the shape for them.
 * Each card is one facet — the four are not variations of one question, they are four questions, and
 * the answers can point in different directions without any of them being wrong.
 *
 * WHICH NUMBER IS THE ANSWER depends on what was asked. A Find question asks whether grounding makes
 * verification FASTER, so time leads and accuracy is the guardrail beside it — faster-but-wronger is
 * not a win. A Guide question asks how evidence supports checking a run STEP BY STEP, which is a
 * localization question, so the error-type-and-step F1 leads and time is the guardrail.
 *
 * A cell under MIN_CELL_N still shows its direction, labelled as too early. Withholding the number
 * entirely invites somebody to go and compute it by hand, without the caveat attached.
 */
const RESEARCH_QUESTIONS = [
  {
    taskType: 'find', style: 'text', kind: 'speed',
    label: 'Find · Text',
    question: 'When users verify an answer directly on the page, does grounding let them verify it '
      + 'faster than a non-grounded agent?',
  },
  {
    taskType: 'find', style: 'visual', kind: 'speed',
    label: 'Find · Visual',
    question: 'When the answer needs the visuals on the page, does grounding let them verify it '
      + 'faster than a non-grounded agent?',
  },
  {
    taskType: 'guide', style: 'visual', kind: 'localization',
    label: 'Guide · Visual',
    question: 'When users check a navigation run step by step, how does visual evidence support '
      + 'that verification?',
  },
  {
    taskType: 'guide', style: 'text', kind: 'localization',
    label: 'Guide · Text',
    question: 'When users check a navigation run step by step, how does textual evidence support '
      + 'that verification?',
  },
];

/**
 * Which tasks this card counts, as a list you can tick.
 *
 * EVERY number on the card follows this — the verdict, the timings, accuracy, localization, the
 * behavioural row, the participant count and the images figure all come from the rows that survive
 * it. That is the point: a task excluded from the average but still counted in "26 participants"
 * would be the most misleading version of this feature.
 *
 * When a filter is active the card says so, loudly, and offers the way back. A dashboard quietly
 * showing a subset is how a number ends up in a paper describing a study nobody ran.
 */
function facetTaskPickerHtml(spec, facetRows, chosen) {
  const key = facetKey(spec);
  const byTask = new Map();
  facetRows.forEach(r => {
    const id = String(r.task_id || '');
    if (!id) return;
    if (!byTask.has(id)) byTask.set(id, { id, ng: 0, g: 0, question: r.question_or_task || '' });
    const t = byTask.get(id);
    if (r.condition === 'grounding') t.g++; else t.ng++;
  });
  const tasks = Array.from(byTask.values()).sort((a, b) => a.id.localeCompare(b.id));
  if (tasks.length < 2) return '';

  const kept = tasks.filter(t => !chosen || chosen.has(t.id)).length;
  // The banner is about a NARROWING, not about whether an entry exists. "Use all tasks" writes an
  // explicit full set, and a card announcing "counting 8 of 8" would be shouting about nothing.
  const active = kept < tasks.length;
  const byDefault = active && !facetTaskFilters.has(key);
  const open = facetPickerOpen.has(key);
  // Carried on the button so the reset can write the full set without re-deriving it from the DOM.
  const allIds = tasks.map(t => t.id).join(' ');

  return `
    ${active ? `<p class="viz-answer-filtered">Counting ${kept} of ${tasks.length} tasks — every
      number below is from those only.${byDefault ? ` Left out by default (${tasks.length - kept}):
        ${adminEsc(FACET_TASK_EXCLUSIONS[key]?.why || 'excluded by the researcher')}. Tick one to
        put it back.` : ''}
      <button type="button" class="viz-task-reset" data-facet="${key}"
        data-tasks="${adminEsc(allIds)}">Use all tasks</button></p>` : ''}
    <details class="viz-task-picker" data-facet="${key}"${open ? ' open' : ''}>
      <summary>Tasks in this card (${kept}/${tasks.length})</summary>
      <div class="viz-task-list">
        ${tasks.map(t => {
          const on = !chosen || chosen.has(t.id);
          const imgs = taskImageCounts.get(t.id);
          return `<label class="viz-task-row">
            <input type="checkbox" class="viz-task-check" data-facet="${key}"
              data-task="${adminEsc(t.id)}"${on ? ' checked' : ''}>
            <code>${adminEsc(t.id)}</code>
            <span class="viz-task-n">${t.ng} vs ${t.g} rows${
              Number.isFinite(imgs) ? ` · ${imgs} images` : ''}</span>
            <span class="viz-task-q">${adminEsc(String(t.question).slice(0, 60))}</span>
          </label>`;
        }).join('')}
      </div>
    </details>`;
}

/** grounded − non-grounded for one metric over one facet, with the n behind each side. */
function facetDelta(rows, metricFn) {
  const grounded = cellFor(conditionRows(rows, 'grounding'), metricFn);
  const nongrounded = cellFor(conditionRows(rows, 'nongrounding'), metricFn);
  const delta = grounded.mean == null || nongrounded.mean == null
    ? null : grounded.mean - nongrounded.mean;
  return { grounded, nongrounded, delta, n: Math.min(grounded.n, nongrounded.n) };
}

/** Below these, a difference is noise dressed as a result. */
const FLAT_MS = 1000;
const FLAT_PTS = 0.05;

/**
 * How many answers were actually wrong, on each side — "0/14 → 1/15 wrong".
 *
 * A percentage hides its own weight. "100% → 93%" reads as a seven-point accuracy cost until you
 * see it is ONE wrong answer out of fifteen, at which point it reads as a single participant having
 * a bad minute. Counts are what tell those two apart, and they cost one line.
 *
 * Read off the cell's own values, which metricValues has already normalised to 1/0, so this can
 * never disagree with the percentage printed above it.
 */
function wrongTally(cell) {
  const side = (s) => {
    const values = s?.values || [];
    return values.length ? `${values.filter(v => v === 0).length}/${values.length}` : null;
  };
  return pairFoot('wrong', side(cell?.nongrounded), side(cell?.grounded));
}

/**
 * How wide the interval around a proportion really is — Wilson, not textbook mean ± 1.96·SE.
 *
 * The textbook interval runs past 100% on exactly the cells anyone cares about: Guide × Visual's
 * grounded arm is 26 of 27 correct, and Wald puts its upper bound at 107%. Wilson is bounded by
 * construction and is the standard choice for a proportion at these n, which are 20–39 rows.
 *
 * WHY AN INTERVAL AND NOT A STANDARD DEVIATION. Accuracy is one 0/1 per participant — every cell
 * holds exactly one row per session — so its sd is sqrt(p(1-p)), a restatement of the percentage
 * with nothing added, and its min and max are 0% and 100% in every cell by construction. The only
 * dispersion figure that says something the mean does not is how precisely the mean is pinned, and
 * on this study that is the number people most need to see: every arm pair below overlaps.
 */
function wilsonInterval(hits, n) {
  if (!n) return null;
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * A footnote built as a labelled pair, so it reads the way the value above it does.
 *
 * WHY THIS EXISTS RATHER THAN A STRING. "95% CI 81.86%–98.46% → 79.68%–97.35%" is five numbers,
 * four percent signs, two dashes and an arrow in one run, and the dash inside each range competes
 * with the arrow between them: the eye has to parse the punctuation before it can find the two
 * halves. Colour already tells the arms apart everywhere else on this card, so it does the
 * separating here too and the punctuation can go: one percent sign per range, the label said once,
 * and each range in its own arm's ink.
 *
 * Returns {html}, which stat() renders unescaped — everything interpolated is a number this file
 * computed, never a string that came off the wire.
 */
function pairFoot(label, left, right) {
  if (!left || !right) return null;
  return {
    html: `<span class="viz-foot-label">${adminEsc(label)}</span>`
      + `<span class="viz-v-ng">${adminEsc(left)}</span>`
      + `<span class="viz-v-arrow">→</span>`
      + `<span class="viz-v-g">${adminEsc(right)}</span>`,
  };
}

/** The Wilson interval for each arm: "95% CI  81.86–98.46%  →  79.68–97.35%". */
function proportionInterval(cell) {
  const side = (s) => {
    const values = s?.values || [];
    if (!values.length) return null;
    const ci = wilsonInterval(values.filter(v => v === 1).length, values.length);
    // The unit goes on the range, not on each bound: "81.86–98.46%" is one quantity, and a percent
    // sign on both ends of a range reads as two separate numbers that happen to be adjacent.
    return ci ? `${(ci[0] * 100).toFixed(2)}–${pct(ci[1])}` : null;
  };
  return pairFoot('95% CI', side(cell?.nongrounded), side(cell?.grounded));
}

/**
 * The spread of a measure, which is where a standard deviation earns its place.
 *
 * Localization and the two F1s behind it are scores in [0,1] rather than coin flips, so their sd
 * carries something the mean does not: whether a facet improved for everybody or for a few. Find ×
 * Text is the one cell where grounding both raises the mean and TIGHTENS it, and that is a
 * different claim from the other three — visible here and nowhere else on the card.
 */
function sampleSd(values) {
  if (!values || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

/** Is this measure a coin flip? Then its sd restates its mean and its min is 0 by construction. */
function isBinaryCell(cell) {
  const all = (cell?.nongrounded?.values || []).concat(cell?.grounded?.values || []);
  return all.length > 0 && all.every(v => v === 0 || v === 1);
}

/**
 * sd and min for one stat, in the measure's own units.
 *
 * ON EVERY METRIC, so the two F1s behind localization are described the same way localization is —
 * a spread quoted for the parent and withheld from its halves would be the one place a reader could
 * not check whether a facet moved for everybody or for a few.
 *
 * MIN IS WITHHELD FROM BINARY MEASURES, and that is a statement rather than an omission. Accuracy,
 * "named any error" and the two Find hops are one 0/1 per participant, so their minimum is 0 in
 * every cell that contains a single wrong answer — which is all of them. Printing "min 0% → 0%" on
 * four rows would fill the card with a fact about the scale rather than about the study. Their sd
 * is kept: it is sqrt(p(1-p)) and adds nothing to the mean, but it is the number people expect to
 * see beside one, and the interval above it is the honest measure of precision.
 */
function dispersionFoots(cell, format) {
  const sd = (s) => {
    const v = sampleSd(s?.values);
    return v == null ? null : format(v);
  };
  const min = (s) => {
    const values = s?.values || [];
    return values.length ? format(Math.min(...values)) : null;
  };
  const out = [pairFoot('sd', sd(cell?.nongrounded), sd(cell?.grounded))];
  if (!isBinaryCell(cell)) out.push(pairFoot('min', min(cell?.nongrounded), min(cell?.grounded)));
  return out.filter(Boolean);
}

/** "44s faster" / "16s slower" / null when there is nothing to say. Negative delta = quicker. */
function timeSwing(delta) {
  if (delta == null) return null;
  if (Math.abs(delta) < FLAT_MS) return 'no change in time';
  return `${seconds(Math.abs(delta))} ${delta < 0 ? 'faster' : 'slower'}`;
}

/** A before → after pair with its swing, e.g. "73% → 83% (+11 pts)". */
function movement(cell, format, deltaFormat) {
  if (cell?.nongrounded?.mean == null || cell?.grounded?.mean == null) return null;
  const sign = cell.delta > 0 ? '+' : '−';
  return `${format(cell.nongrounded.mean)} → ${format(cell.grounded.mean)} `
    + `(${sign}${deltaFormat(Math.abs(cell.delta))})`;
}

/**
 * The whole answer to one question, in a headline and a sentence.
 *
 * A verdict on the lead measure ALONE is not an answer, it is half of one — "44s faster" and "16s
 * slower" both leave the reader asking "at what cost?", which is the question the study exists to
 * settle. So the headline names the TRADE-OFF shape (faster and more accurate; better but slower)
 * and the sentence underneath spends the numbers on it: where each measure started, where it
 * ended, and how far it moved.
 *
 * Direction depends on the measure, not on the sign: less time is better, more accuracy and more
 * localization are better. Anything inside FLAT_MS / FLAT_PTS is called unchanged rather than
 * dressed up as a small win — an 0.4s "improvement" over eleven rows is noise.
 */
function researchVerdict(spec, { lead, speed, accuracy, localization }) {
  const leadHelps = lead.delta == null ? null
    : (spec.kind === 'speed' ? lead.delta < 0 : lead.delta > 0);
  const leadFlat = lead.delta == null
    || Math.abs(lead.delta) < (spec.kind === 'speed' ? FLAT_MS : FLAT_PTS);
  const accFlat = accuracy.delta == null || Math.abs(accuracy.delta) < FLAT_PTS;
  const accHelps = accuracy.delta != null && accuracy.delta > 0;

  if (lead.delta == null && accuracy.delta == null) {
    return { tone: 'none', headline: 'No data yet', guard: 'Nothing scored on both sides of this question yet.' };
  }

  // The headline is the shape of the trade, so a win bought with accuracy reads as a trade rather
  // than as a win. Only an unambiguous both-ways result gets the confident tone.
  // "and" when both measures moved the same way, "but" when they disagree. Getting this backwards
  // ("Slower, but less accurate") quietly tells the reader a trade-off happened where none did.
  const conflict = !leadFlat && !accFlat && leadHelps !== accHelps;
  const leadWord = spec.kind === 'speed'
    ? (leadFlat ? 'No faster, no slower' : (leadHelps ? 'Faster' : 'Slower'))
    : (leadFlat ? 'No better at locating' : (leadHelps ? 'Better at locating' : 'Worse at locating'));
  const accWord = accFlat ? 'with accuracy unchanged'
    : `${conflict ? 'but' : 'and'} ${accHelps ? 'more' : 'less'} accurate`;
  const headline = `${leadWord}, ${accWord}`;

  // A result that moved both ways is a TRADE, and colouring it green or red picks a side the data
  // has not picked. Only agreement earns a verdict colour.
  const tone = conflict || (leadFlat && accFlat) ? 'flat'
    : (leadFlat ? (accHelps ? 'yes' : 'no') : (leadHelps ? 'yes' : 'no'));

  // The sentence: every measure that has something to say, with its start, end and swing.
  const parts = [];
  const locateMove = movement(speed, seconds, seconds);
  const accMove = movement(accuracy, pct, points);
  const locMove = movement(localization, pct, points);

  if (spec.kind === 'speed') {
    if (locateMove) parts.push(`Locating the evidence goes ${locateMove}`);
    if (accMove) parts.push(`answer accuracy goes ${accMove}`);
    if (locMove) parts.push(`and localization goes ${locMove}`);
  } else {
    if (locMove) parts.push(`Localization goes ${locMove}`);
    if (accMove) parts.push(`verdict accuracy goes ${accMove}`);
    if (locateMove) parts.push(`and locating takes ${locateMove}`);
  }
  const sentence = parts.length ? `${parts.join(', ')}.` : '';

  // The one reading that must never be left implicit: quicker, or better placed, but wronger.
  const caveat = (!accFlat && !accHelps && !leadFlat && leadHelps)
    ? ' A faster wrong answer is not a win.' : '';

  return { tone, headline, guard: sentence + caveat };
}

/**
 * The halves that make up one localization number, and what to call them on the card.
 *
 * THE COMBINED FIGURE HIDES WHICH HALF MOVED, and on both task types the two halves behave
 * differently enough that the average is the least informative view of them: Find × Text gains
 * twice as much on its first hop as its second, and every Guide facet localizes a step far worse
 * than it names an error type. A card that only prints the mean invites "localization went up" as
 * the finding when the honest one is "the first half went up".
 *
 * FIND'S HALVES ARE HIT RATES AND THAT IS NOT A SHORTCUT. Q1b asks one question per hop and will
 * not submit without both, so a hop has exactly one pick against one accepted set: precision and
 * recall are the same number, and the F1 of a single hop IS whether that hop was right. The column
 * is already there — `score_evidence_hop_exact` is `{"1": true, "2": false}`, written at submit
 * time — so this reads it rather than deriving something subtly different.
 *
 * The visual arm's second hop is answered by clicking an IMAGE, not by picking a passage
 * (EVIDENCE_PROMPTS_BY_ARM, app/find_task.js), so the labels say which is which. Reading "part 2"
 * as another sentence is how the picture half of that facet gets attributed to prose.
 */
/**
 * Did the participant blame anything at all?
 *
 * The gate in front of both Guide halves, and the reason their F1s read so low: a run on which
 * nobody names an error scores 0 on error type and 0 on step, so a facet where two thirds of the
 * runs are never flagged is mostly averaging zeros from people who never reached the localizing.
 * Without this figure beside them, those two numbers look like bad localization when they are
 * mostly absent localization, and the two call for completely different follow-ups.
 */
function namedAnyError(row) {
  if (row?.task_type !== 'guide') return null;
  return Array.isArray(row.guide_errors) ? row.guide_errors.length > 0 : null;
}

function localizationParts(spec) {
  if (spec.taskType === 'find') {
    return [
      { label: 'Part 1 · passage', metric: row => row?.score_evidence_hop_exact?.['1'] },
      {
        label: spec.style === 'visual' ? 'Part 2 · image' : 'Part 2 · passage',
        metric: row => row?.score_evidence_hop_exact?.['2'],
      },
    ];
  }
  return [
    { label: 'Error type F1', metric: row => f1(row?.score_type_precision, row?.score_type_recall) },
    { label: 'Step F1', metric: row => f1(row?.score_step_precision, row?.score_step_recall) },
  ];
}

function researchAnswerCard(spec, allRows) {
  const facetRows = allRows.filter(r => r.task_type === spec.taskType && taskStyle(r) === spec.style);
  // The picker lists every task the facet HAS, not every task it currently counts — a list that
  // shrank as you unticked things would make a dropped task unreachable to put back.
  const key = facetKey(spec);
  const chosen = chosenTasksFor(key, facetRows);
  const rows = chosen ? facetRows.filter(r => chosen.has(String(r.task_id || ''))) : facetRows;
  const speed = facetDelta(rows, locateTime);
  const judge = facetDelta(rows, judgeTime);
  const total = facetDelta(rows, totalTime);
  const accuracy = facetDelta(rows, answerCorrect);
  const localization = facetDelta(rows, evidenceQuality);
  const lead = spec.kind === 'speed' ? speed : localization;
  const thin = lead.n < MIN_CELL_N;

  const { tone, headline, guard } = researchVerdict(spec, { lead, speed, accuracy, localization });

  const leadName = spec.kind === 'speed'
    ? 'locate time (find_supporting_answer_ms)'
    : 'localization F1 (error type and step, or a correct “no error” in full)';

  // WHICH SIDE IS WHICH, on every value. "14.5 → 11.6" is unreadable without knowing the order, and
  // the one sentence explaining it sits several cards above. The two halves are told apart three
  // ways over — position, weight and colour — plus a legend at the head of the block, because a
  // reader who guesses wrong here inverts every finding on the card.
  // `foot` takes one note or several: accuracy carries both its raw counts and its interval, and
  // they are separate claims — how much the percentage rests on, and how far it could actually sit
  // from where it is printed. Run together on one line they read as a single garbled number.
  const stat = (name, cell, format, foot) => `<div class="viz-answer-stat">
      <span>${adminEsc(name)}</span>
      <b><span class="viz-v-ng" title="non-grounded">${adminEsc(format(cell.nongrounded.mean))}</span>
        <span class="viz-v-arrow">→</span>
        <span class="viz-v-g" title="grounded">${adminEsc(format(cell.grounded.mean))}</span></b>
      ${[].concat(foot || []).concat(dispersionFoots(cell, format)).filter(Boolean)
        .map(line => `<small>${line.html || adminEsc(line)}</small>`).join('')}
    </div>`;

  const readingLegend = `<p class="viz-answer-legend">
    Each pair reads <span class="viz-v-ng">non-grounded</span>
    <span class="viz-v-arrow">→</span> <span class="viz-v-g">grounded</span>.</p>`;

  // Rows AND people, because they are different questions and the card was only answering one. The
  // n is what the headline average rests on; the participant count is how many sittings produced it.
  const people = participantCount(rows);
  // How picture-heavy this facet's material is, averaged over the DISTINCT tasks it drew rather
  // than over rows — a task drawn six times is one page, not six, and weighting by draws would
  // report the popularity of a task as a property of the condition.
  const facetTasks = Array.from(new Set(rows.map(r => String(r.task_id || '')).filter(Boolean)));
  const counted = facetTasks.map(id => taskImageCounts.get(id)).filter(v => Number.isFinite(v));
  const imageAvg = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : null;
  // HOW HEAVILY GROUNDED THE MATERIAL IS, averaged the same way and for the same reason: a task
  // drawn six times is one answer, not six. This describes what the grounded arm was GIVEN, which
  // is the other half of every finding on the card — a facet that gained nothing from grounding
  // reads differently when its answers carried one reference than when they carried nine.
  const refs = facetTasks.map(id => taskReferenceCounts.get(id)).filter(Boolean);
  const refAvg = refs.length ? {
    citations: refs.reduce((a, r) => a + r.citations, 0) / refs.length,
    evidence: refs.reduce((a, r) => a + r.evidence, 0) / refs.length,
    n: refs.length,
  } : null;
  return `<article class="viz-answer viz-answer-${tone}${thin ? ' is-thin' : ''}">
    <header>
      <span class="viz-answer-facet">${adminEsc(spec.label)}</span>
      <span class="viz-answer-n">n ${lead.nongrounded.n} vs ${lead.grounded.n}
        · ${people} participant${people === 1 ? '' : 's'}${imageAvg == null ? ''
          : ` · ${imageAvg.toFixed(1)} images/${spec.taskType === 'find' ? 'page' : 'run'}`}</span>
    </header>
    <p class="viz-answer-q">${adminEsc(spec.question)}</p>
    ${refAvg ? `<p class="viz-answer-refs">Grounded answer carries
      <b>${refAvg.citations.toFixed(1)}</b> text citation${refAvg.citations === 1 ? '' : 's'} and
      <b>${refAvg.evidence.toFixed(1)}</b> image crop${refAvg.evidence === 1 ? '' : 's'},
      mean over the ${refAvg.n} task${refAvg.n === 1 ? '' : 's'} counted. The non-grounded arm shows
      the same claims with every reference stripped.</p>` : ''}
    ${facetTaskPickerHtml(spec, facetRows, chosen)}
    <strong class="viz-answer-headline">${adminEsc(headline)}</strong>
    <p class="viz-answer-guard">${adminEsc(guard)}</p>
    <!-- Which number the headline is actually made of. Five figures sit below it and only one of
         them drives the verdict; leaving that to be inferred is how "62s faster" gets read as the
         whole task when it is one of its two stages. -->
    <p class="viz-answer-basis">Verdict above is from <b>${adminEsc(leadName)}</b>${
      spec.kind === 'speed' ? ', not total time' : ''}.</p>
    ${readingLegend}
    <div class="viz-answer-stats">
      ${stat('Judge time', judge, seconds)}
      ${stat('Locate time', speed, seconds)}
      ${stat('Total time', total, seconds)}
      ${stat('Accuracy', accuracy, pct, [wrongTally(accuracy), proportionInterval(accuracy)])}
      ${stat('Localization', localization, pct)}
    </div>

    <!-- The lead measure taken apart. Same rows, same arms; only the question each half answers is
         different, which is why they can and do move in different directions. -->
    <div class="viz-answer-stats viz-answer-split">
      ${localizationParts(spec).map(part => {
        const cell = facetDelta(rows, part.metric);
        if (cell.nongrounded.mean == null && cell.grounded.mean == null) return '';
        // Its own n, said out loud: on Guide these halves drop every run that had no error to
        // localize, so a split can rest on fewer rows than the card's header claims.
        const foot = cell.nongrounded.n === lead.nongrounded.n && cell.grounded.n === lead.grounded.n
          ? '' : `n ${cell.nongrounded.n} vs ${cell.grounded.n}`;
        return stat(part.label, cell, pct, foot);
      }).join('')}
      ${spec.taskType === 'guide'
        ? stat('Named any error', facetDelta(rows, namedAnyError), pct,
          'the gate before both halves above')
        : ''}
    </div>

    <!-- HOW the task was worked, not just how long it took. Scrolling and Ctrl-F are hunting: a
         reader who cannot see where the answer is goes looking for it, so grounding should bring
         these down even on a facet where the clock refuses to move. -->
    <div class="viz-answer-stats viz-answer-behaviour">
      ${BEHAVIOR_METRICS.map(m => {
        const cell = facetDelta(rows, r => behaviorValue(r, m.key, m.column));
        if (cell.nongrounded.mean == null && cell.grounded.mean == null) return '';
        return stat(m.label, cell, m.key === 'mouse_move_px' ? pixels : oneDecimal);
      }).join('')}
    </div>

    <!-- WHAT THEY SAID, under what they did. Both scales run 1–4 with 4 as the good end; the arrow
         reads the same way as every pair above it. Confidence is about their own answer, usefulness
         about what the condition showed them — so usefulness is the one the arms should move. -->
    <div class="viz-answer-stats viz-answer-selfreport">
      ${SELF_REPORT_METRICS.map(m => {
        const cell = facetDelta(rows, r => selfReportValue(r, m));
        if (cell.nongrounded.mean == null && cell.grounded.mean == null) return '';
        return stat(m.label, cell, scaleOf4);
      }).join('')}
    </div>
    ${thin ? `<p class="viz-answer-thin">Too early to call — this needs ${MIN_CELL_N}+ rows per
      condition, and the thinner side has ${lead.n}. The direction is shown, not the finding.</p>` : ''}
  </article>`;
}

/**
 * The numbers, as a plain object — the same aggregates the four cards draw.
 *
 * This is what gets sent for analysis, and it is deliberately ALL that does: per-facet means and
 * counts, no participant ids, no session ids, no raw rows, no free text. A model can say what the
 * numbers mean without ever seeing who produced them.
 */
function analysisSummary(rows) {
  const cell = (c) => ({ nongrounded: c.nongrounded.mean, grounded: c.grounded.mean,
    n_nongrounded: c.nongrounded.n, n_grounded: c.grounded.n });
  return {
    rows_total: rows.length,
    // The same count the cards show. It used to fall back to participant_id, which is `anon` on
    // nearly every row — so a study with nine sittings could be handed to the model as one person.
    sessions: participantCount(rows),
    min_rows_per_cell_for_confidence: MIN_CELL_N,
    facets: RESEARCH_QUESTIONS.map(spec => {
      const facet = rows.filter(r => r.task_type === spec.taskType && taskStyle(r) === spec.style);
      return {
        facet: spec.label,
        question: spec.question,
        leads_on: spec.kind === 'speed' ? 'time to locate the evidence' : 'error-type and step F1',
        rows: facet.length,
        participants: participantCount(facet),
        // Named so the model cannot mistake one stage for the task: judge is deciding the answer,
        // locate is then finding what backs it, total is their sum. The verdict uses locate alone.
        locate_time_ms: cell(facetDelta(facet, locateTime)),
        judge_time_ms: cell(facetDelta(facet, judgeTime)),
        total_time_ms: cell(facetDelta(facet, totalTime)),
        accuracy: cell(facetDelta(facet, answerCorrect)),
        localization: cell(facetDelta(facet, evidenceQuality)),
        // Both readings of the same two answers, because they fail differently: the mean uses the
        // whole scale and assumes its steps are even, the top-two box assumes nothing about spacing
        // but throws away how far apart the ends are. Named with their scale so neither can be read
        // as the other.
        confidence_mean_1_to_4: cell(facetDelta(facet, r => selfReportValue(r, SELF_REPORT_METRICS[0]))),
        helpfulness_mean_1_to_4: cell(facetDelta(facet, r => selfReportValue(r, SELF_REPORT_METRICS[1]))),
        // An unanswered scale is null, not a "no" — scoring it 0 would count a question nobody was
        // asked as a vote against.
        confidence_very_or_somewhat: cell(facetDelta(facet, r => (r.confidence
          ? ((r.confidence === 'very' || r.confidence === 'somewhat') ? 1 : 0) : null))),
        helpfulness_very_or_somewhat: cell(facetDelta(facet, r => (r.helpfulness
          ? ((r.helpfulness === 'very' || r.helpfulness === 'somewhat') ? 1 : 0) : null))),
      };
    }),
  };
}

/** The optional half: what participants wrote, with nothing attached to say who wrote it. */
function analysisNotes(rows) {
  return rows
    .map(r => ({
      facet: `${r.task_type === 'find' ? 'Find' : 'Guide'} · ${VIZ_STYLE_LABEL[taskStyle(r)]}`,
      condition: r.condition,
      note: String(r.notes || '').trim(),
    }))
    .filter(n => n.note)
    .map(n => `[${n.facet} · ${n.condition}] ${n.note}`);
}

/**
 * The four cards said in four lines, over ALL rows, with its own all-vs-finished switch.
 *
 * Deliberately NOT wired to the filter bar. This block is the paste-into-the-writeup summary of the
 * whole study, and a summary that silently changed because a search box still held "quora" is how a
 * subset ends up quoted as the result. It reads `adminVizRows` — everything fetched — and the only
 * thing that narrows it is the switch on the block itself, which is named on the block.
 *
 * The two views answer different questions and both belong here. ALL SESSIONS counts every answered
 * task, including the ones from sittings that walked away partway; it is the most data, and its two
 * arms can hold different numbers of rows because a drop-off lands mid-sequence. FINISHED ONLY keeps
 * the sittings that answered all eight, which balances the arms by construction — the same people on
 * both sides — at the cost of the rows it drops. Where the two disagree, the disagreement is the
 * finding: it means the effect is carried by who left, not by the condition.
 *
 * Each line's n is the LEAD measure's n for that facet — locate time for Find, localization for
 * Guide — the same number the card above prints, so the two can never quietly differ.
 */
let breakdownFinishedOnly = false;

function breakdownLine(spec, allRows) {
  const facetRows = allRows.filter(r => r.task_type === spec.taskType && taskStyle(r) === spec.style);
  // The same task selection the card above uses — defaults included, and any box ticked since. This
  // block is the four cards said in four lines, so a line that counted a task its own card had
  // dropped would be two different answers to one question, on one screen.
  const chosen = chosenTasksFor(facetKey(spec), facetRows);
  const rows = chosen ? facetRows.filter(r => chosen.has(String(r.task_id || ''))) : facetRows;
  const speed = facetDelta(rows, locateTime);
  const accuracy = facetDelta(rows, answerCorrect);
  const localization = facetDelta(rows, evidenceQuality);
  const lead = spec.kind === 'speed' ? speed : localization;
  const pair = (cell, format) => `<span class="viz-v-ng" title="non-grounded">${adminEsc(format(cell.nongrounded.mean))}</span>`
    + `<span class="viz-v-arrow"> → </span>`
    + `<span class="viz-v-g" title="grounded">${adminEsc(format(cell.grounded.mean))}</span>`;
  return `<li${lead.n < MIN_CELL_N ? ' class="is-thin"' : ''}>
    <b>${adminEsc(spec.label.replace(' · ', ' / '))}</b>
    <span class="viz-breakdown-n">(${lead.nongrounded.n} vs ${lead.grounded.n})</span>:
    locate time: ${pair(speed, seconds)},
    localization quality: ${pair(localization, pct)},
    accuracy: ${pair(accuracy, pct)}
  </li>`;
}

function breakdownSummaryHtml(allRows) {
  const finished = completeSessionKeys(allRows);
  const rows = breakdownFinishedOnly
    ? allRows.filter(r => finished.has(sessionKey(r)))
    : allRows;
  const sessions = participantCount(rows);
  const chip = (on, mode, label) => `<button type="button" data-mode="${mode}"
    class="admin-chip viz-breakdown-mode${on ? ' admin-chip-on' : ''}" aria-pressed="${on}">${label}</button>`;

  return `<section class="viz-card viz-breakdown">
    <div class="viz-breakdown-head">
      <h4>Breakdown summary for each category</h4>
      <div class="viz-breakdown-modes">
        ${chip(!breakdownFinishedOnly, 'all', 'All sessions')}
        ${chip(breakdownFinishedOnly, 'finished', `Completed sessions only (${finished.size})`)}
      </div>
    </div>
    <p class="viz-breakdown-basis">${rows.length} rows · ${sessions} session${sessions === 1 ? '' : 's'}
      · every pair reads non-grounded → grounded · n is the lead measure per side (locate time for
      Find, localization for Guide). Over <b>all fetched rows</b> — the filter bar above does not
      touch this block, but each line counts the same tasks its card does, so a task dropped there
      is dropped here too.</p>
    <ul class="viz-breakdown-list">
      ${RESEARCH_QUESTIONS.map(spec => breakdownLine(spec, rows)).join('')}
    </ul>
    ${breakdownFinishedOnly
      ? `<p class="viz-note">Only sittings with all ${TASKS_PER_SESSION} tasks answered — the arms hold
         the same people, so a difference here cannot be drop-off.</p>`
      : '<p class="viz-note">Every answered task, drop-offs included, so the two arms can hold different row counts.</p>'}
  </section>`;
}

function researchAnswersHtml(rows) {
  const noteCount = analysisNotes(rows).length;
  const people = participantCount(rows);
  return `<section class="viz-answers">
    <div class="viz-answers-head">
      <div>
        <h4>The four questions, at a glance</h4>
        <p class="viz-answers-lead">One card per question. Find asks whether grounding is
          <b>faster</b>, with accuracy as the guardrail; Guide asks how well the evidence supports
          checking a run <b>step by step</b>, with time as the guardrail. Every number reads
          non-grounded → grounded.</p>
        <p class="viz-answers-lead">Every figure is a <b>mean</b> over the matching rows in
          <code>study_task_results_v2</code>, read live from Supabase. Rows with no value for a
          measure are left out of its average rather than counted as zero, so each card's
          <b>n</b> can differ from its row count. Currently
          <b>${people} participant${people === 1 ? '' : 's'}</b>
          (distinct <code>session_id</code>) across <b>${rows.length} rows</b>.</p>
        <p class="viz-answers-lead">A task is timed in two stages, and each card shows both plus
          their sum. <b>Judge time</b> (<code>answer_multiple_choice_ms</code>) is deciding the
          answer from what the agent reported; <b>locate time</b>
          (<code>find_supporting_answer_ms</code>) is then pointing at what backs it, in the page;
          <b>total time</b> is the two added together. The Find verdicts are judged on
          <b>locate time only</b> — that is the stage grounding is meant to change, and pooling it
          with judging dilutes the effect. Do not use the <code>answer_time_ms</code> column for
          the answering stage: it holds the whole task and duplicates <code>time_ms</code>.</p>
      </div>
      <!-- The cards are computed here and always current; this asks a model to read them out and
           say what they mean, which is the part arithmetic cannot do. -->
      <div class="viz-analysis-controls">
        <button class="admin-chip admin-chip-on" id="viz-analyze">↻ Rerun analysis</button>
        <label class="viz-analysis-opt"><input type="checkbox" id="viz-analyze-notes">
          include the ${noteCount} participant note${noteCount === 1 ? '' : 's'}</label>
        <!-- Both run on the researcher's machine through the publish helper: a page cannot write
             files into the repo it was served from, and a write token has no business being in a
             file participants are served. -->
        <button class="admin-chip" id="viz-figures">📊 Publish to figures</button>
        <button class="admin-chip" id="viz-huggingface">🤗 Upload to Hugging Face</button>
        <div class="viz-job-status" id="viz-job-status" hidden></div>
      </div>
    </div>
    <div class="viz-answer-grid">
      ${RESEARCH_QUESTIONS.map(spec => researchAnswerCard(spec, rows)).join('')}
    </div>
    <div class="viz-analysis" id="viz-analysis" hidden></div>
  </section>`;
}

function compositionHtml(rows) {
  const chip = (label, value) => `<span><b>${adminEsc(label)}</b> ${value}</span>`;
  const styles = VIZ_STYLES.map(s => chip(VIZ_STYLE_LABEL[s], rows.filter(r => taskStyle(r) === s).length));
  return `<div class="viz-composition">
    ${chip('Find', rows.filter(r => r.task_type === 'find').length)}
    ${chip('Guide', rows.filter(r => r.task_type === 'guide').length)}
    ${chip('Grounded', conditionRows(rows, 'grounding').length)}
    ${chip('Non-grounded', conditionRows(rows, 'nongrounding').length)}
    ${styles.join('')}
  </div>`;
}

function controlsHtml(rows, filters) {
  const participants = Array.from(new Set(rows.map(r => String(r.participant_id || '')).filter(Boolean))).sort();
  const opt = (value, label, selected) => `<option value="${adminEsc(value)}"${selected === value ? ' selected' : ''}>${adminEsc(label)}</option>`;
  return `<div class="viz-controls">
    <label>Task ${`<select id="viz-filter-task">
      ${opt('all', 'All', filters.taskType)}${opt('find', 'Find', filters.taskType)}${opt('guide', 'Guide', filters.taskType)}
    </select>`}</label>
    <label>Condition ${`<select id="viz-filter-condition">
      ${opt('all', 'All', filters.condition)}${opt('grounding', 'Grounded', filters.condition)}${opt('nongrounding', 'Non-grounded', filters.condition)}
    </select>`}</label>
    <label>Style ${`<select id="viz-filter-style">
      ${opt('all', 'All', filters.style)}${opt('text', 'Text', filters.style)}${opt('visual', 'Visual', filters.style)}${opt('unknown', 'Unknown', filters.style)}
    </select>`}</label>
    <label>Participant <select id="viz-filter-participant">
      ${opt('all', 'All', filters.participant)}
      ${participants.map(p => opt(p, p, filters.participant)).join('')}
    </select></label>
    <label class="viz-search">Search <input id="viz-filter-search" value="${adminEsc(filters.search)}" placeholder="task, participant, note"></label>
    ${completeToggleHtml(rows, filters)}
  </div>`;
}

/**
 * The drop-off filter, said in whole people rather than rows.
 *
 * The count is the point: "9 of 34 finished" is the one number that tells you how much of this
 * table is abandonment, and it is worth reading whether or not the filter is on.
 */
function completeToggleHtml(allRows, filters) {
  const finished = completeSessionKeys(allRows).size;
  const total = allSessionKeys(allRows).size;
  const on = !!filters.completeOnly;
  return `<div class="viz-complete-toggle">
    <button type="button" class="admin-chip${on ? ' admin-chip-on' : ''}" id="viz-filter-complete"
      aria-pressed="${on}">${on ? '✓ ' : ''}Completed sessions only</button>
    <span>${finished} of ${total} session${total === 1 ? '' : 's'} answered all ${TASKS_PER_SESSION} tasks${on ? ' — showing only those' : ''}</span>
  </div>`;
}

/* Collapsed by default: the charts are the answer, and the raw rows are what you open when you
   want to argue with them. The open state survives a re-render so a filter change does not
   slam it shut mid-read. */
let vizTableOpen = false;

function tableHtml(rows) {
  return `<details class="viz-card viz-table-card" id="viz-table-details"${vizTableOpen ? ' open' : ''}>
    <summary>
      <h4>Result rows</h4>
      <span>${rows.length > 40 ? 'showing first 40' : `${rows.length} shown`}</span>
    </summary>
    <div class="viz-table-wrap">
      <table class="viz-table">
        <thead><tr><th>Participant</th><th>Task</th><th>Condition</th><th>Style</th><th>Answer</th><th>Evidence / localization</th><th>Behavior</th><th>Time split</th></tr></thead>
        <tbody>
          ${rows.slice(0, 40).map(row => {
            const answer = answerCorrect(row);
            const evidence = evidenceQuality(row);
            const inter = row.interaction_summary
              ? `${Number(row.interaction_summary.scroll_count || 0)} scroll · ${Number(row.interaction_summary.ctrl_f_count || 0)} Ctrl-F · ${Number(row.interaction_summary.website_click_count || 0)} page clicks`
              : 'No telemetry';
            return `<tr>
              <td>${adminEsc(row.participant_id)}</td>
              <td><strong>${adminEsc(row.task_type)}</strong><br>${adminEsc(row.task_id)}</td>
              <td>${adminEsc(row.condition)}</td>
              <td>${adminEsc(taskStyle(row))}</td>
              <td>${answer == null ? 'No score' : answer ? 'Correct' : 'Wrong'}</td>
              <td>${pct(evidence)}</td>
              <td>${adminEsc(inter)}</td>
              <td>${seconds(row.answer_multiple_choice_ms)} judge<br>${seconds(row.find_supporting_answer_ms)} evidence</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </details>`;
}

/* Nobody reads a dumbbell chart cold. This is the sentence that turns the marks into a
   reading, and it stays visible rather than hiding behind a help icon. */
function howToReadHtml() {
  return `<div class="viz-guide">
    <span>How to read these charts</span>
    <p>Each row is one slice of the study — Find or Guide, Text or Visual. The
      <b class="viz-guide-ng">orange dot</b> is where that slice landed <b>without</b> grounding and the
      <b class="viz-guide-g">blue dot</b> is where it landed <b>with</b> it; the grey rule between them is
      the effect, so a long rule means grounding changed something and a short one means it did not.
      Direction is what matters: on the time chart, blue to the <b>left</b> of orange means grounding
      was faster; on the accuracy and localization charts, blue to the <b>right</b> means grounding was
      better. The pale dots scattered along each row are the individual trials behind the two means —
      when they are spread wide, the means are standing on very little. A <b>hollow</b> dot marks a cell
      with fewer than ${MIN_CELL_N} rows: read it as "not measured yet", not as a result. The numbers on the
      right restate each row as <b>non-grounded → grounded</b> plus the gap, and <b>n 4 vs 4</b> on the left
      is how many rows each dot averages. Hover or tab onto any row for the full breakdown.</p>
  </div>`;
}

/**
 * The one schema problem this dashboard can actually see, said where it will be read.
 *
 * insertStudyResult drops `task_style` and saves the row anyway when the column is missing, which is
 * the right call — an answer, its timings and its scores are worth far more than a facet label — but
 * it warns to a console nobody has open. The symptom surfaces here instead, as a whole half of the
 * study reading "Unlabeled", and the fix is one ALTER away.
 */
function missingStyleNoticeHtml(allRows) {
  const missing = rowsMissingStyle(allRows);
  if (!missing) return '';
  return `<div class="viz-schema-warn">
    <strong>${missing} of ${allRows.length} rows were saved without <code>task_style</code></strong> —
    this database predates that column, so the site dropped it rather than lose the row. The facets
    below fall back to the stimulus each row came from, which resolves every published task; to fix
    it at the source, run the <code>alter table … add column if not exists task_style text;</code>
    from <code>supabase_results_v2.sql</code> in the Supabase SQL editor.
  </div>`;
}

function visualizationHtml(allRows, filters = { taskType: 'all', condition: 'all', style: 'all', participant: 'all', search: '', completeOnly: vizCompleteOnly }) {
  const rows = rowsFor(allRows, filters);
  const conditionLegend = legendHtml([
    { label: 'Non-grounded', color: VIZ_INK.nongrounded },
    { label: 'Grounded', color: VIZ_INK.grounded },
  ]);

  const speedCells = facetCells(rows, r => r.find_supporting_answer_ms);
  const accuracyCells = facetCells(rows, answerCorrect);
  const evidenceCells = facetCells(rows, evidenceQuality);

  const timeSplitCells = [];
  ['find', 'guide'].forEach(taskType => {
    VIZ_STYLES.forEach(style => {
      const facet = rows.filter(r => r.task_type === taskType && taskStyle(r) === style);
      if (!facet.length) return;
      [['nongrounding', 'non-grounded'], ['grounding', 'grounded']].forEach(([condition, word]) => {
        const subset = conditionRows(facet, condition);
        if (!subset.length) return;
        timeSplitCells.push({
          label: `${taskType === 'find' ? 'Find' : 'Guide'} · ${VIZ_STYLE_LABEL[style]} · ${word}`,
          judge: avg(subset, 'answer_multiple_choice_ms') || 0,
          locate: avg(subset, 'find_supporting_answer_ms') || 0,
        });
      });
    });
  });

  // `column` is the flat copy, preferred when present: rows written before the jsonb existed can
  // still carry the count, and rows written before the columns existed still carry the jsonb.
  // The shared list (BEHAVIOR_METRICS) plus the two the chart splits out but the cards do not.
  const behaviorKeys = BEHAVIOR_METRICS.concat([
    { key: 'website_click_count', label: 'Page clicks' },
    { key: 'panel_click_count', label: 'Panel clicks' },
  ]);
  const behaviorCells = behaviorKeys.map(({ key, column, label }) => ({
    key,
    label,
    grounded: cellFor(conditionRows(rows, 'grounding'), r => behaviorValue(r, key, column)),
    nongrounded: cellFor(conditionRows(rows, 'nongrounding'), r => behaviorValue(r, key, column)),
  })).filter(c => c.grounded.n || c.nongrounded.n);

  return `<div class="viz-dashboard">
    <div class="viz-protocol">
      <div>
        <span>Research question</span>
        <strong>Does grounding make verification faster without costing accuracy?</strong>
      </div>
      <p>Every chart reads left to right as non-grounded → grounded, split by Find/Guide × Text/Visual. Hollow dots mean fewer than ${MIN_CELL_N} rows in that cell.</p>
    </div>
    ${freshnessHtml(allRows)}
    ${missingStyleNoticeHtml(allRows)}
    ${controlsHtml(allRows, filters)}
    ${verdictHtml(rows)}
    ${researchAnswersHtml(rows)}
    ${breakdownSummaryHtml(allRows)}
    ${howToReadHtml()}
    <div class="viz-chart-grid">
      <div class="viz-card">
        <h4>Time to locate the evidence</h4>
        ${conditionLegend}
        ${svgDumbbell(speedCells, { format: seconds, betterLower: true, deltaWords: ['faster', 'slower'], aria: 'Evidence-finding time, non-grounded versus grounded' })}
        <p class="viz-note">Q1b duration. Faint dots are individual rows.</p>
      </div>
      <div class="viz-card">
        <h4>Answer accuracy</h4>
        ${conditionLegend}
        ${svgDumbbell(accuracyCells, { format: pct, axisFormat: pctAxis, deltaFormat: points, max: 1, betterLower: false, deltaWords: ['more accurate', 'less accurate'], aria: 'Answer accuracy, non-grounded versus grounded' })}
        <p class="viz-note">Find uses the Q1a claim judgment; Guide uses the verdict.</p>
      </div>
      <div class="viz-card">
        <h4>Evidence localization quality</h4>
        ${conditionLegend}
        ${svgDumbbell(evidenceCells, { format: pct, axisFormat: pctAxis, deltaFormat: points, max: 1, betterLower: false, deltaWords: ['better', 'worse'], aria: 'Evidence localization quality, non-grounded versus grounded' })}
        <p class="viz-note">F1 — the harmonic mean of precision and recall, so over-claiming costs as
          much as missing. Find: the passages picked. Guide: the error types named and the steps blamed,
          one F1 each, averaged. On a run that contains no error, a correct “no error” scores in full so
          the row still counts.</p>
      </div>
      <div class="viz-card">
        <h4>Effort spent verifying</h4>
        ${conditionLegend}
        ${behaviorCells.length
          ? `${svgDumbbell(behaviorCells, { format: oneDecimal, betterLower: true, deltaWords: ['less', 'more'], aria: 'Behavioral traces, non-grounded versus grounded' })}
             <p class="viz-note">Mean per row. Fewer scrolls and Ctrl-F uses is the predicted direction.</p>`
          : '<div class="viz-empty">No telemetry recorded yet — scroll, Ctrl-F and click counts are missing from every visible row.</div>'}
      </div>
      <div class="viz-card viz-card-wide">
        <h4>Where the time goes</h4>
        ${legendHtml([
          { label: 'Judging the claim (Q1a)', color: VIZ_INK.judge },
          { label: 'Locating the evidence (Q1b)', color: VIZ_INK.locate },
        ])}
        ${svgTimeSplit(timeSplitCells)}
        <p class="viz-note">Grounding is only expected to move the second segment.</p>
      </div>
    </div>
    ${compositionHtml(rows)}
    ${tableHtml(rows)}
  </div>`;
}

/* One tooltip element for the whole dashboard, and one set of delegated listeners: the panel is
   rebuilt from scratch on every keystroke in the search box, so anything bound to a mark would
   be thrown away with it. */
let vizTipEl = null;
let vizTipBound = false;

function vizTip() {
  if (vizTipEl && document.body.contains(vizTipEl)) return vizTipEl;
  vizTipEl = document.createElement('div');
  vizTipEl.className = 'viz-tip';
  vizTipEl.hidden = true;
  document.body.appendChild(vizTipEl);
  return vizTipEl;
}

function showVizTip(target, x, y) {
  let payload;
  try {
    payload = JSON.parse(target.getAttribute('data-tip') || '');
  } catch (e) {
    return;
  }
  const tip = vizTip();
  tip.textContent = '';

  const title = document.createElement('b');
  title.textContent = payload.title || '';
  tip.appendChild(title);

  (payload.rows || []).forEach(row => {
    const line = document.createElement('span');
    const key = document.createElement('i');
    key.style.background = row.color;
    const value = document.createElement('strong');
    value.textContent = row.value;
    const label = document.createElement('em');
    label.textContent = row.label;
    line.append(key, value, label);
    tip.appendChild(line);
  });

  if (payload.foot) {
    const foot = document.createElement('small');
    foot.textContent = payload.foot;
    tip.appendChild(foot);
  }

  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const pad = 12;
  const left = Math.min(Math.max(pad, x + 14), window.innerWidth - box.width - pad);
  const top = y - box.height - 14 < pad ? y + 20 : y - box.height - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideVizTip() {
  if (vizTipEl) vizTipEl.hidden = true;
}

function bindVizTooltip() {
  if (vizTipBound) return;
  vizTipBound = true;
  document.addEventListener('pointermove', (e) => {
    const hit = e.target.closest?.('[data-tip]');
    if (hit) showVizTip(hit, e.clientX, e.clientY);
    else hideVizTip();
  });
  document.addEventListener('pointerleave', hideVizTip);
  document.addEventListener('scroll', hideVizTip, true);
  /* Keyboard gets the same readout: tab through the rows, Esc dismisses. */
  document.addEventListener('focusin', (e) => {
    const hit = e.target.closest?.('[data-tip]');
    if (!hit) return hideVizTip();
    const box = hit.getBoundingClientRect();
    showVizTip(hit, box.left + box.width / 2, box.top + box.height);
  });
  document.addEventListener('focusout', hideVizTip);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideVizTip(); });
}

/**
 * The analysis, kept OUT of the re-render path.
 *
 * Every filter change re-renders the dashboard, and a request that fired on render would spend real
 * money on every keystroke in the search box. It runs when the button is pressed, on the rows
 * currently in view, and the result is held here so a re-render can put it back.
 */
let lastAnalysis = null;

async function runVizAnalysis() {
  const btn = document.getElementById('viz-analyze');
  const out = document.getElementById('viz-analysis');
  if (!btn || !out) return;
  const rows = rowsFor(adminVizRows, currentVizFilters());
  const withNotes = !!document.getElementById('viz-analyze-notes')?.checked;

  btn.disabled = true;
  btn.textContent = '… analysing';
  out.hidden = false;
  out.innerHTML = '<p class="viz-analysis-status">Asking the model to read the numbers…</p>';

  try {
    const result = await window.StudyDB.requestAnalysis({
      summary: analysisSummary(rows),
      notes: withNotes ? analysisNotes(rows) : [],
    });
    lastAnalysis = { ...result, rows: rows.length, withNotes };
    out.innerHTML = analysisHtml(lastAnalysis);
  } catch (e) {
    out.innerHTML = `<p class="viz-analysis-status viz-analysis-error">${adminEsc(e.message || e)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Rerun analysis';
  }
}

function analysisHtml(result) {
  return `
    <div class="viz-analysis-head">
      <span>Analysis</span>
      <span class="viz-analysis-meta">${adminEsc(result.model)} · ${result.rows} rows ·
        ${result.withNotes ? `${result.notes_included} notes included` : 'aggregates only'} ·
        ${adminEsc(new Date(result.generated_at).toLocaleString())}</span>
    </div>
    <div class="viz-analysis-body">${renderAnalysisMarkdown(result.analysis)}</div>
    <p class="viz-analysis-foot">Written by a model from the aggregates above — read it as a summary
      to check, not as a result. The charts are the data.</p>`;
}

/**
 * Just enough Markdown for a prose answer: headings, bold, lists, paragraphs.
 *
 * Escaped first, so nothing the model writes can inject markup into the dashboard.
 */
function renderAnalysisMarkdown(text) {
  const lines = adminEsc(String(text || '')).split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  lines.forEach(raw => {
    const line = raw.trim();
    const inline = (v) => v
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (!line) { closeList(); return; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); out.push(`<h5>${inline(heading[2])}</h5>`); return; }
    const bullet = line.match(/^[-*]\s+(.*)$/) || line.match(/^\d+\.\s+(.*)$/);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      return;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  });
  closeList();
  return out.join('');
}

/** What this pane is showing and when it was read, with a way to read it again. */
function freshnessHtml(allRows) {
  const when = vizLoadedAt
    ? vizLoadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'not yet';
  const people = participantCount(allRows);
  return `<div class="viz-freshness">
    <span>Read from Supabase at <b>${adminEsc(when)}</b> —
      ${allRows.length} row${allRows.length === 1 ? '' : 's'},
      ${people} participant${people === 1 ? '' : 's'}. Reopening this tab always refetches.</span>
    <button class="admin-chip" id="viz-refresh" type="button">↻ Reload from Supabase</button>
  </div>`;
}

function bindVisualizationControls() {
  bindVizTooltip();
  document.getElementById('viz-analyze')?.addEventListener('click', runVizAnalysis);
  bindAdminJob('viz-figures', 'figures', 'Publishing figures…',
    'Figures and dataset written. They are built from the tasks each card counts BY DEFAULT, not '
    + 'from any boxes ticked here — re-run after changing a default, not after a look.');
  bindAdminJob('viz-huggingface', 'huggingface', 'Uploading to Hugging Face…',
    'Pushed. Participants’ free-text notes and session ids are not in it; the export carries a '
    + 'per-run participant number instead.');
  // Filters re-slice what is already in hand; this is the one control that goes back to the table.
  document.getElementById('viz-refresh')?.addEventListener('click', () => showAdminVisualizations());

  const redrawCards = () => renderAdminVisualizations(adminVizRows, currentVizFilters());
  // The picker rebuilds the pane on every tick, so its open state has to be remembered or it would
  // snap shut the moment you used it.
  document.querySelectorAll('.viz-task-picker').forEach(d => {
    d.addEventListener('toggle', () => {
      if (d.open) facetPickerOpen.add(d.dataset.facet);
      else facetPickerOpen.delete(d.dataset.facet);
    });
  });
  document.querySelectorAll('.viz-task-check').forEach(box => {
    box.addEventListener('change', () => {
      const key = box.dataset.facet;
      // Materialise "all" into a real set the first time one is unticked, so the two states are the
      // same shape from here on.
      const all = Array.from(document.querySelectorAll(`.viz-task-check[data-facet="${key}"]`));
      const on = new Set(all.filter(b => b.checked).map(b => b.dataset.task));
      if (!on.size) { box.checked = true; return; }   // a card counting nothing is not a view of it
      // Always written, even when it is everything: an unset entry means "use the defaults", and a
      // facet with default exclusions would snap back to them the moment you ticked the last box on.
      facetTaskFilters.set(key, on);
      redrawCards();
    });
  });
  document.querySelectorAll('.viz-task-reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.facet;
      const ids = (btn.dataset.tasks || '').split(/\s+/).filter(Boolean);
      // An explicit "all", not an absence — see chosenTasksFor. Deleting the entry would restore the
      // default exclusions, which is the opposite of what this button says.
      facetTaskFilters.set(key, new Set(ids));
      redrawCards();
    });
  });
  // A re-render (a filter change, a search keystroke) rebuilds the pane; put the last analysis back
  // rather than making the researcher pay for it again, and say which rows it was written from.
  if (lastAnalysis) {
    const out = document.getElementById('viz-analysis');
    if (out) { out.hidden = false; out.innerHTML = analysisHtml(lastAnalysis); }
  }
  document.getElementById('viz-table-details')?.addEventListener('toggle', (e) => {
    vizTableOpen = e.target.open;
  });
  document.querySelectorAll('.viz-breakdown-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      breakdownFinishedOnly = btn.dataset.mode === 'finished';
      renderAdminVisualizations(adminVizRows, currentVizFilters());
    });
  });
  document.getElementById('viz-filter-complete')?.addEventListener('click', () => {
    vizCompleteOnly = !vizCompleteOnly;
    renderAdminVisualizations(adminVizRows, currentVizFilters());
  });
  ['viz-filter-task', 'viz-filter-condition', 'viz-filter-style', 'viz-filter-participant'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => renderAdminVisualizations(adminVizRows, currentVizFilters()));
  });
  document.getElementById('viz-filter-search')?.addEventListener('input', () => {
    const filters = currentVizFilters();
    renderAdminVisualizations(adminVizRows, filters);
    const search = document.getElementById('viz-filter-search');
    if (search) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  });
}

/**
 * Wire one of the helper-run jobs to a button, and say what it did.
 *
 * DISABLED WHILE IT RUNS, because both jobs take seconds and neither is idempotent in a way anyone
 * would enjoy: a second click during a Hugging Face upload is a second commit to a public repo.
 *
 * The status stays on screen after it finishes rather than flashing — the useful part of "figures
 * published" is the sentence about WHICH tasks they were built from, and a toast that vanished
 * would take that with it.
 */
function bindAdminJob(buttonId, job, runningText, doneText) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.addEventListener('click', async () => {
    const status = document.getElementById('viz-job-status');
    const say = (text, bad = false) => {
      if (!status) return;
      status.hidden = false;
      status.textContent = text;
      status.classList.toggle('is-bad', bad);
    };
    button.disabled = true;
    say(runningText);
    try {
      const out = await window.StudyDB.runAdminJob(job);
      // The script's own last line is the honest summary — row counts, the repo it pushed to —
      // and it is more specific than anything this file could say about work it did not do.
      const tail = String(out?.output || '').trim().split('\n').filter(Boolean).pop();
      say(`${doneText}${tail ? `\n${tail}` : ''}`);
    } catch (e) {
      say(e.message || String(e), true);
    } finally {
      button.disabled = false;
    }
  });
}

function renderAdminVisualizations(rows, filters) {
  const content = document.getElementById('admin-content');
  content.innerHTML = visualizationHtml(rows, filters) + '<button class="admin-exit" id="admin-exit">Leave admin mode</button>';
  bindVisualizationControls();
  bindAdminExit();
}

function bindAdminExit() {
  const exit = document.getElementById('admin-exit');
  if (!exit) return;
  exit.onclick = () => {
    window.StudyAdmin.revokeAdmin();
    adminPanel.hidden = true;
    adminPanel.innerHTML = '';
  };
}

/**
 * Refetch every time this pane is opened, and say when it was fetched.
 *
 * Opening the dashboard is the gesture that means "show me where the study is now", so it always
 * goes back to Supabase — the reads are `no-store`, so no layer between here and the table can
 * answer from memory. Filter changes deliberately do NOT refetch: they re-slice rows already in
 * hand, and re-reading the table on every keystroke would be a request per character.
 *
 * The stamp exists because freshness is otherwise unfalsifiable. Numbers that have not moved since
 * yesterday look identical whether nobody ran a task or the fetch quietly served a cached copy, and
 * a researcher should not have to guess which.
 */
// ── Trajectory editor ────────────────────────────────────────────────────────
// Turning a clean recorded run into one that contains an error, so the study has runs where
// localization can be measured at all. The arithmetic lives in app/trajectory_edit.js; this is the
// screen around it. Nothing is written until Save, and the record on screen is a working copy — a
// half-finished edit is discarded by leaving, not published.

let editRecord = null;      // the working copy, unsaved
let editList = [];
let editStatus = '';

const GUIDE_ERROR_TYPES = [
  { id: 'loop', label: 'Loop / no progress' },
  { id: 'mismatch', label: 'Action–goal mismatch' },
  { id: 'wrong_target', label: 'Wrong target / misclick' },
];

async function showTrajectoryEditor() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="viz-loading">Loading trajectories…</div>';
  try {
    editList = await window.StudyDB.listAllStudyTrajectories();
  } catch (e) {
    content.innerHTML = `<div class="welcome-status welcome-status-bad">Could not load trajectories: ${adminEsc(e.message || e)}</div>`
      + '<button class="admin-exit" id="admin-exit">Leave admin mode</button>';
    bindAdminExit();
    return;
  }
  renderTrajectoryEditor();
}

function renderTrajectoryEditor() {
  const content = document.getElementById('admin-content');
  const picked = editRecord?.id || '';
  const options = editList.map(t => `<option value="${adminEsc(t.id)}"${t.id === picked ? ' selected' : ''}>`
    + `${t.in_study ? '● live' : '○ draft'} · ${adminEsc(t.condition || '?')} · ${adminEsc(t.id)}`
    + ` — ${adminEsc(String(t.goal || t.title || '').slice(0, 60))}</option>`).join('');

  content.innerHTML = `
    <label class="welcome-label" for="edit-pick">Trajectory</label>
    <select class="welcome-input" id="edit-pick">
      <option value="">Choose a trajectory…</option>
      ${options}
    </select>
    <div id="edit-body">${editRecord ? trajectoryEditorBodyHtml(editRecord) : ''}</div>
    <div class="welcome-status" id="edit-status">${adminEsc(editStatus)}</div>
    <button class="admin-exit" id="admin-exit">Leave admin mode</button>`;

  document.getElementById('edit-pick').onchange = async (e) => {
    const id = e.target.value;
    editStatus = '';
    if (!id) { editRecord = null; return renderTrajectoryEditor(); }
    setEditStatus('Loading…');
    try {
      editRecord = await window.StudyDB.getStudyTrajectory(id);
    } catch (err) {
      editRecord = null;
      return setEditStatus(`Could not load: ${err.message || err}`, true);
    }
    editStatus = '';
    renderTrajectoryEditor();
  };
  bindTrajectoryEditorBody();
  bindAdminExit();
}

function setEditStatus(text, bad) {
  editStatus = text;
  const el = document.getElementById('edit-status');
  if (el) {
    el.textContent = text;
    el.className = `welcome-status${bad ? ' welcome-status-bad' : ''}`;
  }
}

/**
 * The place a written step goes, closed until asked for.
 *
 * One slot per gap rather than a single form with a "where?" dropdown: the position is the thing
 * being chosen, and choosing it by pointing at the gap cannot be got wrong. `after = 0` is the gap
 * above step 1 — there is no step 0, and before the first step is a real place to add one.
 */
function addStepSlotHtml(after) {
  return `<li class="edit-slot" data-after="${adminEsc(String(after))}" hidden>
    <form class="edit-new edit-addform">
      <label class="welcome-label">New step ${after === 0 ? 'before step 1' : `after step ${adminEsc(String(after))}`}</label>
      <input type="text" class="welcome-input edit-new-text" placeholder="What the agent did, e.g. Click the 'Search' button again." required>
      <div class="edit-new-row">
        <input type="file" class="edit-new-shot" accept="image/*">
        <button type="submit" class="q-btn">Insert step</button>
        <button type="button" class="admin-chip edit-new-cancel">Cancel</button>
      </div>
      <p class="edit-new-note">The screenshot is the page this step happened on. A step without one
        shows nothing when a grounded participant hovers it, so add one unless you mean it to be blank.</p>
    </form>
  </li>`;
}

/**
 * The edit form for one step, closed until asked for.
 *
 * Shows the screenshot it already has. "Replace" is a claim about something you cannot see from a
 * step number — swapping the wrong step's picture is invisible until a participant hovers it — so
 * the current one is on screen while you choose the new one.
 */
function editStepSlotHtml(step) {
  const n = adminEsc(String(step.n));
  return `<li class="edit-slot edit-editslot" data-edit="${n}" hidden>
    <form class="edit-new edit-editform">
      <label class="welcome-label">Editing step ${n}</label>
      <input type="text" class="welcome-input edit-edit-text" value="${adminEsc(step.instruction || '')}" required>
      ${step.screenshot
        ? `<img class="edit-thumb" src="data:image/jpeg;base64,${step.screenshot}" alt="Step ${n} screenshot">`
        : '<p class="edit-new-note">This step has no screenshot.</p>'}
      <div class="edit-new-row">
        <input type="file" class="edit-edit-shot" accept="image/*">
        <button type="submit" class="q-btn">Apply</button>
        <button type="button" class="admin-chip edit-edit-cancel">Cancel</button>
        ${step.screenshot
          ? '<label class="edit-live"><input type="checkbox" class="edit-edit-clear"> Remove the screenshot</label>'
          : ''}
      </div>
      <p class="edit-new-note">Leave the file box empty to keep the screenshot as it is. The text
        changes in both conditions; the screenshot only in the grounded one.</p>
    </form>
  </li>`;
}

/**
 * The agent's answer, its evidence, and a preview of how the two will render together.
 *
 * The preview earns its place: what a participant sees is not the text in the box. Markers become
 * numbered chips, and the numbering follows what SURVIVES — delete three of five markers and the
 * remaining two are chips 1 and 2, not 2 and 5. That renumbering is invisible in the source, so it
 * is shown instead of explained.
 */
function answerEditorHtml(record) {
  const arm = record.arms?.grounding || {};
  const items = Array.isArray(arm.answer_evidence) ? arm.answer_evidence : [];
  const report = window.TrajectoryEdit.answerEvidenceReport(record);

  return `
    <label class="welcome-label" for="edit-answer">Agent answer</label>
    <p class="viz-note">Write <code>[ev:key]</code> where a claim rests on something the agent saw.
      Remove a marker and the chips after it renumber themselves.</p>
    <textarea class="welcome-input edit-answer" id="edit-answer" rows="6">${adminEsc(arm.answer || '')}</textarea>
    <div class="admin-row">
      <button type="button" class="q-btn" id="edit-answer-apply">Apply answer</button>
      <span class="edit-answer-count">${report.shown} chip${report.shown === 1 ? '' : 's'} will show</span>
    </div>

    <label class="welcome-label">Preview — as the participant sees it</label>
    <div class="edit-preview">${answerPreviewHtml(arm)}</div>

    ${report.danglingMarkers.length ? `<p class="edit-problem">⚠ These markers have no evidence, so
      they render as nothing: ${adminEsc(report.danglingMarkers.map(k => `[ev:${k}]`).join(' '))}.
      Add evidence under that key, or take the marker out.</p>` : ''}
    ${report.unusedEvidence.length ? `<p class="edit-problem">⚠ Evidence nobody can reach — no marker
      points at ${adminEsc(report.unusedEvidence.join(', '))}. Add <code>[ev:key]</code> to the answer,
      or remove it below.</p>` : ''}

    <label class="welcome-label">Evidence behind the answer</label>
    <div class="edit-ev-list">
      ${items.length ? items.map(e => {
        const key = String(e.key || '');
        const used = !report.unusedEvidence.includes(key);
        return `<div class="edit-ev">
          <div class="edit-ev-head">
            <code>${adminEsc(key)}</code>
            <span class="edit-ev-flag${used ? '' : ' is-unused'}">${used ? 'linked' : 'not linked'}</span>
            ${e.step != null ? `<span class="edit-ev-step">step ${adminEsc(String(e.step))}</span>` : ''}
            <button type="button" class="admin-chip edit-ev-del" data-key="${adminEsc(key)}">✕ Remove</button>
          </div>
          <input type="text" class="admin-inline-input edit-ev-note" data-key="${adminEsc(key)}"
            value="${adminEsc(e.note || '')}" placeholder="what this shows">
          ${e.screenshot
            ? `<img class="edit-thumb" src="data:image/jpeg;base64,${e.screenshot}" alt="${adminEsc(key)}">`
            : '<p class="edit-new-note">No screenshot — the chip will open an empty card.</p>'}
          <input type="file" class="edit-ev-shot" data-key="${adminEsc(key)}" accept="image/*">
        </div>`;
      }).join('') : '<p class="edit-new-note">No evidence recorded for this answer yet.</p>'}
    </div>

    <form class="edit-new edit-evform">
      <label class="welcome-label">Add evidence</label>
      <div class="edit-new-row">
        <input type="text" class="admin-inline-input edit-ev-newkey" placeholder="key, e.g. cart_total" required>
        <input type="text" class="admin-inline-input edit-ev-newnote" placeholder="what it shows">
      </div>
      <div class="edit-new-row">
        <input type="file" class="edit-ev-newshot" accept="image/*">
        <button type="submit" class="q-btn">Add evidence</button>
      </div>
      <p class="edit-new-note">Adding evidence does not cite it — put <code>[ev:key]</code> in the
        answer where the claim it backs is made.</p>
    </form>`;
}

/** The answer with its markers resolved, numbered exactly as stimulus.js will number them. */
function answerPreviewHtml(arm) {
  const byKey = new Map();
  (arm.answer_evidence || []).forEach(e => {
    if (e?.key) byKey.set(String(e.key).trim().toLowerCase(), e);
  });
  let shown = 0;
  const withChips = adminEsc(arm.answer || '')
    .replace(/\[ev:\s*([^\]]+)\]/gi, (m, rawKey) => {
      const hit = byKey.get(String(rawKey).trim().toLowerCase());
      if (!hit) return '';
      shown++;
      return `<span class="tv-chip" title="${adminEsc(hit.note || hit.key)}">${shown}</span>`;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
  // THE SAME RENDERER THE STIMULUS USES (app/markdown.js), not an approximation of it. A preview
  // that lays text out differently from the page it previews is worse than none: it shows a layout
  // no participant will see and hides the one they will.
  const md = window.StudyMarkdown.render(withChips);
  return md.trim() ? md : '<span class="edit-new-note">Nothing to preview yet.</span>';
}

/** A file, as the bare base64 the trajectory stores (no data: prefix — the renderers add it). */
function readImageAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

function trajectoryEditorBodyHtml(record) {
  const arm = record.arms?.grounding;
  if (!arm) return '<div class="viz-empty">This trajectory has no grounded arm to edit.</div>';
  const steps = arm.steps || [];
  const gt = record.ground_truth || {};
  const errors = Array.isArray(gt.errors) ? gt.errors : [];
  const blamed = new Map();
  errors.forEach(e => (e.steps || []).forEach(n => blamed.set(Number(n), e.type)));
  const problem = window.TrajectoryEdit.groundTruthProblem(gt);

  return `
    <div class="edit-head">
      <div><b>${adminEsc(record.goal || record.title || record.id)}</b></div>
      <label class="edit-live">
        <input type="checkbox" id="edit-in-study"${record.in_study ? ' checked' : ''}>
        In study — shown to participants
      </label>
    </div>

    <p class="viz-note">Duplicating a step repeats the action on the same page, which is what a
      stuck agent looks like. Mark the repeats as a <b>loop</b> error below, then save.
      <button type="button" class="admin-chip edit-add" data-step="0"
        title="Write a new step and insert it before step 1">＋ Add step at the start</button></p>

    <ol class="edit-steps">
      ${addStepSlotHtml(0)}
      ${steps.map(s => `
        <li class="edit-step${blamed.has(Number(s.n)) ? ' is-blamed' : ''}">
          <span class="edit-step-n">${adminEsc(String(s.n))}</span>
          <span class="edit-step-text">${adminEsc(s.instruction || '')}
            ${blamed.has(Number(s.n)) ? `<em class="edit-step-flag">${adminEsc(blamed.get(Number(s.n)))}</em>` : ''}
            ${s.screenshot ? '' : '<em class="edit-step-flag edit-step-noshot">no screenshot</em>'}</span>
          <button type="button" class="admin-chip edit-dup" data-step="${adminEsc(String(s.n))}"
            title="Insert a copy of this step directly after it">⧉ Duplicate</button>
          <button type="button" class="admin-chip edit-add" data-step="${adminEsc(String(s.n))}"
            title="Write a new step and insert it after this one">＋ Add step</button>
          <button type="button" class="admin-chip edit-edit" data-step="${adminEsc(String(s.n))}"
            title="Change what this step says, or its screenshot">✎ Edit</button>
          <button type="button" class="admin-chip edit-remove" data-step="${adminEsc(String(s.n))}"
            title="Delete this step and renumber the rest"${steps.length <= 1 ? ' disabled' : ''}>✕ Remove</button>
        </li>
        ${editStepSlotHtml(s)}
        ${addStepSlotHtml(s.n)}`).join('')}
    </ol>

    ${answerEditorHtml(record)}

    <label class="welcome-label">Which error did the agent make, and where?</label>
    <div class="edit-errors">
      ${GUIDE_ERROR_TYPES.map(t => `
        <label class="edit-error-row">
          <input type="checkbox" class="edit-error-type" value="${t.id}"
            ${errors.some(e => e.type === t.id) ? 'checked' : ''}>
          <span>${adminEsc(t.label)}</span>
          <input type="text" class="admin-inline-input edit-error-steps" data-type="${t.id}"
            placeholder="steps, e.g. 7,8"
            value="${adminEsc((errors.find(e => e.type === t.id)?.steps || []).join(','))}">
        </label>`).join('')}
    </div>

    <label class="welcome-label" for="edit-correctness">Did the agent complete the task?</label>
    <select class="welcome-input" id="edit-correctness">
      ${['success', 'failure'].map(v => `<option value="${v}"${gt.correctness === v ? ' selected' : ''}>`
        + `${v === 'success' ? 'Yes, it completed the task' : 'No, it did not'}</option>`).join('')}
    </select>

    ${problem ? `<p class="edit-problem">⚠ ${adminEsc(problem)}</p>` : ''}

    <div class="admin-row" style="margin-top:12px;">
      <button type="button" class="q-btn" id="edit-save">Save to Supabase</button>
      <button type="button" class="admin-chip" id="edit-cancel">✕ Cancel — reload the saved version</button>
      <button type="button" class="admin-chip" id="edit-reset">↺ Reset to another trajectory…</button>
    </div>

    <!-- Two different undos, because they undo different things. Cancel throws away what has not
         been saved; Reset replaces the steps wholesale from a trajectory that is still clean, which
         is the way back once a bad edit HAS been saved. -->
    <div class="edit-reset-panel" id="edit-reset-panel" hidden>
      <label class="welcome-label" for="edit-reset-src">Copy the steps and ground truth from</label>
      <select class="welcome-input" id="edit-reset-src">
        ${resetSourceOptions(record).map(t => `<option value="${adminEsc(t.id)}"${t.suggested ? ' selected' : ''}>`
          + `${t.suggested ? '↳ same goal · ' : ''}${adminEsc(t.id)} — ${adminEsc(String(t.goal || '').slice(0, 50))}`
          + `</option>`).join('')}
      </select>
      <p class="edit-new-note">Replaces every step, the evidence and the ground truth of
        <b>this</b> trajectory. Its id and its In-study setting are kept. Nothing is written until
        you press Save.</p>
      <div class="admin-row">
        <button type="button" class="q-btn" id="edit-reset-apply">Replace the steps</button>
        <button type="button" class="admin-chip" id="edit-reset-cancel">Cancel</button>
      </div>
    </div>`;
}

/**
 * Trajectories this one could be reset from, the likeliest first.
 *
 * A duplicate carries its source's goal, so the trajectory sharing this goal is almost always the
 * clean original it was copied from — worth preselecting, not worth assuming. Everything else stays
 * in the list because a trajectory can also be reset from something it was never copied from.
 */
function resetSourceOptions(record) {
  const goal = String(record?.goal || '').trim();
  return editList
    .filter(t => t.id !== record.id)
    .map(t => Object.assign({}, t, { suggested: !!goal && String(t.goal || '').trim() === goal }))
    .sort((a, b) => (b.suggested ? 1 : 0) - (a.suggested ? 1 : 0));
}

function bindTrajectoryEditorBody() {
  document.querySelectorAll('.edit-dup').forEach(btn => {
    btn.onclick = () => {
      const n = Number(btn.dataset.step);
      try {
        // Every step-number reference in the record moves with the insert — see cloneRecordStep.
        editRecord = window.TrajectoryEdit.cloneRecordStep(editRecord, n, 1);
      } catch (e) {
        return setEditStatus(e.message || String(e), true);
      }
      setEditStatus(`Duplicated step ${n}. Not saved yet.`);
      const body = document.getElementById('edit-body');
      body.innerHTML = trajectoryEditorBodyHtml(editRecord);
      bindTrajectoryEditorBody();
    };
  });

  document.querySelectorAll('.edit-remove').forEach(btn => {
    btn.onclick = () => {
      const n = Number(btn.dataset.step);
      const was = editRecord.arms.grounding.steps.find(s => Number(s.n) === n);
      try {
        editRecord = window.TrajectoryEdit.removeRecordStep(editRecord, n);
      } catch (e) {
        return setEditStatus(e.message || String(e), true);
      }
      setEditStatus(`Removed step ${n} — “${String(was?.instruction || '').slice(0, 40)}”. `
        + `${editRecord.arms.grounding.steps.length} steps left. Not saved yet; Cancel puts it back.`);
      const body = document.getElementById('edit-body');
      body.innerHTML = trajectoryEditorBodyHtml(editRecord);
      bindTrajectoryEditorBody();
    };
  });

  const closeAllSlots = () => document.querySelectorAll('.edit-slot').forEach(s => { s.hidden = true; });

  document.querySelectorAll('.edit-edit').forEach(btn => {
    btn.onclick = () => {
      closeAllSlots();
      const slot = document.querySelector(`.edit-editslot[data-edit="${btn.dataset.step}"]`);
      if (!slot) return;
      slot.hidden = false;
      slot.querySelector('.edit-edit-text')?.focus();
    };
  });
  document.querySelectorAll('.edit-edit-cancel').forEach(btn => {
    btn.onclick = () => { btn.closest('.edit-slot').hidden = true; };
  });
  // SCOPED BY ITS OWN CLASS, not by `.edit-new`. Both forms carry `.edit-new` for its styling, so a
  // binding on that selector catches the other form too — and because the add binding runs after
  // this one, it was overwriting this handler. Apply then ran the ADD path with no insert position
  // and failed on a step number of NaN.
  document.querySelectorAll('.edit-editform').forEach(form => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const n = Number(form.closest('.edit-editslot').dataset.edit);
      const instruction = form.querySelector('.edit-edit-text').value.trim();
      if (!instruction) return setEditStatus('A step needs something to say.', true);
      const file = form.querySelector('.edit-edit-shot').files[0] || null;
      const clear = form.querySelector('.edit-edit-clear')?.checked;
      // undefined leaves the picture alone, null takes it away — see updateRecordStep.
      let screenshot;
      if (file) {
        setEditStatus('Reading the screenshot…');
        try { screenshot = await readImageAsBase64(file); } catch (err) { return setEditStatus(err.message, true); }
      } else if (clear) {
        screenshot = null;
      }
      try {
        editRecord = window.TrajectoryEdit.updateRecordStep(editRecord, n, { instruction, screenshot });
      } catch (err) {
        return setEditStatus(err.message || String(err), true);
      }
      setEditStatus(`Step ${n} updated`
        + `${file ? ' with a new screenshot' : (clear ? ' — screenshot removed' : '')}. Not saved yet.`);
      const body = document.getElementById('edit-body');
      body.innerHTML = trajectoryEditorBodyHtml(editRecord);
      bindTrajectoryEditorBody();
    };
  });

  const slotFor = (after) => document.querySelector(`.edit-slot[data-after="${after}"]`);
  document.querySelectorAll('.edit-add').forEach(btn => {
    btn.onclick = () => {
      // One open at a time: two half-filled forms in one list is an invitation to submit the wrong one.
      closeAllSlots();
      const slot = slotFor(btn.dataset.step);
      if (!slot) return;
      slot.hidden = false;
      slot.querySelector('.edit-new-text')?.focus();
    };
  });
  document.querySelectorAll('.edit-new-cancel').forEach(btn => {
    btn.onclick = () => { btn.closest('.edit-slot').hidden = true; };
  });
  document.querySelectorAll('.edit-addform').forEach(form => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const slot = form.closest('.edit-slot');
      const after = Number(slot.dataset.after);
      const instruction = form.querySelector('.edit-new-text').value.trim();
      if (!instruction) return setEditStatus('Give the step something to say.', true);
      const file = form.querySelector('.edit-new-shot').files[0] || null;
      let screenshot = null;
      if (file) {
        setEditStatus('Reading the screenshot…');
        try { screenshot = await readImageAsBase64(file); } catch (err) { return setEditStatus(err.message, true); }
      }
      try {
        editRecord = window.TrajectoryEdit.addRecordStep(editRecord, after, { instruction, screenshot });
      } catch (err) {
        return setEditStatus(err.message || String(err), true);
      }
      setEditStatus(`Added a step ${after === 0 ? 'before step 1' : `after step ${after}`}`
        + `${screenshot ? ' with a screenshot' : ' — no screenshot'}. Not saved yet.`);
      const body = document.getElementById('edit-body');
      body.innerHTML = trajectoryEditorBodyHtml(editRecord);
      bindTrajectoryEditorBody();
    };
  });

  const rerender = () => {
    const body = document.getElementById('edit-body');
    body.innerHTML = trajectoryEditorBodyHtml(editRecord);
    bindTrajectoryEditorBody();
  };

  document.getElementById('edit-answer-apply')?.addEventListener('click', () => {
    const text = document.getElementById('edit-answer')?.value ?? '';
    try {
      editRecord = window.TrajectoryEdit.setAnswer(editRecord, text);
    } catch (e) {
      return setEditStatus(e.message || String(e), true);
    }
    const r = window.TrajectoryEdit.answerEvidenceReport(editRecord);
    setEditStatus(`Answer updated — ${r.shown} chip${r.shown === 1 ? '' : 's'} will show. Not saved yet.`);
    rerender();
  });

  document.querySelectorAll('.edit-ev-del').forEach(btn => {
    btn.onclick = () => {
      editRecord = window.TrajectoryEdit.removeEvidence(editRecord, btn.dataset.key);
      setEditStatus(`Removed evidence “${btn.dataset.key}” and its marker. Not saved yet.`);
      rerender();
    };
  });
  document.querySelectorAll('.edit-ev-note').forEach(input => {
    input.onchange = () => {
      editRecord = window.TrajectoryEdit.upsertEvidence(editRecord,
        { key: input.dataset.key, note: input.value });
      setEditStatus(`Note updated for “${input.dataset.key}”. Not saved yet.`);
    };
  });
  document.querySelectorAll('.edit-ev-shot').forEach(input => {
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      setEditStatus('Reading the screenshot…');
      let screenshot;
      try { screenshot = await readImageAsBase64(file); } catch (e) { return setEditStatus(e.message, true); }
      editRecord = window.TrajectoryEdit.upsertEvidence(editRecord,
        { key: input.dataset.key, screenshot });
      setEditStatus(`Screenshot replaced for “${input.dataset.key}”. Not saved yet.`);
      rerender();
    };
  });
  document.querySelector('.edit-evform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const key = form.querySelector('.edit-ev-newkey').value.trim();
    const note = form.querySelector('.edit-ev-newnote').value.trim();
    const file = form.querySelector('.edit-ev-newshot').files[0] || null;
    let screenshot = null;
    if (file) {
      setEditStatus('Reading the screenshot…');
      try { screenshot = await readImageAsBase64(file); } catch (err) { return setEditStatus(err.message, true); }
    }
    try {
      editRecord = window.TrajectoryEdit.upsertEvidence(editRecord, { key, note, screenshot });
    } catch (err) {
      return setEditStatus(err.message || String(err), true);
    }
    setEditStatus(`Added evidence “${key}”. Put [ev:${key}] in the answer to cite it. Not saved yet.`);
    rerender();
  });

  const inStudy = document.getElementById('edit-in-study');
  if (inStudy) inStudy.onchange = () => { editRecord.in_study = inStudy.checked; };
  const correctness = document.getElementById('edit-correctness');
  if (correctness) correctness.onchange = () => {
    editRecord.ground_truth = Object.assign({}, editRecord.ground_truth, { correctness: correctness.value });
  };

  // Cancel goes back to what Supabase holds, which is the definition of "unsaved changes gone".
  document.getElementById('edit-cancel')?.addEventListener('click', async () => {
    const id = editRecord?.id;
    if (!id) return;
    setEditStatus('Reloading the saved version…');
    try {
      editRecord = await window.StudyDB.getStudyTrajectory(id);
    } catch (e) {
      return setEditStatus(`Could not reload: ${e.message || e}`, true);
    }
    setEditStatus('Reloaded from Supabase — unsaved edits discarded.');
    const body = document.getElementById('edit-body');
    body.innerHTML = trajectoryEditorBodyHtml(editRecord);
    bindTrajectoryEditorBody();
  });

  const panel = document.getElementById('edit-reset-panel');
  document.getElementById('edit-reset')?.addEventListener('click', () => { if (panel) panel.hidden = false; });
  document.getElementById('edit-reset-cancel')?.addEventListener('click', () => { if (panel) panel.hidden = true; });
  document.getElementById('edit-reset-apply')?.addEventListener('click', async () => {
    const src = document.getElementById('edit-reset-src')?.value;
    if (!src) return;
    setEditStatus('Loading the source trajectory…');
    let source;
    try {
      source = await window.StudyDB.getStudyTrajectory(src);
    } catch (e) {
      return setEditStatus(`Could not load ${src}: ${e.message || e}`, true);
    }
    if (!source?.arms?.grounding) return setEditStatus(`${src} has no grounded arm to copy.`, true);
    // The id and the publish flag belong to THIS trajectory, not to the one being copied — resetting
    // the steps must not quietly republish a draft or rename the row.
    editRecord = Object.assign({}, editRecord, {
      arms: JSON.parse(JSON.stringify(source.arms)),
      ground_truth: JSON.parse(JSON.stringify(source.ground_truth || {})),
    });
    if (panel) panel.hidden = true;
    setEditStatus(`Steps replaced from ${src} `
      + `(${editRecord.arms.grounding.steps.length} steps). Not saved yet.`);
    const body = document.getElementById('edit-body');
    body.innerHTML = trajectoryEditorBodyHtml(editRecord);
    bindTrajectoryEditorBody();
  });

  document.getElementById('edit-save')?.addEventListener('click', saveTrajectoryEdit);
}

/** Read the error rows back off the form. */
function collectEditorErrors() {
  return Array.from(document.querySelectorAll('.edit-error-type'))
    .filter(box => box.checked)
    .map(box => ({
      type: box.value,
      steps: String(document.querySelector(`.edit-error-steps[data-type="${box.value}"]`)?.value || '')
        .split(/[,\s]+/).map(Number).filter(Number.isFinite),
    }));
}

async function saveTrajectoryEdit() {
  if (!editRecord) return;
  const gt = window.TrajectoryEdit.setGroundTruthErrors(
    Object.assign({}, editRecord.ground_truth,
      { correctness: document.getElementById('edit-correctness')?.value || editRecord.ground_truth?.correctness }),
    collectEditorErrors()
  );

  // REFUSE TO PUBLISH WHAT CANNOT BE SCORED. A live trajectory whose ground truth the scorer rejects
  // returns null for every measure, and the rows come back looking like participants who answered
  // nothing. A draft may be saved half-finished — that is what a draft is for.
  const problem = window.TrajectoryEdit.groundTruthProblem(gt);
  if (problem && editRecord.in_study) {
    return setEditStatus(`Cannot publish yet — ${problem}`, true);
  }

  const steps = editRecord.arms?.grounding?.steps || [];
  const maxStep = steps.length;
  const outOfRange = gt.errors.flatMap(e => e.steps).filter(n => n < 1 || n > maxStep);
  if (outOfRange.length) {
    return setEditStatus(`No such step: ${outOfRange.join(', ')} — this run has steps 1–${maxStep}.`, true);
  }

  setEditStatus('Saving…');
  try {
    await window.StudyDB.updateStudyTrajectory(editRecord.id, {
      arms: editRecord.arms,
      ground_truth: gt,
      in_study: !!editRecord.in_study,
    });
  } catch (e) {
    return setEditStatus(e.message || String(e), true);
  }
  editRecord.ground_truth = gt;
  // The picker is built from a list read once when the tab opened, so without this a trajectory
  // just published still reads "○ draft" in the dropdown — the save worked and the screen said it
  // had not, which is the same lie the silent 204 used to tell.
  const listed = editList.find(t => t.id === editRecord.id);
  if (listed) {
    listed.in_study = !!editRecord.in_study;
    listed.ground_truth = gt;
  }
  setEditStatus(`Saved — ${steps.length} steps, `
    + `${gt.errors.length ? gt.errors.map(e => `${e.type} at ${e.steps.join(',')}`).join('; ') : 'no error'}. `
    + `${editRecord.in_study ? 'LIVE — participants can draw this task.' : 'Still a draft, not shown to anyone.'}`);
  renderTrajectoryEditor();
}

// ── The Find task editor ─────────────────────────────────────────────────────────────────────────
// The Guide half has had an editor since the trajectories needed errors planted in them. The Find
// half had none: its tasks were whatever the publisher last uploaded, and taking one out of the
// study meant editing a row in the Supabase console. This is that, with the checks the console
// cannot make — that a task about to go live still has an answer to score against, and that its
// wording says which of the four cells it belongs to.
//
// WHAT `in_study` DOES. listStudyTasks filters on it, so it is the whole difference between a task
// participants can draw and one that exists but is never shown. Untick it and the task stops
// appearing in new sessions immediately; rows already collected under it stay exactly where they
// are, which is the point — this is how a broken task leaves the rotation without leaving the data.

let findTaskList = [];
let findTaskRecord = null;
let findTaskStatus = '';
/** The two banked agent answers for the open task: { grounding, nongrounding }, either may be null. */
let findTaskCanned = { grounding: null, nongrounding: null };
let findCannedStatus = '';

const FIND_CONDITIONS = [
  { id: 'grounding', label: 'Grounded', note: 'carries the citations and saved evidence' },
  { id: 'nongrounding', label: 'Non-grounded', note: 'the same claims with nothing to check them against' },
];

/**
 * The citation markers inside an answer, in the order they are read.
 *
 * `[368:"Harry assumes in the first book…"]` — an element index and the exact phrase. Mirrors
 * parseFindCitations in app/study.js; the two must agree, because that one decides what a
 * participant actually sees and this one only describes it.
 */
function parseAnswerCitations(answer) {
  const out = [];
  String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (marker, index, text) => {
    out.push({ marker, index: Number(index), text });
    return marker;
  });
  return out;
}

/** The [ev:key] markers in an answer — the saved image crops, as opposed to quoted passages. */
function parseAnswerEvidenceKeys(answer) {
  const keys = [];
  String(answer || '').replace(/\[ev:([^\]]+)\]/g, (m, key) => {
    const clean = String(key || '').trim();
    if (clean && !keys.includes(clean)) keys.push(clean);
    return m;
  });
  return keys;
}

/** Same normalisation study.js keys anchors by, so "has an anchor" here means what it means there. */
function normAnchorText(v) {
  return String(v == null ? '' : v)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchorKeyOf(index, quote) {
  return `${Number(index)}:${normAnchorText(quote)}`;
}

/** Does this citation have a recorded locator, or will it fall back to searching the page for it? */
function citationHasAnchor(row, cite) {
  const anchors = Array.isArray(row?.citation_anchors) ? row.citation_anchors : [];
  return anchors.some(a => a && a.index != null && anchorKeyOf(a.index, a.quote) === anchorKeyOf(cite.index, cite.text));
}

/** The two wordings studyStyle() can read a cell out of. Anything else lands the task nowhere. */
const FIND_TASK_TYPES = ['FIND X VISUAL', 'FIND X TEXT'];

function setFindTaskStatus(message, bad = false) {
  findTaskStatus = message;
  const el = document.getElementById('findtask-status');
  if (!el) return;
  el.textContent = message;
  el.className = `welcome-status${bad ? ' welcome-status-bad' : ''}`;
}

/**
 * Which of the four study cells this task will count towards, decided the way the study decides it.
 *
 * Called against the CURRENT form values rather than the saved row, because getting this wrong is
 * invisible until the dashboard: a task whose wording names neither VISUAL nor TEXT gets `style: ''`
 * from studyStyle(), lands in no bucket in styleBuckets(), and quietly never reaches a participant
 * even with in_study ticked. Better to say so under the field.
 */
function findTaskStyleOf(draft) {
  return studyStyle({
    taskType: 'find', type: draft.type, title: draft.title, question: draft.question,
  });
}

/** The form as it stands, read straight off the inputs — the record is only what was last saved. */
function readFindTaskForm() {
  const value = (id) => String(document.getElementById(id)?.value ?? '').trim();
  const lines = value('findtask-distractors').split('\n').map(s => s.trim()).filter(Boolean);
  return {
    id: findTaskRecord?.id || '',
    title: value('findtask-title'),
    url: value('findtask-url'),
    type: value('findtask-type'),
    question: value('findtask-question'),
    answer: value('findtask-answer'),
    distractors: lines,
    task_index: Number(value('findtask-index')),
    in_study: !!document.getElementById('findtask-in-study')?.checked,
  };
}

/**
 * Why this task cannot go live yet, or ''.
 *
 * Only enforced against a task being PUBLISHED. A draft is allowed to be half-written — that is
 * what a draft is for, and the same rule the trajectory editor applies before it lets one out.
 */
function findTaskProblem(draft) {
  if (!draft.question) return 'it has no question.';
  if (!draft.answer) return 'it has no correct answer, so nothing can be scored against it.';
  if (!draft.distractors.length) return 'it has no distractors, so the multiple choice has one option.';
  if (!draft.url) return 'it has no URL, so there is no page to verify it on.';
  if (!findTaskStyleOf(draft)) {
    return 'nothing in its type, title or question says VISUAL or TEXT, so it belongs to no cell '
      + 'and would never be drawn.';
  }
  const clash = draft.distractors.find(d => d.toLowerCase() === draft.answer.toLowerCase());
  if (clash) return 'one distractor is identical to the correct answer.';
  return '';
}

async function showFindTaskEditor() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="viz-loading">Loading Find tasks…</div>';
  try {
    findTaskList = await window.StudyDB.listAllStudyTasks();
  } catch (e) {
    content.innerHTML = `<div class="welcome-status welcome-status-bad">Could not load Find tasks: ${adminEsc(e.message || e)}</div>`
      + '<button class="admin-exit" id="admin-exit">Leave admin mode</button>';
    bindAdminExit();
    return;
  }
  renderFindTaskEditor();
}

function renderFindTaskEditor() {
  const content = document.getElementById('admin-content');
  const picked = findTaskRecord?.id || '';
  const live = findTaskList.filter(t => t.in_study).length;
  const options = findTaskList.map(t => `<option value="${adminEsc(t.id)}"${t.id === picked ? ' selected' : ''}>`
    + `${t.in_study ? '● live' : '○ held out'} · ${adminEsc(t.id)}`
    + ` — ${adminEsc(String(t.title || t.question || '').slice(0, 60))}</option>`).join('');

  content.innerHTML = `
    <p class="viz-note">${findTaskList.length} Find task${findTaskList.length === 1 ? '' : 's'},
      <b>${live} in the study</b>. Only the live ones are drawn into a participant's queue; the rest
      stay in the table untouched, and so do the results already collected under them.</p>
    <label class="welcome-label" for="findtask-pick">Find task</label>
    <select class="welcome-input" id="findtask-pick">
      <option value="">Choose a task…</option>
      ${options}
    </select>
    <div id="findtask-body">${findTaskRecord ? findTaskEditorBodyHtml(findTaskRecord) : ''}</div>
    <div class="welcome-status" id="findtask-status">${adminEsc(findTaskStatus)}</div>
    <button class="admin-exit" id="admin-exit">Leave admin mode</button>`;

  document.getElementById('findtask-pick').onchange = async (e) => {
    findTaskStatus = '';
    findTaskRecord = findTaskList.find(t => t.id === e.target.value) || null;
    findTaskCanned = { grounding: null, nongrounding: null };
    // Set before the render, not after: an unset status would draw "nothing banked for this arm"
    // for the length of the fetch, which is the one thing this pane must never say by accident.
    findCannedStatus = findTaskRecord ? 'Loading the agent answers…' : '';
    renderFindTaskEditor();
    if (findTaskRecord) await loadFindTaskCanned(findTaskRecord.id);
  };
  bindFindTaskControls();
  bindAdminExit();
}

function findTaskEditorBodyHtml(record) {
  const distractors = Array.isArray(record.distractors) ? record.distractors : [];
  const typeValue = String(record.type || '');
  const known = FIND_TASK_TYPES.includes(typeValue.toUpperCase());
  // Rows are counted only when the dashboard has already been opened this session; a number that
  // appeared for some visits and not others would be worse than a sentence that is always true.
  const collected = adminVizRows.filter(r => String(r.task_id) === String(record.id)).length;

  return `
    <div class="edit-head">
      <div><b>${adminEsc(record.id)}</b> <span class="findtask-style">${adminEsc(findTaskStyleOf(record) || 'no cell')}</span></div>
      <label class="edit-live">
        <input type="checkbox" id="findtask-in-study"${record.in_study ? ' checked' : ''}>
        Use in the study — shown to participants
      </label>
    </div>

    <label class="welcome-label" for="findtask-title">Title</label>
    <input type="text" class="welcome-input" id="findtask-title" value="${adminEsc(record.title || '')}">

    <label class="welcome-label" for="findtask-url">Page URL</label>
    <input type="text" class="welcome-input" id="findtask-url" value="${adminEsc(record.url || '')}">
    <p class="viz-note">The frozen snapshot in <code>study_task_pages</code> is keyed by task id and
      falls back to this URL, so changing it can change which page the task opens. It does not
      re-capture anything — that is <code>scripts/publish.mjs</code>.</p>

    <label class="welcome-label" for="findtask-type">Cell</label>
    <select class="welcome-input" id="findtask-type">
      ${FIND_TASK_TYPES.map(t => `<option value="${t}"${t === typeValue.toUpperCase() ? ' selected' : ''}>${t}</option>`).join('')}
      ${known ? '' : `<option value="${adminEsc(typeValue)}" selected>${adminEsc(typeValue || '(blank)')} — unrecognised</option>`}
    </select>
    <p class="viz-note" id="findtask-style-note"></p>

    <label class="welcome-label" for="findtask-question">Question</label>
    <textarea class="welcome-input" id="findtask-question" rows="4">${adminEsc(record.question || '')}</textarea>

    <label class="welcome-label" for="findtask-answer">Correct answer</label>
    <textarea class="welcome-input" id="findtask-answer" rows="2">${adminEsc(record.answer || '')}</textarea>

    <label class="welcome-label" for="findtask-distractors">Distractors — one per line</label>
    <textarea class="welcome-input" id="findtask-distractors" rows="4">${adminEsc(distractors.join('\n'))}</textarea>

    ${collected ? `<p class="edit-problem">⚠ ${collected} result row${collected === 1 ? ' has' : 's have'}
      already been collected on this task. Rewriting the answer or the distractors makes those rows
      and every future row answers to different questions — take the task out of the study instead if
      what you want is to stop using it.</p>` : ''}

    <label class="welcome-label">Options, as the participant sees them</label>
    <ol class="findtask-options">
      ${[record.answer, ...distractors].filter(Boolean).map((opt, i) => `<li${i === 0 ? ' class="is-correct"' : ''}>
        ${adminEsc(opt)}${i === 0 ? ' <b>← correct</b>' : ''}</li>`).join('')}
    </ol>
    <p class="viz-note">Shown in a shuffled order at question time; listed correct-first here so the
      key is readable.</p>

    <label class="welcome-label" for="findtask-index">Order in the queue</label>
    <input type="number" class="welcome-input" id="findtask-index" value="${adminEsc(String(record.task_index ?? 0))}">

    <div class="admin-row">
      <button type="button" class="welcome-btn" id="findtask-save">Save task</button>
      <button type="button" class="admin-chip" id="findtask-revert">Undo my edits</button>
    </div>

    <div id="findtask-canned">${findTaskCannedHtml(record)}</div>`;
}

/**
 * Fetch the two banked agent answers for a task.
 *
 * One request per condition rather than one for both: the grounded row on a visual task carries a
 * base64 screenshot crop per evidence item, so "both rows for every task" is megabytes, and the
 * editor only ever shows one task at a time.
 */
async function loadFindTaskCanned(taskId) {
  findCannedStatus = 'Loading the agent answers…';
  const pane = document.getElementById('findtask-canned');
  if (pane) pane.innerHTML = '<div class="viz-loading">Loading the agent answers…</div>';
  try {
    const [grounding, nongrounding] = await Promise.all([
      window.StudyDB.getCannedResponse(taskId, 'grounding'),
      window.StudyDB.getCannedResponse(taskId, 'nongrounding'),
    ]);
    // A late reply for a task the researcher has already navigated away from must not overwrite the
    // one now on screen — the two requests race with the picker.
    if (findTaskRecord?.id !== taskId) return;
    findTaskCanned = { grounding, nongrounding };
    findCannedStatus = '';
  } catch (e) {
    findCannedStatus = `Could not load the agent answers: ${e.message || e}`;
  }
  const target = document.getElementById('findtask-canned');
  if (target && findTaskRecord) {
    target.innerHTML = findTaskCannedHtml(findTaskRecord);
    bindFindTaskCannedControls();
  }
}

/**
 * The agent's recorded answer for one arm, and what it rests on.
 *
 * WHAT CAN BE EDITED HERE AND WHAT CANNOT. The answer TEXT can: it is prose, and a typo in it is
 * the commonest thing found while reading a task. The citation ANCHORS cannot — an anchor is a
 * locator resolved against the frozen page (tag, element index, character offsets), and there is no
 * page on this screen to resolve a new one against. What this screen can do is tell you which
 * citations still have one, and let you delete a citation whose quote no longer exists. Repairing an
 * anchor is a different gesture, done on the task screen where the page is loaded and "Pick exact
 * text" can point at it; the link below goes there.
 *
 * EDITING A QUOTE BREAKS ITS ANCHOR, silently, because anchors are keyed by index + quote text. The
 * citation then falls back to searching the page for the phrase, which usually works and sometimes
 * lands on the wrong copy of it. The list says which state each citation is in, before and after.
 */
function findTaskCannedHtml(record) {
  if (findCannedStatus) {
    return `<div class="welcome-status${findCannedStatus.startsWith('Could not') ? ' welcome-status-bad' : ''}">${adminEsc(findCannedStatus)}</div>`;
  }

  return `
    <h4 class="findtask-section">The agent's answers</h4>
    <p class="viz-note">What the participant is shown as the agent's report, one per arm. Both are
      read from <code>study_canned_responses</code>. The two arms must make the <b>same claims</b> —
      the study compares grounding, not two different answers — so edit them together.</p>
    ${FIND_CONDITIONS.map(c => findTaskArmHtml(record, c)).join('')}
    <p class="viz-note">To re-point a citation at a different passage, or to attach a new image crop,
      use <b>Review tasks → 🔍 Find only → Grounded</b> and open this task: the repair tools there
      work on the frozen page, which is the only place a new anchor can be resolved.</p>
    <div class="welcome-status" id="findtask-canned-status"></div>`;
}

function findTaskArmHtml(record, condition) {
  const row = findTaskCanned[condition.id];
  if (!row) {
    return `<div class="findtask-arm">
      <div class="findtask-arm-head"><b>${condition.label}</b>
        <span class="findtask-arm-note">${condition.note}</span></div>
      <p class="edit-problem">Nothing banked for this arm. A task with no ${condition.label.toLowerCase()}
        answer cannot be shown in that condition — publish it with <code>scripts/publish.mjs</code>.</p>
    </div>`;
  }

  const answer = row.answer_display || row.answer_raw || '';
  const cites = parseAnswerCitations(answer);
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const linked = parseAnswerEvidenceKeys(answer);
  const anchors = Array.isArray(row.citation_anchors) ? row.citation_anchors : [];

  return `
    <div class="findtask-arm" data-arm="${condition.id}">
      <div class="findtask-arm-head">
        <b>${condition.label}</b>
        <span class="findtask-arm-note">${condition.note}</span>
        <span class="findtask-arm-n">${cites.length} citation${cites.length === 1 ? '' : 's'} ·
          ${evidence.length} evidence · ${anchors.length} anchor${anchors.length === 1 ? '' : 's'}</span>
      </div>

      <label class="welcome-label" for="findtask-answer-${condition.id}">Answer text</label>
      <textarea class="welcome-input findtask-answer" id="findtask-answer-${condition.id}"
        data-arm="${condition.id}" rows="8">${adminEsc(answer)}</textarea>
      <p class="viz-note">Markers stay in the text: <code>[368:"the exact quoted phrase"]</code> is a
        citation into the page, <code>[ev:key]</code> opens a saved image crop. The non-grounded arm
        renders with every marker stripped, so a marker left in it costs nothing and shows nothing.</p>

      ${cites.length ? `
        <label class="welcome-label">Citations in this answer</label>
        <ol class="findtask-cites">
          ${cites.map((c, i) => {
            const anchored = citationHasAnchor(row, c);
            return `<li>
              <div class="findtask-cite-head">
                <code>[${adminEsc(String(c.index))}]</code>
                <span class="findtask-cite-flag${anchored ? '' : ' is-loose'}">${anchored
                  ? 'anchored' : 'no anchor — found by searching the page'}</span>
                <button type="button" class="admin-chip findtask-cite-del"
                  data-arm="${condition.id}" data-i="${i}">✕ Remove</button>
              </div>
              <div class="findtask-cite-q">${adminEsc(c.text)}</div>
            </li>`;
          }).join('')}
        </ol>` : ''}

      ${evidence.length ? `
        <label class="welcome-label">Saved evidence</label>
        <div class="findtask-ev-list">
          ${evidence.map(e => {
            const key = String(e?.key || '');
            const used = linked.includes(key);
            return `<div class="findtask-ev">
              <div class="findtask-cite-head">
                <code>${adminEsc(key)}</code>
                <span class="findtask-cite-flag${used ? '' : ' is-loose'}">${used
                  ? 'linked' : 'no [ev:] marker points at it'}</span>
              </div>
              <div class="findtask-cite-q">${adminEsc(e?.note || '')}</div>
              ${e?.shot ? `<img class="edit-thumb" src="data:image/jpeg;base64,${e.shot}" alt="${adminEsc(key)}">` : ''}
            </div>`;
          }).join('')}
        </div>` : ''}

      <div class="admin-row">
        <button type="button" class="welcome-btn findtask-canned-save" data-arm="${condition.id}">
          Save the ${condition.label.toLowerCase()} answer</button>
      </div>
    </div>`;
}

function bindFindTaskCannedControls() {
  document.querySelectorAll('.findtask-canned-save').forEach(btn => {
    btn.onclick = () => saveFindTaskCanned(btn.dataset.arm);
  });
  document.querySelectorAll('.findtask-cite-del').forEach(btn => {
    btn.onclick = () => removeFindTaskCitation(btn.dataset.arm, Number(btn.dataset.i));
  });
}

function setCannedStatus(message, bad = false) {
  const el = document.getElementById('findtask-canned-status');
  if (!el) return;
  el.textContent = message;
  el.className = `welcome-status${bad ? ' welcome-status-bad' : ''}`;
}

/**
 * Take one citation out of an answer, and its anchor with it.
 *
 * BY POSITION, not by text. The same phrase can be cited twice — that is what two markers with the
 * same index and quote are — and removing "the one that matches" would delete both, or the wrong
 * one. The anchor goes only if no OTHER surviving citation still keys to it, for the same reason.
 */
function removeFindTaskCitation(arm, position) {
  const row = findTaskCanned[arm];
  const field = document.getElementById(`findtask-answer-${arm}`);
  if (!row || !field) return;
  const text = field.value;
  const cites = parseAnswerCitations(text);
  const target = cites[position];
  if (!target) return;

  let seen = -1;
  const next = text.replace(/\[(\d+):"([^"]*)"\]/g, (marker) => {
    seen++;
    return seen === position ? '' : marker;
  }).replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  field.value = next;

  const stillUsed = parseAnswerCitations(next)
    .some(c => anchorKeyOf(c.index, c.text) === anchorKeyOf(target.index, target.text));
  if (!stillUsed && Array.isArray(row.citation_anchors)) {
    row.citation_anchors = row.citation_anchors
      .filter(a => !a || a.index == null || anchorKeyOf(a.index, a.quote) !== anchorKeyOf(target.index, target.text));
  }
  // Not saved yet — the button below the list is still the thing that writes.
  row.answer_display = next;
  row.answer_raw = next;
  const pane = document.getElementById('findtask-canned');
  if (pane && findTaskRecord) {
    pane.innerHTML = findTaskCannedHtml(findTaskRecord);
    bindFindTaskCannedControls();
    setCannedStatus('Citation removed from the text — not saved yet.');
  }
}

async function saveFindTaskCanned(arm) {
  const row = findTaskCanned[arm];
  const field = document.getElementById(`findtask-answer-${arm}`);
  if (!row || !field || !findTaskRecord) return;
  const answer = field.value;

  // answer_raw and answer_display are written together and kept identical, which is what the
  // in-task editor does (app/study.js) and what every banked row already looks like. Two fields
  // that could disagree would mean the answer scored against and the answer read were not the same.
  const patch = {
    answer_raw: answer,
    answer_display: answer,
    citation_anchors: Array.isArray(row.citation_anchors) ? row.citation_anchors : [],
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
  };
  setCannedStatus('Saving…');
  try {
    await window.StudyDB.updateCannedResponseGrounding(findTaskRecord.id, arm, patch);
  } catch (e) {
    return setCannedStatus(e.message || String(e), true);
  }
  Object.assign(row, patch);
  const cites = parseAnswerCitations(answer);
  const loose = cites.filter(c => !citationHasAnchor(row, c)).length;
  const pane = document.getElementById('findtask-canned');
  if (pane) {
    pane.innerHTML = findTaskCannedHtml(findTaskRecord);
    bindFindTaskCannedControls();
  }
  setCannedStatus(`Saved the ${arm === 'grounding' ? 'grounded' : 'non-grounded'} answer — `
    + `${cites.length} citation${cites.length === 1 ? '' : 's'}`
    + `${loose ? `, ${loose} of them without an anchor (found by searching the page)` : ''}.`);
}

function bindFindTaskControls() {
  if (!findTaskRecord) return;
  const restyle = () => {
    const note = document.getElementById('findtask-style-note');
    if (!note) return;
    const style = findTaskStyleOf(readFindTaskForm());
    note.textContent = style
      ? `Counts as ${style.replace('_', ' / ')} in the dashboard.`
      : 'Nothing here says VISUAL or TEXT — this task belongs to no cell and would never be drawn.';
    note.classList.toggle('findtask-warn', !style);
  };
  restyle();
  ['findtask-type', 'findtask-title', 'findtask-question'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', restyle);
    document.getElementById(id)?.addEventListener('change', restyle);
  });
  bindFindTaskCannedControls();
  document.getElementById('findtask-save').onclick = saveFindTaskEdit;
  document.getElementById('findtask-revert').onclick = () => {
    findTaskStatus = '';
    // findTaskRecord is still the row as it was loaded, so re-rendering IS the undo.
    renderFindTaskEditor();
  };
}

async function saveFindTaskEdit() {
  if (!findTaskRecord) return;
  const draft = readFindTaskForm();

  // REFUSE TO PUBLISH WHAT CANNOT BE ANSWERED, exactly as saveTrajectoryEdit refuses to publish what
  // cannot be scored. A live task missing its answer produces rows that look like participants who
  // got everything wrong, and nothing in the data says the task was at fault.
  const problem = draft.in_study ? findTaskProblem(draft) : '';
  if (problem) return setFindTaskStatus(`Cannot put this in the study — ${problem}`, true);
  if (!Number.isFinite(draft.task_index)) {
    return setFindTaskStatus('Order in the queue has to be a number.', true);
  }

  setFindTaskStatus('Saving…');
  const patch = {
    title: draft.title,
    url: draft.url,
    type: draft.type,
    question: draft.question,
    answer: draft.answer,
    distractors: draft.distractors,
    task_index: draft.task_index,
    in_study: draft.in_study,
  };
  try {
    await window.StudyDB.updateStudyTask(findTaskRecord.id, patch);
  } catch (e) {
    return setFindTaskStatus(e.message || String(e), true);
  }
  // The picker and the form are both built from the list read when the tab opened, so the saved row
  // has to land back in it — otherwise a task just published still reads "○ held out" and the screen
  // contradicts the write that just succeeded.
  Object.assign(findTaskRecord, patch);
  const listed = findTaskList.find(t => t.id === findTaskRecord.id);
  if (listed) Object.assign(listed, patch);
  renderFindTaskEditor();
  setFindTaskStatus(`Saved ${findTaskRecord.id} — ${draft.distractors.length + 1} options, `
    + `${findTaskStyleOf(draft).replace('_', ' / ') || 'no cell'}. `
    + `${draft.in_study ? 'IN THE STUDY — participants can draw it.' : 'Held out — no new session will show it.'}`);
}

async function showAdminVisualizations() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="viz-loading">Loading study results…</div>';
  try {
    const rows = await window.StudyDB.listStudyResults();
    adminVizRows = rows;
    vizLoadedAt = new Date();
    // Static per task, so it rides along with the results rather than being fetched per card.
    try { taskImageCounts = await window.StudyDB.listTaskImageCounts(); } catch (e) { taskImageCounts = new Map(); }
    try { taskReferenceCounts = await window.StudyDB.listAnswerReferenceCounts(); } catch (e) { taskReferenceCounts = new Map(); }
    if (!rows.length) {
      content.innerHTML = '<div class="viz-empty">No result rows yet.</div><button class="admin-exit" id="admin-exit">Leave admin mode</button>';
    } else {
      renderAdminVisualizations(rows, { taskType: 'all', condition: 'all', style: 'all', participant: 'all', search: '', completeOnly: vizCompleteOnly });
      return;
    }
  } catch (e) {
    content.innerHTML = `<div class="welcome-status welcome-status-bad">Could not load result rows: ${adminEsc(e.message || e)}</div>
      <button class="admin-exit" id="admin-exit">Leave admin mode</button>`;
  }
  bindAdminExit();
}

/**
 * The password prompt, inline rather than window.prompt().
 *
 * prompt() is suppressed outright in a growing number of contexts — sandboxed frames, some
 * enterprise policies, several mobile browsers — and when it is suppressed it returns null with no
 * error, so the button looks broken rather than blocked. An inline field cannot be suppressed, can
 * be styled, and lets Enter submit.
 */
function showAdminLogin() {
  adminPanel.hidden = false;
  adminPanel.innerHTML = `
    <div class="admin-title">Admin</div>
    <label class="welcome-label" for="admin-pass">Password</label>
    <input class="welcome-input" id="admin-pass" type="password" autocomplete="off">
    <div class="admin-row" style="margin-top:10px;">
      <button class="admin-chip admin-chip-on" id="admin-unlock">Unlock</button>
      <button class="admin-chip" id="admin-cancel">Cancel</button>
    </div>
    <div class="welcome-status" id="admin-msg"></div>`;

  const field = document.getElementById('admin-pass');
  const msg = document.getElementById('admin-msg');
  field.focus();

  const submit = () => {
    if (window.StudyAdmin.grantAdmin(field.value)) { showAdminPanel(); return; }
    msg.textContent = 'That password is not right.';
    msg.className = 'welcome-status welcome-status-bad';
    field.select();
  };

  document.getElementById('admin-unlock').onclick = submit;
  field.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  document.getElementById('admin-cancel').onclick = () => {
    adminPanel.hidden = true;
    adminPanel.innerHTML = '';
  };
}

adminBtn.onclick = () => {
  if (window.StudyAdmin.isAdmin()) showAdminPanel();
  else showAdminLogin();
};

startBtn.onclick = async () => {
  // Optional by design: the study does not need to know who anyone is, and an id nobody wanted to
  // give is an id that gets typed as "x" anyway. `anon` is written rather than an empty string so
  // the column is never blank — a blank reads as a bug, "anon" reads as a decision.
  const participantId = idInput.value.trim() || 'anon';

  startBtn.disabled = true;
  say('Starting…');
  window.StudySession.clearLocal();
  // Every new run is offered the walkthrough again. The flag lives outside the session (app/tutorial.js
  // explains why), so it would otherwise outlive the participant who dismissed it and the next person
  // on the same machine would never be shown it.
  try { localStorage.removeItem('pageguide_web_tutorial_done'); } catch (e) { /* ignore */ }

  let assignment = null;
  let sessionId = null;
  try {
    assignment = await window.StudyDB.claimStudyAssignment(
      participantId,
      (window.STUDY_CONFIG || {}).ASSIGNMENT_KEY || 'default'
    );
    sessionId = assignment.sessionId;
  } catch (e) {
    console.warn('[study] could not claim round-robin assignment:', e);
    const detail = e?.message ? ` ${e.message}` : '';
    say(`Could not start the study because the round-robin assignment table is not ready.${detail}`, 'bad');
    startBtn.disabled = false;
    return;
  }

  let assignedQueue = [];
  try {
    assignedQueue = buildRoundRobinQueue(queue, assignment.assignmentSlot);
    if (assignedQueue.length !== 8) throw new Error(`Round-robin assignment built ${assignedQueue.length} tasks instead of 8.`);
  } catch (e) {
    say(e.message, 'bad');
    startBtn.disabled = false;
    return;
  }

  Object.assign(window.StudySession.state, {
    participantId,
    arm: 'grounding',
    sessionId,
    runId: window.StudySession.newRunId(),
    assignmentIndex: assignment.assignmentIndex,
    assignmentSlot: assignment.assignmentSlot,
    queue: assignedQueue,
    idx: 0,
    results: [],
    adminReview: false,
  });
  console.info('[study] round-robin assignment', {
    assignmentIndex: assignment.assignmentIndex,
    assignmentSlot: assignment.assignmentSlot,
    queue: assignedQueue.map((task, i) => ({
      i,
      taskType: task.taskType,
      style: task.style,
      id: task.id,
      arm: task.arm,
    })),
  });
  window.StudySession.saveLocal();
  location.href = 'study.html';
};

init();
