// Find V2 welcome screen and Admin claim editor.

(function () {
  const DB = window.StudyDB;
  const S = window.StudySession;
  const V = window.FindV2Variants;
  const status = document.getElementById('welcome-status');
  const count = document.getElementById('welcome-count');
  const countChip = document.getElementById('find-v2-task-count');
  const start = document.getElementById('start-btn');
  const idInput = document.getElementById('participant-id');
  const idToggle = document.getElementById('participant-id-toggle');
  const idField = document.getElementById('participant-id-field');
  const adminButton = document.getElementById('admin-btn');
  const adminPanel = document.getElementById('admin-panel');

  let liveTasks = [];
  let liveGuideTasks = [];
  // The design here is only what a page reads before the flags come back; the study is dealt from
  // what loadWelcome fetched, and beginStudy snapshots that into the session.
  let studyFlags = {
    collectEvidence: false, collectFollowup: false, taskLimitSeconds: 120,
    queueDesign: 'balanced_2x2',
  };
  let adminPassword = '';
  let adminClaims = [];
  let editingClaim = null;
  let adminTab = 'claims';
  let variantTab = 'correct_grounding';

  /**
   * A result's timestamp, read in the study's own timezone.
   *
   * `created_at` is a `timestamptz` — an absolute instant — so it has no timezone of its own to
   * show. This used to be a bare `toLocaleString()`, which renders in whatever zone the BROWSER is
   * set to: the same row read as 3:15pm on a laptop in Alabama and 8:15pm on one in London, with
   * nothing on screen saying which. Pinned to the study's zone so two people comparing notes are
   * reading the same number, and labelled so nobody has to guess.
   *
   * The NAMED zone, not a fixed offset: Central is CST in winter and CDT in summer, and 'America/
   * Chicago' applies whichever was in force on the day — including across the changeover, where a
   * fixed offset would put an hour's error into half the sessions.
   */
  const STUDY_TIME_ZONE = 'America/Chicago';

  function localTime(value) {
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: STUDY_TIME_ZONE,
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).format(when);
    } catch (e) {
      return when.toLocaleString();   // an engine without the zone still shows a time
    }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function say(message, bad = false) {
    status.textContent = message || '';
    status.className = `welcome-status${bad ? ' welcome-status-bad' : ''}`;
  }

  function randomId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `anon-${crypto.randomUUID()}`;
    return `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // ── The queue ────────────────────────────────────────────────────────────
  //
  // A ROUND ROBIN OVER TWO GROUPS, four tasks each. Group A is Text throughout, group B is Visual
  // throughout, and a participant's group is the parity of their assignment slot — so consecutive
  // participants alternate and the two groups fill at the same rate without anyone tracking counts.
  //
  // The three Find cells are FIXED, not rotated: grounded/incorrect, non-grounded/correct,
  // non-grounded/incorrect. That is three of the four cells — there is no grounded/correct task, by
  // design. Every participant therefore sees the same three cells in the same order, and what varies
  // between participants of a group is which claims fill them.
  //
  // Only the fourth task, Guide, rotates its correctness, because a participant who has learnt that
  // the agent always fails can answer it without reading.
  const FIND_CELLS = [
    { correct: false, arm: 'grounding' },
    { correct: true, arm: 'nongrounding' },
    { correct: false, arm: 'nongrounding' },
  ];

  // ── The second design: the 2 × 2 crossed queue ────────────────────────────
  //
  // FOUR TASKS, ONE PER CELL of task type × grounding:
  //
  //     Find  × Grounded        Find  × Non-grounded
  //     Guide × Grounded        Guide × Non-grounded
  //
  // Group A is text throughout and group B is visual throughout, unchanged — modality stays
  // between-subjects, and task type and grounding are both within. That is the difference from
  // FIND_CELLS, where Guide is grounded-only: with no non-grounded Guide task, nothing in the old
  // queue estimates grounding for the Guide half, and the interaction cannot be asked at all.
  const CROSSED_CELLS = [
    { taskType: 'find', arm: 'grounding' },
    { taskType: 'find', arm: 'nongrounding' },
    { taskType: 'guide', arm: 'grounding' },
    { taskType: 'guide', arm: 'nongrounding' },
  ];

  /**
   * Whether cell `index` shows a correct run in this sitting.
   *
   * TWO THINGS AT ONCE, and both matter:
   *
   *   ACROSS SITTINGS — every cell alternates correct → incorrect for consecutive participants of
   *   the same group, so no cell is stuck on one answer and the pool is not read as "the grounded
   *   one is always the true one".
   *
   *   WITHIN A SITTING — two cells are correct and two are not, so a participant cannot learn on
   *   task 2 that the agent always fails and answer tasks 3 and 4 without reading. This is the
   *   failure the old queue's rotating Guide key was already guarding against, applied to all four.
   *
   * The Guide half is offset by one so that Find × Grounded and Guide × Grounded do not carry the
   * same correctness in every sitting. Without the offset the two factors are perfectly correlated
   * within a participant and "did task type matter?" and "did correctness matter?" would be the
   * same question asked twice.
   */
  function crossedCorrect(cycle, index) {
    return (Number(cycle) + index + (index >= 2 ? 1 : 0)) % 2 === 0;
  }

  const DESIGNS = {
    balanced_2x2: {
      label: 'Crossed 2 × 2 — Find and Guide, each grounded and non-grounded',
      short: 'crossed 2 × 2',
      tasks: 4,
    },
    legacy_find3: {
      label: 'Three Find cells + one grounded Guide task',
      short: 'three Find + one Guide',
      tasks: 4,
    },
  };

  function designOf(value) {
    const key = String(value || '');
    return DESIGNS[key] ? key : (DB.DEFAULT_QUEUE_DESIGN || 'balanced_2x2');
  }

  /** The design this browser will deal under, from the flags it loaded. */
  function currentDesign() {
    return designOf(studyFlags.queueDesign);
  }

  function groupOf(slot) {
    return Number(slot) % 2 === 0 ? 'A' : 'B';
  }

  function stylesFor(group) {
    return group === 'B'
      ? { find: 'find_visual', guide: 'guide_visual' }
      : { find: 'find_text', guide: 'guide_text' };
  }

  /**
   * Three claims out of the pool of that style, walked by the slot.
   *
   * `cycle` counts sittings WITHIN a group (slot 0 and 1 are cycle 0, one in each group), so
   * consecutive participants of the same group start at a different claim and the pool is covered
   * evenly instead of the first three being used forever. Walking consecutively rather than picking
   * at random keeps a session reproducible from its slot alone, which is what makes a pilot run
   * debuggable.
   */
  function pickClaims(pool, cycle, want) {
    if (!pool.length) return [];
    const out = [];
    for (let i = 0; i < want; i++) out.push(pool[(cycle + i) % pool.length]);
    return out;
  }

  /**
   * The guide task for this sitting: the wanted correctness if that style has one, otherwise the
   * other.
   *
   * The fallback is the same accommodation FindV2Variants.deal already makes for a half-authored
   * claim. An authoring gap should cost the balance of one cell, not a participant's whole session
   * — and Admin is where it gets fixed, not here.
   */
  function pickGuideTask(pool, cycle) {
    if (!pool.length) return null;
    const want = cycle % 2 === 0;
    const matching = pool.filter(task => task.agentCompleted === want);
    const from = matching.length ? matching : pool;
    return from[Math.floor(cycle / 2) % from.length];
  }

  /**
   * A guide task of the wanted correctness, not already dealt in this sitting.
   *
   * The two fallbacks are ordered, and both are accommodations rather than choices: prefer the
   * wanted key, then any unused task, then repeat. An authoring gap should cost the balance of one
   * cell, not a participant's whole session — and the welcome screen names the gap before anyone
   * sits down, which is where it gets fixed.
   */
  function pickGuideFor(pool, cycle, want, taken) {
    if (!pool.length) return null;
    const fresh = pool.filter(task => !taken.includes(task.id));
    const wanted = fresh.filter(task => task.agentCompleted === want);
    const from = wanted.length ? wanted : (fresh.length ? fresh : pool);
    return from[Math.floor(Number(cycle) / 2) % from.length] || null;
  }

  /** The crossed queue: one task per cell of task type × grounding, correctness alternating. */
  function buildCrossedQueue(claims, guideTasks, slot) {
    const group = groupOf(slot);
    const styles = stylesFor(group);
    const cycle = Math.floor(Number(slot) / 2);

    const findPool = claims.filter(task => task.style === styles.find);
    const guidePool = guideTasks.filter(task => task.style === styles.guide);
    const findCells = CROSSED_CELLS.filter(cell => cell.taskType === 'find');
    const picked = pickClaims(findPool, cycle, findCells.length);

    const queue = [];
    const takenGuides = [];
    CROSSED_CELLS.forEach((cell, index) => {
      const correct = crossedCorrect(cycle, index);
      if (cell.taskType === 'find') {
        const task = picked[index];
        if (!task) return;
        queue.push({
          ...task,
          group,
          arm: cell.arm,
          claimCorrect: correct,
          variantKey: window.FindV2Variants.variantKey(correct, cell.arm),
          assignedOrder: queue.length,
        });
        return;
      }
      const guide = pickGuideFor(guidePool, cycle, correct, takenGuides);
      if (!guide) return;
      takenGuides.push(guide.id);
      queue.push({
        ...guide,
        group,
        arm: cell.arm,
        // THE KEY IS THE TASK'S, NOT THE CELL'S. A Guide run is correct or not because of what the
        // agent did; the cell says which one this slot ASKED for, and pickGuideFor may have had to
        // settle. Recording the request rather than the recording would key an answer against a run
        // the participant never saw.
        claimCorrect: guide.agentCompleted,
        variantKey: window.FindV2Variants.variantKey(guide.agentCompleted !== false, cell.arm),
        assignedOrder: queue.length,
      });
    });
    return queue;
  }

  /** The four tasks this slot is dealt, in order, under the design the study is set to. */
  function buildQueue(claims, guideTasks, slot, design) {
    return designOf(design) === 'legacy_find3'
      ? buildLegacyQueue(claims, guideTasks, slot)
      : buildCrossedQueue(claims, guideTasks, slot);
  }

  /** The original queue: three fixed Find cells, then one grounded Guide task. */
  function buildLegacyQueue(claims, guideTasks, slot) {
    const group = groupOf(slot);
    const styles = stylesFor(group);
    const cycle = Math.floor(Number(slot) / 2);

    const findPool = claims.filter(task => task.style === styles.find);
    const guidePool = guideTasks.filter(task => task.style === styles.guide);

    const queue = pickClaims(findPool, cycle, FIND_CELLS.length).map((task, index) => {
      const cell = FIND_CELLS[index];
      return {
        ...task,
        group,
        arm: cell.arm,
        claimCorrect: cell.correct,
        variantKey: window.FindV2Variants.variantKey(cell.correct, cell.arm),
        assignedOrder: index,
      };
    });

    const guide = pickGuideTask(guidePool, cycle);
    if (guide) {
      queue.push({
        ...guide,
        group,
        // Grounded only, for now. The chip in the question pane reads this.
        arm: 'grounding',
        claimCorrect: guide.agentCompleted,
        variantKey: window.FindV2Variants.variantKey(guide.agentCompleted !== false, 'grounding'),
        assignedOrder: queue.length,
      });
    }
    return queue;
  }

  async function loadWelcome() {
    if (window.__findV2ConfigMissing || !DB?.supabaseConfigured()) {
      // Two different fixes depending on where this is being read, and naming the wrong one costs a
      // researcher the time it takes to edit a file that the deploy overwrites anyway. Served over
      // http(s) this is the published site, where the config is written at deploy time from
      // repository secrets; opened from a file:// or a local server it is somebody's checkout.
      const deployed = location.protocol === 'http:' || location.protocol === 'https:';
      const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      say(deployed && !local
        ? 'This site is not connected to its Supabase project. Set SUPABASE_URL_V2 and SUPABASE_PUBLISH_KEY_V2 as repository secrets, then re-run the deploy.'
        : 'Find V2 is waiting for its Supabase project. Copy app/find_v2_config.example.js to app/find_v2_config.js and fill it in.', true);
      return;
    }

    const saved = S.loadLocal();

    try {
      // getStudyFlags never throws — an unmigrated project answers "both off", which is the default
      // protocol rather than a welcome screen that refuses to start.
      [liveTasks, liveGuideTasks, studyFlags] = await Promise.all([
        DB.listStudyTasks(), DB.listStudyGuideTasks(), DB.getStudyFlags(),
      ]);
    } catch (error) {
      say(`Could not load Find V2: ${error.message || error}`, true);
      return;
    }
    if (!studyFlags.collectEvidence) document.getElementById('welcome-step-evidence')?.remove();

    // AN UNFINISHED RUN RESUMES UNDER THE DESIGN IT WAS DEALT UNDER, always — the queue is saved with
    // the run, and re-dealing it mid-sitting would make task 4 belong to a different experiment from
    // task 1. What was missing is that nothing SAID so, so a pilot run left on this browser under the
    // old three-cell queue came back as "Continue →" with no hint that it was not the design now set,
    // and it looked like the setting had not taken.
    //
    // Now it is named, and a stale one can be thrown away. The discard button appears only when the
    // saved run's design is not the one the study is set to (a run saved before the setting existed
    // counts, since it was dealt under the old queue by definition) — so a participant mid-sitting
    // under the current design is never offered a button that destroys their progress.
    if (saved && saved.idx < saved.queue.length) {
      const design = currentDesign();
      const savedDesign = saved.flags?.queueDesign || '';
      const stale = designOf(savedDesign) !== design || !savedDesign;
      const left = saved.queue.length - saved.idx;
      countChip.textContent = String(saved.queue.length);
      count.textContent = `${saved.idx} completed · ${left} remaining in this saved Find V2 run.`;
      say(stale
        ? `This browser has an unfinished run dealt under the ${savedDesign
            ? DESIGNS[designOf(savedDesign)].short : 'original three Find + one Guide'} queue. `
          + `The study is now set to deal ${DESIGNS[design].short}. Continuing plays the old queue.`
        : 'An unfinished Find V2 run was found on this browser.', stale);
      start.textContent = 'Continue →';
      start.disabled = false;
      start.onclick = () => { location.href = 'study.html'; };
      if (stale) addDiscardButton();
      return;
    }

    // Every queue is four tasks now, whatever the pools hold, so the chip does not count the pool.
    // Both designs deal four; what differs is how they are split between Find and Guide, which is a
    // researcher's concern and not something to put in front of a participant.
    const design = currentDesign();
    const guideSlots = design === 'legacy_find3' ? 1 : 2;
    const findSlots = design === 'legacy_find3' ? FIND_CELLS.length : 2;
    countChip.textContent = String(findSlots + (liveGuideTasks.length ? guideSlots : 0));
    // The limit chip reads the SETTING, not a number written into the page. A welcome screen
    // promising three minutes over a two-minute clock is worse than no promise at all.
    const limitChip = document.getElementById('find-v2-task-limit');
    if (limitChip) {
      const seconds = Number(studyFlags.taskLimitSeconds) || 120;
      limitChip.textContent = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
    }
    if (!liveTasks.length) {
      say('Find V2 is configured, but no claim is marked “Use in study” yet.', true);
      count.textContent = 'Open Admin to create or publish a claim.';
      return;
    }

    // Said out loud rather than left to fail mid-session. A group whose pool is short still runs —
    // pickClaims wraps — but it repeats a claim within the sitting, and that is worth knowing before
    // a participant is in front of it rather than after.
    const shortages = [];
    ['A', 'B'].forEach(group => {
      const styles = stylesFor(group);
      const find = liveTasks.filter(task => task.style === styles.find).length;
      const guidePool = liveGuideTasks.filter(task => task.style === styles.guide);
      if (find < findSlots) shortages.push(`group ${group} has ${find} ${styles.find} claim${find === 1 ? '' : 's'} for ${findSlots} slots`);
      if (!guidePool.length) shortages.push(`group ${group} has no ${styles.guide} task`);
      // The crossed design deals TWO Guide tasks per sitting and wants one of each key. One task, or
      // two that agree, means a cell falls back to the wrong correctness — and pickGuideFor would
      // then repeat a task within the sitting, which is worth knowing before the participant sits.
      else if (design !== 'legacy_find3') {
        if (guidePool.length < 2) shortages.push(`group ${group} has 1 ${styles.guide} task for 2 slots`);
        else if (!guidePool.some(task => task.agentCompleted === true)) shortages.push(`group ${group} has no “completed” ${styles.guide} task`);
        else if (!guidePool.some(task => task.agentCompleted === false)) shortages.push(`group ${group} has no “did not complete” ${styles.guide} task`);
      }
    });

    // THE CROSSED QUEUE DEALS ALL FOUR FIND CELLS, and the old one never dealt correct-and-grounded —
    // so a claim authored under the old design can have that cell empty. resolve() falls back across
    // the grounding axis rather than rendering a blank answer card, but the fallback is a DIFFERENT
    // stimulus from the one the cell names, and nothing downstream would say which was shown.
    if (design !== 'legacy_find3') {
      const short = liveTasks.filter(task => !window.FindV2Variants.KEYS
        .every(key => task.authoredVariants?.[key]));
      if (short.length) {
        shortages.push(`${short.length} live claim${short.length === 1 ? '' : 's'} `
          + `${short.length === 1 ? 'is' : 'are'} missing an authored answer variant `
          + '(the crossed queue deals all four correctness × grounding cells)');
      }
    }

    // A run with no guide task at all is the un-migrated case, and naming the fix beats listing the
    // symptom twice.
    const noGuideAtAll = !liveGuideTasks.length;
    // Nothing is said when the set is healthy. "Find V2 is ready" told a PARTICIPANT that the
    // apparatus works, which is not their concern and is one more sentence between them and the
    // task; the gaps below are still reported, because those a researcher needs to see.
    say(noGuideAtAll
      ? 'Ready — Find only. No Guide task is available yet; run supabase_v2_guide.sql, then scripts/migrate_guide_v2.mjs, then tag them in Admin → Guide tasks.'
      : (shortages.length ? `Ready, with gaps: ${shortages.join('; ')}.` : ''),
    !!shortages.length);
    // Also silent. How the queue is composed and which group a sitting lands in are the researcher's
    // business, and telling a participant that groups "alternate automatically" invites them to
    // wonder which one they got — see the Group chip in the task pane, which is where that belongs.
    count.textContent = '';
    start.disabled = false;
    start.onclick = beginStudy;
  }

  /**
   * Throw away the saved run and deal a fresh one under the current design.
   *
   * Deliberately a second, quieter control rather than a mode of the Start button: it destroys work,
   * and a participant who pressed the wrong one would lose their answers and be re-assigned a slot.
   * Only rendered when the saved run's design is not the one now set — see the note at the call.
   */
  function addDiscardButton() {
    const actions = document.querySelector('.welcome-actions');
    if (!actions || document.getElementById('v2-discard-saved')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'welcome-id-toggle';
    button.id = 'v2-discard-saved';
    button.textContent = 'Discard it and start a new run';
    button.onclick = () => {
      if (button.dataset.armed !== 'true') {
        // One confirmation, in the button itself: a window.confirm on the welcome screen is a modal a
        // participant can dismiss without reading, and this is not a participant's decision anyway.
        button.dataset.armed = 'true';
        button.textContent = 'Discard the saved answers — click again to confirm';
        return;
      }
      S.clearLocal();
      location.reload();
    };
    actions.appendChild(button);
  }

  async function beginStudy() {
    if (start.dataset.starting === 'true') return;
    start.dataset.starting = 'true';
    start.disabled = true;
    const entered = String(idInput?.value || '').trim();
    const participantId = entered || randomId();
    const dryRun = S.isDryRunId(participantId);
    say(dryRun ? 'Opening a test run — no session or answer will be saved…' : 'Creating your Find V2 session…');

    let assignment;
    try {
      assignment = dryRun
        ? {
            sessionId: null,
            assignmentIndex: S.dryRunSlot(participantId),
            assignmentSlot: S.dryRunSlot(participantId),
            conditionOrder: 'find_v2_test',
          }
        : await DB.claimStudyAssignment(participantId);
    } catch (error) {
      start.dataset.starting = '';
      start.disabled = false;
      say(`Could not start Find V2: ${error.message || error}`, true);
      return;
    }

    Object.assign(S.state, {
      participantId,
      sessionId: assignment.sessionId,
      runId: S.newRunId(),
      assignmentIndex: assignment.assignmentIndex,
      assignmentSlot: assignment.assignmentSlot,
      conditionOrder: assignment.conditionOrder,
      // The session-level arm is vestigial now that every task carries its own; kept so a resumed
      // session and an older row still read the same field.
      arm: 'grounding',
      group: groupOf(assignment.assignmentSlot),
      // `admin` walks the same queue a participant gets, with ← → and nothing recorded.
      previewNav: S.isPreviewId(participantId),
      queue: buildQueue(liveTasks, liveGuideTasks, assignment.assignmentSlot, currentDesign()),
      idx: 0,
      results: [],
      startedAt: Date.now(),
      dryRun,
      studyVersion: 'find-v2',
      // Snapshotted here, once. A switch flipped in Admin halfway through this
      // participant's queue must not change what task 4 asks compared with task 3.
      flags: { ...studyFlags },
    });
    S.saveLocal();
    location.href = 'study.html';
  }

  if (idToggle && idField) {
    idToggle.onclick = () => {
      idToggle.hidden = true;
      idField.hidden = false;
      idInput?.focus();
    };
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  const ADMIN_PASSWORD_KEY = 'pageguide_find_v2_admin_password';

  function rememberAdminPassword(password) {
    adminPassword = password;
    try { sessionStorage.setItem(ADMIN_PASSWORD_KEY, password); } catch (e) { /* tab memory only */ }
  }

  function forgetAdminPassword() {
    adminPassword = '';
    try { sessionStorage.removeItem(ADMIN_PASSWORD_KEY); } catch (e) { /* ignore */ }
  }

  function renderAdminLogin(message = '') {
    adminPanel.hidden = false;
    adminPanel.innerHTML = `
      <div class="admin-title">Find V2 Admin <span class="admin-warn">server-checked editor</span></div>
      <p class="viz-note">Use the password configured in the new Supabase project with
        <code>set_pageguide_find_v2_admin_password</code>. It stays in this tab only.</p>
      <label class="welcome-label" for="find-v2-admin-password">Admin password</label>
      <input class="welcome-input" id="find-v2-admin-password" type="password" autocomplete="current-password">
      <div class="welcome-status${message ? ' welcome-status-bad' : ''}" id="find-v2-admin-login-status">${esc(message)}</div>
      <div class="admin-row">
        <button class="welcome-btn" id="find-v2-admin-login">Open Admin</button>
        <button class="admin-chip" id="find-v2-admin-close">Cancel</button>
      </div>`;

    const field = document.getElementById('find-v2-admin-password');
    const submit = async () => {
      const password = String(field.value || '');
      const loginStatus = document.getElementById('find-v2-admin-login-status');
      if (!password) {
        loginStatus.textContent = 'Enter the Find V2 admin password.';
        loginStatus.className = 'welcome-status welcome-status-bad';
        return;
      }
      loginStatus.textContent = 'Checking…';
      loginStatus.className = 'welcome-status';
      try {
        await DB.checkAdmin(password);
      } catch (error) {
        loginStatus.textContent = error.message || String(error);
        loginStatus.className = 'welcome-status welcome-status-bad';
        return;
      }
      rememberAdminPassword(password);
      await openAdmin();
    };
    document.getElementById('find-v2-admin-login').onclick = submit;
    field.onkeydown = event => { if (event.key === 'Enter') submit(); };
    document.getElementById('find-v2-admin-close').onclick = () => {
      adminPanel.hidden = true;
      adminPanel.innerHTML = '';
    };
    field.focus();
  }

  async function openAdmin() {
    adminPanel.hidden = false;
    adminPanel.innerHTML = '<div class="viz-loading">Loading Find V2 Admin…</div>';
    try {
      adminClaims = await DB.listAllClaims();
    } catch (error) {
      renderAdminLogin(error.message || String(error));
      return;
    }
    renderAdminShell();
  }


  function renderAdminShell() {
    adminPanel.innerHTML = `
      <div class="admin-title">🔓 Find V2 Admin <span class="admin-warn">changes V2 only</span></div>
      <div class="admin-tabs">
        <button class="admin-tab${adminTab === 'claims' ? ' admin-tab-on' : ''}" data-v2-tab="claims">Edit claims</button>
        <button class="admin-tab${adminTab === 'results' ? ' admin-tab-on' : ''}" data-v2-tab="results">Results</button>
        <button class="admin-tab${adminTab === 'guide' ? ' admin-tab-on' : ''}" data-v2-tab="guide">Guide tasks</button>
        <button class="admin-tab${adminTab === 'preview' ? ' admin-tab-on' : ''}" data-v2-tab="preview">Session preview</button>
        <button class="admin-tab${adminTab === 'settings' ? ' admin-tab-on' : ''}" data-v2-tab="settings">Study settings</button>
      </div>
      <div id="find-v2-admin-content"></div>
      <div class="admin-row admin-exit-row">
        <button class="admin-exit" id="find-v2-admin-exit">Leave Admin</button>
        <!-- INSIDE the unlocked shell, not merely hidden on the welcome page. A hidden <a> is still
             in the participant's DOM with its href readable, so "hidden" was never the same thing as
             "behind Admin". Rendered here it does not exist until the password has been checked.
             NOTE: this controls discoverability, not access — find-v1.html is a static page with its
             own configuration and anyone typing the URL still reaches it. -->
        <a class="admin-door" id="find-v1-link" href="find-v1.html">Original V1 study →</a>
      </div>`;

    adminPanel.querySelectorAll('[data-v2-tab]').forEach(button => {
      button.onclick = () => {
        adminTab = button.dataset.v2Tab;
        renderAdminShell();
      };
    });
    document.getElementById('find-v2-admin-exit').onclick = () => {
      forgetAdminPassword();
      editingClaim = null;
      adminPanel.hidden = true;
      adminPanel.innerHTML = '';
    };
    if (adminTab === 'results') renderResults();
    else if (adminTab === 'settings') renderSettings();
    else if (adminTab === 'guide') renderGuideTasks();
    else if (adminTab === 'preview') renderSessionPreview();
    else renderClaims();
  }

  // ── Session preview ──────────────────────────────────────────────────────
  //
  // WHAT THE PARTICIPANT ACTUALLY SEES DURING A GUIDE TASK, rendered here rather than described.
  //
  // Every other tab in this panel shows the material as the researcher stores it — the answer as a
  // paragraph, the trail as a list, the journey as thumbnails. None of that is the stimulus. The
  // stimulus is a two-pane screen with the trail on top, the journey folded away beneath it, a
  // hover that produces a screenshot in one arm and nothing in the other, and a verdict that cannot
  // be answered for the first few seconds. Reviewing wording against the storage view is how a
  // condition gets shipped that reads differently from the one that was designed.
  //
  // So this mounts THE REAL RENDERER — app/stimulus.js, the same file study.html drives — against
  // the real published trajectory, in the real arm. The only facsimile is the question pane on the
  // right: it is inert markup with the study's own classes, because instrumenting it would start
  // clocks and offer a Submit that writes nothing, and a preview that pretends to be the task gets
  // reviewed as though it were one.
  let previewTasks = null;
  let previewRecords = new Map();   // id -> trajectory. Each is megabytes of base64; capped below.
  const PREVIEW_PREFS_KEY = 'pageguide_find_v2_preview_opts';

  function previewDefaults() {
    return {
      id: '',
      arm: 'grounding',
      trailFirst: true,
      journeyCollapsed: true,
      highlight: true,
    // WHAT IS ON THE PAGE AT ALL, as opposed to how it is arranged. The live study shows all four;
    // this tab starts with the REASONING TRAIL OFF so the page a participant would face without the
    // agent's own account of itself can be looked at first, and the trail added back deliberately.
    // Every switch here is a change to the stimulus, which is why they are their own group and not
    // mixed in with the layout ones.
      sections: { states: true, journey: true, answer: true, trail: false },
    };
  }

  /**
   * The saved preview settings, or the defaults.
   *
   * LOCAL TO THIS BROWSER, AND ONLY THIS TAB. It is a researcher's bookmark for how they like to
   * look at the stimulus — it does not touch the study, and a participant's session is unaffected by
   * anything saved here. The study's own switches live in Study settings and are written to the
   * database, which is the difference between a preference and a condition.
   */
  function loadPreviewOpts() {
    const base = previewDefaults();
    let saved;
    try { saved = JSON.parse(localStorage.getItem(PREVIEW_PREFS_KEY) || 'null'); }
    catch (e) { saved = null; }   // private mode, or a half-written value: fall back, never throw
    if (!saved || typeof saved !== 'object') return base;
    return {
      ...base,
      ...saved,
      // Merged rather than replaced, so a settings blob saved before a section existed does not
      // arrive with that section undefined and drop it from the page.
      sections: { ...base.sections, ...(saved.sections || {}) },
    };
  }

  let previewOpts = loadPreviewOpts();

  const PREVIEW_SECTIONS = [
    { key: 'states', label: 'Page before / after', note: 'the two state shots, shown in both arms' },
    { key: 'journey', label: 'View Journey', note: 'every action, in order' },
    { key: 'answer', label: 'Agent answer', note: 'the claim being judged' },
    { key: 'trail', label: 'Reasoning trail', note: 'the agent’s own account — off until you add it' },
  ];

  const PREVIEW_STAGES = [
    {
      pane: 'right', name: 'Condition and group',
      body: 'Named out loud before anything else. The banner says which arm this task is in and what '
        + 'is different about it; the chip says which counterbalancing half the sitting is in. A '
        + 'participant who is not told reads a missing screenshot as a broken page.',
    },
    {
      pane: 'right', name: 'The task the agent was given',
      body: 'The goal, with the countdown beside it. This is the only statement of what the agent was '
        + 'supposed to do — everything on the left is what it did instead.',
    },
    {
      pane: 'left', name: 'Page state · before and after',
      body: 'Shown in BOTH arms. The arms differ in whether each action can be checked, not in '
        + 'whether the outcome is known.',
    },
    {
      pane: 'left', name: 'Reasoning trail',
      body: 'The agent’s own account, written after the run, naming the steps it treated as '
        + 'milestones — some of the journey, not all of it. Deliberately neutral: no status flags, '
        + 'or it would answer the question for them.',
    },
    {
      pane: 'left', name: 'Agent answer',
      body: 'The claim being judged. In the grounded arm it carries numbered chips and underlined '
        + 'phrases that resolve to what the agent saw; in the non-grounded arm it is plain prose.',
    },
    {
      pane: 'left', name: 'View Journey',
      body: 'Every action, in order, folded shut so the trail is read first. Opening it is a '
        + 'deliberate act and one of the few navigation events worth measuring. Grounded: hover a row '
        + 'for the page the agent was looking at, click for full size. Non-grounded: text, and '
        + 'nothing to hover.',
    },
    {
      pane: 'right', name: 'The verdict',
      body: 'One question — did the agent complete the task — locked for the first few seconds so it '
        + 'cannot be answered before the material has been looked at, and force-submitted at the '
        + 'task limit.',
    },
    {
      pane: 'right', name: 'Follow-up',
      body: 'Confidence and helpfulness, asked only when the study settings collect them.',
    },
  ];

  function previewFlowHtml() {
    return `
      <details class="welcome-fold preview-flow">
        <summary><strong>How a participant moves through a Guide task</strong> — the eight moments, in order</summary>
        <div class="welcome-fold-body">
          <ol class="preview-stages">
            ${PREVIEW_STAGES.map((stage, i) => `
              <li class="preview-stage is-${stage.pane}">
                <span class="preview-stage-n">${i + 1}</span>
                <div>
                  <b>${esc(stage.name)}</b>
                  <span class="preview-stage-pane">${stage.pane === 'left' ? 'left pane · the material' : 'right pane · the instrument'}</span>
                  <p>${esc(stage.body)}</p>
                </div>
              </li>`).join('')}
          </ol>
          <p class="viz-note"><b>The gestures</b>, all of them grounded-arm only except the last:
            hover a journey row → the page at that step · click a row → full-size · hover a numbered
            chip in the answer → the evidence behind that clause · hover a trail milestone → its step’s
            picture · <b>ⓘ</b> beside any section heading → what that section is, in both arms.</p>
        </div>
      </details>`;
  }

  /** The task picker, the arm switch and the three layout switches. */
  function previewControlsHtml(tasks) {
    const opt = (task) => `
      <option value="${esc(task.id)}"${task.id === previewOpts.id ? ' selected' : ''}>
        ${task.task_style === 'guide_visual' ? 'B · visual' : 'A · text'} —
        ${esc(task.goal || task.title || task.id)}
        ${task.agent_completed === true ? '— keyed CORRECT' : task.agent_completed === false ? '— keyed INCORRECT' : ''}
      </option>`;
    return `
      <div class="preview-controls">
        <label class="preview-field">
          <span class="welcome-label">Guide task</span>
          <select class="welcome-input" id="preview-task">${tasks.map(opt).join('')}</select>
        </label>
        <div class="preview-field">
          <span class="welcome-label">Arm</span>
          <div class="preview-chips">
            <button class="admin-chip${previewOpts.arm === 'grounding' ? ' admin-chip-on' : ''}" data-preview-arm="grounding">Grounded</button>
            <button class="admin-chip${previewOpts.arm === 'nongrounding' ? ' admin-chip-on' : ''}" data-preview-arm="nongrounding">Non-grounded</button>
          </div>
        </div>
        <div class="preview-field preview-field-wide">
          <span class="welcome-label">Include on the page</span>
          <div class="preview-chips">
            ${PREVIEW_SECTIONS.map(section => `
              <label class="preview-toggle preview-section${previewOpts.sections[section.key] ? ' is-in' : ''}"
                title="${esc(section.note)}">
                <input type="checkbox" data-preview-section="${section.key}"${previewOpts.sections[section.key] ? ' checked' : ''}>
                ${esc(section.label)}</label>`).join('')}
          </div>
        </div>
        <div class="preview-field">
          <span class="welcome-label">Layout</span>
          <div class="preview-chips">
            <label class="preview-toggle"><input type="checkbox" data-preview-flag="trailFirst"${previewOpts.trailFirst ? ' checked' : ''}> Trail first</label>
            <label class="preview-toggle"><input type="checkbox" data-preview-flag="journeyCollapsed"${previewOpts.journeyCollapsed ? ' checked' : ''}> Journey folded</label>
            <label class="preview-toggle is-proposal"><input type="checkbox" data-preview-flag="highlight"${previewOpts.highlight ? ' checked' : ''}> Flag the trail’s steps in the journey</label>
          </div>
        </div>
        <div class="preview-field preview-save">
          <span class="welcome-label">These settings</span>
          <div class="preview-chips">
            <button class="admin-chip" id="preview-save">Save as my default</button>
            <button class="admin-chip" id="preview-reset">Reset</button>
            <span class="welcome-status" id="preview-save-status"></span>
          </div>
        </div>
      </div>
      <p class="viz-note"><b>Include</b> decides what is on the page at all — each box is a different
        stimulus, not a different view of one. The live study shows all four; the <b>reasoning trail
        starts unticked here</b>, so the screen can be read first without the agent’s account of
        itself and the trail added back deliberately. Dropping the answer leaves nothing to judge,
        which is worth seeing once. <b>Layout</b> only rearranges what is included — trail first and
        journey folded are what the live study ships.</p>
      <p class="viz-note"><b>Flag the trail’s steps</b> is on by default in this tab and <b>off in the
        live study</b>: it marks the journey rows the reasoning trail accounts for as
        <b>important milestone</b>. Before turning it on for participants, note that it is a second
        manipulation stacked on grounding, and that it points at the steps the agent chose to
        narrate — which, for a run that misreports what it saw, is exactly where the discrepancy is
        not. It still draws with the trail switched off, worded as the agent’s milestones rather than
        as the trail’s.</p>
      <p class="viz-note"><b>Save as my default</b> keeps this arrangement in this browser for the
        next time the tab is opened. It is a bookmark for looking at the stimulus and changes nothing
        a participant sees — the study’s own switches are in <b>Study settings</b>.</p>`;
  }

  /** The right pane, as inert markup. Same classes as the live instrument, no clocks, no submit. */
  function previewQuestionPaneHtml(task) {
    const arm = previewOpts.arm;
    const group = task?.task_style === 'guide_visual' ? 'B' : 'A';
    const limit = Number(studyFlags.taskLimitSeconds) || 120;
    const mmss = `${String(Math.floor(limit / 60)).padStart(2, '0')}:${String(limit % 60).padStart(2, '0')}`;
    const copy = arm === 'nongrounding'
      ? { label: 'Non-grounded', note: 'no screenshots, and no evidence behind the answer' }
      : { label: 'Grounded', note: 'each step can be checked against the page' };
    return `
      <div class="q-head"><span class="q-title">📘 Review the task</span></div>
      <div class="q-progress">Task 4/4</div>
      <div class="q-body">
        <div class="q-task-card">
          <div class="q-timers">
            <div class="q-timer-chip">
              <span class="q-timer-label">Time left</span>
              <span class="q-timer">${esc(mmss)}</span>
            </div>
          </div>
          <div class="q-task-label">The task the agent was given</div>
          ${esc(task?.goal || task?.title || '')}
        </div>
        <div class="tv-condition ${arm === 'nongrounding' ? 'is-nongrounded' : 'is-grounded'}">
          <span class="tv-condition-badge"><span class="tv-condition-dot" aria-hidden="true"></span>${esc(copy.label)}</span>
          <span class="tv-condition-note">${esc(copy.note)}</span>
        </div>
        <div class="tv-group">
          <span class="tv-group-badge">Group ${group}</span>
          <span class="tv-group-note">${group === 'B' ? 'visual' : 'text'}</span>
        </div>
        <div class="q-card">
          <div class="q-card-head"><span class="q-badge">Q1</span>
            <p class="q-text">Did the agent successfully complete the task?</p></div>
          <p class="q-sub q-answer-lock">Read the question and the agent’s answer first — you can respond in <b>5</b>s.</p>
          <div class="q-options is-locked">
            <label class="q-opt q-opt-rich"><input type="radio" disabled>
              <span><b>Yes</b><small>It did the whole job, and its answer matches what it actually did.</small></span></label>
            <label class="q-opt q-opt-rich"><input type="radio" disabled>
              <span><b>No</b><small>It did not finish the job, <b>or</b> its answer claims something that did not happen.</small></span></label>
          </div>
        </div>
        <div class="q-actions"><button class="q-btn q-btn-primary" disabled>Submit →</button></div>
        <p class="viz-note preview-inert">Inert on purpose — no clock runs and nothing is recorded.
          The left pane is the real renderer against the real trajectory.</p>
      </div>`;
  }

  /** Fetch a trajectory once and keep at most two: `arms` is base64 screenshots and runs to megabytes. */
  async function previewRecord(id) {
    if (previewRecords.has(id)) return previewRecords.get(id);
    const record = await DB.getGuideTrajectory(id);
    if (previewRecords.size >= 2) previewRecords = new Map();
    previewRecords.set(id, record);
    return record;
  }

  async function paintPreview() {
    const stage = document.getElementById('preview-stage');
    const panel = document.getElementById('preview-question');
    if (!stage || !panel) return;
    const task = (previewTasks || []).find(t => t.id === previewOpts.id);
    panel.innerHTML = previewQuestionPaneHtml(task);
    stage.innerHTML = '<div class="tv-empty">Loading the trajectory…</div>';
    let record;
    try { record = await previewRecord(previewOpts.id); }
    catch (error) {
      stage.innerHTML = `<div class="tv-empty">${esc(error.message || String(error))}</div>`;
      return;
    }
    // Re-read the stage: an await means the tab may have been left and re-rendered under us.
    const live = document.getElementById('preview-stage');
    if (!live) return;
    window.Stimulus.mountStimulus(record, previewOpts.arm, {
      goal: document.createElement('h1'),
      count: document.createElement('div'),
      stage: live,
    }, {
      trailFirst: previewOpts.trailFirst,
      journeyCollapsed: previewOpts.journeyCollapsed,
      highlightMilestones: previewOpts.highlight,
      sections: previewOpts.sections,
    });

    // SAY WHICH ONE IS ON SCREEN. Most tasks carry only a recorded grounded arm, and the
    // non-grounded one is derived at render by _stripGuideArm — the same rule the extension applies,
    // and the definition of the arm rather than a substitute for it. A researcher reading the left
    // pane should know whether they are looking at authored material or at the strip of it.
    const derived = previewOpts.arm === 'nongrounding' && !record?.arms?.nongrounding;
    const label = document.getElementById('preview-source');
    if (label) {
      label.textContent = derived
        ? 'Non-grounded arm derived from the recorded grounded one — steps as text, no screenshots, no evidence.'
        : `Recorded ${previewOpts.arm === 'nongrounding' ? 'non-grounded' : 'grounded'} arm, as published.`;
      label.className = `viz-note preview-source${derived ? ' is-derived' : ''}`;
    }
  }

  async function renderSessionPreview() {
    const content = document.getElementById('find-v2-admin-content');

    // The renderer is the point of this tab; without it the tab would draw a mock-up, which is the
    // one thing it exists not to do.
    if (!window.Stimulus?.mountStimulus) {
      content.innerHTML = `<p class="welcome-status welcome-status-bad">The trajectory viewer is not
        loaded. index.html must include <code>styles/stimulus.css</code> and
        <code>app/stimulus.js</code> for this tab to show the real participant view.</p>`;
      return;
    }

    content.innerHTML = '<div class="viz-loading">Loading the Guide tasks…</div>';
    if (!previewTasks) {
      try { previewTasks = (await DB.listAllGuideTasks()).filter(row => row.in_study); }
      catch (error) {
        previewTasks = null;
        content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
        return;
      }
    }

    if (!previewTasks.length) {
      content.innerHTML = `<p class="viz-note">No Guide task is in the study yet, so there is nothing
        a participant would see. Tag one in <b>Guide tasks</b> first.</p>`;
      return;
    }

    if (!previewTasks.some(task => task.id === previewOpts.id)) previewOpts.id = previewTasks[0].id;

    content.innerHTML = `
      <p class="viz-note">The Guide task as a participant meets it: the real left pane, rendered by
        the same <code>app/stimulus.js</code> the study runs, against the published trajectory in the
        arm you pick. The right pane is a still of the instrument.</p>
      ${previewFlowHtml()}
      ${previewControlsHtml(previewTasks)}
      <p class="viz-note preview-source" id="preview-source"></p>
      <div class="preview-frame">
        <div class="preview-pane-label">Left pane — the material</div>
        <div class="preview-pane-label">Right pane — the instrument</div>
        <section class="preview-stimulus"><main class="tv-main">
          <section class="tv-stage" id="preview-stage"></section>
        </main></section>
        <aside class="preview-question task-panel" id="preview-question"></aside>
      </div>`;

    content.querySelector('#preview-task').onchange = (e) => {
      previewOpts.id = e.target.value;
      void paintPreview();
    };
    content.querySelectorAll('[data-preview-arm]').forEach(button => {
      button.onclick = () => {
        previewOpts.arm = button.dataset.previewArm;
        renderSessionPreview();
      };
    });
    // A full re-render, not a repaint: the checkbox's own on/off styling lives in the markup, and
    // the flag legend's wording depends on whether the trail is on the page.
    const saveStatus = content.querySelector('#preview-save-status');
    content.querySelector('#preview-save').onclick = () => {
      try {
        localStorage.setItem(PREVIEW_PREFS_KEY, JSON.stringify(previewOpts));
        saveStatus.textContent = 'Saved for this browser.';
        saveStatus.className = 'welcome-status';
      } catch (error) {
        saveStatus.textContent = `Could not save: ${error.message || error}`;
        saveStatus.className = 'welcome-status welcome-status-bad';
      }
    };
    content.querySelector('#preview-reset').onclick = () => {
      try { localStorage.removeItem(PREVIEW_PREFS_KEY); } catch (e) { /* nothing to clear */ }
      const id = previewOpts.id;
      previewOpts = previewDefaults();
      previewOpts.id = id;          // the task on screen is not one of the settings being reset
      renderSessionPreview();
    };

    content.querySelectorAll('[data-preview-section]').forEach(box => {
      box.onchange = () => {
        previewOpts.sections[box.dataset.previewSection] = box.checked;
        renderSessionPreview();
      };
    });
    content.querySelectorAll('[data-preview-flag]').forEach(box => {
      box.onchange = () => {
        previewOpts[box.dataset.previewFlag] = box.checked;
        void paintPreview();
      };
    });

    await paintPreview();
  }

  function blankVariants() {
    const out = {};
    V.KEYS.forEach(key => { out[key] = { answer_text: '', citation_anchors: [], evidence: [] }; });
    return out;
  }

  function blankClaim() {
    return {
      id: '', source_task_id: '', title: '', url: '', task_style: 'find_text', question: '',
      answer_variants: blankVariants(), correctness_mode: 'balanced',
      answer_text: '', claim_correct: true, evidence: [], citation_anchors: [],
      evidence_ground_truth: {}, page_title: '', page_html: '', page_bytes: 0,
      in_study: false, task_index: adminClaims.length,
    };
  }

  /** The cells this claim still needs before it can go live under its mode. */
  function missingVariants(row) {
    const mode = V.correctnessMode(row.correctness_mode);
    const needed = mode === 'always_correct'
      ? ['correct_grounding', 'correct_nongrounding']
      : mode === 'always_incorrect'
        ? ['incorrect_grounding', 'incorrect_nongrounding']
        : V.KEYS;
    return needed.filter(key => !V.variantOf(row, key).answer_text);
  }

  function claimOption(row) {
    const filled = V.KEYS.filter(key => V.variantOf(row, key).answer_text).length;
    const mode = V.correctnessMode(row.correctness_mode);
    const pin = mode === 'always_correct' ? '✓ always correct'
      : mode === 'always_incorrect' ? '✕ always incorrect'
      : 'both keys';
    const pool = row.in_study ? '● live' : '○ held out';
    return `${pool} · ${filled}/4 answers · ${pin} · ${row.id} — ${String(row.question || row.title || '').slice(0, 45)}`;
  }

  function renderClaims(message = '', bad = false) {
    const content = document.getElementById('find-v2-admin-content');
    const live = adminClaims.filter(row => row.in_study).length;
    const ready = adminClaims.filter(row => !missingVariants(row).length).length;
    const selected = editingClaim?.id || '';
    content.innerHTML = `
      <p class="viz-note"><b>${adminClaims.length}</b> claim${adminClaims.length === 1 ? '' : 's'} ·
        <b>${live}</b> live · <b>${ready}</b> fully authored. Each row is one question, with a
        correct and an incorrect agent answer written for both the grounded and the non-grounded arm.
        Which of the four a participant sees is counterbalanced from their assignment slot.</p>
      <div class="find-v2-editor-picker">
        <label class="welcome-label" for="find-v2-claim-pick">Claim</label>
        <select class="welcome-input" id="find-v2-claim-pick">
          <option value="">Choose a claim…</option>
          ${adminClaims.map(row => `<option value="${esc(row.id)}"${row.id === selected ? ' selected' : ''}>${esc(claimOption(row))}</option>`).join('')}
        </select>
        <button class="admin-chip" id="find-v2-new-claim">＋ New claim</button>
      </div>
      <div id="find-v2-claim-editor">${editingClaim ? claimEditorHtml(editingClaim) : ''}</div>
      <div class="welcome-status${bad ? ' welcome-status-bad' : ''}" id="find-v2-claim-status">${esc(message)}</div>`;

    document.getElementById('find-v2-claim-pick').onchange = async event => {
      const id = event.target.value;
      editingClaim = null;
      if (!id) return renderClaims();
      document.getElementById('find-v2-claim-editor').innerHTML = '<div class="viz-loading">Loading the claim and page…</div>';
      try {
        editingClaim = await DB.getClaim(id);
      } catch (error) {
        return renderClaims(error.message || String(error), true);
      }
      renderClaims();
    };
    document.getElementById('find-v2-new-claim').onclick = () => {
      editingClaim = blankClaim();
      renderClaims('New claims start held out. Save them before marking them live.');
    };
    bindClaimEditor();
  }

  function prettyJSON(value, fallback) {
    try { return JSON.stringify(value ?? fallback, null, 2); } catch (e) { return JSON.stringify(fallback, null, 2); }
  }

  /**
   * One authored answer, with its own references.
   *
   * Deliberately four separate editors rather than one answer plus a "strip the
   * citations" switch: the non-grounded answer is written prose, not the
   * grounded answer with brackets removed, and the incorrect answer has to be
   * plausible on its own terms. The panes are tabbed because only one is being
   * written at a time, and the tab strip is where the authoring gaps show.
   */
  function variantPaneHtml(row, key) {
    const variant = V.variantOf(row, key);
    const grounded = key.endsWith('_grounding');
    return `
      <div class="find-v2-variant-pane" data-variant-pane="${key}"${key === variantTab ? '' : ' hidden'}>
        <p class="viz-note">${grounded
          ? 'Grounded arm — keep the citation markers <code>[368:&quot;exact quote&quot;]</code> and '
            + '<code>[ev:image-key]</code>. They become the clickable references beside the answer.'
          : 'Non-grounded arm — write this as the agent would state it with no references. Any '
            + 'citation marker left here is stripped before the participant sees it.'}
          ${key.startsWith('incorrect_')
            ? '<b>This answer must be wrong</b>, and wrong in a way a careful reader can catch on the page.'
            : 'This answer must be correct on the page.'}</p>
        <label class="welcome-label" for="v2-answer-${key}">Agent answer — ${esc(V.LABELS[key])}</label>
        <textarea class="welcome-input find-v2-answer-editor" id="v2-answer-${key}" rows="9"
          placeholder="What the agent replied.">${esc(variant.answer_text)}</textarea>
        ${grounded ? `<div class="admin-row">
          <button class="admin-chip" data-fix-refs="${key}"${row.id ? '' : ' disabled'}>🔗 Check &amp; fix references in the page</button>
          <span class="q-sub">${row.id
            ? 'Opens this claim on the task screen, where you can click the page to re-link a reference.'
            : 'Save the claim first.'}</span>
        </div>` : ''}
        <div class="v2-preview" data-preview-for="${key}">
          <div class="v2-preview-head">As the participant sees it
            <span class="v2-chip ${grounded ? 'is-grounded' : 'is-nongrounded'}">${grounded ? 'Grounded' : 'Non-grounded'}</span>
            <span class="v2-chip ${key.startsWith('correct_') ? 'is-correct' : 'is-incorrect'}">${key.startsWith('correct_') ? 'Correct' : 'Incorrect'}</span>
          </div>
          <div class="v2-preview-body" data-preview-body="${key}"></div>
          <div class="v2-preview-warn" data-preview-warn="${key}" hidden></div>
        </div>
        <details class="welcome-fold find-v2-advanced">
          <summary><strong>References for this answer</strong> — JSON</summary>
          <div class="welcome-fold-body">
            <label class="welcome-label" for="v2-anchors-${key}">Citation anchors</label>
            <textarea class="welcome-input v2-json" id="v2-anchors-${key}" rows="5">${esc(prettyJSON(variant.citation_anchors, []))}</textarea>
            <label class="welcome-label" for="v2-evidence-${key}">Saved visual evidence</label>
            <textarea class="welcome-input v2-json" id="v2-evidence-${key}" rows="5">${esc(prettyJSON(variant.evidence, []))}</textarea>
          </div>
        </details>
      </div>`;
  }

  /**
   * What this variant will actually look like to a participant, under the box it is typed in.
   *
   * It calls the PLAYER'S renderer (window.FindCitations.renderAnswer), not a copy of it. A preview
   * built from a second implementation previews the wrong thing, which is how a malformed marker
   * reached a live answer: the grounded arm showed the raw bracket as prose and nothing here said
   * so. Because the renderer is shared, the marker shapes it tolerates and the wreckage it removes
   * are the same in both places by construction.
   *
   * The warning is the other half. An artifact is REMOVED from what the participant sees — showing
   * somebody "[765: Oxford" is worse than showing nothing — but removing it quietly would hide a
   * mistake that belongs back in the text, so it is named here, beside the box that can fix it.
   */
  function paintVariantPreview(key, text) {
    const body = adminPanel.querySelector(`[data-preview-body="${key}"]`);
    const warn = adminPanel.querySelector(`[data-preview-warn="${key}"]`);
    if (!body) return;
    const arm = key.endsWith('_nongrounding') ? 'nongrounding' : 'grounding';
    const value = String(text || '').trim();

    body.innerHTML = value
      ? window.FindCitations.renderAnswer(value, arm)
      : '<em class="q-sub">Nothing written for this variant yet.</em>';

    const found = window.FindCitations.artifacts(value);
    if (warn) {
      warn.hidden = !found.length;
      warn.innerHTML = found.length
        ? `<b>${found.length} broken citation marker${found.length === 1 ? '' : 's'}</b> — removed from
           what the participant sees, but worth fixing here. A marker must read
           <code>[368:"exact quote"]</code>; these do not:
           <ul>${found.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
        : '';
    }
  }

  function claimEditorHtml(row) {
    const pageBytes = Number(row.page_bytes) || new Blob([row.page_html || '']).size;
    const mode = V.correctnessMode(row.correctness_mode);
    const gaps = missingVariants(row);
    return `
      <div class="edit-head find-v2-edit-head">
        <div>
          <b>${row.id ? esc(row.id) : 'New claim'}</b>
          <span class="find-v2-truth-badge ${gaps.length ? 'is-incorrect' : 'is-correct'}">
            ${gaps.length ? `${gaps.length} answer${gaps.length === 1 ? '' : 's'} still to write` : 'All required answers written'}
          </span>
        </div>
        <label class="edit-live"><input type="checkbox" id="v2-in-study"${row.in_study ? ' checked' : ''}>
          Use in Find V2</label>
      </div>

      <div class="find-v2-form-grid">
        <label><span class="welcome-label">Claim id</span>
          <input class="welcome-input" id="v2-id" value="${esc(row.id || '')}"${row.id ? ' readonly' : ''}
            placeholder="e.g. MUFC-V2-01"></label>
        <label><span class="welcome-label">Source task id <span class="q-sub">optional</span></span>
          <input class="welcome-input" id="v2-source-id" value="${esc(row.source_task_id || '')}"></label>
        <label><span class="welcome-label">Task style</span>
          <select class="welcome-input" id="v2-style">
            <option value="find_text"${row.task_style === 'find_text' ? ' selected' : ''}>Find × Text</option>
            <option value="find_visual"${row.task_style === 'find_visual' ? ' selected' : ''}>Find × Visual</option>
          </select></label>
        <label><span class="welcome-label">Queue order</span>
          <input class="welcome-input" id="v2-index" type="number" value="${esc(row.task_index ?? 0)}"></label>
      </div>

      <label class="welcome-label" for="v2-title">Title</label>
      <input class="welcome-input" id="v2-title" value="${esc(row.title || '')}">
      <label class="welcome-label" for="v2-url">Page URL</label>
      <input class="welcome-input" id="v2-url" value="${esc(row.url || '')}">
      <label class="welcome-label" for="v2-question">Question shown to the participant</label>
      <textarea class="welcome-input" id="v2-question" rows="3">${esc(row.question || '')}</textarea>

      <fieldset class="find-v2-verdict-key">
        <legend class="welcome-label">How should this claim's answer key be dealt?</legend>
        <label class="q-opt"><input type="radio" name="v2-mode" value="balanced"${mode === 'balanced' ? ' checked' : ''}>
          <span><b>Counterbalanced</b><small>Some participants see the correct answer, some the
            incorrect one. Needs all four answers written.</small></span></label>
        <label class="q-opt"><input type="radio" name="v2-mode" value="always_correct"${mode === 'always_correct' ? ' checked' : ''}>
          <span><b>Always correct</b><small>Every participant sees a correct answer; the scored
            response is always Yes. Needs the two correct answers only.</small></span></label>
        <label class="q-opt"><input type="radio" name="v2-mode" value="always_incorrect"${mode === 'always_incorrect' ? ' checked' : ''}>
          <span><b>Always incorrect</b><small>Every participant sees a wrong answer; the scored
            response is always No. Needs the two incorrect answers only.</small></span></label>
      </fieldset>

      <div class="find-v2-variant-tabs">
        ${V.KEYS.map(key => {
          const written = !!V.variantOf(row, key).answer_text;
          return `<button type="button" class="admin-tab${key === variantTab ? ' admin-tab-on' : ''}${written ? '' : ' is-blank'}"
            data-variant-tab="${key}">${written ? '●' : '○'} ${esc(V.LABELS[key])}</button>`;
        }).join('')}
      </div>
      <div class="find-v2-variant-panes">${V.KEYS.map(key => variantPaneHtml(row, key)).join('')}</div>
      ${gaps.length ? `<p class="welcome-status welcome-status-bad">Still to write before this claim
        can go live: ${gaps.map(key => esc(V.LABELS[key])).join(', ')}.</p>` : ''}

      <div class="find-v2-page-upload">
        <label class="welcome-label" for="v2-page-file">Captured page HTML</label>
        <input id="v2-page-file" type="file" accept=".html,.htm,text/html">
        <span id="v2-page-size">${pageBytes ? `${Math.round(pageBytes / 1024).toLocaleString()} KB loaded` : 'No page loaded'}</span>
      </div>
      <label class="welcome-label" for="v2-page-title">Captured page title <span class="q-sub">optional</span></label>
      <input class="welcome-input" id="v2-page-title" value="${esc(row.page_title || '')}">

      <details class="welcome-fold find-v2-advanced">
        <summary><strong>Evidence ground truth</strong> — JSON, shared by all four answers</summary>
        <div class="welcome-fold-body">
          <p class="viz-note">Where the supporting passage or image actually is on the page. It does
            not change with the answer shown, so the evidence question is scored the same way in
            every cell.</p>
          <textarea class="welcome-input v2-json" id="v2-ground-truth" rows="7">${esc(prettyJSON(row.evidence_ground_truth, {}))}</textarea>
        </div>
      </details>

      <div class="admin-row">
        <button class="welcome-btn" id="v2-save-claim">Save claim</button>
        ${row.id ? '<button class="admin-chip" id="v2-duplicate-claim">Duplicate as a new claim</button>' : ''}
        <button class="admin-chip" id="v2-revert-claim">Undo unsaved edits</button>
      </div>`;
  }

  function parseJSONField(id, expected, label) {
    const field = document.getElementById(id);
    const name = label || id.replace('v2-', '').replaceAll('-', ' ');
    const raw = String(field?.value || '').trim();
    let value;
    try { value = raw ? JSON.parse(raw) : expected === 'array' ? [] : {}; }
    catch (error) { throw new Error(`${name} is not valid JSON: ${error.message}`); }
    if (expected === 'array' && !Array.isArray(value)) throw new Error(`${name} must be a JSON array.`);
    if (expected === 'object' && (!value || Array.isArray(value) || typeof value !== 'object')) {
      throw new Error(`${name} must be a JSON object.`);
    }
    return value;
  }

  function readClaimForm() {
    const value = id => String(document.getElementById(id)?.value || '').trim();
    const mode = document.querySelector('input[name="v2-mode"]:checked')?.value;
    if (mode == null) throw new Error('Choose how this claim\'s answer key should be dealt.');

    // Every pane is read, not just the visible one: the hidden panes still hold
    // their values, and a variant dropped because its tab was not open would be
    // silently lost on save.
    const answer_variants = {};
    V.KEYS.forEach(key => {
      answer_variants[key] = {
        answer_text: value(`v2-answer-${key}`),
        citation_anchors: parseJSONField(`v2-anchors-${key}`, 'array', `${V.LABELS[key]} citation anchors`),
        evidence: parseJSONField(`v2-evidence-${key}`, 'array', `${V.LABELS[key]} visual evidence`),
      };
    });

    return {
      id: value('v2-id'),
      source_task_id: value('v2-source-id') || null,
      title: value('v2-title') || null,
      url: value('v2-url'),
      task_style: value('v2-style'),
      question: value('v2-question'),
      answer_variants,
      correctness_mode: mode,
      evidence_ground_truth: parseJSONField('v2-ground-truth', 'object', 'evidence ground truth'),
      page_title: value('v2-page-title') || null,
      page_html: editingClaim?.page_html || '',
      in_study: !!document.getElementById('v2-in-study')?.checked,
      task_index: Number(value('v2-index')) || 0,
    };
  }

  function claimProblem(draft) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(draft.id)) {
      return 'Claim id must be 2–80 characters using letters, numbers, dot, dash, or underscore.';
    }
    if (!draft.question) return 'The participant question is blank.';
    if (!V.KEYS.some(key => draft.answer_variants[key].answer_text)) {
      return 'Write at least one agent answer before saving.';
    }
    if (draft.in_study && !draft.url) return 'A live claim needs a page URL.';
    if (draft.in_study && !draft.page_html) return 'A live claim needs captured page HTML.';
    // Only blocks going live. A partially written claim saves fine while held
    // out, which is how a claim gets authored one cell at a time.
    const gaps = draft.in_study ? missingVariants(draft) : [];
    if (gaps.length) {
      return `A live claim needs every answer it can be dealt. Still blank: `
        + `${gaps.map(key => V.LABELS[key]).join(', ')}.`;
    }
    return '';
  }

  function bindClaimEditor() {
    if (!editingClaim) return;

    // Switching tabs only toggles visibility. Re-rendering here would read the
    // saved row again and throw away whatever is typed in the other three panes.
    adminPanel.querySelectorAll('[data-variant-tab]').forEach(button => {
      button.onclick = () => {
        variantTab = button.dataset.variantTab;
        adminPanel.querySelectorAll('[data-variant-tab]').forEach(other => {
          other.classList.toggle('admin-tab-on', other.dataset.variantTab === variantTab);
        });
        adminPanel.querySelectorAll('[data-variant-pane]').forEach(pane => {
          pane.hidden = pane.dataset.variantPane !== variantTab;
        });
      };
    });

    // The tab dot is the only place an unwritten answer shows once its pane is
    // hidden, so it tracks typing rather than waiting for a save.
    V.KEYS.forEach(key => {
      const box = document.getElementById(`v2-answer-${key}`);
      const tab = adminPanel.querySelector(`[data-variant-tab="${key}"]`);
      if (!box || !tab) return;
      box.oninput = () => {
        const written = !!box.value.trim();
        tab.classList.toggle('is-blank', !written);
        tab.textContent = `${written ? '●' : '○'} ${V.LABELS[key]}`;
        paintVariantPreview(key, box.value);
      };
      paintVariantPreview(key, box.value);
    });

    // Re-linking a reference means clicking the real page, and the page only exists on the task
    // screen. So this hands the claim over to it in review mode rather than trying to embed a second
    // snapshot viewer in the admin panel.
    adminPanel.querySelectorAll('[data-fix-refs]').forEach(button => {
      button.onclick = () => {
        const key = button.dataset.fixRefs;
        const row = editingClaim;
        if (!row?.id) return;
        const dealt = V.parseKey(key);
        const entry = (claim) => ({
          id: claim.id,
          taskType: 'find',
          studyVersion: 'find-v2',
          title: claim.title || '',
          url: claim.url || '',
          type: claim.task_style === 'find_text' ? 'FIND × TEXT' : 'FIND × VISUAL',
          question: claim.question || '',
          style: claim.task_style,
          arm: dealt.condition,
          claimCorrect: dealt.correct,
          variantKey: key,
          // What adminTaskLabel prints HELD OUT from, and what adminNavHtml warns on.
          inStudy: claim.in_study === true,
          answer: '',
          distractors: [],
        });

        // THE WHOLE STUDY SET, not just the claim that was clicked.
        //
        // This used to queue one claim, so "Next" had nowhere to go and the jump list had a single
        // entry — which made a screen built for walking a set behave like a dead end. Checking
        // references is work you do across the set: a snapshot is re-captured or an answer re-worded
        // and several claims need re-linking, and going back to Admin between each one reloads the
        // panel and loses your place.
        //
        // LIVE CLAIMS ONLY, in the order participants meet them, because those are the ones whose
        // references a participant will actually be shown. A held-out claim's links can be fixed
        // when it goes live.
        const live = adminClaims
          .filter(claim => claim.in_study && claim.id)
          .sort((a, b) => (Number(a.task_index) || 0) - (Number(b.task_index) || 0)
            || String(a.id).localeCompare(String(b.id)));
        const queue = live.map(entry);

        // The clicked claim is always reachable, even held out — it is the one the researcher asked
        // for, and dropping it because it is not live would answer a different request than the one
        // the button made. It goes first so review opens where it was opened from.
        let at = queue.findIndex(task => task.id === row.id);
        if (at < 0) { queue.unshift(entry(row)); at = 0; }

        S.state.participantId = 'admin-review';
        S.state.variantKey = key;
        S.state.adminReview = true;
        S.state.idx = at;
        S.state.results = [];
        S.state.queue = queue;
        S.saveReview();
        // Same tab, so the admin password in sessionStorage travels with it — that is what lets the
        // task screen save a re-link without asking for it again.
        location.href = 'study.html';
      };
    });

    const file = document.getElementById('v2-page-file');
    if (file) file.onchange = async () => {
      const picked = file.files?.[0];
      if (!picked) return;
      const html = await picked.text();
      editingClaim.page_html = html;
      editingClaim.page_bytes = new Blob([html]).size;
      const size = document.getElementById('v2-page-size');
      size.textContent = `${Math.round(editingClaim.page_bytes / 1024).toLocaleString()} KB loaded from ${picked.name}`;
    };

    document.getElementById('v2-revert-claim').onclick = async () => {
      if (!editingClaim.id) {
        editingClaim = blankClaim();
      } else {
        editingClaim = await DB.getClaim(editingClaim.id);
      }
      renderClaims('Unsaved edits discarded.');
    };

    document.getElementById('v2-duplicate-claim')?.addEventListener('click', () => {
      let draft;
      try { draft = readClaimForm(); }
      catch (error) { return renderClaims(error.message || String(error), true); }
      editingClaim = { ...draft, id: '', in_study: false, task_index: adminClaims.length };
      renderClaims('Duplicated in memory, all four answers included. Give it a new id, edit the '
        + 'answers, then save.');
    });

    document.getElementById('v2-save-claim').onclick = async () => {
      let draft;
      try { draft = readClaimForm(); }
      catch (error) { return renderClaims(error.message || String(error), true); }
      const problem = claimProblem(draft);
      if (problem) return renderClaims(problem, true);

      const button = document.getElementById('v2-save-claim');
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await DB.saveClaim(adminPassword, draft);
        adminClaims = await DB.listAllClaims();
        editingClaim = await DB.getClaim(draft.id);
      } catch (error) {
        if (/password|JWT|permission|authorized/i.test(error.message || '')) forgetAdminPassword();
        return renderClaims(error.message || String(error), true);
      }
      liveTasks = await DB.listStudyTasks();
      countChip.textContent = String(liveTasks.length);
      count.textContent = `${liveTasks.length} active claim${liveTasks.length === 1 ? '' : 's'} in Find V2.`;
      const written = V.KEYS.filter(key => draft.answer_variants[key].answer_text).length;
      renderClaims(`Saved ${draft.id} with ${written} of 4 agent answers written`
        + `${draft.in_study ? ' — LIVE in Find V2.' : ' — held out.'}`);
    };
  }

  /**
   * The two protocol switches, and what turning one off costs in the data.
   *
   * BOTH ARE OFF BY DEFAULT, in the database rather than here — see supabase_v2_flags.sql. The
   * default study is the Yes/No verdict alone; the evidence stage and the follow-up are things a
   * researcher turns on deliberately, because each one lengthens every task in the queue.
   *
   * A change lands on runs STARTED after it is saved. A session carries the flags it began with, so
   * a participant halfway through a queue is never asked a question the first half did not ask.
   */
  async function renderSettings() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Loading study settings…</div>';

    let flags;
    try { flags = await DB.getStudyFlags(); }
    catch (error) {
      content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
      return;
    }

    const design = designOf(flags.queueDesign);

    const row = (id, on, title, detail) => `
      <label class="q-opt q-opt-rich admin-setting">
        <input type="checkbox" id="${id}"${on ? ' checked' : ''}>
        <span class="q-opt-body"><span><b>${title}</b><small>${detail}</small></span></span>
      </label>`;

    content.innerHTML = `
      <p class="viz-note">What every participant is asked and told, beyond the Yes/No verdict. A change applies to runs <b>started after</b> it is saved — a session in progress
        keeps the protocol it began with.</p>
      <div class="admin-settings">
        ${row('v2-collect-evidence', flags.collectEvidence,
          'Ask participants to pick evidence',
          'Adds the two “point at what supports it” questions after the verdict — a sentence and, on '
          + 'a FIND × VISUAL claim, an image. While this is off, <code>evidence_time_ms</code> and the '
          + '<code>score_evidence_*</code> columns stay null and <code>evidence_responses</code> is empty.')}
        ${row('v2-show-trail', flags.showReasoningTrail,
          'Show the reasoning trail on Guide tasks',
          'The agent’s own account of the run, above its answer. <b>Off by default.</b> It is a story '
          + 'about the run rather than evidence from it — it opens “I have completed the task” and '
          + 'names only the steps the agent chose to narrate — so showing it asks a participant to '
          + 'disconfirm a confident claim instead of checking the record. The View Journey, the two '
          + 'page states and the answer are shown either way.')}
        ${row('v2-flag-milestones', flags.flagMilestones,
          'Flag the trail’s steps in the journey',
          'Marks the View Journey rows the reasoning trail accounts for as <b>important milestone</b>, '
          + 'and counts them on the fold. On by default, and the walkthrough follows it. It is a real '
          + 'manipulation: it changes where a participant looks first, and it points at the steps the '
          + 'agent <em>chose</em> to narrate — which, for a run that misreports what it saw, is exactly '
          + 'where the discrepancy is not.')}
        ${row('v2-show-group', flags.showGroupChip,
          'Show participants their group',
          'Adds a <b>GROUP A · text</b> / <b>GROUP B · visual</b> chip beside the condition banner. '
          + 'Off by default: it names a factor the participant is not asked about and cannot act on, '
          + 'and a label saying they are in a group invites them to wonder what the other group is '
          + 'getting. Useful for piloting and for screenshots. The condition banner is unaffected — '
          + 'that one says what is on the screen, which a participant does need.')}
        ${row('v2-collect-followup', flags.collectFollowup,
          'Ask the task follow-up',
          'Adds the confidence and usefulness scales and the optional note after each claim. While '
          + 'this is off, <code>confidence</code>, <code>helpfulness</code> and <code>notes</code> stay null.')}
        <label class="q-opt q-opt-rich admin-setting">
          <span class="q-opt-body"><span><b>Time per task</b><small>The countdown every task opens
            on, and the hard cutoff behind it — at zero a participant gets 5 more seconds to choose,
            and a task that runs those out is stored as unanswered rather than as a No. Between 30
            and 900 seconds.</small></span></span>
          <span class="admin-limit">
            <input type="number" id="v2-task-limit" min="30" max="900" step="10"
              value="${Number(flags.taskLimitSeconds) || 120}"> seconds
          </span>
        </label>
      </div>
      <p class="viz-note">Scroll, Ctrl-F, text selection, clicks, pointer travel, whether the
        references were opened, and the per-task timings are recorded either way — the switches
        change what is <em>asked</em>, not what is <em>observed</em>.</p>

      <h3 class="admin-subtitle">Which queue a participant is dealt</h3>
      <p class="viz-note">The one setting here that changes the <b>experiment</b> rather than what is
        asked within it. It takes effect for sittings started after it is saved; a session already
        under way keeps the design it began with, and rows already collected were dealt under
        whichever design was set at the time — so switching mid-study splits the data into two
        experiments, and only you can say whether that is what you want.</p>
      <div class="admin-settings" id="v2-design-choice">
        ${designOptionHtml('balanced_2x2', design,
          'Crossed 2 × 2 <span class="v2-chip is-grounded">default</span>',
          'Four tasks: <b>Find × Grounded</b>, <b>Find × Non-grounded</b>, <b>Guide × Grounded</b>, '
          + '<b>Guide × Non-grounded</b>, each alternating correct and incorrect. Group A is text '
          + 'throughout, group B visual. Task type and grounding are both within-subjects, so the '
          + 'grounding effect can be read for the Guide half as well as the Find half.')}
        ${designOptionHtml('legacy_find3', design,
          'Three Find cells + one grounded Guide task',
          'The original V2 queue: Find grounded/incorrect, Find non-grounded/correct, Find '
          + 'non-grounded/incorrect — there is deliberately no correct-and-grounded Find task — then '
          + 'one <b>grounded</b> Guide task whose key alternates. Guide is never non-grounded here, '
          + 'so nothing in it estimates grounding for the Guide half.')}
      </div>
      <div id="v2-dealt-tasks">${dealtTasksHtml(design)}</div>

      <h3 class="admin-subtitle">The walkthrough</h3>
      <p class="viz-note">Two practice tasks, one Find and one Guide, offered once before task 1 and
        skippable. The material is invented — a pool timetable — and nothing about it is in the
        study; a practice answer builds no row and never advances the queue. It is offered on a
        browser that has not seen it, so a researcher who has already taken it needs the second
        button to be shown it again <b>on this browser</b>.</p>
      <div class="preview-chips">
        <a class="admin-chip" href="study.html?tutorial=preview" target="_blank" rel="noopener">Preview the walkthrough ↗</a>
        <button class="admin-chip" id="v2-tutorial-reset">Show it again on this browser</button>
        <span class="welcome-status" id="v2-tutorial-status"></span>
      </div>

      <div class="admin-row">
        <button class="welcome-btn" id="v2-save-settings">Save settings</button>
      </div>
      <div class="welcome-status" id="v2-settings-status"></div>`;

    // The table under the choice follows the RADIO, not the saved value — a researcher comparing the
    // two designs should be able to read what each deals before committing to one. Nothing is written
    // until Save settings is pressed.
    const chosenDesign = () => designOf(
      content.querySelector('input[name="v2-queue-design"]:checked')?.value);
    content.querySelectorAll('input[name="v2-queue-design"]').forEach(input => {
      input.onchange = () => {
        const holder = document.getElementById('v2-dealt-tasks');
        if (holder) holder.innerHTML = dealtTasksHtml(chosenDesign());
      };
    });

    // The walkthrough's "already seen" mark is a localStorage key on whichever browser took it, so
    // this clears it HERE and says so — it cannot reach a participant's machine, and a button that
    // implied otherwise would be worse than no button.
    const tutorialStatus = content.querySelector('#v2-tutorial-status');
    content.querySelector('#v2-tutorial-reset').onclick = () => {
      try { localStorage.removeItem('pageguide_find_v2_tutorial_done'); } catch (e) { /* private mode */ }
      tutorialStatus.textContent = 'Cleared — the next run started in this browser will be offered it.';
      tutorialStatus.className = 'welcome-status';
    };

    const statusEl = document.getElementById('v2-settings-status');
    const setStatus = (message, bad = false) => {
      statusEl.textContent = message;
      statusEl.className = `welcome-status${bad ? ' welcome-status-bad' : ''}`;
    };

    document.getElementById('v2-save-settings').onclick = async () => {
      const button = document.getElementById('v2-save-settings');
      button.disabled = true;
      setStatus('Saving…');
      try {
        const seconds = Number(document.getElementById('v2-task-limit').value);
        if (!Number.isFinite(seconds) || seconds < 30 || seconds > 900) {
          button.disabled = false;
          return setStatus('Time per task must be between 30 and 900 seconds.', true);
        }
        const saved = await DB.saveStudyFlags(adminPassword, {
          collectEvidence: document.getElementById('v2-collect-evidence').checked,
          collectFollowup: document.getElementById('v2-collect-followup').checked,
          taskLimitSeconds: Math.round(seconds),
          queueDesign: chosenDesign(),
          showGroupChip: document.getElementById('v2-show-group').checked,
          flagMilestones: document.getElementById('v2-flag-milestones').checked,
          showReasoningTrail: document.getElementById('v2-show-trail').checked,
        });
        // Reflect what the SERVER stored, not what the boxes said — the two differ if a write is
        // rejected, and a panel that reports its own optimism is how a pilot runs the wrong protocol.
        studyFlags = saved;
        setStatus(`Saved. Evidence: ${saved.collectEvidence ? 'on' : 'off'} · Follow-up: `
          + `${saved.collectFollowup ? 'on' : 'off'} · ${saved.taskLimitSeconds}s per task · queue: `
          + `${DESIGNS[designOf(saved.queueDesign)].short} · group chip: `
          + `${saved.showGroupChip ? 'shown' : 'hidden'} · milestones: `
          + `${saved.flagMilestones ? 'flagged' : 'not flagged'} · trail: `
          + `${saved.showReasoningTrail ? 'shown' : 'hidden'}.`
          + ' Runs already in progress keep the protocol they started with.');
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
      button.disabled = false;
    };
  }

  /**
   * The Guide tasks, and the two things about each of them that a migration cannot know.
   *
   * The trajectories come from scripts/migrate_guide_v2.mjs, which copies them out of the V1 project
   * verbatim and deliberately lands every one not-in-study. Two fields have to be judged by a person:
   *
   *   Text or Visual   — nothing in the recording says which, and the group a task is dealt to
   *                      depends on it.
   *   Did it complete? — THE ANSWER KEY. The agent's own summary is a hint and not the key: most of
   *                      these runs open "I have completed the task" while carrying recorded errors,
   *                      and a run that claims success the journey does not support is the most
   *                      interesting item in the set. The summary is shown here so the call can be
   *                      made without leaving the panel.
   *
   * The server refuses to publish a task with no key (save_pageguide_guide_v2_meta), so the worst a
   * mistake here can do is keep a task out of the study.
   */
  async function renderGuideTasks() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Loading Guide tasks…</div>';

    let rows;
    try { rows = await DB.listAllGuideTasks(); }
    catch (error) {
      content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
      return;
    }

    if (!rows.length) {
      content.innerHTML = `
        <p class="viz-note">No Guide tasks yet. Run <code>node scripts/migrate_guide_v2.mjs</code> to
          copy the recorded trajectories across from the V1 project, then tag them here.</p>`;
      return;
    }

    // What the round robin actually has to work with. A group needs three claims and one guide task
    // of its style, and the correct/incorrect rotation needs one of each answer per style — said
    // here, where it can be fixed, rather than discovered mid-session.
    const live = rows.filter(r => r.in_study);
    const tally = (style, key) => live.filter(r => r.task_style === style && r.agent_completed === key).length;
    const gaps = [];
    [['guide_text', 'A / text'], ['guide_visual', 'B / visual']].forEach(([style, label]) => {
      if (!tally(style, true) && !tally(style, false)) gaps.push(`${label} has no live task`);
      else if (!tally(style, true)) gaps.push(`${label} has no “completed” task, so its rotation always shows a failed run`);
      else if (!tally(style, false)) gaps.push(`${label} has no “did not complete” task, so its rotation always shows a successful run`);
    });

    content.innerHTML = `
      <p class="viz-note"><b>${rows.length}</b> Guide task${rows.length === 1 ? '' : 's'} ·
        <b>${live.length}</b> in study. Each participant gets exactly one, matched to their group:
        group A is <b>text</b>, group B is <b>visual</b>.</p>
      ${guideBoardHtml(live)}
      ${gaps.length ? `<p class="welcome-status welcome-status-bad">${esc(gaps.join(' · '))}.</p>` : ''}
      <div class="admin-guide-list">
        ${live.map(row => guideTaskCardHtml(row)).join('')}
      </div>
      ${rows.length > live.length ? `
        <details class="welcome-fold admin-guide-rest">
          <summary><strong>${rows.length - live.length} task${rows.length - live.length === 1 ? '' : 's'} not in the study</strong>
            — withdrawn, unkeyed, or held back</summary>
          <div class="welcome-fold-body">
            <div class="admin-guide-list">
              ${rows.filter(row => !row.in_study).map(row => guideTaskCardHtml(row)).join('')}
            </div>
          </div>
        </details>` : ''}
      <div class="welcome-status" id="v2-guide-status"></div>`;

    // FETCHED ON DEMAND, AND WITHOUT THE SCREENSHOTS. `arms` is megabytes of base64, so the
    // inspector pulls the answer and the trail as JSON subpaths — a kilobyte — and the journey only
    // when somebody asks for it. Loading thirteen trajectories to render a list of thirteen titles
    // times the request out; that is not a hypothetical, it is what happened.
    content.querySelectorAll('[data-guide-trail]').forEach(button => {
      button.onclick = async () => {
        const id = button.dataset.guideTrail;
        const box = content.querySelector(`[data-guide-trail-for="${CSS.escape(id)}"]`);
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<p class="q-sub">Loading…</p>';
        try {
          box.innerHTML = guideInspectHtml(await DB.getGuideInspect(id));
          bindGuideInspect(box, id);
        } catch (error) {
          box.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
        }
      };
    });

    const statusEl = document.getElementById('v2-guide-status');
    content.querySelectorAll('[data-guide-save]').forEach(button => {
      button.onclick = async () => {
        const id = button.dataset.guideSave;
        const card = content.querySelector(`[data-guide-card="${CSS.escape(id)}"]`);
        const completed = card.querySelector(`input[name="done-${CSS.escape(id)}"]:checked`)?.value;
        button.disabled = true;
        statusEl.textContent = 'Saving…';
        statusEl.className = 'welcome-status';
        try {
          await DB.saveGuideMeta(adminPassword, {
            id,
            taskStyle: card.querySelector(`select[data-guide-style="${CSS.escape(id)}"]`).value,
            agentCompleted: completed === 'yes' ? true : completed === 'no' ? false : null,
            inStudy: card.querySelector(`input[data-guide-live="${CSS.escape(id)}"]`).checked,
            claimsCompletion: (rows.find(r => r.id === id) || {}).claims_completion,
            taskIndex: Number(card.querySelector(`input[data-guide-order="${CSS.escape(id)}"]`).value) || 0,
          });
          // A SECOND WRITE, because it is a second fact with a different owner: the meta writer sets
          // the four judged fields, this sets the recorder's problems[]. Sent after the meta save so
          // a rejected key (no answer key, honest failure, empty arms) stops before either lands.
          const problem = card.querySelector(`select[data-guide-problem="${CSS.escape(id)}"]`);
          if (problem) await DB.saveGuideProblems(adminPassword, id, problem.value ? [problem.value] : []);
          await renderGuideTasks();
        } catch (error) {
          statusEl.textContent = error.message || String(error);
          statusEl.className = 'welcome-status welcome-status-bad';
          button.disabled = false;
        }
      };
    });
  }

  /**
   * Everything about one Guide run that a researcher needs in order to key it.
   *
   * BOTH ARMS OF THE ANSWER, side by side. The two differ by more than a setting: an answer carries
   * [ev:…] markers that become evidence chips in the grounded arm and are stripped in the
   * non-grounded one, so the sentence a participant reads is not the same sentence. Rendered through
   * the player's own renderer, so this is what they will actually see rather than an approximation.
   *
   * The trail is shown as the participant sees it — NEUTRAL, with no error flags. The step that went
   * wrong is deliberately not marked, because marking it would answer "did the agent complete the
   * task?" before they had looked. The recorded errors are listed separately below, under the key,
   * where they inform the researcher's judgement without contaminating the stimulus.
   */
  /**
   * Which of three kinds of run this is — the distinction the Guide condition actually turns on.
   *
   * "Did it complete the task?" splits a run two ways, but the runs split three:
   *
   *   faithful success — says it finished, and did
   *   FALSE SUCCESS    — says it finished, and did not. The item worth having: the answer reads as a
   *                      clean result and only the trajectory shows otherwise, so a participant has
   *                      to check the page to catch it.
   *   honest failure   — says it could not finish, and could not. The correct verdict is No, but it
   *                      is readable off the answer's first sentence without looking at anything,
   *                      so it measures reading rather than grounding.
   *
   * `claims` is DERIVED from how the answer opens, which is a heuristic — the answer is shown right
   * above this so the call can be checked rather than trusted. `actually` is the authored key.
   */
  /**
   * The status of a Guide run, from the two stored facts.
   *
   *   claims the job is done + it was     -> CORRECT   (faithful success)
   *   claims the job is done + it was not -> INCORRECT (false success) — the study item
   *   admits it could not finish          -> honest failure, not used
   *
   * `claims_completion` is null until supabase_v2_faithfulness.sql is applied. In that window the
   * status is reported as unclassified rather than guessed, because guessing is what would put an
   * honest failure on screen labelled "Incorrect" — the exact confusion this exists to remove.
   */
  /**
   * Which counterbalancing half a result row came from.
   *
   * DERIVED, not stored. `groupOf(slot)` decides the group at deal time and `stylesFor(group)` turns
   * it into the task style, so `task_style` already carries the group losslessly — a `*_visual` row
   * is a group B row and can be nothing else. Adding a column to store it again would give the
   * dashboard a second source of truth that could disagree with the first.
   */
  /**
   * Whether this participant opened any of the agent's evidence.
   *
   * THE MANIPULATION CHECK. The grounded arm is defined by the evidence being there to check, and
   * without this a null result has two opposite readings — grounding does not help, or nobody
   * looked. Clicks and dwelled hovers are shown apart because they are different gestures: hovering
   * a step is how the Guide viewer is meant to be read, clicking a chip is a deliberate lookup.
   */
  function refsCellHtml(row) {
    const clicks = Number(row.reference_click_count);
    const hovers = Number(row.reference_hover_count);
    const distinct = Number(row.reference_distinct_count);
    const first = Number(row.reference_first_ms);
    // Null across the board means the instrumentation never ran — not that nothing was opened.
    if (!Number.isFinite(clicks) && !Number.isFinite(hovers)) {
      return '<td class="q-sub" title="No interaction telemetry on this row">—</td>';
    }
    const total = (Number.isFinite(clicks) ? clicks : 0) + (Number.isFinite(hovers) ? hovers : 0);
    if (!total) {
      return `<td><span class="v2-chip is-none-opened" title="${
        row.condition === 'nongrounding'
          ? 'Non-grounded: there were no references to open.'
          : 'Grounded, and none was opened — the participant judged without checking.'
      }">none</span></td>`;
    }
    const bits = [];
    if (Number.isFinite(clicks) && clicks) bits.push(`${clicks} click${clicks === 1 ? '' : 's'}`);
    if (Number.isFinite(hovers) && hovers) bits.push(`${hovers} hover${hovers === 1 ? '' : 's'}`);
    if (Number.isFinite(distinct) && distinct) bits.push(`${distinct} distinct`);
    const when = Number.isFinite(first) ? ` · first at ${(first / 1000).toFixed(1)}s` : '';
    return `<td class="q-sub">${esc(bits.join(' · '))}${esc(when)}</td>`;
  }

  /**
   * The manipulation check as one number, per arm.
   *
   * REPORTED SEPARATELY, never pooled. A non-grounded row has no references to open, so its zero is
   * structural; a grounded row's zero is behavioural. One percentage over both would average those
   * two different facts into a number that means neither.
   */
  function referenceUseHtml(rows) {
    const withTelemetry = rows.filter(r => Number.isFinite(Number(r.reference_click_count))
      || Number.isFinite(Number(r.reference_hover_count)));
    if (!withTelemetry.length) return '';
    const opened = r => (Number(r.reference_click_count) || 0) + (Number(r.reference_hover_count) || 0) > 0;
    const cell = (arm, label) => {
      const set = withTelemetry.filter(r => (r.condition === 'nongrounding') === (arm === 'nongrounding'));
      const pct = set.length ? `${Math.round(100 * set.filter(opened).length / set.length)}%` : '—';
      return `<div><b>${pct}</b><span>${esc(label)} · n=${set.length}</span></div>`;
    };
    return `
      <p class="viz-note">Did anyone actually open the evidence? The grounded arm is defined by its
        being there to check, so a null result means nothing until this number is known. The
        non-grounded figure is the floor: those tasks have no references, and anything above zero
        there is the before/after pair, which both arms are shown.</p>
      <div class="find-v2-result-summary">
        ${cell('grounding', 'grounded · opened ≥1')}
        ${cell('nongrounding', 'non-grounded · opened ≥1')}
        <div><b>${withTelemetry.length}</b><span>rows with telemetry</span></div>
      </div>`;
  }

  /**
   * The four tasks a sitting is dealt, spelled out.
   *
   * READ FROM FIND_CELLS AND buildQueue, not written out beside them. The protocol is defined by
   * those two, and a hand-kept description of it is a second definition that drifts — this table is
   * generated from the same array the queue is, so it cannot say something the study does not do.
   *
   * The gaps are as informative as the rows. There is no Find × Correct × Grounded cell: the design
   * deals three of the four, on purpose. And Guide is grounded-only, so the arm never varies there —
   * what alternates is its answer key.
   */
  /** One queue-design choice. A radio and not a checkbox: the two are alternatives, not switches. */
  function designOptionHtml(key, current, title, detail) {
    return `
      <label class="q-opt q-opt-rich admin-setting">
        <input type="radio" name="v2-queue-design" value="${key}"${key === current ? ' checked' : ''}>
        <span class="q-opt-body"><span><b>${title}</b><small>${detail}</small></span></span>
      </label>`;
  }

  function dealtTasksHtml(design) {
    const armLabel = (arm) => (arm === 'nongrounding' ? 'Non-grounded' : 'Grounded');
    const row = (n, kind, style, correct, arm, note) => `
      <tr>
        <td>${n}</td>
        <td><b>${esc(kind)} × ${esc(style)}</b></td>
        <td><span class="v2-chip ${correct === null ? '' : correct ? 'is-correct' : 'is-incorrect'}">${
          correct === null ? 'alternates' : correct ? 'Correct' : 'Incorrect'}</span></td>
        <td><span class="v2-chip ${arm === 'nongrounding' ? 'is-nongrounded' : 'is-grounded'}">${armLabel(arm)}</span></td>
        <td class="q-sub">${esc(note)}</td>
      </tr>`;

    const table = (body) => `
      <div class="viz-table-wrap"><table class="viz-table">
        <thead><tr><th>#</th><th>Task</th><th>Answer</th><th>Condition</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`;

    const forGroup = (group) => {
      const styles = stylesFor(group);
      const find = styles.find === 'find_visual' ? 'Visual' : 'Text';
      const guide = styles.guide === 'guide_visual' ? 'Visual' : 'Text';
      const head = `<h4 class="admin-inspect-h">Group ${group} · ${esc(group === 'B' ? 'visual' : 'text')}</h4>`;

      if (design === 'legacy_find3') {
        return head + table(
          FIND_CELLS.map((cell, i) => row(i + 1, 'Find', find, cell.correct, cell.arm,
            i === 0 ? 'walks the live claim pool by slot' : '')).join('')
          + row(FIND_CELLS.length + 1, 'Guide', guide, null, 'grounding',
            'grounded only; the key alternates correct → incorrect each sitting in this group'));
      }

      // The crossed design's correctness is a function of the sitting, so the table shows the two
      // sittings it alternates between rather than a single "alternates" chip that says nothing
      // about which cells share an answer.
      const sitting = (cycle) => table(CROSSED_CELLS.map((cell, i) => row(
        i + 1,
        cell.taskType === 'find' ? 'Find' : 'Guide',
        cell.taskType === 'find' ? find : guide,
        crossedCorrect(cycle, i),
        cell.arm,
        i === 0 ? 'walks the live pool by slot' : '')).join(''));

      return `${head}
        <p class="q-sub">An even sitting in this group:</p>${sitting(0)}
        <p class="q-sub">The next one:</p>${sitting(1)}`;
    };

    const note = design === 'legacy_find3'
      ? `<p class="viz-note"><b>The missing cell is deliberate.</b> Find deals three of its four
          correctness × grounding cells — there is no correct-and-grounded Find task — and Guide is
          grounded-only, so its arm never varies. Accuracy on a correct answer is the false-alarm
          rate and accuracy on an incorrect one is the catch rate; grounding should move the second
          without moving the first.</p>`
      : `<p class="viz-note"><b>Every cell is filled, and correctness alternates twice over.</b> Each
          cell flips correct → incorrect between consecutive sittings of the same group, and within
          any one sitting two runs are correct and two are not — so nobody can learn on task 2 that
          the agent always fails. The Guide half is offset by one so it does not carry the same
          correctness as the Find half in every sitting; without that, task type and correctness
          would be perfectly correlated within a participant. Modality stays between-subjects
          (A text, B visual); task type and grounding are both within.</p>`;

    return `
      <h3 class="admin-subtitle">What one participant is dealt</h3>
      <p class="viz-note">Four tasks, in this order, generated from the same cells and
        <code>buildQueue</code> the study runs — so this cannot describe a protocol the study does
        not deal. Group is the slot's parity: even slots get A, odd get B.</p>
      ${forGroup('A')}
      ${forGroup('B')}
      ${note}`;
  }

  function groupOfRow(row) {
    return String(row?.task_style || '').endsWith('_visual')
      ? { key: 'B', label: 'B · visual' }
      : { key: 'A', label: 'A · text' };
  }

  /**
   * Accuracy split by WHY the run was incorrect — the reason the mode is snapshotted at all.
   *
   * MISREPORTED is the item the grounding condition exists to measure: the answer reads clean and
   * only the trajectory contradicts it. INCOMPLETE is catchable from the outcome alone. If grounding
   * is doing what the study predicts, it should move the first without needing to move the second,
   * and the two are therefore reported side by side and NEVER averaged into one accuracy — the same
   * rule README.md states for detection and localization.
   *
   * A mode with no scored rows prints "—", not 0%: nobody has been asked yet, which is not the same
   * as everybody getting it wrong.
   */
  function modeAccuracyHtml(rows) {
    const modes = ['none', 'misreported', 'incomplete', 'could_not_complete', 'unspecified'];
    const present = modes.filter(mode => rows.some(r => r.failure_mode === mode));
    if (!present.length) return '';
    const cell = (mode) => {
      const scored = rows.filter(r => r.failure_mode === mode && r.score_verdict_correct != null);
      const pct = scored.length
        ? `${(100 * scored.filter(r => r.score_verdict_correct).length / scored.length).toFixed(0)}%`
        : '—';
      return `<div><b>${pct}</b><span>${esc(window.FindV2GuideKey.label(mode))} · n=${scored.length}</span></div>`;
    };
    return `
      <p class="viz-note">Verdict accuracy by why the run was incorrect. Reported apart, never
        averaged: <b>misreported</b> is the item only the trajectory exposes, <b>incomplete</b> is
        readable from the outcome, and grounding should move the first without needing to move the
        second.</p>
      <div class="find-v2-result-summary">${present.map(cell).join('')}</div>`;
  }

  function modeCellHtml(row) {
    const mode = row.failure_mode;
    if (!mode) return '<td class="q-sub">—</td>';
    if (mode === 'none') return '<td class="q-sub">not a failure item</td>';
    return `<td><span class="v2-chip is-mode-${esc(mode)}">${esc(window.FindV2GuideKey.label(mode))}</span></td>`;
  }

  function groupCellHtml(row) {
    const group = groupOfRow(row);
    return `<td><span class="v2-chip is-group-${group.key.toLowerCase()}">${esc(group.label)}</span></td>`;
  }

  function guideStatus(row) {
    const done = row.agent_completed;
    const claims = typeof row.claims_completion === 'boolean' ? row.claims_completion : null;
    if (done == null) return { label: 'Not keyed', cls: '', note: 'set the answer key' };
    if (claims === false) {
      return { label: 'Honest failure', cls: '',
        note: 'admits it could not finish — answerable without opening the page, so not used' };
    }
    if (claims === null) {
      return { label: done ? 'Completed' : 'Did not complete', cls: '',
        note: 'run supabase_v2_faithfulness.sql to separate a false success from an honest failure' };
    }
    return done
      ? { label: 'CORRECT', cls: 'is-correct', note: 'faithful success — says it finished, and did' }
      : { label: 'INCORRECT', cls: 'is-incorrect', note: 'false success — says it finished, but did not' };
  }

  function guideFaithfulness(answer, agentCompleted) {
    const opening = String(answer || '').trim().toLowerCase();
    const claims = !/^(i could not|i was unable|i did not|the guide was unable)/.test(opening);
    if (agentCompleted == null) return { label: 'Not keyed', cls: '', note: 'set the answer key first' };
    if (claims && agentCompleted) {
      return { label: 'Faithful success', cls: 'is-correct', note: 'says it finished, and did' };
    }
    if (claims && !agentCompleted) {
      return { label: 'FALSE SUCCESS', cls: 'is-incorrect',
        note: 'says it finished but did not — only the trajectory reveals it' };
    }
    if (!claims && !agentCompleted) {
      return { label: 'Honest failure', cls: '',
        note: 'says it could not finish — answerable from the first sentence alone, without checking the page' };
    }
    return { label: 'Unexpected', cls: '', note: 'says it could not finish, but is keyed as completed' };
  }

  function guideInspectHtml(row) {
    const answer = String(row.answer || '');
    const trail = row.trail && typeof row.trail === 'object' ? row.trail : {};
    const milestones = Array.isArray(trail.milestones) ? trail.milestones : [];
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    const gt = row.guide_ground_truth && typeof row.guide_ground_truth === 'object' ? row.guide_ground_truth : {};
    const errors = Array.isArray(gt.errors) ? gt.errors : [];
    const problems = Array.isArray(gt.problems) ? gt.problems : [];
    const key = row.agent_completed;

    return `
      <div class="admin-inspect">
        <div class="admin-inspect-keyrow">
          <span class="v2-chip ${key === true ? 'is-correct' : key === false ? 'is-incorrect' : ''}">${
            key === true ? 'Key: completed the task'
              : key === false ? 'Key: did not complete' : 'Key: not set'}</span>
          ${(() => { const f = guideFaithfulness(answer, key); return `
            <span class="v2-chip ${f.cls}" title="${esc(f.note)}">${esc(f.label)}</span>
            <span class="q-sub">${esc(f.note)}</span>`; })()}
          <span class="q-sub">Scored against this. From V1's
            <code>ground_truth.correctness</code> = <b>${esc(String(gt.correctness || 'not recorded'))}</b>.</span>
        </div>

        <h4 class="admin-inspect-h">Agent answer — grounded <span class="v2-chip is-grounded">Grounded</span>
          <span class="q-sub">click a 📎 chip to see what it cites</span></h4>
        <div class="admin-inspect-answer" data-answer-for="${esc(row.id)}">${answer
          ? window.FindCitations.renderAnswer(answer, 'grounding')
          : '<em class="q-sub">No answer recorded.</em>'}</div>
        ${evidenceListHtml(row.id, evidence)}

        <h4 class="admin-inspect-h">Agent answer — non-grounded <span class="v2-chip is-nongrounded">Non-grounded</span></h4>
        <div class="admin-inspect-answer">${answer
          ? window.FindCitations.renderAnswer(answer, 'nongrounding')
          : '<em class="q-sub">No answer recorded.</em>'}</div>

        <h4 class="admin-inspect-h">Reasoning trail <span class="q-sub">as the participant sees it</span></h4>
        <p class="admin-guide-summary">${esc(trail.summary || 'No summary was recorded.')}</p>
        ${milestones.map(m => `<div class="q-sub admin-inspect-ms"><b>${esc(String(m.step ?? ''))}</b> ${esc(m.text || '')}</div>`).join('')}

        <h4 class="admin-inspect-h">View journey <span class="q-sub">${row.step_count || 0} steps</span></h4>
        <button class="admin-chip" data-load-journey="${esc(row.id)}">Load the journey and screenshots</button>
        <div data-journey-for="${esc(row.id)}"></div>

        <h4 class="admin-inspect-h">Recorded errors <span class="q-sub">researcher-only; never shown to a participant</span></h4>
        ${errors.length || problems.length ? `
          ${problems.length ? `<p class="q-sub">Problems: <b>${esc(problems.join(', '))}</b></p>` : ''}
          ${gt.problem ? `<p class="q-sub">${esc(gt.problem)}</p>` : ''}
          ${errors.map(e => `<div class="q-sub"><b>${esc(String(e.type || ''))}</b> at step${
            (e.steps || []).length === 1 ? '' : 's'} ${esc((e.steps || []).join(', '))}</div>`).join('')}`
          : '<p class="q-sub">None recorded.</p>'}
      </div>`;
  }

  /**
   * The saved evidence behind each 📎 chip in the answer.
   *
   * The chips render as buttons in the participant's view and were inert here, so an admin could see
   * that a claim cited something but not what. These runs' evidence is NOTE-ONLY — no crop, no source
   * text, just the agent's own description and the step it came from — so the useful thing a click
   * can do is show the note and offer the step's screenshot, which is the actual record of what the
   * page said. That distinction matters when the question is whether a number was read or invented:
   * the note is the agent's account and can be wrong in exactly the same way the answer is.
   */
  function evidenceListHtml(id, evidence) {
    if (!evidence.length) return '';
    return `
      <div class="admin-evidence" data-evidence-for="${esc(id)}">
        <div class="admin-evidence-head">Evidence cited by this answer</div>
        ${evidence.map((e, i) => `
          <div class="admin-evidence-row" data-ev-row="${esc(String(e?.key || i))}">
            <span class="admin-evidence-n">E${i + 1}</span>
            <div>
              <div>${esc(e?.note || '(no note recorded)')}</div>
              <div class="q-sub">key <code>${esc(e?.key || '—')}</code>${
                e?.step != null ? ` · from step ${esc(String(e.step))}` : ''}${
                e?.source_text ? ` · quoted: “${esc(String(e.source_text).slice(0, 120))}”` : ''}</div>
              ${e?.step != null
                ? `<button class="admin-chip" data-ev-step="${esc(String(e.step))}" data-ev-task="${esc(id)}">Show step ${esc(String(e.step))} screenshot</button>`
                : ''}
            </div>
          </div>`).join('')}
      </div>`;
  }

  /**
   * A stored screenshot, as something an <img> will actually load.
   *
   * SCREENSHOTS ARE STORED AS RAW BASE64, with no `data:` prefix — app/fake_page.js strips it at
   * capture time on purpose, and every renderer puts it back: app/stimulus.js does it twice,
   * app/study.js and app/welcome.js three more times between them. This inspector was the one place
   * that forgot, so `src` began with the base64 payload's leading "/9j/…" and the browser read it as
   * a RELATIVE URL. It fetched /9j/4AAQSkZJRgABAQ… off the origin, got a 404, and drew the broken-
   * image alt text — which renders as a small box reading "step 1" and looks for all the world like
   * a deliberate placeholder button rather than a failure.
   *
   * A value that already carries the prefix is passed through, so a recorder that starts writing
   * full data URLs does not double it up.
   */
  function shotSrc(shot) {
    const value = String(shot || '');
    if (/^data:/.test(value)) return value;
    // The recorder writes JPEG, and every other renderer hardcodes that. Sniffed from the base64
    // magic anyway, because a PNG announced as JPEG only works by the browser ignoring what we told
    // it — and it costs one line to not rely on that.
    const type = /^iVBORw0KGgo/.test(value) ? 'png' : 'jpeg';
    return `data:image/${type};base64,${value}`;
  }

  function bindGuideInspect(box, id) {
    // The 📎 chips inside the rendered answer. They are real buttons; nothing was listening.
    box.querySelectorAll(`[data-answer-for="${CSS.escape(id)}"] .find-ev`).forEach(chip => {
      chip.onclick = () => {
        const key = chip.dataset.evKey;
        const rows = box.querySelectorAll('[data-ev-row]');
        rows.forEach(r => r.classList.remove('is-on'));
        const row = box.querySelector(`[data-ev-row="${CSS.escape(key)}"]`);
        if (!row) return;
        row.classList.add('is-on');
        try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
      };
    });

    // Jump straight to the step a piece of evidence came from, loading the journey if needed.
    box.querySelectorAll('[data-ev-step]').forEach(jump => {
      jump.onclick = async () => {
        const n = jump.dataset.evStep;
        const loader = box.querySelector(`[data-load-journey="${CSS.escape(id)}"]`);
        if (loader && !loader.disabled) loader.click();
        // The journey loads asynchronously; wait for the row rather than guessing a delay.
        for (let i = 0; i < 60; i++) {
          const target = box.querySelector(`[data-step-row="${CSS.escape(n)}"]`);
          if (target) {
            box.querySelectorAll('[data-step-row]').forEach(r => r.classList.remove('is-on'));
            target.classList.add('is-on');
            try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
            return;
          }
          await new Promise(r => setTimeout(r, 100));
        }
      };
    });

    const button = box.querySelector(`[data-load-journey="${CSS.escape(id)}"]`);
    if (!button) return;
    button.onclick = async () => {
      const holder = box.querySelector(`[data-journey-for="${CSS.escape(id)}"]`);
      button.disabled = true;
      holder.innerHTML = '<p class="q-sub">Loading the journey…</p>';
      try {
        const steps = await DB.getGuideSteps(id);
        holder.innerHTML = steps.length
          ? `<div class="admin-journey">${steps.map(step => `
              <div class="admin-journey-row" data-step-row="${esc(String(step.n ?? ''))}">
                <b>${esc(String(step.n ?? ''))}</b>
                <div>
                  <div>${esc(step.instruction || step.action || '')}</div>
                  ${step.url ? `<div class="q-sub">${esc(step.url)}</div>` : ''}
                  ${step.screenshot ? `<img class="admin-journey-shot" src="${esc(shotSrc(step.screenshot))}" alt="step ${esc(String(step.n ?? ''))}">` : '<div class="q-sub">No screenshot saved.</div>'}
                </div>
              </div>`).join('')}</div>`
          : '<p class="q-sub">No steps recorded for the grounded arm.</p>';
      } catch (error) {
        holder.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
        button.disabled = false;
      }
    };
  }

  /**
   * The study set as a 2x2: what is live, by correctness and by group.
   *
   * The card list says what each task is; this says whether the SET is usable, which is a different
   * question and the one that decides whether a session can run. A zero here is not a small number
   * — it is a cell the rotation cannot deal, so that group falls back and every participant in it
   * sees the same kind of run. Called out as a gap rather than printed as a quiet 0.
   */
  /**
   * WHY a run is keyed incorrect, on the card.
   *
   * The derived label and the recorder's raw problem ids together, the same way guideFaithfulness is
   * shown next to the sentence it judged: a classification a researcher cannot check against its
   * input is one they have to take on trust.
   */
  /**
   * WHY this run is incorrect — the one thing about a Guide task nothing could previously edit.
   *
   * `guide_ground_truth.problems` drives the derived failure mode, the 2x2 board, the per-mode
   * accuracy split and `failure_mode` on every result row, and until now the only writer was the
   * recorder's own save path — which rewrites the whole ground-truth object from its payload. A
   * classification made by hand therefore reverted the next time the run was recorded, with nothing
   * said. It still will; this is the way to put it back without a script.
   *
   * Shown only for a run keyed INCORRECT. A run that completed the task has no failure to classify,
   * and offering the control there would invite one to be invented.
   */
  function failureModeEditorHtml(row) {
    if (row.agent_completed !== false) return '';
    const problems = window.FindV2GuideKey.problemsOf(row.guide_ground_truth);
    const current = problems.includes('hallucinated_result') ? 'hallucinated_result'
      : problems.includes('wrong_result') ? 'wrong_result'
      : problems.includes('incomplete') ? 'incomplete'
      : problems.includes('could_not_complete') ? 'could_not_complete' : '';
    const opt = (value, label) =>
      `<option value="${value}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;
    return `
      <p class="q-sub">Why is it incorrect? <b>Not asked of the participant</b> — they give one
        verdict. This is the classification the board and the per-mode accuracy split read, and it is
        snapshotted onto every result row as <code>failure_mode</code>.</p>
      <div class="admin-row">
        <select data-guide-problem="${esc(row.id)}">
          ${opt('', '— not recorded —')}
          ${opt('hallucinated_result', 'Misreported — the answer claims what the run does not support')}
          ${opt('wrong_result', 'Misreported (wrong result) — reported the wrong thing')}
          ${opt('incomplete', 'Incomplete — only part of the job was done')}
          ${opt('could_not_complete', 'Could not complete — did not finish, and said so')}
        </select>
        <span class="q-sub">recorded as <code>${esc(problems.join(', ') || 'nothing')}</code></span>
      </div>`;
  }

  function failureChipHtml(row) {
    const GK = window.FindV2GuideKey;
    const mode = GK.failureMode(row.guide_ground_truth, row.agent_completed);
    if (!mode || mode === 'none') return '';
    const problems = GK.problemsOf(row.guide_ground_truth);
    const title = `${GK.note(mode)}${problems.length ? ` · recorded as ${problems.join(', ')}` : ''}`;
    return `<span class="v2-chip is-mode-${esc(mode)}" title="${esc(title)}">${esc(GK.label(mode))}</span>`;
  }

  function guideBoardHtml(live) {
    const GK = window.FindV2GuideKey;
    const count = (style, correct) => live.filter(r =>
      r.task_style === style && r.claims_completion !== false && r.agent_completed === correct).length;
    const cell = (style, correct) => {
      const n = count(style, correct);
      return `<td class="${n ? '' : 'is-gap'}"><b>${n}</b>${n ? '' : '<span>no task</span>'}</td>`;
    };
    const total = (style) => count(style, true) + count(style, false);

    // THE INCORRECT ROW SPLIT BY WHY. A group with false successes but none of the misreporting kind
    // can still run, and would look perfectly healthy on the two rows above — while the one item the
    // grounding condition exists to measure is missing from it. Indented under INCORRECT because
    // these are a breakdown of that row, not two more kinds of run.
    const modeCount = (style, mode) => live.filter(r =>
      r.task_style === style && r.claims_completion !== false
      && GK.failureMode(r.guide_ground_truth, r.agent_completed) === mode).length;
    // A GAP ONLY WHERE ONE MATTERS. Every run that can reach a participant claims completion and is
    // therefore a misreport — the incomplete and could-not-complete runs are all honest failures,
    // which are excluded by design. So a zero on the misreported row is a hole in the study set,
    // while a zero on the others is the design working. Flagging both red taught the board to cry
    // wolf about the half that can never be filled.
    const modeRow = (mode, why) => {
      const gapMatters = mode === 'misreported';
      const cellFor = (style) => {
        const n = modeCount(style, mode);
        if (n) return `<td><b>${n}</b></td>`;
        return gapMatters
          ? '<td class="is-gap"><b>0</b><span>no task</span></td>'
          : '<td class="is-none"><b>0</b><span>not in this design</span></td>';
      };
      return `<tr class="guide-board-sub"><th>↳ ${esc(GK.label(mode))}<span>${esc(why)}</span></th>
        ${cellFor('guide_text')}${cellFor('guide_visual')}</tr>`;
    };
    return `
      <table class="guide-board">
        <thead><tr>
          <th></th>
          <th>Guide × Text<span>group A</span></th>
          <th>Guide × Visual<span>group B</span></th>
        </tr></thead>
        <tbody>
          <tr><th>CORRECT<span>faithful success</span></th>
            ${cell('guide_text', true)}${cell('guide_visual', true)}</tr>
          <tr><th>INCORRECT<span>false success</span></th>
            ${cell('guide_text', false)}${cell('guide_visual', false)}</tr>
          ${modeRow('misreported', 'only the trajectory shows it')}
          ${modeRow('incomplete', 'visible in the outcome alone')}
          <tr class="guide-board-total"><th>Total in study</th>
            <td><b>${total('guide_text')}</b></td><td><b>${total('guide_visual')}</b></td></tr>
        </tbody>
      </table>`;
  }

  function guideTaskCardHtml(row) {
    const id = row.id;
    const done = row.agent_completed;
    const status = guideStatus(row);
    const radio = (value, label) => `
      <label class="q-opt q-opt-rich admin-setting">
        <input type="radio" name="done-${esc(id)}" value="${value}"${
          (value === 'yes') === (done === true) && done !== null ? ' checked' : ''}>
        <span class="q-opt-body"><span>${label}</span></span>
      </label>`;
    return `
      <div class="admin-guide-card" data-guide-card="${esc(id)}">
        <div class="admin-guide-head">
          <div class="admin-guide-title">
            <b>${esc(row.goal || row.title || id)}</b>
            <span class="v2-chip ${status.cls}" title="${esc(status.note)}">${esc(status.label)}</span>
            ${failureChipHtml(row)}
            ${row.in_study ? '<span class="v2-chip is-grounded">In study</span>' : ''}
          </div>
          <span class="q-sub">${esc(id)} · ${Number(row.step_count) || 0} steps · ${esc(status.note)}</span>
        </div>
        <div class="admin-row">
          <label class="q-sub">Style
            <select data-guide-style="${esc(id)}">
              <option value="guide_text"${row.task_style !== 'guide_visual' ? ' selected' : ''}>Text (group A)</option>
              <option value="guide_visual"${row.task_style === 'guide_visual' ? ' selected' : ''}>Visual (group B)</option>
            </select>
          </label>
          <label class="q-sub">Order
            <input type="number" data-guide-order="${esc(id)}" value="${Number(row.task_index) || 0}" style="width:70px">
          </label>
          <label class="q-sub">
            <input type="checkbox" data-guide-live="${esc(id)}"${row.in_study ? ' checked' : ''}> Use in study
          </label>
          <button class="admin-chip" data-guide-save="${esc(id)}">Save</button>
          <button class="admin-chip" data-guide-trail="${esc(id)}">Inspect</button>
        </div>
        <div class="admin-guide-trail" data-guide-trail-for="${esc(id)}" hidden></div>
        <p class="q-sub">Did the agent successfully complete the task? <b>This is the answer key</b>
          — the participant's Yes/No is scored against it, and they are asked it in exactly these
          words, so a run that finishes the job but misdescribes it is a <b>No</b>.</p>
        <div class="q-options">
          ${radio('yes', '<b>Yes</b><small>It did the whole job, and its answer matches what it actually did.</small>')}
          ${radio('no', '<b>No</b><small>It did not finish the job, <b>or</b> its answer claims something that did not happen.</small>')}
        </div>
        ${failureModeEditorHtml(row)}
      </div>`;
  }

  /**
   * The two axes of the design, as their own columns.
   *
   * They used to share one cell as "Correct · Grounded". The study exists to find out which of the
   * two moved a participant's accuracy, and reading that off a combined string means matching
   * substrings by eye down a column of a thousand rows. Split, each is scannable on its own, and the
   * pairing is still obvious because they sit side by side.
   *
   * Falls back to deriving the variant from the older two columns, so rows written before
   * `variant_key` existed still say what they showed rather than going blank.
   */
  function variantCellsHtml(row) {
    const key = V.KEYS.includes(row.variant_key)
      ? row.variant_key
      : V.variantKey(row.claim_correct_snapshot !== false, row.condition);
    const parsed = V.parseKey(key);
    const grounded = parsed.condition !== 'nongrounding';
    return `
          <td><span class="v2-chip ${parsed.correct ? 'is-correct' : 'is-incorrect'}">${
            parsed.correct ? 'Correct' : 'Incorrect'}</span></td>
          <td><span class="v2-chip ${grounded ? 'is-grounded' : 'is-nongrounded'}">${
            grounded ? 'Grounded' : 'Non-grounded'}</span></td>`;
  }

  async function renderResults() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Loading private Find V2 results…</div>';
    let rows;
    try { rows = await DB.listResults(adminPassword); }
    catch (error) {
      content.innerHTML = `<div class="welcome-status welcome-status-bad">${esc(error.message || error)}</div>`;
      return;
    }
    const rate = subset => {
      if (!subset.length) return '—';
      return `${(100 * subset.filter(row => row.verdict_correct).length / subset.length).toFixed(1)}%`;
    };
    const yes = rows.filter(row => row.participant_verdict).length;
    const cell = key => rows.filter(row => (row.variant_key
      || V.variantKey(row.claim_correct_snapshot, row.condition)) === key);
    content.innerHTML = `
      <div class="find-v2-result-summary">
        <div><b>${rows.length}</b><span>judgments</span></div>
        <div><b>${rate(rows)}</b><span>verdict accuracy</span></div>
        <div><b>${rate(rows.filter(row => row.condition === 'grounding'))}</b><span>grounded accuracy</span></div>
        <div><b>${rate(rows.filter(row => row.condition === 'nongrounding'))}</b><span>non-grounded accuracy</span></div>
      </div>
      <div class="find-v2-result-summary">
        ${V.KEYS.map(key => `<div><b>${rate(cell(key))}</b>
          <span>${esc(V.LABELS[key])} · n=${cell(key).length}</span></div>`).join('')}
      </div>
      ${referenceUseHtml(rows)}
      <p class="viz-note">The four cells are the point of the design: accuracy on a correct answer
        is the participant's false-alarm rate, accuracy on an incorrect one is their catch rate, and
        grounding is what should move the second without moving the first.</p>
      <p class="viz-note">${yes} Yes and ${rows.length - yes} No responses. Results are read through
        the password-checked RPC; the anon role has no direct SELECT policy on this table.</p>
      ${rows.length ? `<div class="viz-table-wrap"><table class="viz-table find-v2-results-table">
        <thead><tr><th>When<span class="q-sub"> · Central</span></th><th>Participant</th><th>Group</th><th>Claim</th><th>Answer shown</th><th>Grounding</th><th>Refs opened</th><th>Key</th><th>Answer</th><th>Scored</th><th>Time</th></tr></thead>
        <tbody>${rows.slice(0, 1000).map(row => `<tr>
          <td>${esc(localTime(row.created_at))}</td>
          <td>${esc(row.participant_id)}</td>${groupCellHtml(row)}<td><code>${esc(row.claim_id)}</code></td>
          ${variantCellsHtml(row)}
          ${refsCellHtml(row)}
          <td>${row.claim_correct_snapshot ? 'Yes' : 'No'}</td>
          <td>${row.participant_verdict == null ? '—' : (row.participant_verdict ? 'Yes' : 'No')}</td>
          <td class="${row.verdict_correct == null ? '' : (row.verdict_correct ? 'is-good' : 'is-bad')}">${
            row.verdict_correct == null
              ? (row.verdict_timed_out ? 'Timed out' : '—')
              : (row.verdict_correct ? 'Correct' : 'Incorrect')}</td>
          <td>${Math.round(Number(row.answer_time_ms || 0) / 1000)}s</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="admin-review-empty">No Find V2 result rows yet.</p>'}
      <div id="find-v2-charts"></div>
      <div id="find-v2-guide-results"><div class="viz-loading">Loading Guide results…</div></div>`;

    renderGuideResults(rows);
  }

  /**
   * The Guide half of the same session.
   *
   * A participant's fourth task lands in a different table, so a Results tab that only read the Find
   * one showed three quarters of every sitting and gave no hint the rest existed.
   */
  async function renderGuideResults(findRows) {
    const box = document.getElementById('find-v2-guide-results');
    if (!box) return;
    let rows;
    try { rows = await DB.listGuideResults(adminPassword); }
    catch (error) {
      box.innerHTML = `<p class="welcome-status welcome-status-bad">Guide results: ${esc(error.message || error)}</p>`;
      return;
    }
    const scored = rows.filter(row => row.score_verdict_correct != null);
    const rate = scored.length
      ? `${(100 * scored.filter(row => row.score_verdict_correct).length / scored.length).toFixed(1)}%`
      : '—';
    box.innerHTML = `
      <h3 class="admin-subtitle">Guide tasks</h3>
      <div class="find-v2-result-summary">
        <div><b>${rows.length}</b><span>judgments</span></div>
        <div><b>${rate}</b><span>verdict accuracy</span></div>
        <div><b>${rows.filter(row => row.task_style === 'guide_text').length}</b><span>group A · text</span></div>
        <div><b>${rows.filter(row => row.task_style === 'guide_visual').length}</b><span>group B · visual</span></div>
      </div>
      ${modeAccuracyHtml(rows)}
      ${referenceUseHtml(rows)}
      ${rows.length ? `<div class="viz-table-wrap"><table class="viz-table find-v2-results-table">
        <thead><tr><th>When<span class="q-sub"> · Central</span></th><th>Participant</th><th>Group</th><th>Task</th><th>Why incorrect</th><th>Answer shown</th><th>Grounding</th><th>Refs opened</th><th>Completed?</th><th>Answer</th><th>Scored</th><th>Time</th></tr></thead>
        <tbody>${rows.slice(0, 1000).map(row => `<tr>
          <td>${esc(localTime(row.created_at))}</td>
          <td>${esc(row.participant_id)}</td>${groupCellHtml(row)}<td><code>${esc(row.task_id)}</code></td>
          ${modeCellHtml(row)}
          <td><span class="v2-chip ${row.answer_correct_snapshot ? 'is-correct' : 'is-incorrect'}">${
            row.answer_correct_snapshot ? 'Correct' : 'Incorrect'}</span></td>
          <td><span class="v2-chip ${row.condition === 'nongrounding' ? 'is-nongrounded' : 'is-grounded'}">${
            row.condition === 'nongrounding' ? 'Non-grounded' : 'Grounded'}</span></td>
          ${refsCellHtml(row)}
          <td>${row.answer_correct_snapshot == null ? '—' : (row.answer_correct_snapshot ? 'Yes' : 'No')}</td>
          <td>${row.guide_answer_correct == null ? '—' : (row.guide_answer_correct ? 'Yes' : 'No')}</td>
          <td class="${row.score_verdict_correct == null ? '' : (row.score_verdict_correct ? 'is-good' : 'is-bad')}">${
            row.score_verdict_correct == null
              ? (row.verdict_timed_out ? 'Timed out' : '—')
              : (row.score_verdict_correct ? 'Correct' : 'Incorrect')}</td>
          <td>${Math.round(Number(row.time_ms || 0) / 1000)}s</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="admin-review-empty">No Guide result rows yet.</p>'}`;

    renderCharts(findRows || [], rows);
  }

  /**
   * Time and accuracy, by grounding and by correctness, for both task types.
   *
   * THE EMPTY CELLS ARE THE POINT AS MUCH AS THE FULL ONES. This protocol deals three of the four
   * Find cells — there is no grounded/correct task — and Guide is grounded-only. So half of the 2x2
   * the charts ask for cannot be filled by any number of participants, and the panels say "not in
   * this design" in those slots rather than leaving a gap that reads as "nobody scored here yet".
   */
  function renderCharts(findRows, guideRows) {
    const host = document.getElementById('find-v2-charts');
    if (!host || !window.FindV2Charts) return;
    const CH = window.FindV2Charts;
    const ST = window.FindV2Stats;

    // Timed-out tasks have no verdict, so they are not accuracy observations. They are dropped from
    // both charts and counted separately: scoring an unanswered task as wrong would inflate the
    // error rate of whichever condition ran people out of time.
    const timedOutFind = findRows.filter(r => r.verdict_timed_out).length;
    const timedOutGuide = guideRows.filter(r => r.verdict_timed_out).length;
    const f = findRows.filter(r => !r.verdict_timed_out);
    const g = guideRows.filter(r => !r.verdict_timed_out);

    const findCell = (cell) => {
      const rows = f.filter(r => (r.variant_key
        || V.variantKey(r.claim_correct_snapshot, r.condition)) === cell.key);
      return {
        cell,
        values: rows.map(r => Number(r.answer_time_ms)).filter(Number.isFinite),
        n: rows.length,
        k: rows.filter(r => r.verdict_correct).length,
      };
    };
    // Guide is grounded-only for now, so its non-grounded cells are structurally empty.
    const guideCell = (cell) => {
      const rows = g.filter(r => (r.condition === 'nongrounding' ? 'nongrounding' : 'grounding') === cell.arm
        && (r.answer_correct_snapshot === true) === cell.correct);
      return {
        cell,
        values: rows.map(r => Number(r.time_ms)).filter(Number.isFinite),
        n: rows.length,
        k: rows.filter(r => r.score_verdict_correct).length,
      };
    };

    const findGroups = CH.CELLS.map(findCell);
    const guideGroups = CH.CELLS.map(guideCell);

    host.innerHTML = `
      <h3 class="admin-subtitle">Time and accuracy</h3>
      ${CH.legendHtml()}
      <h4 class="admin-inspect-h">Find</h4>
      <div class="viz-grid">
        ${CH.boxChart(findGroups, { title: 'Time on task', unit: 'ms' })}
        ${CH.rateChart(findGroups, { title: 'Verdict accuracy' })}
      </div>
      <h4 class="admin-inspect-h">Guide</h4>
      <div class="viz-grid">
        ${CH.boxChart(guideGroups, { title: 'Time on task', unit: 'ms' })}
        ${CH.rateChart(guideGroups, { title: 'Verdict accuracy' })}
      </div>
      ${significanceHtml(findGroups, guideGroups, timedOutFind + timedOutGuide)}`;
  }

  /**
   * Which comparisons this design can actually test, and what they say.
   *
   * Exact tests only — Fisher for the rates, exact Mann-Whitney for the times. At five observations
   * a cell the normal approximations behind a chi-square or a z-test are not slightly off, they are
   * answering a question about a limit this data is nowhere near.
   *
   * The power line is not a disclaimer bolted on afterwards; it is the most important number here.
   * With 5 against 5, Fisher's exact test CANNOT return p < 0.05 unless the split is almost perfect
   * — 5/5 against 0/5 gives p = 0.008 and 4/5 against 1/5 gives p = 0.21. So "not significant" in
   * this table overwhelmingly means "not enough data yet", and reading it as evidence of no effect
   * would be exactly backwards.
   */
  function significanceHtml(findGroups, guideGroups, timedOut) {
    const ST = window.FindV2Stats;
    const by = (groups, key) => groups.find(x => x.cell.key === key);

    const tests = [];
    const addPair = (label, a, b, note) => {
      if (!a || !b || !a.n || !b.n) {
        tests.push({ label, blocked: note || 'one side of this comparison is not dealt by the current design' });
        return;
      }
      const acc = ST.fisherExact(a.k, a.n - a.k, b.k, b.n - b.k);
      const time = ST.mannWhitney(a.values, b.values);
      tests.push({ label, a, b, acc, time });
    };

    addPair('Find · incorrect claims — grounded vs non-grounded',
      by(findGroups, 'incorrect_grounding'), by(findGroups, 'incorrect_nongrounding'));
    addPair('Find · correct claims — grounded vs non-grounded',
      by(findGroups, 'correct_grounding'), by(findGroups, 'correct_nongrounding'),
      'the grounded/correct cell is not dealt by this protocol, so the grounding effect on correct claims cannot be estimated');
    addPair('Find · non-grounded — correct vs incorrect claims',
      by(findGroups, 'correct_nongrounding'), by(findGroups, 'incorrect_nongrounding'));
    addPair('Guide · grounded — completed vs did-not-complete runs',
      by(guideGroups, 'correct_grounding'), by(guideGroups, 'incorrect_grounding'));
    addPair('Guide — grounded vs non-grounded',
      by(guideGroups, 'correct_grounding'), by(guideGroups, 'correct_nongrounding'),
      'Guide is grounded-only in this protocol, so it carries no grounding comparison at all');

    return `
      <h4 class="admin-inspect-h">Is any of this significant?</h4>
      <p class="viz-note viz-power"><b>Almost certainly not yet, and the tests below cannot say
        otherwise.</b> With 5 observations against 5, Fisher's exact test cannot reach p &lt; 0.05
        unless the split is nearly perfect: 5/5 vs 0/5 gives p = 0.008, and 4/5 vs 1/5 gives
        p = 0.21. A blank result here means <em>not enough data</em>, not <em>no effect</em>.</p>
      <div class="viz-table-wrap"><table class="viz-table">
        <thead><tr><th>Comparison</th><th>Accuracy</th><th>Time</th></tr></thead>
        <tbody>${tests.map(t => t.blocked ? `
          <tr><td>${esc(t.label)}</td><td colspan="2" class="viz-blocked">${esc(t.blocked)}</td></tr>`
          : `
          <tr>
            <td>${esc(t.label)}<br><span class="q-sub">n = ${t.a.n} vs ${t.b.n}</span></td>
            <td>${t.a.k}/${t.a.n} vs ${t.b.k}/${t.b.n}<br>
              <span class="${t.acc.p < 0.05 ? 'is-good' : 'q-sub'}">Fisher exact, ${esc(ST.fmtP(t.acc.p))}</span></td>
            <td>${window.FindV2Charts.fmtMs(ST.boxStats(t.a.values)?.med)} vs
              ${window.FindV2Charts.fmtMs(ST.boxStats(t.b.values)?.med)}<br>
              <span class="${t.time.p < 0.05 ? 'is-good' : 'q-sub'}">Mann–Whitney, ${esc(ST.fmtP(t.time.p))}</span></td>
          </tr>`).join('')}</tbody>
      </table></div>
      ${timedOut ? `<p class="viz-note">${timedOut} timed-out task${timedOut === 1 ? '' : 's'} excluded:
        an unanswered task is not a wrong answer, and counting it as one would inflate the error rate
        of whichever condition ran people out of time.</p>` : ''}`;
  }



  adminButton.onclick = async () => {
    if (!DB?.supabaseConfigured()) return renderAdminLogin('Configure the new Find V2 Supabase project first.');
    try { adminPassword = sessionStorage.getItem(ADMIN_PASSWORD_KEY) || ''; } catch (e) { adminPassword = ''; }
    if (!adminPassword) return renderAdminLogin();
    try { await DB.checkAdmin(adminPassword); }
    catch (error) {
      forgetAdminPassword();
      return renderAdminLogin(error.message || String(error));
    }
    openAdmin();
  };

  loadWelcome();
}());

