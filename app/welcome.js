// The welcome screen: identify the participant, build the queue, open the study.
//
// The queue is built HERE rather than on the task screen so a misconfiguration is discovered before
// a participant has been told the study is starting — "there are no tasks" is a far better thing to
// find on this page than after the first click.

const status = document.getElementById('welcome-status');
const startBtn = document.getElementById('start-btn');
const countEl = document.getElementById('welcome-count');
const idInput = document.getElementById('participant-id');

function say(msg, tone = '') {
  status.textContent = msg || '';
  status.className = `welcome-status${tone ? ' welcome-status-' + tone : ''}`;
}

let queue = [];

async function init() {
  if (window.__configMissing || !window.StudyDB.supabaseConfigured()) {
    startBtn.disabled = true;
    say('This site is not configured yet: copy app/config.example.js to app/config.js and fill in '
      + 'your Supabase URL and anon key.', 'bad');
    return;
  }
  try {
    queue = await window.StudyDB.listStudyTrajectories();
  } catch (e) {
    startBtn.disabled = true;
    say(`Could not load the tasks: ${e.message}`, 'bad');
    return;
  }
  if (!queue.length) {
    startBtn.disabled = true;
    say('No trajectories are marked for the study yet. Upload some from the extension\'s recorder '
      + '(🧭 Record Guide User Study → ⬆), and make sure they are ticked for inclusion.', 'bad');
    return;
  }
  countEl.textContent = `${queue.length} task${queue.length === 1 ? '' : 's'} · about `
    + `${Math.max(5, Math.round(queue.length * 2))} minutes`;
}

startBtn.onclick = async () => {
  const participantId = idInput.value.trim();
  if (!participantId) { say('Please enter a participant ID.', 'bad'); idInput.focus(); return; }

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
    participantId, arm, sessionId, queue, idx: 0, results: [],
  });
  window.StudySession.saveLocal();
  location.href = 'study.html';
};

init();
