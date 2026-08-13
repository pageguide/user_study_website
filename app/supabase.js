// Supabase access for the study site.
// ===================================
// Everything this site needs from the network, in one place: read the stimuli, write the results.
//
// Deliberately plain `fetch` against PostgREST rather than the supabase-js SDK. The whole site is
// static files with no build step, and pulling in a bundled SDK to issue four HTTP requests would
// buy nothing except a build step. This also mirrors how the extension talks to Supabase
// (sidepanel/study.js), so the two clients fail the same way and can be debugged the same way.

const CFG = (typeof window !== 'undefined' && window.STUDY_CONFIG) || {};

/** Is there a usable configuration at all? The example file's placeholders do not count. */
function supabaseConfigured() {
  const url = String(CFG.SUPABASE_URL || '');
  const key = String(CFG.SUPABASE_ANON_KEY || '');
  return !!url && !!key && !url.startsWith('YOUR_') && !key.startsWith('YOUR_');
}

function headers(prefer) {
  const h = {
    'Content-Type': 'application/json',
    apikey: CFG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}`,
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

/**
 * One read. NEVER FROM THE BROWSER CACHE.
 *
 * `cache: 'no-store'` because every GET here asks "what is in the table right now": the results a
 * researcher is watching accumulate, and the stimuli they may have just republished. PostgREST sets
 * no validators, which leaves the response open to heuristic caching — so reopening the dashboard
 * could redraw the same numbers from memory and look exactly like a study where nobody had run a
 * task since. A stale answer to that question is worse than a slow one.
 */
async function get(path) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured — copy app/config.example.js to app/config.js.');
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, { headers: headers(), cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} on ${path}: ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

async function rpc(name, data = {}) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured — copy app/config.example.js to app/config.js.');
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Supabase RPC ${name} failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
  return res.json().catch(() => null);
}

/**
 * Insert one row.
 *
 * Mirrors the extension's supabaseInsert, including its retry: `return=representation` adds a
 * RETURNING clause that RLS rejects when there is no anon SELECT policy on the table, which fails
 * the WHOLE insert rather than just the read-back. Retrying with `return=minimal` still creates the
 * row — we simply cannot capture its id.
 */
async function insert(table, data, { wantRow = false } = {}) {
  if (!supabaseConfigured()) return null;
  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: headers(wantRow ? 'return=representation' : 'return=minimal'),
      body: JSON.stringify(data),
    });
    if (res.ok) {
      if (!wantRow) return true;
      const json = await res.json().catch(() => null);
      return (Array.isArray(json) && json[0]) || true;
    }
    if (wantRow && (res.status === 401 || res.status === 403)) {
      const retry = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: headers('return=minimal'),
        body: JSON.stringify(data),
      });
      return retry.ok ? true : null;
    }
    console.error(`[study] Supabase ${res.status} on ${table}:`, await res.text().catch(() => ''));
    return null;
  } catch (e) {
    console.warn(`[study] Supabase insert into ${table} failed:`, e);
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.detail] - return {ok, status, error} instead of true/null, for callers that
 *   need to act on WHY a write failed rather than only that it did.
 */
async function upsert(table, data, conflictColumn, opts = {}) {
  const fail = (status, error) => (opts.detail ? { ok: false, status, error } : null);
  if (!supabaseConfigured()) return fail(0, 'Supabase is not configured.');
  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumn)}`, {
      method: 'POST',
      headers: headers('resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(data),
    });
    if (res.ok) return opts.detail ? { ok: true, status: res.status, error: '' } : true;
    const body = await res.text().catch(() => '');
    console.error(`[study] Supabase ${res.status} on ${table} upsert:`, body);
    return fail(res.status, body);
  } catch (e) {
    console.warn(`[study] Supabase upsert into ${table} failed:`, e);
    return fail(0, e?.message || String(e));
  }
}

// ── Stimuli ──
// The trajectory LIST comes back without `arms`, because arms carries the base64 screenshots and a
// 16-trajectory bank would be tens of megabytes to build a queue out of. The full record is fetched
// one at a time, when the participant reaches it.

const TRAJECTORY_LIST_COLUMNS = 'id,goal,title,condition,in_study,captured_at';

/** Every trajectory the study should show, in capture order — the participant's queue. */
async function listStudyTrajectories() {
  const rows = await get(
    `study_guide_trajectories?select=${TRAJECTORY_LIST_COLUMNS}&in_study=is.true&order=captured_at.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

/** One trajectory in full, screenshots included. ~1.5MB for a nine-step run. */
async function getStudyTrajectory(id) {
  const rows = await get(`study_guide_trajectories?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}

// ── Results ──

async function insertStudySession(participantId, conditionLabel) {
  const row = await insert('study_sessions', {
    participant_id: participantId,
    condition_order: conditionLabel,
  }, { wantRow: true });
  return (row && row.id) || null;
}

/**
 * The label describing the layout a slot was dealt, for when the RPC did not return one.
 *
 * Matches claim_study_assignment (supabase_results_v2.sql) exactly, including the `% 2` rule that
 * decides which arm leads each pair in buildRoundRobinQueue. A fallback that kept saying `rr_mixed`
 * would file an interleaved session under the old block-order design — the one distinction the
 * analysis has to make.
 */
function conditionOrderLabel(slot) {
  const n = Math.max(0, Number(slot) || 0);
  return `rr_inter_g${n}_ng${n + 1}_${n % 2 === 0 ? 'gfirst' : 'ngfirst'}`;
}

async function claimStudyAssignment(participantId, assignmentKey = 'default') {
  const rows = await rpc('claim_study_assignment', {
    p_participant_id: participantId,
    p_assignment_key: assignmentKey,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error('Assignment RPC returned no row.');
  return {
    sessionId: row.session_id ?? row.id ?? null,
    assignmentIndex: Number(row.assignment_index ?? 0),
    assignmentSlot: Number(row.assignment_slot ?? row.assignment_index ?? 0),
    conditionOrder: row.condition_order || conditionOrderLabel(row.assignment_slot),
  };
}

const STUDY_TASK_RESULT_COLUMNS = new Set([
  'result_key', 'client_run_id', 'session_id', 'participant_id', 'task_id', 'task_index',
  'question_index', 'task_type', 'task_style', 'condition', 'question_or_task',
  'time_ms', 'answer_time_ms', 'answer_multiple_choice_ms', 'find_supporting_answer_ms',
  'answer', 'answer_correct', 'evidence_responses',
  'guide_answer_correct', 'guide_answer_problems', 'guide_answer_problem', 'guide_errors',
  'score_answer_correct', 'score_evidence_precision', 'score_evidence_recall',
  'score_evidence_exact', 'score_evidence_hop_exact',
  'score_verdict_correct', 'score_problem_precision', 'score_problem_recall', 'score_problem_exact',
  'score_type_precision', 'score_type_recall', 'score_step_precision', 'score_step_recall',
  'score_step_exact', 'score_no_error_agreement', 'confidence', 'helpfulness', 'notes',
  'interaction_summary',
  // The behavioural counts, flat, under the same names study_task_results uses in the extension.
  'scroll_user_count', 'ctrl_f_count', 'text_select_count', 'click_count', 'mouse_move_px',
]);

/**
 * Columns a database may not have yet, dropped one at a time on a schema-cache rejection.
 *
 * Ordered newest-first only for legibility; insertStudyResult removes whichever one the error
 * names. The behavioural counts belong here because the site is deployed independently of the SQL —
 * losing an entire answer to a missing count column would be the worst of both.
 */
const OPTIONAL_RESULT_COLUMNS = [
  'notes', 'interaction_summary', 'task_style',
  'scroll_user_count', 'ctrl_f_count', 'text_select_count', 'click_count', 'mouse_move_px',
];

function normalizeStudyResultRecord(record) {
  const clean = {};
  Object.entries(record || {}).forEach(([key, value]) => {
    if (STUDY_TASK_RESULT_COLUMNS.has(key)) clean[key] = value;
  });
  return clean;
}

/**
 * One result row.
 *
 * RETRIES WITHOUT OPTIONAL NEWER COLUMNS. A site can be deployed before the matching SQL migration
 * is run; in that case PostgREST rejects the whole row for one unknown column. Drop only the missing
 * optional field, loudly, rather than losing the answer, timings and scores.
 */
async function insertStudyResult(record) {
  const row = normalizeStudyResultRecord(record);
  const optionalColumns = OPTIONAL_RESULT_COLUMNS;
  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const res = await upsert('study_task_results_v2', row, 'result_key', { detail: true });
    if (res.ok) return true;

    const missingOptionalColumn = optionalColumns.find(key =>
      Object.prototype.hasOwnProperty.call(row, key)
      && new RegExp(`\\b${key}\\b`).test(res.error || '')
      && /column|schema cache/i.test(res.error || ''));
    if (!missingOptionalColumn) return null;

    console.warn(`[study] this database has no \`${missingOptionalColumn}\` column yet; saving the row without it. `
      + 'Run supabase_results_v2.sql in the Supabase SQL editor to keep all result fields.');
    delete row[missingOptionalColumn];
  }
  return null;
}

/**
 * Every result row, newest first.
 *
 * The cap is high enough not to bind — 8 rows per participant puts 20000 past two thousand
 * sittings — but it is still a cap, and a silent one would mean the dashboard quietly stops
 * including the newest work. So say so if we ever come back exactly full.
 */
const STUDY_RESULT_LIMIT = 20000;

/**
 * Every trajectory the editor can open, published or not.
 *
 * listStudyTrajectories is filtered to `in_study` because that is the participant queue. This one
 * is not: a trajectory being prepared has `in_study = false` precisely so it stays out of the
 * rotation until its errors are annotated, and that is exactly when it needs editing.
 */
async function listAllStudyTrajectories() {
  const rows = await get('study_guide_trajectories?select=id,goal,title,condition,in_study,ground_truth'
    + '&order=captured_at.desc');
  return Array.isArray(rows) ? rows : [];
}

/**
 * Write an edited trajectory back.
 *
 * PATCH by id, and only the columns handed in — a trajectory row carries megabytes of screenshots,
 * and a full-row write would put all of them back on the wire to change one step number.
 *
 * `return=representation` IS THE POINT, not a convenience. anon may SELECT this table but has no
 * UPDATE policy, so a write matches zero rows — and PostgREST answers that with **204, exactly the
 * same as success**. Asked for `return=minimal`, this function reported "Saved" over a table that
 * had not changed, which is the worst failure a save button has: the edit is gone and the screen
 * says it is not. Counting the returned rows is the only way to tell the two apart.
 *
 * Falling back to the loopback helper when the row count is zero mirrors
 * updateCannedResponseGrounding: the stimuli are deliberately not anon-writable — a study whose
 * material any visitor could rewrite is not a study — so a real save goes through the process that
 * holds the secret key.
 */
async function updateStudyTrajectory(id, patch) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured.');
  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/study_guide_trajectories`
      + `?id=eq.${encodeURIComponent(id)}&select=id`, {
      method: 'PATCH',
      headers: headers('return=representation'),
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) return true;
      throw new Error('Supabase accepted the request but updated no rows — RLS blocked the write.');
    }
    throw new Error(await res.text().catch(() => `Supabase update failed (${res.status})`));
  } catch (e) {
    return updateViaAdminHelper('/admin/trajectory', { id, patch }, e);
  }
}

/**
 * Send a refused write to the loopback helper that is allowed to make it.
 *
 * One function for every stimulus table: the endpoint differs, the dance does not — find the token,
 * ask for it once and remember it for the session, POST, and forget it again the moment the helper
 * says it is wrong so the next save can prompt instead of failing forever.
 *
 * @param {string} route - the helper path, e.g. '/admin/task'
 * @param {object} body - the JSON payload that route expects
 * @param {Error} originalError - what Supabase said, kept as the message when there is no token
 */
async function updateViaAdminHelper(route, body, originalError) {
  let token = '';
  try { token = sessionStorage.getItem('pageguide_admin_save_token') || ''; } catch (e) { /* ignore */ }
  if (!token) {
    token = (window.prompt('Editing study material needs the local publish helper.\n\n'
      + 'Run `node scripts/publish.mjs --serve` and paste the admin save token it prints:') || '').trim();
    if (token) {
      try { sessionStorage.setItem('pageguide_admin_save_token', token); } catch (e) { /* ignore */ }
    }
  }
  if (!token) throw originalError;

  let res;
  try {
    res = await fetch(`http://127.0.0.1:8790${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PageGuide-Admin-Token': token },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Could not reach the publish helper on 127.0.0.1:8790. '
      + 'Start it with `node scripts/publish.mjs --serve`, then save again.');
  }
  if (res.ok) return true;
  if (res.status === 401 || res.status === 403) {
    try { sessionStorage.removeItem('pageguide_admin_save_token'); } catch (e) { /* ignore */ }
  }
  const said = await res.text().catch(() => '');
  throw new Error(said || originalError?.message || `admin helper returned ${res.status}`);
}

/**
 * How many pictures each task's material holds, keyed by task id.
 *
 * COUNTED ONCE AND STORED, never derived here. A Find page is 3–8 MB of saved HTML; counting its
 * <img> tags in the dashboard would mean pulling fifty megabytes to print one average. The counts
 * are written by scripts/publish.mjs --count-images and read back as two small integers.
 *
 * Missing columns are not an error: the site deploys independently of the SQL, and a dashboard that
 * refused to draw because one optional number was absent would be worse than one that omits it.
 */
async function listTaskImageCounts() {
  const out = new Map();
  const add = (rows, idKey) => (Array.isArray(rows) ? rows : []).forEach(r => {
    const n = Number(r?.image_count);
    if (r?.[idKey] && Number.isFinite(n)) out.set(String(r[idKey]), n);
  });
  try {
    add(await get('study_task_pages?select=task_id,image_count'), 'task_id');
  } catch (e) {
    console.info('[study] no image_count on study_task_pages yet — run the SQL to enable it.');
  }
  try {
    add(await get('study_guide_trajectories?select=id,image_count&in_study=is.true'), 'id');
  } catch (e) {
    console.info('[study] no image_count on study_guide_trajectories yet.');
  }
  return out;
}

/**
 * How many references the agent's grounded answer carries, per task.
 *
 * Two kinds, and they are not the same thing to a participant. A CITATION `[368:"the exact quoted
 * phrase"]` points into the page's prose and is checked by reading; an EVIDENCE chip `[ev:key]`
 * opens a picture the agent saved at record time and is checked by looking. A card that reported
 * one total would hide the difference the Text/Visual split exists to study.
 *
 * COUNTED FROM THE ANSWER TEXT, WHICH IS WHY THIS IS CHEAP. The markers are in `answer_display` for
 * a Find task and in the grounded arm's `answer` for a trajectory — both are a few hundred bytes.
 * The alternative, counting the `evidence` array, drags a base64 screenshot per item across the
 * wire: this whole function is under 20 KB, and the same query over the arrays is tens of megabytes.
 * `arms->grounding->>answer` is a PostgREST sub-field select, so the trajectory's screenshots stay
 * in the database.
 *
 * WHAT IT COUNTS IS WHAT THE ANSWER CLAIMS, not what renders. A marker whose key has no evidence
 * behind it renders as nothing, and this still counts it — deliberately, because the figure is
 * about how heavily the material was annotated, and a silently-dropped chip is a fault to find in
 * the editor rather than a number to quietly shrink here.
 *
 * Missing tables or columns are not an error. This is a descriptive extra on a dashboard that must
 * still draw without it.
 */
const CITATION_MARKER = /\[\d+:"[^"]*"\]/g;
const EVIDENCE_MARKER = /\[ev:[^\]]+\]/g;

function countAnswerMarkers(answer) {
  const text = String(answer || '');
  return {
    citations: (text.match(CITATION_MARKER) || []).length,
    evidence: (text.match(EVIDENCE_MARKER) || []).length,
  };
}

async function listAnswerReferenceCounts() {
  const out = new Map();
  try {
    const rows = await get('study_canned_responses?select=task_id,answer_display,answer_raw'
      + '&condition=eq.grounding');
    (Array.isArray(rows) ? rows : []).forEach(r => {
      if (r?.task_id) out.set(String(r.task_id), countAnswerMarkers(r.answer_display || r.answer_raw));
    });
  } catch (e) {
    console.info('[study] could not read canned answers for reference counts:', e.message);
  }
  try {
    const rows = await get('study_guide_trajectories?select=id,answer:arms->grounding->>answer');
    (Array.isArray(rows) ? rows : []).forEach(r => {
      if (r?.id) out.set(String(r.id), countAnswerMarkers(r.answer));
    });
  } catch (e) {
    console.info('[study] could not read trajectory answers for reference counts:', e.message);
  }
  return out;
}

async function listStudyResults() {
  const rows = await get(`study_task_results_v2?select=*&order=created_at.desc&limit=${STUDY_RESULT_LIMIT}`);
  const list = Array.isArray(rows) ? rows : [];
  if (list.length >= STUDY_RESULT_LIMIT) {
    console.warn(`[study] result fetch hit the ${STUDY_RESULT_LIMIT}-row cap — the dashboard is not `
      + 'showing every row. Raise STUDY_RESULT_LIMIT in app/supabase.js or start paginating.');
  }
  return list;
}

async function updateCannedResponseGrounding(taskId, condition, patch) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured.');
  const clean = {};
  ['answer_raw', 'answer_display', 'citation_anchors', 'evidence'].forEach(k => {
    if (Object.prototype.hasOwnProperty.call(patch || {}, k)) clean[k] = patch[k];
  });
  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/study_canned_responses`
      + `?task_id=eq.${encodeURIComponent(taskId)}&condition=eq.${encodeURIComponent(condition)}`
      + '&select=task_id,condition,answer_raw,answer_display,citation_anchors,evidence', {
      method: 'PATCH',
      headers: headers('return=representation'),
      body: JSON.stringify(clean),
    });
    if (res.ok) {
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) return true;
      throw new Error('Supabase accepted the request but updated no rows. RLS likely blocked the write.');
    }
    throw new Error(await res.text().catch(() => `Supabase update failed (${res.status})`));
  } catch (e) {
    return updateViaAdminHelper('/admin/canned-response',
      { task_id: taskId, condition, patch: clean }, e);
  }
}

/**
 * The dashboard's analysis, run by the local publish helper.
 *
 * The key is an LLM spending credential, so it lives where the Supabase secret does: in .env, read
 * by scripts/publish.mjs, never in this file. app/config.js is served to every participant — a key
 * placed here would be a public key. The helper is loopback-only and gated by the same admin token
 * the canned-response editor uses.
 *
 * What crosses the wire is the aggregate the dashboard has already drawn, plus the participants'
 * notes only when the researcher asked for them. No participant ids, no session ids, no raw rows.
 */
async function requestAnalysis({ summary, notes = [], model = '' }) {
  let token = '';
  try { token = sessionStorage.getItem('pageguide_admin_save_token') || ''; } catch (e) { /* ignore */ }
  if (!token) {
    token = (window.prompt('Paste the admin save token printed by `node scripts/publish.mjs --serve`:') || '').trim();
    if (!token) throw new Error('An admin save token is needed to reach the analysis helper.');
    try { sessionStorage.setItem('pageguide_admin_save_token', token); } catch (e) { /* ignore */ }
  }

  let res;
  try {
    res = await fetch('http://127.0.0.1:8790/admin/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PageGuide-Admin-Token': token },
      body: JSON.stringify({ summary, notes, model }),
    });
  } catch (e) {
    throw new Error('The analysis helper is not running. Start it with `node scripts/publish.mjs --serve`.');
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    try { sessionStorage.removeItem('pageguide_admin_save_token'); } catch (e) { /* ignore */ }
  }
  if (!res.ok) throw new Error(body?.error || `The helper returned ${res.status}.`);
  return body;
}

// ── The Find half ──
// The site cannot RUN a Find task: that needs the extension on a live page to index it, highlight
// citations and let a participant pick sentences off it. What it can do is show the material —
// the question, the page it lives on, the agent's recorded answer for the arm, and the options —
// which is what a reviewer needs when checking wording, and what admin mode exists for.

async function listStudyTasks() {
  const rows = await get('study_tasks?select=*&task_type=eq.find&in_study=is.true&order=task_index.asc');
  return Array.isArray(rows) ? rows : [];
}

/**
 * Every Find task the editor can open, in the study or not.
 *
 * listStudyTasks is filtered to `in_study` because that is the participant queue. This one is not,
 * for the same reason listAllStudyTrajectories is not: a task held out of the rotation is exactly
 * the one somebody needs to open, either to finish it or to put it back.
 *
 * `select=*` is safe here and would not be on the guide table — a Find task row is a question, a
 * URL and four short strings. The megabytes live in study_task_pages, which this never touches.
 */
async function listAllStudyTasks() {
  const rows = await get('study_tasks?select=*&task_type=eq.find&order=task_index.asc');
  return Array.isArray(rows) ? rows : [];
}

/**
 * Write an edited Find task back — same two-step as updateStudyTrajectory, for the same reasons.
 *
 * anon has no UPDATE policy on the stimuli, and PostgREST answers a write that matched no rows with
 * 204, which is byte-for-byte what success looks like. So the write asks for the rows back and
 * counts them; zero rows means RLS refused, and the edit goes to the loopback helper that holds the
 * secret key instead of a save button reporting a save that did not happen.
 */
async function updateStudyTask(id, patch) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured.');
  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/study_tasks`
      + `?id=eq.${encodeURIComponent(id)}&select=id`, {
      method: 'PATCH',
      headers: headers('return=representation'),
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) return true;
      throw new Error('Supabase accepted the request but updated no rows — RLS blocked the write.');
    }
    throw new Error(await res.text().catch(() => `Supabase update failed (${res.status})`));
  } catch (e) {
    return updateViaAdminHelper('/admin/task', { id, patch }, e);
  }
}

/** The recorded agent answer for one task in one arm, or null when it was never banked. */
async function getCannedResponse(taskId, condition) {
  const rows = await get('study_canned_responses?select=*'
    + `&task_id=eq.${encodeURIComponent(taskId)}&condition=eq.${encodeURIComponent(condition)}&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}

async function getStudyGroundTruth(taskId, url) {
  const rows = await get(`study_ground_truth?select=*&task_id=eq.${encodeURIComponent(taskId)}&limit=1`);
  if (Array.isArray(rows) && rows[0]) return rows[0];
  if (!url) return null;
  const all = await get('study_ground_truth?select=*');
  return (Array.isArray(all) ? all : []).find(row =>
    Object.values(row?.hops || {}).flat().some(hit => String(hit?.url || '') === String(url))) || null;
}

/**
 * The frozen page for one Find task, or null.
 *
 * Fetched one at a time and never with the task list: an inlined article is megabytes, so pulling
 * ten of them to build a queue would cost tens of megabytes before the first question is on screen.
 *
 * TWO TASKS CAN SHARE ONE PAGE. MUFC-V1 and MUFC-V1-TEXT are the same Wikipedia article asked under
 * the two Find conditions, and the snapshot is only captured and published once — so a task with no
 * row of its own falls back to whatever was captured for the same URL. Storing it twice would waste
 * megabytes and, worse, let the two copies drift, which would make the conditions differ in the
 * page itself rather than only in the grounding.
 *
 * @param {string} taskId
 * @param {string} [url] - the task's page, for the shared-snapshot fallback
 */
async function getTaskPage(taskId, url) {
  const own = await get(`study_task_pages?select=*&task_id=eq.${encodeURIComponent(taskId)}&limit=1`);
  if (Array.isArray(own) && own[0]) return own[0];
  if (!url) return null;
  const shared = await get(`study_task_pages?select=*&url=eq.${encodeURIComponent(url)}&limit=1`);
  return (Array.isArray(shared) && shared[0]) || null;
}

window.StudyDB = {
  getTaskPage,
  requestAnalysis,
  supabaseConfigured,
  listStudyTrajectories,
  listAllStudyTrajectories,
  getStudyTrajectory,
  updateStudyTrajectory,
  listStudyTasks,
  listAllStudyTasks,
  updateStudyTask,
  getCannedResponse,
  getStudyGroundTruth,
  updateCannedResponseGrounding,
  claimStudyAssignment,
  insertStudySession,
  insertStudyResult,
  listStudyResults,
  listTaskImageCounts,
  listAnswerReferenceCounts,
};
