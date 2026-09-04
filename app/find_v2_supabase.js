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

  // `page_html` is omitted here — the queue lists every claim, the snapshot is fetched only when its
  // task opens. So was `answer_variants`, on the grounds that it was "four short answers"; it is not.
  // Each variant carries its EVIDENCE, and evidence carries base64 screenshots, so the four cells run
  // to 584 KB on SVSF-V1 and 1.57 MB across the ten live claims — downloaded on the welcome screen
  // before Start could be pressed, to answer four booleans per claim.
  //
  // Everything that reads this list wants only WHETHER each cell has text: FindV2Variants.authored
  // for the queue, missingVariants for the Admin list. So the four answer_texts are projected as
  // scalars and reassembled below into the shape those callers already expect. Editing a claim still
  // goes through getClaim, which selects the whole row.
  const VARIANT_TEXT_COLUMNS = window.FindV2Variants.KEYS
    .map(key => `${key}:answer_variants->${key}->>answer_text`).join(',');

  const CLAIM_LIST_COLUMNS = [
    'id', 'source_task_id', 'title', 'url', 'task_style', 'question',
    'correctness_mode', 'claim_correct', 'answer_text',
    'in_study', 'task_index', 'page_bytes', 'updated_at',
    VARIANT_TEXT_COLUMNS,
  ].join(',');

  /**
   * Put `answer_variants` back, carrying the answer text and nothing else.
   *
   * Callers do `variantOf(row, key).answer_text`, so they get exactly what they ask for. `evidence`
   * and `citation_anchors` come back empty rather than absent — a caller that reads them off a LIST
   * row would otherwise get undefined and throw, and this way it gets the truth for a list query:
   * they were not fetched.
   */
  function withVariantTexts(row) {
    const variants = {};
    window.FindV2Variants.KEYS.forEach(key => {
      variants[key] = { answer_text: row[key] || '', evidence: [], citation_anchors: [] };
      delete row[key];
    });
    return { ...row, answer_variants: variants };
  }

  async function listStudyTasks() {
    const rows = await get(`pageguide_find_v2_claims?select=${CLAIM_LIST_COLUMNS}`
      + '&in_study=is.true&order=task_index.asc,id.asc');
    return (Array.isArray(rows) ? rows : []).map(row => taskRow(withVariantTexts(row)));
  }

  async function listAllClaims() {
    const rows = await get(`pageguide_find_v2_claims?select=${CLAIM_LIST_COLUMNS}`
      + '&order=task_index.asc,id.asc');
    return (Array.isArray(rows) ? rows : []).map(withVariantTexts);
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
  // WHAT THE PLAYER NEEDS TO RENDER AN ANSWER — and nothing else.
  //
  // This used to call getClaim, which is `select=*`. On a claim with a captured page that pulls
  // `page_html` — the whole snapshot, megabytes of it — to read an answer paragraph, and it does so
  // IN PARALLEL WITH getTaskPage, which is fetching the same column for the same row at the same
  // time. Every Find task therefore downloaded its page snapshot twice before it could be shown,
  // and the second copy was thrown away. `page_title` and `page_bytes` go with it for the same
  // reason: the answer card does not read them.
  //
  // `answer_variants` stays whole. FindV2Variants.resolve walks the cells looking for the authored
  // one and falls back across them, so projecting a single subpath would change which stimulus a
  // half-authored claim shows — a correctness bug traded for a few kilobytes.
  const CLAIM_ANSWER_COLUMNS = 'id,url,question,claim_correct,answer_text,'
    + 'citation_anchors,evidence,answer_variants';

  async function getClaimAnswer(id) {
    const rows = await get(`pageguide_find_v2_claims?select=${CLAIM_ANSWER_COLUMNS}`
      + `&id=eq.${encodeURIComponent(id)}&limit=1`);
    return (Array.isArray(rows) && rows[0]) || null;
  }

  async function getCannedResponse(taskId, condition, task) {
    const row = await getClaimAnswer(taskId);
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
  // `guide_ground_truth` is a hundred-odd bytes a row and is what the failure-mode chip is read
  // from, so it belongs in the list. It is the ONLY jsonb column that does — never add one to a
  // query that also selects `arms`, which is base64 screenshots and times the request out.
  const GUIDE_LIST_BASE = [
    'id', 'source_trajectory_id', 'title', 'goal', 'task_style',
    'agent_completed', 'in_study', 'task_index', 'step_count', 'updated_at',
    'guide_ground_truth',
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
      groundTruth: row.guide_ground_truth && typeof row.guide_ground_truth === 'object'
        ? row.guide_ground_truth : {},
      // Why it is keyed incorrect, for the Admin chip and the per-mode accuracy split. Derived, not
      // stored: nothing new is authored, so there is nothing new to keep in sync.
      failureMode: window.FindV2GuideKey.failureMode(row.guide_ground_truth, row.agent_completed),
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

  /**
   * The failure-mode classification for one Guide task.
   *
   * SEPARATE FROM saveGuideMeta on purpose. That one writes the four judged fields through
   * save_pageguide_guide_v2_meta; this writes `guide_ground_truth.problems`, which is a different
   * fact with a different owner — the recorder writes the rest of that object and this must not
   * touch it.
   */
  async function saveGuideProblems(password, id, problems) {
    return rpc('save_pageguide_guide_v2_problems', {
      p_password: password,
      p_id: id,
      p_problems: Array.isArray(problems) ? problems.filter(Boolean) : [],
    });
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
  // Two minutes, matching the column default — what a project answers before
  // supabase_v2_task_limit.sql has been applied and the RPC returns no such field.
  const DEFAULT_TASK_LIMIT_SECONDS = 120;

  // The queue designs the site can deal. An unknown value — a project written to by hand, or one
  // running a newer site than this browser — maps to the default rather than throwing: a welcome
  // screen that refuses to start is worse than a sitting dealt under the documented default.
  const QUEUE_DESIGNS = ['balanced_2x2', 'legacy_find3', 'guide_visual_4'];
  const DEFAULT_QUEUE_DESIGN = 'balanced_2x2';

  function queueDesignOf(row) {
    const value = String(row?.queue_design || '');
    return QUEUE_DESIGNS.includes(value) ? value : DEFAULT_QUEUE_DESIGN;
  }

  function taskLimitOf(row) {
    const value = Number(row?.task_limit_seconds);
    if (!Number.isFinite(value)) return DEFAULT_TASK_LIMIT_SECONDS;
    return Math.min(900, Math.max(30, Math.round(value)));
  }

  // 0 is off — plain round-robin. Anything else is the target number of COMPLETED sittings per
  // `assignment_slot % 4` class, which is identically the target n of four Find cells and four
  // Guide cells. A project that has not run supabase_v2_recruit_quota.sql answers 0.
  function slotQuotaOf(row) {
    const value = Number(row?.slot_quota);
    if (!Number.isFinite(value)) return 0;
    return Math.min(200, Math.max(0, Math.round(value)));
  }

  /**
   * The per-cell task pins, normalized to an object keyed by design.
   *
   * A project that has not run supabase_v2_task_picker.sql answers with no column at all, which is
   * the same answer as "nothing is pinned" — every cell falls back to the rotation its design
   * already had. That is what makes the picker additive: applying the migration changes nothing
   * until somebody actually chooses.
   */
  // 0 is "no delay", 500 is the default, and 5000 is a usability ceiling rather than a design limit.
  // A project that has not run supabase_v2_task_picker.sql answers with the default, which is what
  // the code would use anyway — so applying the migration does not change how the walk feels.
  const DEFAULT_BROWSE_SIM_DELAY_MS = 500;

  function browseSimDelayOf(row) {
    const value = Number(row?.browse_sim_delay_ms);
    if (!Number.isFinite(value)) return DEFAULT_BROWSE_SIM_DELAY_MS;
    return Math.min(5000, Math.max(0, Math.round(value)));
  }

  function taskSelectionOf(row) {
    const value = row?.task_selection;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function getStudyFlags() {
    const fallback = {
      collectEvidence: false,
      collectFollowup: false,
      taskLimitSeconds: DEFAULT_TASK_LIMIT_SECONDS,
      // OFF, and the same answer a migrated project gives. The chip names an experimental factor the
      // participant is not asked about, so its absence is the default rather than a degraded mode.
      showGroupChip: false,
      // ON. The walkthrough teaches the journey by pointing at the flagged steps, so a project that
      // has not run the migration yet must not rehearse a screen the study then withholds.
      flagMilestones: true,
      // OFF. The trail is the agent's own account of the run, not evidence about it — see
      // supabase_v2_reasoning_trail.sql for why it frames the judgement rather than informing it.
      showReasoningTrail: false,
      // A project that has not run supabase_v2_queue_design.sql answers with the default design,
      // which is the crossed one — the same answer it will give once the migration lands, so the
      // study a participant is dealt does not change when the SQL is applied.
      queueDesign: DEFAULT_QUEUE_DESIGN,
      // OFF, so a project that has not run the quota migration deals exactly the round-robin it
      // dealt before. Recruiting to a target is a decision, not a default.
      slotQuota: 0,
      // NOTHING PINNED. An unmigrated project deals exactly the rotation it dealt before, so the
      // picker cannot change a study by being deployed — only by being used.
      taskSelection: {},
      // ON, matching the column default: the migration exists to add the button, so a project that
      // has run it wants it. A project that has NOT run it never reaches this — the flag only does
      // anything on a non-grounded Guide task, and the code that reads it is deployed together.
      allowBrowseSim: true,
      browseSimDelayMs: DEFAULT_BROWSE_SIM_DELAY_MS,
    };
    let data;
    try { data = await rpc('pageguide_find_v2_study_flags', {}); }
    catch (e) { return fallback; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') return fallback;
    return {
      collectEvidence: !!row.collect_evidence,
      collectFollowup: !!row.collect_followup,
      taskLimitSeconds: taskLimitOf(row),
      queueDesign: queueDesignOf(row),
      showGroupChip: row.show_group_chip === true,
      // Absent means on, matching the column default and the fallback above.
      flagMilestones: row.flag_milestones !== false,
      showReasoningTrail: row.show_reasoning_trail === true,
      slotQuota: slotQuotaOf(row),
      taskSelection: taskSelectionOf(row),
      // Absent means on, matching the column default and the fallback above.
      allowBrowseSim: row.allow_browse_sim !== false,
      browseSimDelayMs: browseSimDelayOf(row),
    };
  }

  async function saveStudyFlags(password, flags) {
    const body = {
      p_password: password,
      p_collect_evidence: !!flags?.collectEvidence,
      p_collect_followup: !!flags?.collectFollowup,
    };
    // Omitted rather than sent as null when absent, so a project still on the three-argument
    // function keeps saving the two booleans instead of failing on an unknown parameter.
    if (Number.isFinite(Number(flags?.taskLimitSeconds))) {
      body.p_task_limit_seconds = Math.round(Number(flags.taskLimitSeconds));
    }
    // Same rule for the same reason: a project still on the four-argument function keeps saving the
    // rest rather than failing on a parameter it does not have.
    if (QUEUE_DESIGNS.includes(String(flags?.queueDesign || ''))) {
      body.p_queue_design = String(flags.queueDesign);
    }
    // Sent only when the caller actually has an opinion, so a browser older than the column keeps
    // saving the rest instead of failing on a parameter the function does not have.
    if (typeof flags?.showGroupChip === 'boolean') {
      body.p_show_group_chip = flags.showGroupChip;
    }
    if (typeof flags?.flagMilestones === 'boolean') {
      body.p_flag_milestones = flags.flagMilestones;
    }
    if (typeof flags?.showReasoningTrail === 'boolean') {
      body.p_show_reasoning_trail = flags.showReasoningTrail;
    }
    // Same rule again: omitted rather than sent as 0, so a browser older than the column cannot
    // switch the quota off by not knowing about it.
    if (Number.isFinite(Number(flags?.slotQuota))) {
      body.p_slot_quota = Math.round(Number(flags.slotQuota));
    }
    // Same rule once more. The Study settings tab has no opinion about the pins and the Study tasks
    // tab has none about the switches, so each sends only what it owns — and a tab that stayed
    // silent must never be read as having cleared the other's work.
    if (flags?.taskSelection && typeof flags.taskSelection === 'object'
      && !Array.isArray(flags.taskSelection)) {
      body.p_task_selection = flags.taskSelection;
    }
    if (typeof flags?.allowBrowseSim === 'boolean') {
      body.p_allow_browse_sim = flags.allowBrowseSim;
    }
    if (Number.isFinite(Number(flags?.browseSimDelayMs))) {
      body.p_browse_sim_delay_ms = Math.round(Number(flags.browseSimDelayMs));
    }
    // WHAT POSTGREST SAYS WHEN THE PROJECT IS BEHIND THE BROWSER, translated.
    //
    // Functions are resolved BY ARGUMENT NAME, so a browser that sends `p_task_selection` to a
    // project still holding the nine-argument writer does not get "unknown parameter" — it gets
    // "Could not find the function public.save_pageguide_find_v2_flags(p_allow_browse_sim,
    // p_browse_sim_delay_ms, …) in the schema cache", a list of twelve names with nothing in it
    // saying which are new or what to do. Shown raw in the Admin status line, that reads as the
    // panel being broken rather than as one SQL file not having been run.
    //
    // Caught HERE rather than in each tab: Study settings and Study tasks both write through this
    // function, and both would have to carry the same translation. Re-thrown, never swallowed —
    // retrying without the new parameters would report a save that half happened.
    let data;
    try {
      data = await rpc('save_pageguide_find_v2_flags', body);
    } catch (error) {
      const message = String(error?.message || error);
      if (/Could not find the function/i.test(message) && /save_pageguide_find_v2_flags/.test(message)) {
        const missing = ['p_task_selection', 'p_allow_browse_sim', 'p_browse_sim_delay_ms']
          .filter(name => name in body);
        throw new Error('This Supabase project has not been migrated for these settings yet — its '
          + `save_pageguide_find_v2_flags does not take ${missing.join(', ') || 'these parameters'}. `
          + 'Run supabase_v2_task_picker.sql in the project\'s SQL editor (it is idempotent, so '
          + 'running it again is safe), then reload this page. Nothing was saved.');
      }
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      collectEvidence: !!row?.collect_evidence,
      collectFollowup: !!row?.collect_followup,
      taskLimitSeconds: taskLimitOf(row),
      queueDesign: queueDesignOf(row),
      showGroupChip: row?.show_group_chip === true,
      flagMilestones: row?.flag_milestones !== false,
      showReasoningTrail: row?.show_reasoning_trail === true,
      slotQuota: slotQuotaOf(row),
      taskSelection: taskSelectionOf(row),
      allowBrowseSim: row?.allow_browse_sim !== false,
      browseSimDelayMs: browseSimDelayOf(row),
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
  /**
   * One variant's citation anchors, and — only when a reference was deleted — its answer text.
   *
   * `p_answer_text` is omitted entirely when null rather than sent as null, so a project that has
   * not run supabase_v2_answer_edit.sql still resolves the 4-argument overload and re-linking keeps
   * working. Deleting a reference on such a project fails loudly, which is the right way round: the
   * alternative is an answer that still shows a citation the anchors no longer have.
   */
  async function saveVariantAnchors(password, id, variantKey, anchors, answerText = null) {
    const body = {
      p_password: password,
      p_id: id,
      p_variant_key: variantKey,
      p_anchors: Array.isArray(anchors) ? anchors : [],
    };
    if (typeof answerText === 'string') body.p_answer_text = answerText;
    return rpc('save_pageguide_find_v2_anchors', body);
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

  /**
   * How many sittings each `assignment_slot % 4` class has started, completed, and has in flight.
   *
   * Read from the SESSIONS table, which the Results tab never sees: a sitting that pressed Start and
   * submitted nothing leaves no result row at all, so a denominator built from results alone would
   * report a completion rate of 100% and a recruitment plan built on it would be wrong by half.
   *
   * The same function the slot dealer calls, deliberately — the panel showing the standings and the
   * claim acting on them must not carry two copies of the completeness rule.
   *
   * Returns an empty list on a project that has not run supabase_v2_recruit_quota.sql, so the panel
   * can say so rather than throw inside the Results tab.
   */
  async function classCounts() {
    let rows;
    try { rows = await rpc('pageguide_find_v2_class_counts', {}); }
    catch (e) { return []; }
    if (!Array.isArray(rows)) return [];
    return rows
      .map(row => ({
        slotClass: Number(row?.slot_class),
        started: Number(row?.started) || 0,
        complete: Number(row?.complete) || 0,
        inflight: Number(row?.inflight) || 0,
      }))
      .filter(row => Number.isInteger(row.slotClass) && row.slotClass >= 0 && row.slotClass <= 3)
      .sort((a, b) => a.slotClass - b.slotClass);
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
    classCounts,
    saveVariantAnchors,
    getStudyFlags,
    saveStudyFlags,
    QUEUE_DESIGNS,
    DEFAULT_QUEUE_DESIGN,
    DEFAULT_BROWSE_SIM_DELAY_MS,
    listStudyGuideTasks,
    listAllGuideTasks,
    getGuideTrajectory,
    getGuideInspect,
    getGuideSteps,
    saveGuideMeta,
    saveGuideProblems,
    insertGuideResult,
  };
}());

