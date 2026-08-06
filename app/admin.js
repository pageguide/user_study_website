// Admin mode.
// ===========
// A reviewer's way through the study: pick a half, pick an arm, page through the material quickly,
// and record NOTHING. It exists so the person running the study can check what participants will
// see without becoming a row in their own dataset.
//
// WHAT THE PASSWORD IS AND IS NOT. It is a speed bump on a public page, not access control: the
// site is static, so anything it checks is in the source for anyone who looks. That is acceptable
// because admin mode grants no privilege — it reads the same anon-readable stimuli every visitor
// can already read, and its one real power is to stop writing. Nothing is protected by this, so
// nothing is lost when someone reads it. It is here to keep a participant from wandering into
// reviewer controls, and for that a speed bump is the right size.
//
// The consequence that matters: admin mode must never write. A reviewer clicking through sixteen
// tasks to check wording would otherwise leave sixteen rows that look exactly like a real
// participant who answered impossibly fast, and no column would say otherwise.

const ADMIN_PASSWORD = 'PageGuide2026';
const ADMIN_KEY = 'pageguide_web_study_admin';

/** Session-scoped, so closing the tab drops it — a shared machine does not stay unlocked. */
function isAdmin() {
  try { return sessionStorage.getItem(ADMIN_KEY) === '1'; } catch (e) { return false; }
}

function grantAdmin(password) {
  if (String(password || '') !== ADMIN_PASSWORD) return false;
  try { sessionStorage.setItem(ADMIN_KEY, '1'); } catch (e) { /* private mode: mode lasts this page */ }
  return true;
}

function revokeAdmin() {
  try { sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ }
}

/** The reviewer's choices, remembered across a reload so paging through is not restarted. */
const ADMIN_OPTIONS_KEY = 'pageguide_web_study_admin_opts';
const DEFAULT_OPTIONS = { half: 'all', arm: 'grounding', tab: 'review' };

function adminOptions() {
  try {
    return Object.assign({}, DEFAULT_OPTIONS, JSON.parse(sessionStorage.getItem(ADMIN_OPTIONS_KEY) || '{}'));
  } catch (e) {
    return Object.assign({}, DEFAULT_OPTIONS);
  }
}

function setAdminOptions(opts) {
  try {
    sessionStorage.setItem(ADMIN_OPTIONS_KEY, JSON.stringify(Object.assign(adminOptions(), opts)));
  } catch (e) { /* ignore */ }
}

/**
 * Filter a queue to the chosen half. Pure.
 *
 * Guide entries carry a trajectory; Find entries carry a question. That is the difference, and it
 * is a property of the data rather than a flag someone has to remember to set.
 */
function filterQueueByHalf(queue, half) {
  const list = Array.isArray(queue) ? queue : [];
  if (half === 'guide') return list.filter(e => e.taskType === 'guide');
  if (half === 'find') return list.filter(e => e.taskType === 'find');
  return list;
}

window.StudyAdmin = {
  isAdmin,
  grantAdmin,
  revokeAdmin,
  adminOptions,
  setAdminOptions,
  filterQueueByHalf,
  ADMIN_PASSWORD_HINT: 'Ask the researcher.',
};
