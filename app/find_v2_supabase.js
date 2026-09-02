// Supabase adapter for the isolated Find V2 study.
// It intentionally presents the small interface app/study.js already uses for
// Find playback, while every request goes to the V2-only tables/functions.

(function () {
  const CFG = window.FIND_V2_CONFIG || {};

  function supabaseConfigured() {
    const url = String(CFG.SUPABASE_URL || '');
    const key = String(CFG.SUPABASE_ANON_KEY || '');
    return !!url && !!key && !url.startsWith('YOUR_') && !key.startsWith('YOUR_');
  }

  function headers(prefer) {
    const out = {
      'Content-Type': 'application/json',
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}`,
    };
    if (prefer) out.Prefer = prefer;
    return out;
  }

  async function request(path, init = {}) {
    if (!supabaseConfigured()) {
      throw new Error('Find V2 Supabase is not configured — fill in app/find_v2_config.js.');
    }
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, {
      cache: 'no-store',
      ...init,
      headers: { ...headers(), ...(init.headers || {}) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = detail;
      try { message = JSON.parse(detail)?.message || detail; } catch (e) { /* plain response */ }
      throw new Error(message || `Supabase request failed (${res.status}).`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  function get(path) {
    return request(path);
  }

  function rpc(name, body) {
    return request(`rpc/${name}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    });
  }

  function styleType(style) {
    return style === 'find_visual' ? 'FIND X VISUAL' : 'FIND X TEXT';
  }

  function taskRow(row) {
    return {
      id: row.id,
      sourceTaskId: row.source_task_id || '',
      taskType: 'find',
      studyVersion: 'find-v2',
      title: row.title || '',
      url: row.url || '',
      type: styleType(row.task_style),
      question: row.question || '',
      // How this row's correctness axis may be dealt. The welcome screen turns
      // this plus the assignment slot into the per-task `claimCorrect` the
      // participant is actually scored against.
      correctnessMode: window.FindV2Variants.correctnessMode(row.correctness_mode),
      // Which of the four cells actually have authored text, so a slot is never
      // dealt a variant that would render as a blank agent answer.
      authoredVariants: window.FindV2Variants.authored(row),
      // Kept for the shared Find shell. V2 never builds answer choices from it.
      answer: '',
      distractors: [],
      in_study: row.in_study === true,
      task_index: Number(row.task_index) || 0,
      style: row.task_style,
    };
  }

  // `answer_variants` is small (four short answers) next to `page_html`, which is
  // still deliberately omitted here: the queue lists every claim, the snapshot is
  // fetched only when its task opens.
  const CLAIM_LIST_COLUMNS = [
    'id', 'source_task_id', 'title', 'url', 'task_style', 'question',
    'answer_variants', 'correctness_mode', 'claim_correct', 'answer_text',
    'in_study', 'task_index', 'page_bytes', 'updated_at',
  ].join(',');

  async function listStudyTasks() {
    const rows = await get(`pageguide_find_v2_claims?select=${CLAIM_LIST_COLUMNS}`
      + '&in_study=is.true&order=task_index.asc,id.asc');
    return (Array.isArray(rows) ? rows : []).map(taskRow);
  }

  async function listAllClaims() {
    const rows = await get(`pageguide_find_v2_claims?select=${CLAIM_LIST_COLUMNS}`
      + '&order=task_index.asc,id.asc');
    return Array.isArray(rows) ? rows : [];
  }

  async function getClaim(id) {
    const rows = await get('pageguide_find_v2_claims?select=*'
      + `&id=eq.${encodeURIComponent(id)}&limit=1`);
    return (Array.isArray(rows) && rows[0]) || null;
  }

  /**
   * The one of four authored answers this participant was dealt.
   *
   * `task` carries the correctness the welcome screen assigned; `condition` is
   * the grounding half of the same variant. Both halves are needed, which is why
   * the shared Find shell passes the task through as a third argument — V1's
   * adapter takes two and ignores it.
   */
  async function getCannedResponse(taskId, condition, task) {
    const row = await getClaim(taskId);
    if (!row) return null;
    const correct = task ? task.claimCorrect === true : row.claim_correct === true;
    const chosen = window.FindV2Variants.resolve(row, correct, condition);
    return {
      task_id: row.id,
      condition,
      variant_key: chosen.key,
      claim_correct: correct,
      url: row.url,
      question: row.question,
      answer_raw: chosen.answer_text,
      answer_display: chosen.answer_text,
      evidence: chosen.evidence,
      citation_anchors: chosen.citation_anchors,
    };
  }

  async function getTaskPage(taskId) {
    const rows = await get('pageguide_find_v2_claims?select=id,url,page_title,page_html,page_bytes'
      + `&id=eq.${encodeURIComponent(taskId)}&limit=1`);
    const row = (Array.isArray(rows) && rows[0]) || null;
    return row ? {
      task_id: row.id,
      url: row.url,
      title: row.page_title,
      html: row.page_html,
      bytes: row.page_bytes,
    } : null;
  }

  async function getStudyGroundTruth(taskId) {
    const rows = await get('pageguide_find_v2_claims?select=id,evidence_ground_truth'
      + `&id=eq.${encodeURIComponent(taskId)}&limit=1`);
    const row = (Array.isArray(rows) && rows[0]) || null;
    if (!row) return null;
    const gt = row.evidence_ground_truth && typeof row.evidence_ground_truth === 'object'
      ? row.evidence_ground_truth : {};
    return { task_id: row.id, hops: gt.hops || gt };
  }

  // ── Guide tasks ──────────────────────────────────────────────────────────
  // `arms` carries every step's base64 screenshot, so it is NEVER in a list query: pulling thirteen
  // trajectories to build a four-task queue would move megabytes to choose one id. The list carries
  // the fields a queue is built from; getGuideTask fetches the one that is about to be played.
  const GUIDE_LIST_BASE = [
    'id', 'source_trajectory_id', 'title', 'goal', 'task_style',
    'agent_completed', 'in_study', 'task_index', 'step_count', 'updated_at',
  ];
  const GUIDE_LIST_COLUMNS = GUIDE_LIST_BASE.concat('claims_completion').join(',');
  // Retried without it when supabase_v2_faithfulness.sql has not been applied yet: the panel is more
  // useful missing one chip than refusing to open.
  const GUIDE_LIST_FALLBACK = GUIDE_LIST_BASE.join(',');

  async function getGuideRows(where) {
    try { return await get(`pageguide_guide_v2_tasks?select=${GUIDE_LIST_COLUMNS}${where}`); }
    catch (e) {
      if (!/claims_completion/.test(e?.message || '')) throw e;
      console.warn('[find-v2] claims_completion is missing; run supabase_v2_faithfulness.sql');
      return get(`pageguide_guide_v2_tasks?select=${GUIDE_LIST_FALLBACK}${where}`);
    }
  }

  function guideRow(row) {
    return {
      // Does the answer claim the job is done? With agent_completed this separates a false success
      // (the study item) from an honest failure (excluded). Null until the migration is applied.
      claimsCompletion: typeof row.claims_completion === 'boolean' ? row.claims_completion : null,
      id: row.id,
      taskType: 'guide',
      studyVersion: 'find-v2',
      title: row.title || '',
      goal: row.goal || row.title || '',
      question: row.goal || row.title || '',
      style: row.task_style || 'guide_text',
      type: row.task_style === 'guide_visual' ? 'GUIDE × VISUAL' : 'GUIDE × TEXT',
      // The authored answer key. A task whose key is null is never dealt — see pickGuideTask.
      agentCompleted: typeof row.agent_completed === 'boolean' ? row.agent_completed : null,
      in_study: row.in_study === true,
      task_index: Number(row.task_index) || 0,
      stepCount: Number(row.step_count) || 0,
    };
  }

  /**
   * The guide tasks a queue may be built from: live, and actually judged.
   *
   * NEVER THROWS, for the same reason getStudyFlags does not. A project that has not had
   * supabase_v2_guide.sql applied answers "no guide tasks", and the Find half of the study still
   * runs — the welcome screen already says which group is short of what. Failing hard here took the
   * whole welcome screen down over a table the participant may not even reach.
   */
  async function listStudyGuideTasks() {
    let rows;
    try {
      rows = await getGuideRows('&in_study=is.true&order=task_index.asc,id.asc');
    } catch (e) {
      console.warn('[find-v2] no guide tasks available:', e?.message || e);
      return [];
    }
    return (Array.isArray(rows) ? rows : []).map(guideRow)
      // An honest failure is answerable from the answer's first sentence without opening the page,
      // so it is never dealt — enforced here as well as in the save function, because a task that
      // was live before the rule existed would otherwise keep being dealt.
      .filter(task => task.agentCompleted !== null && task.claimsCompletion !== false);
  }

  /**
   * Every guide task, judged or not — what the Admin tab lists.
   *
   * This one DOES throw: an admin who cannot see the tasks needs to be told the schema is missing,
   * not shown an empty list that looks like a finished migration.
   */
  async function listAllGuideTasks() {
    const rows = await getGuideRows('&order=task_index.asc,id.asc');
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * What the Admin inspector needs, WITHOUT the screenshots.
   *
   * `arms` is base64 images and runs to megabytes; selecting the whole column for thirteen tasks
   * times the request out, and for one task it downloads a video's worth of data to show a
   * paragraph. PostgREST can project JSON subpaths, so the answer and the trail come across as the
   * few kilobytes they actually are, and the journey is fetched only if somebody asks for it.
   */
  async function getGuideInspect(id) {
    const rows = await get('pageguide_guide_v2_tasks'
      + '?select=id,goal,title,task_style,agent_completed,guide_ground_truth,step_count'
      + ',answer:arms->grounding->>answer,trail:arms->grounding->trail'
      + ',evidence:arms->grounding->answer_evidence'
      + `&id=eq.${encodeURIComponent(id)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error(`No Guide V2 task for ${id}.`);
    return row;
  }

  /** The journey, screenshots and all. Heavy, and only ever loaded on a deliberate click. */
  async function getGuideSteps(id) {
    const rows = await get('pageguide_guide_v2_tasks'
      + `?select=steps:arms->grounding->steps&id=eq.${encodeURIComponent(id)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    return Array.isArray(row?.steps) ? row.steps : [];
  }

  /** The heavy half — the trajectory itself — for the one task being played. */
  async function getGuideTrajectory(id) {
    const rows = await get('pageguide_guide_v2_tasks?select=id,goal,title,arms,guide_ground_truth'
      + `&id=eq.${encodeURIComponent(id)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error(`No Guide V2 trajectory for ${id}.`);
    return row;
  }

  async function saveGuideMeta(password, meta) {
    return rpc('save_pageguide_guide_v2_meta', {
      p_password: password,
      p_id: meta.id,
      p_task_style: meta.taskStyle || null,
      p_agent_completed: typeof meta.agentCompleted === 'boolean' ? meta.agentCompleted : null,
      p_in_study: !!meta.inStudy,
      p_task_index: Number.isFinite(Number(meta.taskIndex)) ? Number(meta.taskIndex) : null,
      p_claims_completion: typeof meta.claimsCompletion === 'boolean' ? meta.claimsCompletion : null,
    });
  }

  /** Plain insert, for the same reason insertStudyResult is one. */
  async function insertGuideResult(record) {
    const res = await request('pageguide_guide_v2_results', {
      method: 'POST',
      headers: headers('return=minimal'),
      body: JSON.stringify(record),
    });
    return res == null ? true : !!res;
  }

  async function claimStudyAssignment(participantId) {
    const data = await rpc('claim_pageguide_find_v2_session', {
      p_participant_id: participantId,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Find V2 assignment returned no session.');
    return {
      sessionId: row.session_id,
      assignmentIndex: Number(row.assignment_slot) || 0,
      assignmentSlot: Number(row.assignment_slot) || 0,
      conditionOrder: row.condition_order || '',
    };
  }

  /**
   * A PLAIN INSERT, deliberately — not an upsert.
   *
   * This used to post with `on_conflict=result_key&resolution=merge-duplicates`, which Postgres runs
   * as INSERT ... ON CONFLICT (result_key) DO UPDATE — and that requires SELECT privilege on the
   * arbiter column. The anon role has `insert, update` and NO select, by design: a participant must
   * not be able to read anybody's answers, their own included. So every real result was rejected with
   * `42501 permission denied` and parked in localStorage, while dry runs (which never post) looked
   * fine. Granting select back to buy idempotency would trade the study's confidentiality for a retry
   * path nothing actually exercises: there is no automatic resend, and a duplicate result_key is
   * better surfaced as a conflict than silently merged.
   */
  async function insertStudyResult(record) {
    const res = await request('pageguide_find_v2_results', {
      method: 'POST',
      headers: headers('return=minimal'),
      body: JSON.stringify(record),
    });
    return res == null ? true : !!res;
  }

  async function checkAdmin(password) {
    return rpc('pageguide_find_v2_admin_check', { p_password: password });
  }

  /**
   * The two protocol switches, as the participant's browser sees them.
   *
   * Falls back to both-off on ANY failure — an unmigrated project, an offline
   * moment, a function that was never granted. The fallback is the default
   * protocol rather than a thrown error on purpose: a researcher who has not
   * run supabase_v2_flags.sql yet gets the short study, not a welcome screen
   * that refuses to start.
   */
  async function getStudyFlags() {
    const fallback = { collectEvidence: false, collectFollowup: false };
    let data;
    try { data = await rpc('pageguide_find_v2_study_flags', {}); }
    catch (e) { return fallback; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') return fallback;
    return {
      collectEvidence: !!row.collect_evidence,
      collectFollowup: !!row.collect_followup,
    };
  }

  async function saveStudyFlags(password, flags) {
    const data = await rpc('save_pageguide_find_v2_flags', {
      p_password: password,
      p_collect_evidence: !!flags?.collectEvidence,
      p_collect_followup: !!flags?.collectFollowup,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return {
      collectEvidence: !!row?.collect_evidence,
      collectFollowup: !!row?.collect_followup,
    };
  }

  async function saveClaim(password, claim) {
    return rpc('save_pageguide_find_v2_claim', {
      p_password: password,
      p_claim: claim,
    });
  }

  /**
   * One variant's references, and nothing else.
   *
   * Deliberately NOT saveClaim. A claim carries its captured page — eight megabytes — so saving a
   * re-link through it would read and rewrite all of that to change a few hundred bytes, and would
   * put the question, the page and all four answers at risk of being restored from a stale copy.
   * This writes one path in the jsonb and never touches the rest.
   */
  async function saveVariantAnchors(password, id, variantKey, anchors) {
    return rpc('save_pageguide_find_v2_anchors', {
      p_password: password,
      p_id: id,
      p_variant_key: variantKey,
      p_anchors: Array.isArray(anchors) ? anchors : [],
    });
  }

  async function listGuideResults(password, limit = 20000) {
    const rows = await rpc('pageguide_guide_v2_admin_results', {
      p_password: password,
      p_limit: limit,
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function listResults(password, limit = 20000) {
    const rows = await rpc('pageguide_find_v2_admin_results', {
      p_password: password,
      p_limit: limit,
    });
    return Array.isArray(rows) ? rows : [];
  }

  window.StudyDB = {
    supabaseConfigured,
    listStudyTasks,
    getCannedResponse,
    getTaskPage,
    getStudyGroundTruth,
    claimStudyAssignment,
    insertStudyResult,
    listAllClaims,
    getClaim,
    checkAdmin,
    saveClaim,
    listResults,
    listGuideResults,
    saveVariantAnchors,
    getStudyFlags,
    saveStudyFlags,
    listStudyGuideTasks,
    listAllGuideTasks,
    getGuideTrajectory,
    getGuideInspect,
    getGuideSteps,
    saveGuideMeta,
    insertGuideResult,
  };
}());

