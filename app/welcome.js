// The welcome screen: identify the participant, build the queue, open the study.
//
// The queue is built HERE rather than on the task screen so a misconfiguration is discovered before
// a participant has been told the study is starting — "there are no tasks" is a far better thing to
// find on this page than after the first click.

const status = document.getElementById('welcome-status');
const startBtn = document.getElementById('start-btn');
const countEl = document.getElementById('welcome-count');
const idInput = document.getElementById('participant-id');
const adminBtn = document.getElementById('admin-btn');
const adminPanel = document.getElementById('admin-panel');

function say(msg, tone = '') {
  status.textContent = msg || '';
  status.className = `welcome-status${tone ? ' welcome-status-' + tone : ''}`;
}

let queue = [];

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
    }));
  } catch (e) {
    console.warn('[study] no Find tasks:', e.message);
  }
  try {
    const trajectories = await window.StudyDB.listStudyTrajectories();
    trajectories.forEach(t => out.push({ taskType: 'guide', id: t.id, goal: t.goal, title: t.title, condition: t.condition }));
  } catch (e) {
    console.warn('[study] no guide trajectories:', e.message);
  }
  return out;
}

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
  const find = queue.filter(e => e.taskType === 'find').length;
  const guide = queue.length - find;
  countEl.textContent = `${find} find · ${guide} guide · about ${Math.max(5, Math.round(queue.length * 2))} minutes`;

  if (window.StudyAdmin.isAdmin()) showAdminPanel();
}

// ── Admin ──
// A reviewer's door. It grants no privilege over the data — the stimuli it reads are anon-readable
// to every visitor — so its one real power is to NOT write, which is exactly what a reviewer
// clicking through sixteen tasks needs. See app/admin.js on why the password is a speed bump.

function showAdminPanel() {
  const o = window.StudyAdmin.adminOptions();
  adminPanel.hidden = false;
  adminPanel.innerHTML = `
    <div class="admin-title">🔓 Admin — review mode <span class="admin-warn">nothing is recorded</span></div>
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

  adminPanel.querySelectorAll('[data-half]').forEach(b => {
    b.onclick = () => { window.StudyAdmin.setAdminOptions({ half: b.dataset.half }); showAdminPanel(); };
  });
  adminPanel.querySelectorAll('[data-arm]').forEach(b => {
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

  const params = new URLSearchParams(location.search);
  const arm = window.StudySession.resolveArm(params);

  // The session row is created up front so every task row can reference it. A failure here is not
  // fatal — the tasks still record, with a null session_id — so it must not stop the study.
  let sessionId = null;
  try {
    sessionId = await window.StudyDB.insertStudySession(
      participantId, window.StudySession.conditionLabel(arm));
  } catch (e) {
    console.warn('[study] could not open a session row:', e);
  }

  Object.assign(window.StudySession.state, {
    participantId, arm, sessionId, queue, idx: 0, results: [], adminReview: false,
  });
  window.StudySession.saveLocal();
  location.href = 'study.html';
};

init();
