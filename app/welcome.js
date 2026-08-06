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

function buildRoundRobinQueue(list, slot) {
  const buckets = styleBuckets(list);
  const missing = missingStyles(buckets);
  if (missing.length) throw new Error(`Missing published study questions for: ${missing.join(', ')}.`);
  const n = Math.max(0, Number(slot) || 0);
  const grounded = STYLE_ORDER.map((style, i) => {
    const bucket = buckets[style.id];
    return withArm(bucket[n % bucket.length], 'grounding', i);
  });
  const nongrounded = STYLE_ORDER.map((style, i) => {
    const bucket = buckets[style.id];
    return withArm(bucket[(n + 1) % bucket.length], 'nongrounding', STYLE_ORDER.length + i);
  });
  return grounded.concat(nongrounded);
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
  adminPanel.hidden = false;
  adminPanel.innerHTML = `
    <div class="admin-title">🔓 Admin <span class="admin-warn">review mode writes nothing</span></div>
    <div class="admin-tabs" id="admin-tabs">
      ${[['review', 'Review tasks'], ['viz', 'Visualizations']].map(([id, label]) => `
        <button class="admin-tab${o.tab === id ? ' admin-tab-on' : ''}" data-admin-tab="${id}">${label}</button>`).join('')}
    </div>
    <div id="admin-content"></div>`;

  adminPanel.querySelectorAll('[data-admin-tab]').forEach(b => {
    b.onclick = () => {
      window.StudyAdmin.setAdminOptions({ tab: b.dataset.adminTab });
      showAdminPanel();
    };
  });

  if (o.tab === 'viz') {
    showAdminVisualizations();
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
    <button class="admin-chip" id="admin-tutorial">▶ Preview the walkthrough</button>
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

function num(value) {
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

function pct(value) {
  return value == null ? 'No data' : `${Math.round(value * 100)}%`;
}

function oneDecimal(value) {
  return value == null ? 'No data' : String(Math.round(value * 10) / 10);
}

function seconds(value) {
  return value == null ? 'No data' : `${Math.round(value / 1000)}s`;
}

function points(value) {
  return value == null ? 'No data' : `${Math.round(value * 100)} pts`;
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

function evidenceQuality(row) {
  if (row?.task_type === 'find') {
    return avgValues([row.score_evidence_precision, row.score_evidence_recall]);
  }
  if (row?.task_type === 'guide') {
    return avgValues([row.score_type_recall, row.score_step_recall]);
  }
  return null;
}

function rowsFor(rows, filters) {
  const q = String(filters.search || '').trim().toLowerCase();
  return rows.filter(row => {
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
  };
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
      <text x="${xOf(t).toFixed(1)}" y="${baseline + 18}" text-anchor="middle" class="viz-svg-label">${adminEsc(fmt(t))}</text>`).join('')}
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
 * localization question, so the error-type-and-step recall leads and time is the guardrail.
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

/** grounded − non-grounded for one metric over one facet, with the n behind each side. */
function facetDelta(rows, metricFn) {
  const grounded = cellFor(conditionRows(rows, 'grounding'), metricFn);
  const nongrounded = cellFor(conditionRows(rows, 'nongrounding'), metricFn);
  const delta = grounded.mean == null || nongrounded.mean == null
    ? null : grounded.mean - nongrounded.mean;
  return { grounded, nongrounded, delta, n: Math.min(grounded.n, nongrounded.n) };
}

function researchAnswerCard(spec, allRows) {
  const rows = allRows.filter(r => r.task_type === spec.taskType && taskStyle(r) === spec.style);
  const speed = facetDelta(rows, r => r.find_supporting_answer_ms);
  const accuracy = facetDelta(rows, answerCorrect);
  const localization = facetDelta(rows, evidenceQuality);
  const lead = spec.kind === 'speed' ? speed : localization;
  const thin = lead.n < MIN_CELL_N;

  let tone = 'none';
  let headline = 'No data yet';
  if (lead.delta != null) {
    // Faster is better for time; higher is better for localization.
    const helps = spec.kind === 'speed' ? lead.delta < 0 : lead.delta > 0;
    tone = Math.abs(lead.delta) < (spec.kind === 'speed' ? 1000 : 0.05) ? 'flat' : (helps ? 'yes' : 'no');
    headline = spec.kind === 'speed'
      ? (tone === 'flat' ? 'No faster, no slower'
        : `${helps ? 'Yes' : 'No'} — ${seconds(Math.abs(lead.delta))} ${helps ? 'faster' : 'slower'}`)
      : (tone === 'flat' ? 'It makes no difference'
        : `${helps ? 'It helps' : 'It does not help'} — ${points(Math.abs(lead.delta))} ${helps ? 'better' : 'worse'} at locating the step`);
  }

  const guard = spec.kind === 'speed'
    ? (accuracy.delta == null ? 'No scored answers on both sides yet, so the accuracy side is open.'
      : Math.abs(accuracy.delta) < 0.05 ? `Accuracy is flat (${points(Math.abs(accuracy.delta))} apart), so the time is the whole story.`
        : accuracy.delta > 0 ? `And accuracy is ${points(accuracy.delta)} higher with it.`
          : `But accuracy is ${points(Math.abs(accuracy.delta))} lower with it — a faster wrong answer is not a win.`)
    // A localization win with accuracy falling behind it is not a win, so the guardrail carries both
    // — time only when accuracy has nothing to say.
    : [
      accuracy.delta != null && Math.abs(accuracy.delta) >= 0.05
        ? (accuracy.delta > 0 ? `Accuracy is ${points(accuracy.delta)} higher with it.`
          : `But accuracy is ${points(Math.abs(accuracy.delta))} lower with it.`)
        : null,
      speed.delta == null ? 'No paired timings yet, so the time side is open.'
        : Math.abs(speed.delta) < 1000 ? 'Time to locate is unchanged.'
          : speed.delta < 0 ? `It is ${seconds(Math.abs(speed.delta))} faster to locate.`
            : `It takes ${seconds(Math.abs(speed.delta))} longer to locate.`,
    ].filter(Boolean).join(' ');

  const stat = (name, cell, format) => `<div class="viz-answer-stat">
      <span>${adminEsc(name)}</span>
      <b>${adminEsc(format(cell.nongrounded.mean))} → ${adminEsc(format(cell.grounded.mean))}</b>
    </div>`;

  return `<article class="viz-answer viz-answer-${tone}${thin ? ' is-thin' : ''}">
    <header>
      <span class="viz-answer-facet">${adminEsc(spec.label)}</span>
      <span class="viz-answer-n">n ${lead.nongrounded.n} vs ${lead.grounded.n}</span>
    </header>
    <p class="viz-answer-q">${adminEsc(spec.question)}</p>
    <strong class="viz-answer-headline">${adminEsc(headline)}</strong>
    <p class="viz-answer-guard">${adminEsc(guard)}</p>
    <div class="viz-answer-stats">
      ${stat('Locate time', speed, seconds)}
      ${stat('Accuracy', accuracy, pct)}
      ${stat('Localization', localization, pct)}
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
    sessions: new Set(rows.map(r => r.session_id || r.client_run_id || r.participant_id).filter(Boolean)).size,
    min_rows_per_cell_for_confidence: MIN_CELL_N,
    facets: RESEARCH_QUESTIONS.map(spec => {
      const facet = rows.filter(r => r.task_type === spec.taskType && taskStyle(r) === spec.style);
      return {
        facet: spec.label,
        question: spec.question,
        leads_on: spec.kind === 'speed' ? 'time to locate the evidence' : 'error-type and step recall',
        rows: facet.length,
        locate_time_ms: cell(facetDelta(facet, r => r.find_supporting_answer_ms)),
        judge_time_ms: cell(facetDelta(facet, r => r.answer_multiple_choice_ms)),
        accuracy: cell(facetDelta(facet, answerCorrect)),
        localization: cell(facetDelta(facet, evidenceQuality)),
        confidence_very_or_somewhat: cell(facetDelta(facet, r =>
          (r.confidence === 'very' || r.confidence === 'somewhat') ? 1 : 0)),
        helpfulness_very_or_somewhat: cell(facetDelta(facet, r =>
          (r.helpfulness === 'very' || r.helpfulness === 'somewhat') ? 1 : 0)),
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

function researchAnswersHtml(rows) {
  const noteCount = analysisNotes(rows).length;
  return `<section class="viz-answers">
    <div class="viz-answers-head">
      <div>
        <h4>The four questions, at a glance</h4>
        <p class="viz-answers-lead">One card per question. Find asks whether grounding is
          <b>faster</b>, with accuracy as the guardrail; Guide asks how well the evidence supports
          checking a run <b>step by step</b>, with time as the guardrail. Every number reads
          non-grounded → grounded.</p>
      </div>
      <!-- The cards are computed here and always current; this asks a model to read them out and
           say what they mean, which is the part arithmetic cannot do. -->
      <div class="viz-analysis-controls">
        <button class="admin-chip admin-chip-on" id="viz-analyze">↻ Rerun analysis</button>
        <label class="viz-analysis-opt"><input type="checkbox" id="viz-analyze-notes">
          include the ${noteCount} participant note${noteCount === 1 ? '' : 's'}</label>
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

function visualizationHtml(allRows, filters = { taskType: 'all', condition: 'all', style: 'all', participant: 'all', search: '' }) {
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

  const behaviorKeys = [
    { key: 'scroll_count', label: 'Scrolls' },
    { key: 'ctrl_f_count', label: 'Ctrl-F uses' },
    { key: 'website_click_count', label: 'Page clicks' },
    { key: 'panel_click_count', label: 'Panel clicks' },
  ];
  const behaviorCells = behaviorKeys.map(({ key, label }) => ({
    key,
    label,
    grounded: cellFor(conditionRows(rows, 'grounding'), r => r?.interaction_summary?.[key]),
    nongrounded: cellFor(conditionRows(rows, 'nongrounding'), r => r?.interaction_summary?.[key]),
  })).filter(c => c.grounded.n || c.nongrounded.n);

  return `<div class="viz-dashboard">
    <div class="viz-protocol">
      <div>
        <span>Research question</span>
        <strong>Does grounding make verification faster without costing accuracy?</strong>
      </div>
      <p>Every chart reads left to right as non-grounded → grounded, split by Find/Guide × Text/Visual. Hollow dots mean fewer than ${MIN_CELL_N} rows in that cell.</p>
    </div>
    ${missingStyleNoticeHtml(allRows)}
    ${controlsHtml(allRows, filters)}
    ${verdictHtml(rows)}
    ${researchAnswersHtml(rows)}
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
        ${svgDumbbell(accuracyCells, { format: pct, deltaFormat: points, max: 1, betterLower: false, deltaWords: ['more accurate', 'less accurate'], aria: 'Answer accuracy, non-grounded versus grounded' })}
        <p class="viz-note">Find uses the Q1a claim judgment; Guide uses the verdict.</p>
      </div>
      <div class="viz-card">
        <h4>Evidence localization quality</h4>
        ${conditionLegend}
        ${svgDumbbell(evidenceCells, { format: pct, deltaFormat: points, max: 1, betterLower: false, deltaWords: ['better', 'worse'], aria: 'Evidence localization quality, non-grounded versus grounded' })}
        <p class="viz-note">Find: paragraph precision and recall. Guide: error type and step recall.</p>
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

function bindVisualizationControls() {
  bindVizTooltip();
  document.getElementById('viz-analyze')?.addEventListener('click', runVizAnalysis);
  // A re-render (a filter change, a search keystroke) rebuilds the pane; put the last analysis back
  // rather than making the researcher pay for it again, and say which rows it was written from.
  if (lastAnalysis) {
    const out = document.getElementById('viz-analysis');
    if (out) { out.hidden = false; out.innerHTML = analysisHtml(lastAnalysis); }
  }
  document.getElementById('viz-table-details')?.addEventListener('toggle', (e) => {
    vizTableOpen = e.target.open;
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

async function showAdminVisualizations() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="viz-loading">Loading study results…</div>';
  try {
    const rows = await window.StudyDB.listStudyResults();
    adminVizRows = rows;
    if (!rows.length) {
      content.innerHTML = '<div class="viz-empty">No result rows yet.</div><button class="admin-exit" id="admin-exit">Leave admin mode</button>';
    } else {
      renderAdminVisualizations(rows, { taskType: 'all', condition: 'all', style: 'all', participant: 'all', search: '' });
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
