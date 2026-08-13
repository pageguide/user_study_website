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

const ADMIN_KEY = 'pageguide_web_study_admin';

/**
 * The doors, and what each one opens.
 *
 * THREE PASSWORDS, NOT THREE PRIVILEGES. Each unlocks a subset of the same panel; none reaches
 * anything the others could not already read, because the tables behind it are anon-readable to
 * every visitor anyway. What the split buys is not having to hand out the full password to show
 * somebody a chart — and, in the other direction, being able to send a reviewer to check task
 * wording without also handing them the running results, which is the one thing that could colour
 * how they read a trajectory.
 *
 * Kept as one table so a role cannot gain a tab in the password list and lose it in the panel: the
 * tabs ARE the permission, and welcome.js builds its tab strip straight from this.
 */
const ADMIN_DOORS = [
  // Editing a trajectory rewrites what every future participant is shown, so it lives behind the
  // full password only — a reviewer checking wording has no reason to reach it.
  { password: 'PageGuide2026', role: 'full', tabs: ['review', 'viz', 'edit', 'findtask'] },
  { password: 'visualization', role: 'viz', tabs: ['viz'] },
  { password: 'review', role: 'review', tabs: ['review'] },
];

const ROLE_TABS = Object.fromEntries(ADMIN_DOORS.map(d => [d.role, d.tabs]));

/**
 * Which door was opened: 'full' | 'viz' | 'review' | null.
 *
 * Session-scoped, so closing the tab drops it — a shared machine does not stay unlocked. '1' is what
 * the single-password build wrote, and is read as full: a tab unlocked before this change should not
 * be silently locked out by it. Anything unrecognised is locked, not guessed at.
 */
function adminRole() {
  try {
    const raw = sessionStorage.getItem(ADMIN_KEY);
    if (raw === '1') return 'full';
    return Object.prototype.hasOwnProperty.call(ROLE_TABS, raw) ? raw : null;
  } catch (e) {
    return null;
  }
}

function isAdmin() {
  return adminRole() != null;
}

/** The panel tabs this role may open, in the order they should appear. */
function adminTabs() {
  return ROLE_TABS[adminRole()] || [];
}

/** The task recorder and the review walkthrough. */
function canReviewTasks() {
  return adminTabs().includes('review');
}

/** The results dashboard. */
function canViewVisualizations() {
  return adminTabs().includes('viz');
}

/** The role granted (truthy), or false. Trimmed, because a pasted password carries a space. */
function grantAdmin(password) {
  const value = String(password || '').trim();
  const door = ADMIN_DOORS.find(d => d.password === value);
  if (!door) return false;
  try { sessionStorage.setItem(ADMIN_KEY, door.role); } catch (e) { /* private mode: mode lasts this page */ }
  return door.role;
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
  adminRole,
  adminTabs,
  canReviewTasks,
  canViewVisualizations,
  grantAdmin,
  revokeAdmin,
  adminOptions,
  setAdminOptions,
  filterQueueByHalf,
  ADMIN_PASSWORD_HINT: 'Ask the researcher.',
};
