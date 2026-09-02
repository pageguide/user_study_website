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
  let studyFlags = { collectEvidence: false, collectFollowup: false };
  let adminPassword = '';
  let adminClaims = [];
  let editingClaim = null;
  let adminTab = 'claims';
  let variantTab = 'correct_grounding';

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

  /** The four tasks this slot is dealt, in order. */
  function buildQueue(claims, guideTasks, slot) {
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
      say('Find V2 is waiting for its new Supabase project. Fill in app/find_v2_config.js after running supabase_find_v2.sql.', true);
      count.textContent = 'The original V1 configuration is not used here.';
      return;
    }

    const saved = S.loadLocal();
    if (saved && saved.idx < saved.queue.length) {
      const left = saved.queue.length - saved.idx;
      countChip.textContent = String(saved.queue.length);
      count.textContent = `${saved.idx} completed · ${left} remaining in this saved Find V2 run.`;
      say('An unfinished Find V2 run was found on this browser.');
      start.textContent = 'Continue Find V2 →';
      start.disabled = false;
      start.onclick = () => { location.href = 'study.html'; };
      return;
    }

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

    // Every queue is four tasks now, whatever the pools hold, so the chip does not count the pool.
    countChip.textContent = String(FIND_CELLS.length + (liveGuideTasks.length ? 1 : 0));
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
      const guide = liveGuideTasks.filter(task => task.style === styles.guide).length;
      if (find < FIND_CELLS.length) shortages.push(`group ${group} has ${find} ${styles.find} claim${find === 1 ? '' : 's'} for ${FIND_CELLS.length} slots`);
      if (!guide) shortages.push(`group ${group} has no ${styles.guide} task`);
    });

    // A run with no guide task at all is the un-migrated case, and naming the fix beats listing the
    // symptom twice.
    const noGuideAtAll = !liveGuideTasks.length;
    say(noGuideAtAll
      ? 'Ready — Find only. No Guide task is available yet; run supabase_v2_guide.sql, then scripts/migrate_guide_v2.mjs, then tag them in Admin → Guide tasks.'
      : (shortages.length ? `Ready, with gaps: ${shortages.join('; ')}.` : 'Find V2 is ready.'),
    !!shortages.length);
    count.textContent = `Each participant gets ${FIND_CELLS.length} Find claims and `
      + `${liveGuideTasks.length ? '1 Guide task' : 'no Guide task yet'} · groups A (text) and B (visual) alternate automatically.`;
    start.disabled = false;
    start.onclick = beginStudy;
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
      queue: buildQueue(liveTasks, liveGuideTasks, assignment.assignmentSlot),
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
      showV1Link(false);
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

  /** The V1 study is a researcher's door, not a participant's. Shown only while Admin is open. */
  function showV1Link(on) {
    const link = document.getElementById('find-v1-link');
    if (link) link.hidden = !on;
  }

  function renderAdminShell() {
    showV1Link(true);
    adminPanel.innerHTML = `
      <div class="admin-title">🔓 Find V2 Admin <span class="admin-warn">changes V2 only</span></div>
      <div class="admin-tabs">
        <button class="admin-tab${adminTab === 'claims' ? ' admin-tab-on' : ''}" data-v2-tab="claims">Edit claims</button>
        <button class="admin-tab${adminTab === 'results' ? ' admin-tab-on' : ''}" data-v2-tab="results">Results</button>
        <button class="admin-tab${adminTab === 'guide' ? ' admin-tab-on' : ''}" data-v2-tab="guide">Guide tasks</button>
        <button class="admin-tab${adminTab === 'settings' ? ' admin-tab-on' : ''}" data-v2-tab="settings">Study settings</button>
      </div>
      <div id="find-v2-admin-content"></div>
      <button class="admin-exit" id="find-v2-admin-exit">Leave Admin</button>`;

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
      showV1Link(false);
    };
    if (adminTab === 'results') renderResults();
    else if (adminTab === 'settings') renderSettings();
    else if (adminTab === 'guide') renderGuideTasks();
    else renderClaims();
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
        S.state.participantId = 'admin-review';
        S.state.variantKey = key;
        S.state.adminReview = true;
        S.state.idx = 0;
        S.state.results = [];
        S.state.queue = [{
          id: row.id,
          taskType: 'find',
          studyVersion: 'find-v2',
          title: row.title || '',
          url: row.url || '',
          type: row.task_style === 'find_text' ? 'FIND × TEXT' : 'FIND × VISUAL',
          question: row.question || '',
          style: row.task_style,
          arm: dealt.condition,
          claimCorrect: dealt.correct,
          variantKey: key,
          answer: '',
          distractors: [],
        }];
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

    const row = (id, on, title, detail) => `
      <label class="q-opt q-opt-rich admin-setting">
        <input type="checkbox" id="${id}"${on ? ' checked' : ''}>
        <span class="q-opt-body"><span><b>${title}</b><small>${detail}</small></span></span>
      </label>`;

    content.innerHTML = `
      <p class="viz-note">What every participant is asked, beyond the Yes/No verdict. Both are off by
        default. A change applies to runs <b>started after</b> it is saved — a session in progress
        keeps the protocol it began with.</p>
      <div class="admin-settings">
        ${row('v2-collect-evidence', flags.collectEvidence,
          'Ask participants to pick evidence',
          'Adds the two “point at what supports it” questions after the verdict — a sentence and, on '
          + 'a FIND × VISUAL claim, an image. While this is off, <code>evidence_time_ms</code> and the '
          + '<code>score_evidence_*</code> columns stay null and <code>evidence_responses</code> is empty.')}
        ${row('v2-collect-followup', flags.collectFollowup,
          'Ask the task follow-up',
          'Adds the confidence and usefulness scales and the optional note after each claim. While '
          + 'this is off, <code>confidence</code>, <code>helpfulness</code> and <code>notes</code> stay null.')}
      </div>
      <p class="viz-note">Scroll, Ctrl-F, text selection, clicks, pointer travel and the per-task
        timings are recorded either way — the switches change what is <em>asked</em>, not what is
        <em>observed</em>.</p>
      <div class="admin-row">
        <button class="welcome-btn" id="v2-save-settings">Save settings</button>
      </div>
      <div class="welcome-status" id="v2-settings-status"></div>`;

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
        const saved = await DB.saveStudyFlags(adminPassword, {
          collectEvidence: document.getElementById('v2-collect-evidence').checked,
          collectFollowup: document.getElementById('v2-collect-followup').checked,
        });
        // Reflect what the SERVER stored, not what the boxes said — the two differ if a write is
        // rejected, and a panel that reports its own optimism is how a pilot runs the wrong protocol.
        studyFlags = saved;
        setStatus(`Saved. Evidence: ${saved.collectEvidence ? 'on' : 'off'} · Follow-up: `
          + `${saved.collectFollowup ? 'on' : 'off'}.`);
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
  function groupOfRow(row) {
    return String(row?.task_style || '').endsWith('_visual')
      ? { key: 'B', label: 'B · visual' }
      : { key: 'A', label: 'A · text' };
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
                  ${step.screenshot ? `<img class="admin-journey-shot" src="${esc(step.screenshot)}" alt="step ${esc(String(step.n ?? ''))}">` : '<div class="q-sub">No screenshot saved.</div>'}
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
  function guideBoardHtml(live) {
    const count = (style, correct) => live.filter(r =>
      r.task_style === style && r.claims_completion !== false && r.agent_completed === correct).length;
    const cell = (style, correct) => {
      const n = count(style, correct);
      return `<td class="${n ? '' : 'is-gap'}"><b>${n}</b>${n ? '' : '<span>no task</span>'}</td>`;
    };
    const total = (style) => count(style, true) + count(style, false);
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
        <p class="q-sub">Did the agent complete the task? <b>This is the answer key</b> — the
          participant's Yes/No is scored against it.</p>
        <div class="q-options">
          ${radio('yes', '<b>Yes</b><small>It completed the task.</small>')}
          ${radio('no', '<b>No</b><small>It did not complete the task.</small>')}
        </div>
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
      <p class="viz-note">The four cells are the point of the design: accuracy on a correct answer
        is the participant's false-alarm rate, accuracy on an incorrect one is their catch rate, and
        grounding is what should move the second without moving the first.</p>
      <p class="viz-note">${yes} Yes and ${rows.length - yes} No responses. Results are read through
        the password-checked RPC; the anon role has no direct SELECT policy on this table.</p>
      ${rows.length ? `<div class="viz-table-wrap"><table class="viz-table find-v2-results-table">
        <thead><tr><th>When</th><th>Participant</th><th>Group</th><th>Claim</th><th>Answer shown</th><th>Grounding</th><th>Key</th><th>Answer</th><th>Scored</th><th>Time</th></tr></thead>
        <tbody>${rows.slice(0, 1000).map(row => `<tr>
          <td>${esc(new Date(row.created_at).toLocaleString())}</td>
          <td>${esc(row.participant_id)}</td>${groupCellHtml(row)}<td><code>${esc(row.claim_id)}</code></td>
          ${variantCellsHtml(row)}
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
      ${rows.length ? `<div class="viz-table-wrap"><table class="viz-table find-v2-results-table">
        <thead><tr><th>When</th><th>Participant</th><th>Group</th><th>Task</th><th>Answer shown</th><th>Grounding</th><th>Completed?</th><th>Answer</th><th>Scored</th><th>Time</th></tr></thead>
        <tbody>${rows.slice(0, 1000).map(row => `<tr>
          <td>${esc(new Date(row.created_at).toLocaleString())}</td>
          <td>${esc(row.participant_id)}</td>${groupCellHtml(row)}<td><code>${esc(row.task_id)}</code></td>
          <td><span class="v2-chip ${row.answer_correct_snapshot ? 'is-correct' : 'is-incorrect'}">${
            row.answer_correct_snapshot ? 'Correct' : 'Incorrect'}</span></td>
          <td><span class="v2-chip ${row.condition === 'nongrounding' ? 'is-nongrounded' : 'is-grounded'}">${
            row.condition === 'nongrounding' ? 'Non-grounded' : 'Grounded'}</span></td>
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

