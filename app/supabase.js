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

async function get(path) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured — copy app/config.example.js to app/config.js.');
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
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
    conditionOrder: row.condition_order || `rr_mixed_g${Number(row.assignment_slot ?? 0)}_ng${Number(row.assignment_slot ?? 0) + 1}`,
  };
}

const STUDY_TASK_RESULT_COLUMNS = new Set([
  'result_key', 'client_run_id', 'session_id', 'participant_id', 'task_id', 'task_index',
  'question_index', 'task_type', 'condition', 'question_or_task',
  'time_ms', 'answer_time_ms', 'answer_multiple_choice_ms', 'find_supporting_answer_ms',
  'answer', 'answer_correct', 'evidence_responses',
  'guide_answer_correct', 'guide_answer_problems', 'guide_answer_problem', 'guide_errors',
  'score_answer_correct', 'score_evidence_precision', 'score_evidence_recall',
  'score_evidence_exact', 'score_evidence_hop_exact',
  'score_verdict_correct', 'score_problem_precision', 'score_problem_recall', 'score_problem_exact',
  'score_type_precision', 'score_type_recall', 'score_step_precision', 'score_step_recall',
  'score_step_exact', 'score_no_error_agreement', 'confidence', 'helpfulness', 'notes',
]);

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
 * RETRIES ONCE WITHOUT `notes`. The optional note needs a column that supabase_results_v2.sql adds,
 * and a site deployed before that migration is run would otherwise have PostgREST reject the whole
 * row — losing the answer, the timings and the scores over a free-text box nobody had to fill in.
 * The note is the least valuable field in the row; it is the one that should be dropped when the
 * schema is behind, loudly, rather than taking the measurements down with it.
 */
async function insertStudyResult(record) {
  const row = normalizeStudyResultRecord(record);
  const res = await upsert('study_task_results_v2', row, 'result_key', { detail: true });
  if (res.ok) return true;

  const missingNotes = /notes/.test(res.error || '') && /column|schema cache/i.test(res.error || '');
  if (!missingNotes || !Object.prototype.hasOwnProperty.call(row, 'notes')) return null;

  console.warn('[study] this database has no `notes` column yet — saving the row without the note. '
    + 'Run supabase_results_v2.sql in the Supabase SQL editor to keep participants\' notes.');
  const { notes, ...withoutNotes } = row;
  const retry = await upsert('study_task_results_v2', withoutNotes, 'result_key', { detail: true });
  return retry.ok ? true : null;
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
    return updateCannedResponseViaAdminHelper(taskId, condition, clean, e);
  }
}

async function updateCannedResponseViaAdminHelper(taskId, condition, patch, originalError) {
  let token = '';
  try { token = sessionStorage.getItem('pageguide_admin_save_token') || ''; } catch (e) { /* ignore */ }
  if (!token) {
    token = window.prompt('Paste the admin save token printed by `node scripts/publish.mjs --serve`:') || '';
    token = token.trim();
    if (token) {
      try { sessionStorage.setItem('pageguide_admin_save_token', token); } catch (e) { /* ignore */ }
    }
  }
  if (!token) throw originalError;

  const res = await fetch('http://127.0.0.1:8790/admin/canned-response', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PageGuide-Admin-Token': token,
    },
    body: JSON.stringify({ task_id: taskId, condition, patch }),
  });
  if (res.ok) return true;
  if (res.status === 401 || res.status === 403) {
    try { sessionStorage.removeItem('pageguide_admin_save_token'); } catch (e) { /* ignore */ }
  }
  const body = await res.text().catch(() => '');
  throw new Error(body || originalError?.message || `admin helper returned ${res.status}`);
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
  supabaseConfigured,
  listStudyTrajectories,
  getStudyTrajectory,
  listStudyTasks,
  getCannedResponse,
  getStudyGroundTruth,
  updateCannedResponseGrounding,
  claimStudyAssignment,
  insertStudySession,
  insertStudyResult,
};
