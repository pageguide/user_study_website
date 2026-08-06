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

function boolRate(rows, key) {
  const vals = rows.map(r => r?.[key]).filter(v => v === true || v === false);
  if (!vals.length) return null;
  return vals.filter(Boolean).length / vals.length;
}

function avg(rows, key) {
  const vals = rows.map(r => Number(r?.[key])).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
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

function metricBar(label, value, detail = '') {
  const width = value == null ? 0 : Math.max(0, Math.min(100, Math.round(value * 100)));
  return `
    <div class="viz-bar-row">
      <div class="viz-bar-label">${adminEsc(label)}</div>
      <div class="viz-bar-track"><span style="width:${width}%"></span></div>
      <div class="viz-bar-value">${value == null ? 'No data' : `${width}%`}${detail ? ` <span>${adminEsc(detail)}</span>` : ''}</div>
    </div>`;
}

function metricNumberBar(label, value, max) {
  const width = value == null || !max ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return `
    <div class="viz-bar-row">
      <div class="viz-bar-label">${adminEsc(label)}</div>
      <div class="viz-bar-track viz-bar-track-muted"><span style="width:${width}%"></span></div>
      <div class="viz-bar-value">${oneDecimal(value)}</div>
    </div>`;
}

function groupedRows(rows, taskType, condition) {
  return rows.filter(r => r.task_type === taskType && r.condition === condition);
}

function interactionAvg(rows, key) {
  const vals = rows
    .map(r => Number(r?.interaction_summary?.[key]))
    .filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function visualizationHtml(rows) {
  const find = rows.filter(r => r.task_type === 'find');
  const guide = rows.filter(r => r.task_type === 'guide');
  const sessions = new Set(rows.map(r => r.session_id || r.client_run_id || r.participant_id).filter(Boolean)).size;
  const completedSessions = new Set(rows
    .filter(r => r.session_id != null)
    .map(r => r.session_id)
    .filter(id => rows.filter(r => r.session_id === id).length >= 8)).size;
  const allTime = avg(rows, 'time_ms');
  const interactionKeys = ['scroll_count', 'ctrl_f_count', 'website_click_count', 'panel_click_count'];
  const interactionMax = Math.max(1, ...interactionKeys.flatMap(key => [
    interactionAvg(find, key) || 0,
    interactionAvg(guide, key) || 0,
  ]));

  const conditionBars = (taskType, key, title) => `
    <div class="viz-card">
      <h4>${adminEsc(title)}</h4>
      ${metricBar('Grounded', boolRate(groupedRows(rows, taskType, 'grounding'), key))}
      ${metricBar('Non-grounded', boolRate(groupedRows(rows, taskType, 'nongrounding'), key))}
    </div>`;

  return `
    <div class="viz-dashboard">
      <div class="viz-kpis">
        <div class="viz-kpi"><span>Sessions</span><strong>${sessions}</strong><small>${completedSessions} completed 8 tasks</small></div>
        <div class="viz-kpi"><span>Rows</span><strong>${rows.length}</strong><small>${find.length} Find · ${guide.length} Guide</small></div>
        <div class="viz-kpi"><span>Find accuracy</span><strong>${pct(boolRate(find, 'score_answer_correct'))}</strong><small>answer correctness</small></div>
        <div class="viz-kpi"><span>Guide accuracy</span><strong>${pct(boolRate(guide, 'score_verdict_correct'))}</strong><small>verdict correctness</small></div>
        <div class="viz-kpi"><span>Avg time</span><strong>${seconds(allTime)}</strong><small>per task row</small></div>
      </div>

      <div class="viz-grid">
        ${conditionBars('find', 'score_answer_correct', 'Find answer correctness')}
        ${conditionBars('guide', 'score_verdict_correct', 'Guide verdict correctness')}
        <div class="viz-card">
          <h4>Find supporting evidence</h4>
          ${metricBar('Precision', avg(find, 'score_evidence_precision'))}
          ${metricBar('Recall', avg(find, 'score_evidence_recall'))}
          ${metricBar('Exact match', boolRate(find, 'score_evidence_exact'))}
        </div>
        <div class="viz-card">
          <h4>Guide localization quality</h4>
          ${metricBar('Type precision', avg(guide, 'score_type_precision'))}
          ${metricBar('Type recall', avg(guide, 'score_type_recall'))}
          ${metricBar('Step precision', avg(guide, 'score_step_precision'))}
          ${metricBar('Step recall', avg(guide, 'score_step_recall'))}
        </div>
        <div class="viz-card viz-card-wide">
          <h4>Average interactions per task</h4>
          ${metricNumberBar('Find scroll sessions', interactionAvg(find, 'scroll_count'), interactionMax)}
          ${metricNumberBar('Guide scroll sessions', interactionAvg(guide, 'scroll_count'), interactionMax)}
          ${metricNumberBar('Find Ctrl-F', interactionAvg(find, 'ctrl_f_count'), interactionMax)}
          ${metricNumberBar('Guide Ctrl-F', interactionAvg(guide, 'ctrl_f_count'), interactionMax)}
          ${metricNumberBar('Find website clicks', interactionAvg(find, 'website_click_count'), interactionMax)}
          ${metricNumberBar('Guide website clicks', interactionAvg(guide, 'website_click_count'), interactionMax)}
          ${metricNumberBar('Find panel clicks', interactionAvg(find, 'panel_click_count'), interactionMax)}
          ${metricNumberBar('Guide panel clicks', interactionAvg(guide, 'panel_click_count'), interactionMax)}
          <p class="viz-note">Interaction telemetry appears only for rows collected after this dashboard update.</p>
        </div>
      </div>

      <div class="viz-card viz-table-card">
        <h4>Recent result rows</h4>
        <div class="viz-table-wrap">
          <table class="viz-table">
            <thead><tr><th>Participant</th><th>Task</th><th>Condition</th><th>Answer</th><th>Evidence</th><th>Interactions</th><th>Time</th></tr></thead>
            <tbody>
              ${rows.slice(0, 30).map(row => {
                const isFind = row.task_type === 'find';
                const answer = isFind ? pct(row.score_answer_correct == null ? null : Number(row.score_answer_correct)) : pct(row.score_verdict_correct == null ? null : Number(row.score_verdict_correct));
                const evidence = isFind
                  ? pct(row.score_evidence_precision)
                  : pct(row.score_step_recall ?? row.score_type_recall);
                const inter = row.interaction_summary
                  ? `${Number(row.interaction_summary.scroll_count || 0)} scroll · ${Number(row.interaction_summary.ctrl_f_count || 0)} find · ${Number(row.interaction_summary.website_click_count || 0)} clicks`
                  : 'No data';
                return `<tr>
                  <td>${adminEsc(row.participant_id)}</td>
                  <td>${adminEsc(row.task_type)} · ${adminEsc(row.task_id)}</td>
                  <td>${adminEsc(row.condition)}</td>
                  <td>${answer}</td>
                  <td>${evidence}</td>
                  <td>${adminEsc(inter)}</td>
                  <td>${seconds(row.time_ms)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

async function showAdminVisualizations() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="viz-loading">Loading study results…</div>';
  try {
    const rows = await window.StudyDB.listStudyResults();
    if (!rows.length) {
      content.innerHTML = '<div class="viz-empty">No result rows yet.</div><button class="admin-exit" id="admin-exit">Leave admin mode</button>';
    } else {
      content.innerHTML = visualizationHtml(rows) + '<button class="admin-exit" id="admin-exit">Leave admin mode</button>';
    }
  } catch (e) {
    content.innerHTML = `<div class="welcome-status welcome-status-bad">Could not load result rows: ${adminEsc(e.message || e)}</div>
      <button class="admin-exit" id="admin-exit">Leave admin mode</button>`;
  }
  document.getElementById('admin-exit').onclick = () => {
    window.StudyAdmin.revokeAdmin();
    adminPanel.hidden = true;
    adminPanel.innerHTML = '';
  };
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
