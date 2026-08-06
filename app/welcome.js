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
    <button class="admin-exit" id="admin-exit">Leave admin mode</button>`;

  content.querySelectorAll('[data-half]').forEach(b => {
    b.onclick = () => { window.StudyAdmin.setAdminOptions({ half: b.dataset.half }); showAdminPanel(); };
  });
  content.querySelectorAll('[data-arm]').forEach(b => {
    b.onclick = () => { window.StudyAdmin.setAdminOptions({ arm: b.dataset.arm }); showAdminPanel(); };
  });
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

function signedPct(delta) {
  if (delta == null) return 'No data';
  const n = Math.round(delta * 100);
  return `${n > 0 ? '+' : ''}${n}%`;
}

function oneDecimal(value) {
  return value == null ? 'No data' : String(Math.round(value * 10) / 10);
}

function seconds(value) {
  return value == null ? 'No data' : `${Math.round(value / 1000)}s`;
}

function taskStyle(row) {
  const explicit = String(row?.task_style || '').toLowerCase();
  if (explicit.includes('visual')) return 'visual';
  if (explicit.includes('text')) return 'text';
  const id = String(row?.task_id || '').toLowerCase();
  if (id.includes('text')) return 'text';
  const evidence = Array.isArray(row?.evidence_responses) ? row.evidence_responses : [];
  if (evidence.some(e => String(e?.kind || '').toLowerCase() === 'image')) return 'visual';
  if (row?.task_type === 'find' && evidence.length) return 'text';
  return 'unknown';
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

function interactionAvg(rows, key) {
  return avgValues(rows.map(r => r?.interaction_summary?.[key]));
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

function compareMetric(rows, taskType, metricFn) {
  const relevant = rows.filter(r => r.task_type === taskType);
  const grounded = relevant.filter(r => r.condition === 'grounding');
  const nongrounded = relevant.filter(r => r.condition === 'nongrounding');
  return {
    grounded: avgValues(grounded.map(metricFn)),
    nongrounded: avgValues(nongrounded.map(metricFn)),
    groundedN: grounded.length,
    nongroundedN: nongrounded.length,
  };
}

function insightCard(title, value, detail, tone = '') {
  return `<div class="viz-insight${tone ? ` viz-insight-${tone}` : ''}">
    <span>${adminEsc(title)}</span>
    <strong>${adminEsc(value)}</strong>
    <small>${adminEsc(detail)}</small>
  </div>`;
}

function speedInsight(rows, taskType, key) {
  const c = compareMetric(rows, taskType, r => r[key]);
  if (c.grounded == null || c.nongrounded == null) {
    return insightCard(`${taskType} speed`, 'No comparison yet', 'Need rows in both conditions.');
  }
  const delta = c.nongrounded - c.grounded;
  const faster = delta > 0;
  return insightCard(
    `${taskType} speed`,
    faster ? `${seconds(delta)} faster grounded` : `${seconds(Math.abs(delta))} slower grounded`,
    `Grounded ${seconds(c.grounded)} vs non-grounded ${seconds(c.nongrounded)}.`,
    faster ? 'good' : 'warn'
  );
}

function accuracyInsight(rows) {
  const c = compareMetric(rows, 'find', answerCorrect);
  const g = compareMetric(rows, 'guide', answerCorrect);
  const findDelta = c.grounded == null || c.nongrounded == null ? null : c.grounded - c.nongrounded;
  const guideDelta = g.grounded == null || g.nongrounded == null ? null : g.grounded - g.nongrounded;
  return insightCard(
    'Accuracy cost',
    `Find ${signedPct(findDelta)} · Guide ${signedPct(guideDelta)}`,
    'Positive means grounded was more accurate; near zero supports “faster without costing accuracy”.'
  );
}

function evidenceInsight(rows) {
  const find = compareMetric(rows, 'find', evidenceQuality);
  const guide = compareMetric(rows, 'guide', evidenceQuality);
  return insightCard(
    'Evidence localization',
    `Find ${pct(find.grounded)} · Guide ${pct(guide.grounded)}`,
    'Find uses paragraph evidence quality. Guide uses error type and step recall.'
  );
}

function svgBarChart(title, items, opts = {}) {
  const width = 520;
  const height = 260;
  const top = 34;
  const left = 42;
  const bottom = 50;
  const max = opts.max ?? Math.max(1, ...items.map(i => num(i.value) || 0));
  const innerW = width - left - 16;
  const innerH = height - top - bottom;
  const gap = 12;
  const barW = Math.max(14, (innerW - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length));
  return `<svg class="viz-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${adminEsc(title)}">
    <text x="${left}" y="20" class="viz-svg-title">${adminEsc(title)}</text>
    <line x1="${left}" y1="${top + innerH}" x2="${width - 12}" y2="${top + innerH}" class="viz-axis"></line>
    ${items.map((item, i) => {
      const value = num(item.value);
      const barH = value == null ? 0 : Math.max(0, Math.min(innerH, (value / max) * innerH));
      const x = left + i * (barW + gap);
      const y = top + innerH - barH;
      const label = item.format ? item.format(value) : oneDecimal(value);
      return `<g>
        <title>${adminEsc(item.label)}: ${adminEsc(label)}</title>
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="5" fill="${item.color || '#7857ff'}"></rect>
        <text x="${x + barW / 2}" y="${Math.max(34, y - 6)}" text-anchor="middle" class="viz-svg-value">${adminEsc(label)}</text>
        <text x="${x + barW / 2}" y="${height - 24}" text-anchor="middle" class="viz-svg-label">${adminEsc(item.label)}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

function svgLineChart(title, rows) {
  const width = 720;
  const height = 260;
  const left = 44;
  const top = 34;
  const innerW = width - left - 24;
  const innerH = height - top - 46;
  const indexes = Array.from(new Set(rows.map(r => Number(r.task_index)).filter(Number.isFinite))).sort((a, b) => a - b);
  const series = ['grounding', 'nongrounding'].map(condition => ({
    condition,
    color: condition === 'grounding' ? '#7857ff' : '#0f6b43',
    points: indexes.map(i => ({
      i,
      value: avgValues(rows.filter(r => r.condition === condition && Number(r.task_index) === i).map(r => r.time_ms)),
    })).filter(p => p.value != null),
  }));
  const max = Math.max(1, ...series.flatMap(s => s.points.map(p => p.value)));
  const minIndex = indexes.length ? indexes[0] : 0;
  const maxIndex = indexes.length > 1 ? indexes[indexes.length - 1] : minIndex + 1;
  const xOf = (i) => left + ((i - minIndex) / Math.max(1, maxIndex - minIndex)) * innerW;
  const yOf = (v) => top + innerH - (v / max) * innerH;
  return `<svg class="viz-svg viz-line-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${adminEsc(title)}">
    <text x="${left}" y="20" class="viz-svg-title">${adminEsc(title)}</text>
    <line x1="${left}" y1="${top + innerH}" x2="${width - 16}" y2="${top + innerH}" class="viz-axis"></line>
    <line x1="${left}" y1="${top}" x2="${left}" y2="${top + innerH}" class="viz-axis"></line>
    ${series.map(s => s.points.length ? `<polyline points="${s.points.map(p => `${xOf(p.i)},${yOf(p.value)}`).join(' ')}"
      fill="none" stroke="${s.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${s.points.map(p => `<circle cx="${xOf(p.i)}" cy="${yOf(p.value)}" r="4" fill="${s.color}">
        <title>${s.condition}, task ${p.i + 1}: ${seconds(p.value)}</title>
      </circle>`).join('')}` : '').join('')}
    <text x="${width - 170}" y="20" class="viz-svg-label" fill="#7857ff">Grounded</text>
    <text x="${width - 88}" y="20" class="viz-svg-label" fill="#0f6b43">Non-grounded</text>
    <text x="${left}" y="${height - 12}" class="viz-svg-label">Task order</text>
  </svg>`;
}

function piePath(cx, cy, r, start, end) {
  const sx = cx + r * Math.cos(start);
  const sy = cy + r * Math.sin(start);
  const ex = cx + r * Math.cos(end);
  const ey = cy + r * Math.sin(end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
}

function svgPieChart(title, slices) {
  const total = slices.reduce((sum, s) => sum + Math.max(0, Number(s.value) || 0), 0);
  let start = -Math.PI / 2;
  return `<svg class="viz-svg viz-pie-svg" viewBox="0 0 360 220" role="img" aria-label="${adminEsc(title)}">
    <text x="18" y="22" class="viz-svg-title">${adminEsc(title)}</text>
    ${total ? slices.map((s, i) => {
      const portion = Math.max(0, Number(s.value) || 0) / total;
      const end = start + portion * Math.PI * 2;
      const path = piePath(112, 116, 70, start, end);
      start = end;
      return `<path d="${path}" fill="${s.color}">
        <title>${adminEsc(s.label)}: ${s.value} rows (${Math.round(portion * 100)}%)</title>
      </path>
      <rect x="212" y="${62 + i * 28}" width="10" height="10" rx="2" fill="${s.color}"></rect>
      <text x="230" y="${72 + i * 28}" class="viz-svg-label">${adminEsc(s.label)} (${s.value})</text>`;
    }).join('') : '<text x="88" y="120" class="viz-svg-label">No data</text>'}
  </svg>`;
}

function metricRows(rows, filters) {
  const find = rows.filter(r => r.task_type === 'find');
  const guide = rows.filter(r => r.task_type === 'guide');
  const sessions = new Set(rows.map(r => r.session_id || r.client_run_id || r.participant_id).filter(Boolean)).size;
  const telemetryRows = rows.filter(r => r.interaction_summary);
  return `
    <div class="viz-kpis">
      <div class="viz-kpi"><span>Visible rows</span><strong>${rows.length}</strong><small>${adminEsc(filters.taskType)} · ${adminEsc(filters.condition)} · ${adminEsc(filters.style)}</small></div>
      <div class="viz-kpi"><span>Sessions</span><strong>${sessions}</strong><small>unique session/run identifiers</small></div>
      <div class="viz-kpi"><span>Find answer accuracy</span><strong>${pct(boolRate(find, answerCorrect))}</strong><small>${find.length} Find rows</small></div>
      <div class="viz-kpi"><span>Guide verdict accuracy</span><strong>${pct(boolRate(guide, answerCorrect))}</strong><small>${guide.length} Guide rows</small></div>
      <div class="viz-kpi"><span>Telemetry coverage</span><strong>${pct(rows.length ? telemetryRows.length / rows.length : null)}</strong><small>scroll, Ctrl-F, clicks</small></div>
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

function tableHtml(rows) {
  return `<div class="viz-card viz-table-card">
    <div class="viz-card-head">
      <h4>Result rows</h4>
      <span>${rows.length > 40 ? 'showing first 40' : `${rows.length} shown`}</span>
    </div>
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
  </div>`;
}

function visualizationHtml(allRows, filters = { taskType: 'all', condition: 'all', style: 'all', participant: 'all', search: '' }) {
  const rows = rowsFor(allRows, filters);
  const find = rows.filter(r => r.task_type === 'find');
  const guide = rows.filter(r => r.task_type === 'guide');
  const speedBars = [
    { label: 'Find G', value: avg(find.filter(r => r.condition === 'grounding'), 'find_supporting_answer_ms'), color: '#7857ff', format: seconds },
    { label: 'Find NG', value: avg(find.filter(r => r.condition === 'nongrounding'), 'find_supporting_answer_ms'), color: '#0f6b43', format: seconds },
    { label: 'Guide G', value: avg(guide.filter(r => r.condition === 'grounding'), 'find_supporting_answer_ms'), color: '#9b84ff', format: seconds },
    { label: 'Guide NG', value: avg(guide.filter(r => r.condition === 'nongrounding'), 'find_supporting_answer_ms'), color: '#2f8f66', format: seconds },
  ];
  const accuracyBars = [
    { label: 'Find G', value: boolRate(find.filter(r => r.condition === 'grounding'), answerCorrect), color: '#7857ff', format: pct },
    { label: 'Find NG', value: boolRate(find.filter(r => r.condition === 'nongrounding'), answerCorrect), color: '#0f6b43', format: pct },
    { label: 'Guide G', value: boolRate(guide.filter(r => r.condition === 'grounding'), answerCorrect), color: '#9b84ff', format: pct },
    { label: 'Guide NG', value: boolRate(guide.filter(r => r.condition === 'nongrounding'), answerCorrect), color: '#2f8f66', format: pct },
  ];
  const behaviorBars = [
    { label: 'Scroll', value: interactionAvg(rows, 'scroll_count'), color: '#7857ff' },
    { label: 'Ctrl-F', value: interactionAvg(rows, 'ctrl_f_count'), color: '#5b3fd6' },
    { label: 'Page clicks', value: interactionAvg(rows, 'website_click_count'), color: '#0f6b43' },
    { label: 'Panel clicks', value: interactionAvg(rows, 'panel_click_count'), color: '#8a5300' },
  ];
  const styleCounts = ['text', 'visual', 'unknown'].map((style, i) => ({
    label: style[0].toUpperCase() + style.slice(1),
    value: rows.filter(r => taskStyle(r) === style).length,
    color: ['#7857ff', '#0f6b43', '#c97a00'][i],
  }));

  return `<div class="viz-dashboard">
    <div class="viz-protocol">
      <div>
        <span>Research question</span>
        <strong>Does grounding make verification faster without costing accuracy?</strong>
      </div>
      <p>Use the filters to compare grounded vs non-grounded, Find vs Guide, and Text vs Visual tasks. Charts update immediately.</p>
    </div>
    ${controlsHtml(allRows, filters)}
    ${metricRows(rows, filters)}
    <div class="viz-insights">
      ${speedInsight(rows, 'find', 'find_supporting_answer_ms')}
      ${speedInsight(rows, 'guide', 'find_supporting_answer_ms')}
      ${accuracyInsight(rows)}
      ${evidenceInsight(rows)}
    </div>
    <div class="viz-chart-grid">
      <div class="viz-card">${svgBarChart('Evidence/step-finding time', speedBars, { max: Math.max(1, ...speedBars.map(b => b.value || 0)) })}</div>
      <div class="viz-card">${svgBarChart('Answer accuracy', accuracyBars, { max: 1 })}</div>
      <div class="viz-card viz-card-wide">${svgLineChart('Average total time by task order', rows)}</div>
      <div class="viz-card">${svgPieChart('Task style mix', styleCounts)}</div>
      <div class="viz-card">${svgPieChart('Task type mix', [
        { label: 'Find', value: find.length, color: '#7857ff' },
        { label: 'Guide', value: guide.length, color: '#0f6b43' },
      ])}</div>
      <div class="viz-card viz-card-wide">${svgBarChart('Average behavior traces', behaviorBars)}</div>
    </div>
    ${tableHtml(rows)}
  </div>`;
}

function bindVisualizationControls() {
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
