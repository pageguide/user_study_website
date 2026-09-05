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
    collectEvidence: false, collectFollowup: false, taskLimitSeconds: 180,
    queueDesign: 'balanced_2x2', slotQuota: 0,
  };
  let adminPassword = '';
  let adminClaims = [];
  let editingClaim = null;
  let adminTab = 'claims';
  let variantTab = 'correct_grounding';
  // The V2 Results tab joins these two tables into one participant view. Kept after the initial
  // password-checked reads so excluding a participant can redraw every result without another RPC.
  let adminFindResults = [];
  let adminGuideResults = [];
  let adminGuideResultsError = '';
  // Per assignment_slot % 4 class, straight from the sessions table. Kept beside the result rows
  // because the recruitment panel needs a denominator the result rows cannot supply: a sitting that
  // pressed Start and answered nothing exists only there.
  let adminClassCounts = [];
  let excludedResultSessions = new Set();
  let participantResultPickerOpen = false;
  // A STANDING FILTER, not a bulk edit. "Exclude all incomplete" ticks off the incomplete sittings
  // that exist at the moment it is pressed; this stays true across a reload, so a partial sitting
  // that lands later is held out too and a cell's n cannot quietly grow by one abandoned session.
  let completedResultsOnly = false;

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

  // ── The third design: four Guide × Visual runs, the same four for everyone ─
  //
  // NO ROUND ROBIN. The two designs above deal from a pool by slot, which is what makes them
  // balanced: nobody chooses which claim lands in which cell, so nothing about the stimuli can
  // covary with the condition by a researcher's preference. This one gives that up on purpose.
  //
  // Every participant is dealt the SAME four runs in the SAME order — all Guide, all VISUAL — one
  // per cell of correctness × grounding:
  //
  //     1  Correct   × Grounded          3  Correct   × Non-grounded
  //     2  Incorrect × Non-grounded      4  Incorrect × Grounded
  //
  // WHAT IS GAINED: both factors become fully within-subjects with no counterbalancing left over, so
  // the n of every cell is just the number of completed sittings — no class can be short of another,
  // and `slot_quota` has nothing left to level. WHAT IS GIVEN UP: the stimulus is no longer crossed
  // with the condition, so a difference between cells is a difference between FOUR PARTICULAR RUNS
  // as much as between four conditions, and the four have to be chosen to be comparable by hand.
  // That choice is Admin → Study tasks, and it is the reason task_selection exists.
  //
  // The order is the one the design was specified in, and it is deliberately not
  // correct/correct/incorrect/incorrect: consecutive tasks differ in correctness, so a participant
  // cannot settle into answering the same way twice and cannot read the third cell's answer off the
  // second's.
  const GUIDE_VISUAL_CELLS = [
    { taskType: 'guide', correct: true, arm: 'grounding' },
    { taskType: 'guide', correct: false, arm: 'nongrounding' },
    { taskType: 'guide', correct: true, arm: 'nongrounding' },
    { taskType: 'guide', correct: false, arm: 'grounding' },
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
    guide_visual_4: {
      label: 'Four Guide × Visual runs — one per correctness × grounding cell, the same four for everyone',
      short: 'four fixed Guide × Visual runs',
      tasks: 4,
    },
  };

  /** The cells a design deals, in order. What the picker lists and what the queue walks. */
  function cellsOf(design) {
    if (design === 'guide_visual_4') return GUIDE_VISUAL_CELLS;
    if (design === 'legacy_find3') {
      return FIND_CELLS.map(cell => ({ taskType: 'find', correct: cell.correct, arm: cell.arm }))
        .concat([{ taskType: 'guide', correct: null, arm: 'grounding' }]);
    }
    return CROSSED_CELLS.map(cell => ({ ...cell, correct: null }));
  }

  /** Whether every cell of this design is dealt to everyone, so pinning needs no group split. */
  function designHasGroups(design) {
    return design !== 'guide_visual_4';
  }

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
  function buildCrossedQueue(claims, guideTasks, slot, selection) {
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
        // A PIN OVERRIDES THE WALK, and only for the cell it names. `picked[index]` is what the slot
        // would have dealt; a pinned claim replaces it without disturbing the other cells, so the
        // pool keeps being covered evenly by whatever is left unpinned.
        const task = pinnedTask(findPool, pinAt(selection, 'balanced_2x2', group, index))
          || picked[index];
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
      const guide = pinnedTask(guidePool, pinAt(selection, 'balanced_2x2', group, index))
        || pickGuideFor(guidePool, cycle, correct, takenGuides);
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

  // ── The pins ──────────────────────────────────────────────────────────────
  //
  // `task_selection` names the task that fills a cell, and it is read the same way by the queue and
  // by the picker that writes it. Keyed by design so switching designs to look at one does not throw
  // the other's choices away, and by group where the design still has groups:
  //
  //     { "guide_visual_4": ["ms9j3200", …],
  //       "balanced_2x2":   { "A": [null, …], "B": [ … ] } }
  //
  // A missing entry is not an error and not an empty cell — it means "not pinned", and that cell
  // falls back to the rotation its design already had. So a half-filled selection degrades to the
  // old behaviour rather than to a short queue, and the picker can be filled in one cell at a time.

  /** The pinned ids for one design and group, as a sparse array indexed by cell. */
  function pinsFor(selection, design, group) {
    const all = selection && typeof selection === 'object' ? selection : {};
    const forDesign = all[design];
    if (!forDesign) return [];
    if (Array.isArray(forDesign)) return forDesign;
    if (!designHasGroups(design)) return [];
    const forGroup = forDesign[group];
    return Array.isArray(forGroup) ? forGroup : [];
  }

  /** The pinned id for one cell, or '' — normalized so a null, a 0 and a stray object all read alike. */
  function pinAt(selection, design, group, index) {
    const id = pinsFor(selection, design, group)[index];
    return typeof id === 'string' ? id.trim() : '';
  }

  /**
   * The task a pin names, or null if it names nothing the pool still has.
   *
   * A pin that no longer resolves is NOT an error here. Untick a task in Admin and every pin to it
   * goes stale; failing the deal would take the study down over a checkbox, so the cell falls back
   * to its rotation and the picker shows the stale pin as a named gap where it can be fixed.
   */
  function pinnedTask(pool, id) {
    return id ? (pool.find(task => task.id === id) || null) : null;
  }

  /**
   * The fixed queue: four Guide × Visual runs, the same four for everyone.
   *
   * The slot is not read. It still numbers the sitting — that is the session's identity and the
   * recruitment counter's — but under this design it selects nothing, which is the whole point.
   *
   * A cell with no usable pin falls back to any live guide_visual task of the wanted correctness
   * that is not already dealt. That fallback is an accommodation for a half-filled picker, not a
   * rotation: it is deterministic, and Admin says which cells are relying on it.
   */
  function buildGuideVisualQueue(guideTasks, selection) {
    const pool = guideTasks.filter(task => task.style === 'guide_visual');
    const queue = [];
    const taken = [];
    GUIDE_VISUAL_CELLS.forEach((cell, index) => {
      const pinned = pinnedTask(pool, pinAt(selection, 'guide_visual_4', '', index));
      const spare = pool.find(task => task.agentCompleted === cell.correct && !taken.includes(task.id))
        || pool.find(task => task.agentCompleted === cell.correct)
        || null;
      const task = pinned || spare;
      if (!task) return;
      taken.push(task.id);
      queue.push({
        ...task,
        // Everyone is visual now, so there is no A/B split left to record. 'B' rather than '' keeps
        // every consumer that reads a group — the chip, the dashboards — reading the modality that
        // is actually on screen.
        group: 'B',
        arm: cell.arm,
        // THE KEY IS THE TASK'S, NOT THE CELL'S, for the same reason it is in the crossed queue: a
        // run is correct or not because of what the agent did. The cell says what this position
        // ASKED for, and a fallback may have had to settle — scoring against the request rather than
        // the recording would key an answer against a run nobody saw.
        claimCorrect: task.agentCompleted,
        variantKey: window.FindV2Variants.variantKey(task.agentCompleted !== false, cell.arm),
        assignedOrder: queue.length,
      });
    });
    return queue;
  }

  /** The four tasks this slot is dealt, in order, under the design the study is set to. */
  function buildQueue(claims, guideTasks, slot, design, selection) {
    const key = designOf(design);
    if (key === 'guide_visual_4') return buildGuideVisualQueue(guideTasks, selection);
    if (key === 'legacy_find3') return buildLegacyQueue(claims, guideTasks, slot, selection);
    return buildCrossedQueue(claims, guideTasks, slot, selection);
  }

  /** The original queue: three fixed Find cells, then one grounded Guide task. */
  function buildLegacyQueue(claims, guideTasks, slot, selection) {
    const group = groupOf(slot);
    const styles = stylesFor(group);
    const cycle = Math.floor(Number(slot) / 2);

    const findPool = claims.filter(task => task.style === styles.find);
    const guidePool = guideTasks.filter(task => task.style === styles.guide);

    const queue = pickClaims(findPool, cycle, FIND_CELLS.length).map((walked, index) => {
      const cell = FIND_CELLS[index];
      const task = pinnedTask(findPool, pinAt(selection, 'legacy_find3', group, index)) || walked;
      return {
        ...task,
        group,
        arm: cell.arm,
        claimCorrect: cell.correct,
        variantKey: window.FindV2Variants.variantKey(cell.correct, cell.arm),
        assignedOrder: index,
      };
    });

    const guide = pinnedTask(guidePool, pinAt(selection, 'legacy_find3', group, FIND_CELLS.length))
      || pickGuideTask(guidePool, cycle);
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

    // THE LIMIT CHIP, BEFORE THE RESUME BRANCH. It used to be painted only on the path that deals a
    // fresh queue, so a participant coming back to an unfinished run read "— per task" — an em dash
    // where the one promise the header makes about pacing should be. The chip reads the SETTING, not
    // a number written into the page: a welcome screen promising three minutes over a two-minute
    // clock is worse than no promise at all.
    const limitChip = document.getElementById('find-v2-task-limit');
    if (limitChip) {
      const seconds = Number(studyFlags.taskLimitSeconds) || 180;
      limitChip.textContent = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
    }

    // AN UNFINISHED RUN RESUMES UNDER THE DESIGN IT WAS DEALT UNDER, always — the queue is saved with
    // the run, and re-dealing it mid-sitting would make task 4 belong to a different experiment from
    // task 1. What was missing is that nothing SAID so, so a pilot run left on this browser under the
    // old three-cell queue came back as "Continue →" with no hint that it was not the design now set,
    // and it looked like the setting had not taken.
    //
    // Now it is named, and ANY unfinished run can be thrown away — not only one dealt under a
    // superseded design. The button used to appear only for a stale queue, on the reasoning that a
    // participant mid-sitting should not be shown a control that destroys their progress. In
    // practice the case it left unhandled is the common one: a run abandoned halfway, a browser
    // shared between pilots, somebody who wants to start again from a clean sheet. Their only way
    // out was clearing site data, and a study whose escape hatch is devtools does not have one.
    //
    // What keeps it safe is the button itself: it is quiet, it sits apart from Continue, and it
    // asks a second time before it does anything — see addDiscardButton.
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
      addDiscardButton();
      return;
    }

    // Every queue is four tasks now, whatever the pools hold, so the chip does not count the pool.
    // Both designs deal four; what differs is how they are split between Find and Guide, which is a
    // researcher's concern and not something to put in front of a participant.
    const design = currentDesign();
    const guideSlots = design === 'guide_visual_4' ? 4 : design === 'legacy_find3' ? 1 : 2;
    const findSlots = design === 'guide_visual_4' ? 0 : design === 'legacy_find3' ? FIND_CELLS.length : 2;
    countChip.textContent = String(findSlots + (liveGuideTasks.length ? guideSlots : 0));
    // THE FIXED DESIGN DEALS NO FIND CLAIMS AT ALL, so an empty claim pool is not a reason to refuse
    // to start under it — the old check would have held the study shut over a table it never reads.
    if (design === 'guide_visual_4') {
      const visual = liveGuideTasks.filter(task => task.style === 'guide_visual');
      if (!visual.some(task => task.agentCompleted === true)
        || !visual.some(task => task.agentCompleted === false)) {
        say('This study deals four Guide × Visual runs and needs at least one keyed “completed” '
          + 'and one keyed “did not complete”. Open Admin → Study tasks.', true);
        count.textContent = `${visual.length} Guide × Visual task${visual.length === 1 ? '' : 's'} in the study.`;
        return;
      }
      const dealt = buildGuideVisualQueue(liveGuideTasks, studyFlags.taskSelection);
      // Cleared explicitly on the healthy path. `say` is the only thing that clears the "Loading
      // Find V2…" the page ships with, so an early return that never calls it leaves a participant
      // looking at a spinner's worth of words over a Start button that works.
      say(dealt.length < GUIDE_VISUAL_CELLS.length
        ? `Only ${dealt.length} of the four Guide × Visual cells can be filled. `
          + 'Open Admin → Study tasks to choose a run for each.'
        : '', dealt.length < GUIDE_VISUAL_CELLS.length);
      countChip.textContent = String(dealt.length || GUIDE_VISUAL_CELLS.length);
      // SILENT WHEN IT IS HEALTHY, like the path below. Which four runs everyone is dealt is a
      // researcher's business — it is spelled out in Admin → Study tasks — and putting it on the
      // welcome screen tells a participant what they are about to be shown before they are shown it.
      count.textContent = '';
      if (!dealt.length) return;
      start.disabled = false;
      start.onclick = beginStudy;
      return;
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
      ? 'Ready — Find only. No Guide task is available yet; run sql/020_supabase_v2_guide.sql, then scripts/migrate_guide_v2.mjs, then tag them in Admin → Guide tasks.'
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
   * Offered for EVERY unfinished run — see the note at the call — which is why it asks twice: the
   * first press only arms it, and the label changes to say what the second press will do.
   *
   * IT CLEARS THE BROWSER'S COPY, and nothing else. Answers already written to Supabase stay where
   * they are, which is the honest thing: those tasks were genuinely completed, and a discarded run
   * is an abandoned sitting rather than a retraction. The new run gets its own session id.
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
        button.textContent = 'Discard this run and its saved answers — click again to confirm';
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
      // The fixed design has no A/B split — everyone is visual — so the group is a property of the
      // DESIGN there, not of the slot. Reading the slot's parity would label half the sittings "A ·
      // text" while dealing them four visual runs.
      group: currentDesign() === 'guide_visual_4' ? 'B' : groupOf(assignment.assignmentSlot),
      // `admin` walks the same queue a participant gets, with ← → and nothing recorded.
      previewNav: S.isPreviewId(participantId),
      queue: buildQueue(liveTasks, liveGuideTasks, assignment.assignmentSlot, currentDesign(),
        studyFlags.taskSelection),
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


  /**
   * The tabs, and the one that only exists under one design.
   *
   * `The four cells` is DESIGN-CONDITIONAL, not always-present-and-empty. It previews the four runs
   * a fixed queue deals, each in the arm that queue deals it in — under a rotating design there is
   * no such thing, because which run fills a cell is decided per sitting by the slot. A tab that
   * answered "it depends on the participant" would be worse than no tab: it is a screen people open
   * to check what everyone is about to see, and the whole reason it can answer that is that the
   * fixed design makes "everyone" a meaningful word.
   */
  function adminTabsHtml() {
    const tabs = [
      ['claims', 'Edit claims'],
      ['results', 'Results'],
      ['guide', 'Guide tasks'],
      ['tasks', 'Study tasks'],
      ['arms', 'Guide arms'],
    ];
    if (currentDesign() === 'guide_visual_4') tabs.push(['cells', 'The four cells']);
    tabs.push(['preview', 'Session preview'], ['walkthrough', 'Walkthrough'], ['settings', 'Study settings']);
    return tabs.map(([key, label]) => `<button class="admin-tab${
      adminTab === key ? ' admin-tab-on' : ''}" data-v2-tab="${key}">${esc(label)}</button>`).join('');
  }

  /** Re-hang the click handlers after the strip is rebuilt in place. */
  function bindAdminTabs() {
    adminPanel.querySelectorAll('[data-v2-tab]').forEach(button => {
      button.onclick = () => {
        adminTab = button.dataset.v2Tab;
        renderAdminShell();
      };
    });
  }

  function renderAdminShell() {
    // The design can change under a tab that only exists beneath one — switch to guide_visual_4,
    // open The four cells, switch back. Falling back to the picker rather than to a blank pane keeps
    // the admin on the screen that explains why the tab went away.
    if (adminTab === 'cells' && currentDesign() !== 'guide_visual_4') adminTab = 'tasks';

    adminPanel.innerHTML = `
      <div class="admin-title">🔓 Find V2 Admin <span class="admin-warn">changes V2 only</span></div>
      <div class="admin-tabs">${adminTabsHtml()}</div>
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

    bindAdminTabs();
    document.getElementById('find-v2-admin-exit').onclick = () => {
      forgetAdminPassword();
      editingClaim = null;
      // THE PICKER'S UNSAVED TICKS GO WITH THE SESSION, like the half-edited claim above them. They
      // are a draft against a pool that was read when the tab opened; coming back later and pressing
      // Save would write them against whatever the pool is by then, including rows another admin has
      // since changed. Dropping them costs a re-tick; keeping them can silently move a study.
      pickerDraft = null;
      // Every cached read goes with the session. Admin is where the database is CHANGED, so a list
      // that outlives one visit is a list that can describe the study as it was before the last edit.
      pickerTasks = null;
      previewTasks = null;
      armsTasks = null;
      cellsTasks = null;
      adminClaims = [];
      adminPanel.hidden = true;
      adminPanel.innerHTML = '';
    };
    if (adminTab === 'results') renderResults();
    else if (adminTab === 'settings') renderSettings();
    else if (adminTab === 'guide') renderGuideTasks();
    else if (adminTab === 'tasks') renderTaskPicker();
    else if (adminTab === 'arms') renderGuideArms();
    else if (adminTab === 'cells') renderGuideVisualCells();
    else if (adminTab === 'preview') renderSessionPreview();
    else if (adminTab === 'walkthrough') renderWalkthroughTab();
    else renderClaims();
  }

  // ── The walkthrough, inspectable ─────────────────────────────────────────
  //
  // THE REAL THING IN A FRAME, not a description of it. The walkthrough only exists on the task
  // page: it needs the two panes, the instrument, the snapshot iframe and the coachmarks that
  // measure against them. So this embeds `study.html?tutorial=preview` — the same URL the study
  // itself answers — and everything inside works, Back and Next included.
  //
  // THE PREVIEW CLAIMS NO ASSIGNMENT SLOT and writes nothing: it seeds a participant id that says
  // ADMIN-PREVIEW, builds no queue and never reaches the result path. Checking some wording must not
  // spend a participant's place in the round robin.

  /**
   * The walkthrough preview URL, carrying the design.
   *
   * THE PREVIEW HAS NO DEALT QUEUE — it builds none on purpose, so that checking some wording does
   * not spend a participant's place in the round robin — and the queue is what the walkthrough
   * normally reads to decide whether to rehearse a Find task. So the design has to be handed to it,
   * and this tab is where it is known. Without it the preview would always show the two-task
   * walkthrough, including for a study that deals no Find task at all — which is precisely the
   * mismatch a preview exists to catch.
   */
  function walkthroughPreviewUrl() {
    return `study.html?tutorial=preview&design=${encodeURIComponent(currentDesign())}`;
  }

  function renderWalkthroughTab() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = `
      <p class="viz-note">The walkthrough as a participant meets it — two practice tasks, one Find
        and one Guide, with the coachmarks pointing at the real screen. It is the live page in a
        frame, so Back, Next, Skip and both practice answers all work. Nothing here claims an
        assignment slot or writes a row.</p>

      <div class="preview-chips walkthrough-tools">
        <button class="admin-chip" id="v2-walk-reload">Restart it</button>
        <a class="admin-chip" href="${esc(walkthroughPreviewUrl())}" target="_blank" rel="noopener">Open full size ↗</a>
        <span class="welcome-status" id="v2-walk-note"></span>
      </div>

      <div class="walkthrough-frame">
        <iframe id="v2-walk-frame" title="The Find V2 walkthrough"
          src="${esc(walkthroughPreviewUrl())}"></iframe>
      </div>

      <p class="viz-note">The coachmarks are positioned against the elements the study renders, and
        they measure the window they are in — so this frame is a fair test of where a card lands only
        at roughly the size a participant's window would be. If a card looks wrong here, check it
        full size before changing anything.</p>

      <h3 class="admin-subtitle">When a participant is offered it</h3>
      <p class="viz-note">Once per <b>run</b>, before task 1, and skippable. It used to be once per
        <b>browser</b>, which meant the second participant to sit at a machine started with no
        practice while the first got two — a difference between participants that nothing in the
        analysis could see. Every new sitting is offered it now; a refresh partway through task 1 is
        not, because the mark names the run in progress.</p>`;

    const note = document.getElementById('v2-walk-note');
    document.getElementById('v2-walk-reload').onclick = () => {
      const frame = document.getElementById('v2-walk-frame');
      // Re-assigned rather than reload()ed: the walkthrough marks itself done against the run it was
      // taken in, and a fresh document is the only way to start it from the first screen again.
      frame.src = `${walkthroughPreviewUrl()}&t=${Date.now()}`;
      note.textContent = 'Restarted.';
      note.className = 'welcome-status';
    };
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
        <b>milestone</b>. Before turning it on for participants, note that it is a second
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
    const limit = Number(studyFlags.taskLimitSeconds) || 180;
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
    // RE-READ EVERY TIME THIS TAB IS OPENED. It used to fetch once and keep the list for the life of
    // the page, so a task renamed or re-keyed in Supabase went on showing its old title here until
    // somebody happened to reload — and the one thing this tab is for is checking what a participant
    // will see. The query is the list columns only (no `arms`, so no screenshots), which is why
    // paying for it on every visit costs nothing worth saving.
    try { previewTasks = (await DB.listAllGuideTasks()).filter(row => row.in_study); }
    catch (error) {
      previewTasks = null;
      content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
      return;
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
   * BOTH ARE OFF BY DEFAULT, in the database rather than here — see sql/010_supabase_v2_flags.sql. The
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
          'Flag the trail’s steps in the grounded journey',
          'Marks the View Journey rows the reasoning trail accounts for as <b>milestone</b>, '
          + 'and counts them on the fold. On by default, and the walkthrough follows it. It is a real '
          + 'manipulation: it changes where a participant looks first, and it points at the steps the '
          + 'agent <em>chose</em> to narrate — which, for a run that misreports what it saw, is exactly '
          + 'where the discrepancy is not. <b>Grounded tasks only</b>: a flag on a row that cannot be '
          + 'opened points at a step a non-grounded participant has no way to check.')}
        ${row('v2-show-group', flags.showGroupChip,
          'Show participants their group',
          'Adds a <b>GROUP A · text</b> / <b>GROUP B · visual</b> chip beside the condition banner. '
          + 'Off by default: it names a factor the participant is not asked about and cannot act on, '
          + 'and a label saying they are in a group invites them to wonder what the other group is '
          + 'getting. Useful for piloting and for screenshots. The condition banner is unaffected — '
          + 'that one says what is on the screen, which a participant does need.')}
        ${row('v2-allow-browse-sim', flags.allowBrowseSim,
          'Offer “simulate the browsing” on Guide tasks',
          'A button above the journey that opens the run as a slideshow — one page state per step, '
          + 'starting on the page the agent finished on and walked <b>backwards</b> with Back and '
          + 'Next. <b>Offered in both arms</b>, so it is a constant of the study rather than part of '
          + 'what separates them. What the arms differ in is the checkable journey — the milestone '
          + 'flags, the hover and the click all belong to the grounded one — and both get the same '
          + 'walk. Whether it was opened, and how far back it was walked, lands in each row\'s '
          + '<code>interaction_summary.browse_sim</code> — comparable across the arms, and a session '
          + 'that never pressed it can still be analysed as the condition that ran before it existed.')}
        <label class="q-opt q-opt-rich admin-setting">
          <span class="q-opt-body"><span><b>How long a simulated page takes to load</b><small>The
            pause between pressing Back or Next and the next page appearing. Browsing is not
            instant, and at <b>0</b> the buttons scrub — a fourteen-step run empties in a second and
            no page is on screen long enough to read. This is the one number here that changes what
            the walk <em>measures</em>: it sets the cost of going to look, which is the difference
            between the evidence being available and being worth going to get. Between 0 and 5000
            milliseconds.</small></span></span>
          <span class="admin-limit">
            <input type="number" id="v2-browse-delay" min="0" max="5000" step="50"
              value="${Number.isFinite(Number(flags.browseSimDelayMs))
                ? Math.round(Number(flags.browseSimDelayMs)) : 500}"> ms
          </span>
        </label>
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
              value="${Number(flags.taskLimitSeconds) || 180}"> seconds
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
        ${designOptionHtml('guide_visual_4', design,
          'Four Guide × Visual runs — the same four for everyone',
          'Four tasks, all Guide, all visual: <b>Correct × Grounded</b>, <b>Incorrect × '
          + 'Non-grounded</b>, <b>Correct × Non-grounded</b>, <b>Incorrect × Grounded</b>, in that '
          + 'order. <b>No round robin</b> — the slot no longer picks anything, so correctness and '
          + 'grounding are both fully within-subjects and every cell\'s n is simply the number of '
          + 'completed sittings. No Find claim is dealt, and there is no text group. In exchange the '
          + 'stimulus stops being crossed with the condition: a difference between cells is a '
          + 'difference between four particular runs as much as between four conditions, so the four '
          + 'have to be chosen to be comparable. Choose them in <b>Study tasks</b>.')}
        ${designOptionHtml('legacy_find3', design,
          'Three Find cells + one grounded Guide task',
          'The original V2 queue: Find grounded/incorrect, Find non-grounded/correct, Find '
          + 'non-grounded/incorrect — there is deliberately no correct-and-grounded Find task — then '
          + 'one <b>grounded</b> Guide task whose key alternates. Guide is never non-grounded here, '
          + 'so nothing in it estimates grounding for the Guide half.')}
      </div>
      <div id="v2-dealt-tasks">${dealtTasksHtml(design)}</div>

      <h3 class="admin-subtitle">Recruit to a target</h3>
      <p class="viz-note">A slot's class — <code>assignment_slot % 4</code> — decides everything about
        a sitting, so the number of <b>completed</b> sittings in a class is identically the n of four
        Find cells <em>and</em> four Guide cells. The queue deals the four classes evenly; who
        finishes does not, and plain round-robin preserves a shortfall instead of closing it. Set a
        target above zero and each new sitting is dealt the class furthest from it. <b>0 is off</b> —
        plain round-robin, exactly as before. The Results tab shows the standings.</p>
      <div class="admin-settings">
        <label class="q-opt q-opt-rich admin-setting">
          <span class="q-opt-body"><span><b>Completed sittings wanted per class</b>
            <small>Four classes, so the study is finished at four times this number. The counter only
              ever skips <em>forward</em>: a slot also picks which claims are dealt, so rewinding it
              would re-deal the same stimuli to a later participant.</small></span></span>
          <span class="admin-limit">
            <input type="number" id="v2-slot-quota" min="0" max="200" step="1"
              value="${Number(flags.slotQuota) || 0}"> per class
          </span>
        </label>
      </div>

      <h3 class="admin-subtitle">The post-study questionnaire</h3>
      <p class="viz-note">The form the final screen links to and embeds, asked once after the last
        task. <b>Leave it blank to use the built-in form</b> — an empty box falls back to
        <code>app/find_v2_config.js</code> and then to the address compiled into the page, so the
        last step of the study cannot be removed by clearing a text field. Changing it takes effect
        for everyone immediately, including runs already in progress: the final screen is reached
        once, at the end, and the right form is whichever one is current then.</p>
      <div class="admin-settings">
        <label class="q-opt q-opt-rich admin-setting admin-setting-wide">
          <span class="q-opt-body"><span><b>Survey URL</b><small>Prefer the long
            <code>docs.google.com/forms/d/e/…/viewform</code> address over a
            <code>forms.gle</code> short link — see the note below if you paste a short
            one.</small></span></span>
        </label>
        <input class="welcome-input" id="v2-survey-url" type="url" spellcheck="false"
          placeholder="https://docs.google.com/forms/d/e/…/viewform"
          value="${esc(flags.postSurveyUrl || '')}">
        <p class="welcome-status" id="v2-survey-note"></p>
        <div class="preview-chips">
          <a class="admin-chip" id="v2-survey-open" target="_blank" rel="noopener"
            href="${esc(flags.postSurveyUrl || '')}">Open the form ↗</a>
          <a class="admin-chip" href="study.html?finish=preview" target="_blank" rel="noopener">Preview the final screen ↗</a>
        </div>
      </div>

      <h3 class="admin-subtitle">The walkthrough</h3>
      <p class="viz-note">Two practice tasks, one Find and one Guide, offered once before task 1 and
        skippable. The material is invented — a pool timetable — and nothing about it is in the
        study; a practice answer builds no row and never advances the queue. It is offered on a
        browser that has not seen it, so a researcher who has already taken it needs the second
        button to be shown it again <b>on this browser</b>.</p>
      <div class="preview-chips">
        <a class="admin-chip" href="${esc(walkthroughPreviewUrl())}" target="_blank" rel="noopener">Preview the walkthrough ↗</a>
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

    // THE SHORT-LINK WARNING, live rather than on save. `?embedded=true` is what strips Google's page
    // chrome from the frame, and a forms.gle link is a 302 — a redirect does not carry a query string
    // forward, so the parameter is dropped and the final screen embeds the full Google Forms page
    // inside itself. It still works and a participant can still submit, which is why this warns
    // instead of refusing: it is a cosmetic cost with an easy fix, not a broken study.
    const surveyInput = content.querySelector('#v2-survey-url');
    const surveyNote = content.querySelector('#v2-survey-note');
    const surveyOpen = content.querySelector('#v2-survey-open');
    const paintSurveyNote = () => {
      const value = String(surveyInput.value || '').trim();
      surveyOpen.href = value;
      surveyOpen.classList.toggle('is-disabled', !value);
      if (!value) {
        surveyNote.textContent = 'Blank — the built-in form is used.';
        surveyNote.className = 'welcome-status';
        return;
      }
      if (!/^https:\/\//i.test(value)) {
        surveyNote.textContent = 'The survey URL must start with https://.';
        surveyNote.className = 'welcome-status welcome-status-bad';
        return;
      }
      if (/^https:\/\/forms\.gle\//i.test(value)) {
        surveyNote.innerHTML = '<b>This is a forms.gle short link.</b> It works, and participants '
          + 'can submit — but a short link is a redirect, and a redirect drops the '
          + '<code>?embedded=true</code> the final screen appends, so the form is framed with '
          + 'Google’s full page chrome inside it. For a clean embed, open the form → <b>Send</b> → '
          + 'the link tab → untick <b>Shorten URL</b>, and paste the long '
          + '<code>…/viewform</code> address here instead.';
        surveyNote.className = 'welcome-status welcome-status-bad';
        return;
      }
      surveyNote.textContent = 'Looks embeddable.';
      surveyNote.className = 'welcome-status';
    };
    surveyInput.oninput = paintSurveyNote;
    paintSurveyNote();

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
        const quota = Number(document.getElementById('v2-slot-quota').value);
        if (!Number.isFinite(quota) || quota < 0 || quota > 200) {
          button.disabled = false;
          return setStatus('The per-class recruitment target must be between 0 and 200 (0 is off).', true);
        }
        const delay = Number(document.getElementById('v2-browse-delay').value);
        if (!Number.isFinite(delay) || delay < 0 || delay > 5000) {
          button.disabled = false;
          return setStatus('The simulated page load must be between 0 and 5000 milliseconds.', true);
        }
        const surveyUrl = String(surveyInput.value || '').trim();
        if (surveyUrl && !/^https:\/\//i.test(surveyUrl)) {
          button.disabled = false;
          return setStatus('The survey URL must be an https:// address, or blank for the built-in form.', true);
        }
        const saved = await DB.saveStudyFlags(adminPassword, {
          collectEvidence: document.getElementById('v2-collect-evidence').checked,
          collectFollowup: document.getElementById('v2-collect-followup').checked,
          taskLimitSeconds: Math.round(seconds),
          queueDesign: chosenDesign(),
          showGroupChip: document.getElementById('v2-show-group').checked,
          flagMilestones: document.getElementById('v2-flag-milestones').checked,
          showReasoningTrail: document.getElementById('v2-show-trail').checked,
          slotQuota: Math.round(quota),
          allowBrowseSim: document.getElementById('v2-allow-browse-sim').checked,
          browseSimDelayMs: Math.round(delay),
          postSurveyUrl: surveyUrl,
        });
        // Reflect what the SERVER stored, not what the boxes said — the two differ if a write is
        // rejected, and a panel that reports its own optimism is how a pilot runs the wrong protocol.
        const designChanged = designOf(saved.queueDesign) !== designOf(studyFlags.queueDesign);
        studyFlags = saved;
        // THE STRIP ONLY, not the whole shell. `The four cells` exists only under the fixed design,
        // so saving a switch to it has to make the tab appear — but re-rendering the shell would
        // throw away the settings pane and the "Saved…" line that says the switch landed, which
        // reads as the save having failed.
        if (designChanged) {
          const strip = adminPanel.querySelector('.admin-tabs');
          if (strip) { strip.innerHTML = adminTabsHtml(); bindAdminTabs(); }
        }
        setStatus(`Saved. Evidence: ${saved.collectEvidence ? 'on' : 'off'} · Follow-up: `
          + `${saved.collectFollowup ? 'on' : 'off'} · ${saved.taskLimitSeconds}s per task · queue: `
          + `${DESIGNS[designOf(saved.queueDesign)].short} · group chip: `
          + `${saved.showGroupChip ? 'shown' : 'hidden'} · milestones: `
          + `${saved.flagMilestones ? 'flagged' : 'not flagged'} · trail: `
          + `${saved.showReasoningTrail ? 'shown' : 'hidden'} · recruiting: `
          + `${saved.slotQuota > 0 ? `${saved.slotQuota} per class` : 'round-robin'} · browse `
          + `simulator: ${saved.allowBrowseSim
            ? `offered, ${saved.browseSimDelayMs}ms per page` : 'off'} · survey: `
          + `${saved.postSurveyUrl ? saved.postSurveyUrl : 'the built-in form'}.`
          // TWO DIFFERENT RULES, said apart because they really are different. The protocol flags
          // are snapshotted at Start, so a run under way keeps them; the survey URL is read at the
          // END, so a change reaches everyone including people already answering.
          + ' Runs already in progress keep the protocol they started with —'
          + ' except the survey, which is read when the final screen is reached.');
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
      button.disabled = false;
    };
  }

  // ── Guide arms: the two conditions, side by side, both live ───────────────
  //
  // WHAT IT IS FOR. The grounded and non-grounded arms of a Guide run are the study's independent
  // variable, and until now the only way to compare them was to render one, change a dropdown, and
  // compare the second against your memory of the first. Everything that matters here is a
  // difference — which chips survive, which step rows lose their screenshot, what the answer says
  // once its [ev:] markers are stripped — and a difference is the one thing memory is worst at.
  //
  // BOTH PANES ARE REAL AND BOTH ARE LIVE. Hover a grounded step and its screenshot appears; press
  // the non-grounded pane's simulate button and the walk opens. That is deliberate: this tab is
  // where the simulator gets checked before a participant meets it.
  //
  // WHY IFRAMES. app/stimulus.js holds the mounted arm in module-level state and marks the
  // non-grounded condition with a class on document.body — so two mounts in one document silently
  // become one arm shown twice. A frame each gives both panes their own document and their own copy
  // of the renderer, unchanged. See the note at the top of guide-arm.html.

  let armsTasks = null;
  let armsOpts = { id: '', trail: false, milestones: true, sim: true };

  function armFrameUrl(id, arm) {
    const params = new URLSearchParams({
      task: id,
      arm,
      trail: armsOpts.trail ? '1' : '0',
      milestones: armsOpts.milestones ? '1' : '0',
      sim: armsOpts.sim ? '1' : '0',
      // The study's own page delay, so the walk in this frame is timed the way a participant's is.
      delay: String(Number.isFinite(Number(studyFlags.browseSimDelayMs))
        ? Math.round(Number(studyFlags.browseSimDelayMs)) : 500),
    });
    return `guide-arm.html?${params.toString()}`;
  }

  async function renderGuideArms() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Loading the Guide runs…</div>';

    // Re-read on every open, for the reason given in renderSessionPreview: a cached list is a list
    // that can disagree with the database, and this tab exists to show what the database holds.
    try { armsTasks = await DB.listAllGuideTasks(); }
    catch (error) {
      armsTasks = null;
      content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
      return;
    }
    if (!armsTasks.length) {
      content.innerHTML = `<p class="viz-note">No Guide run exists yet. Run
        <code>node scripts/migrate_guide_v2.mjs</code>, then key them in <b>Guide tasks</b>.</p>`;
      return;
    }
    if (!armsTasks.some(task => task.id === armsOpts.id)) {
      // Prefer one that is actually in the study: an admin opening this tab is nearly always
      // checking something a participant will be shown, not something held out.
      armsOpts.id = (armsTasks.find(task => task.in_study) || armsTasks[0]).id;
    }

    const chosen = armsTasks.find(task => task.id === armsOpts.id);
    const key = typeof chosen?.agent_completed === 'boolean'
      ? (chosen.agent_completed ? 'Completed' : 'Did not complete') : 'Not keyed';

    content.innerHTML = `
      <p class="viz-note">The same run under both conditions, at the same moment, both fully live.
        The grounded pane shows a screenshot per step on hover; the non-grounded one shows the steps
        as text. When the simulator is on, <b>both</b> panes carry it — it is offered in either arm,
        so the difference this comparison is for is the per-step evidence rather than the walk.
        <b>Nothing on this screen is recorded</b>, and the button's use here does not reach any
        result row.</p>

      <div class="preview-chips arms-tools">
        <label class="q-sub" for="arms-task">Run</label>
        <select class="welcome-input" id="arms-task">
          ${armsTasks.map(task => `<option value="${esc(task.id)}"${task.id === armsOpts.id ? ' selected' : ''}>${
            esc(task.title || task.goal || task.id)}${task.in_study ? '' : ' — held out'}</option>`).join('')}
        </select>
        <label class="picker-tick"><input type="checkbox" data-arms-opt="sim"${armsOpts.sim ? ' checked' : ''}> Simulate-browsing button</label>
        <label class="picker-tick"><input type="checkbox" data-arms-opt="trail"${armsOpts.trail ? ' checked' : ''}> Reasoning trail</label>
        <label class="picker-tick"><input type="checkbox" data-arms-opt="milestones"${armsOpts.milestones ? ' checked' : ''}> Flag milestones</label>
      </div>
      <p class="viz-note">${esc(chosen?.task_style === 'guide_visual' ? 'Visual' : 'Text')} ·
        answer key <b>${esc(key)}</b> · ${chosen?.in_study ? 'in the study' : 'held out of the study'}.
        ${chosen?.task_style === 'guide_text' ? '<b>A text-mode run was recorded with no step '
          + 'screenshots at all</b>, so its grounded arm has nothing to show and the simulator has '
          + 'nothing to walk — the two panes will look alike, and that is the recording rather than '
          + 'a fault in this screen.' : ''}</p>

      <div class="arms-frames">
        <div class="arms-pane">
          <div class="arms-label"><span class="v2-chip is-grounded">Grounded</span>
            each step can be checked against the page it was taken on</div>
          <iframe class="arms-frame" id="arms-grounding" title="The grounded arm"
            src="${esc(armFrameUrl(armsOpts.id, 'grounding'))}"></iframe>
        </div>
        <div class="arms-pane">
          <div class="arms-label"><span class="v2-chip is-nongrounded">Non-grounded</span>
            the steps as text${armsOpts.sim ? ', plus the button that walks the pages' : ''}</div>
          <iframe class="arms-frame" id="arms-nongrounding" title="The non-grounded arm"
            src="${esc(armFrameUrl(armsOpts.id, 'nongrounding'))}"></iframe>
        </div>
      </div>

      <div class="preview-chips">
        <a class="admin-chip" id="arms-open-g" href="${esc(armFrameUrl(armsOpts.id, 'grounding'))}"
          target="_blank" rel="noopener">Open the grounded arm full size ↗</a>
        <a class="admin-chip" id="arms-open-n" href="${esc(armFrameUrl(armsOpts.id, 'nongrounding'))}"
          target="_blank" rel="noopener">Open the non-grounded arm full size ↗</a>
      </div>

      <h3 class="admin-subtitle">What the two panes differ in</h3>
      <p class="viz-note">Read from <code>_stripGuideArm</code> in
        <code>vendor/guide_trajectories.js</code>, which is the definition of the non-grounded arm
        rather than a description of it — so this cannot claim a difference the renderer does not
        make.</p>
      <div class="viz-table-wrap"><table class="viz-table">
        <thead><tr><th></th><th>Grounded</th><th>Non-grounded</th></tr></thead>
        <tbody>
          <tr><td><b>Step screenshots</b></td><td>one per step, on hover and click</td><td>none — nulled by the strip</td></tr>
          <tr><td><b>Milestone flags</b></td><td>the steps the trail narrates are marked, with a legend saying they can be checked instead of the whole journey</td><td>none — a flag pointing at a row that does not open is a signpost to a door that is not there</td></tr>
          <tr><td><b>“You can click the steps”</b></td><td>shown under the legend</td><td>not shown — the rows do not open</td></tr>
          <tr><td><b>Answer evidence chips</b></td><td>numbered, and they open what the agent saw</td><td>none, and the <code>[ev:…]</code> markers are removed from the prose</td></tr>
          <tr><td><b>Linked phrases in the answer</b></td><td>underlined, and they open a screenshot</td><td>plain text</td></tr>
          <tr><td><b>Before / after page states</b></td><td colspan="2">shown in <b>both</b> — the arms differ in whether each <em>action</em> can be checked, not in whether the outcome is known</td></tr>
          <tr><td><b>Steps, order, wording, answer</b></td><td colspan="2">identical — the same run, renumbered only if the strip had to</td></tr>
          <tr><td><b>Simulate browsing</b></td><td colspan="2">${armsOpts.sim
            ? 'offered in <b>both</b> — the run as a slideshow, opening on the last page and walked '
              + 'back one at a time. It is a constant of the study, not part of what separates the '
              + 'arms; what it changes is how much work checking a step is, which is what the '
              + 'grounded column above already gives away for free'
            : 'switched off for this preview'}</td></tr>
        </tbody>
      </table></div>`;

    content.querySelector('#arms-task').onchange = (event) => {
      armsOpts.id = event.target.value;
      renderGuideArms();
    };
    content.querySelectorAll('[data-arms-opt]').forEach(box => {
      box.onchange = () => {
        armsOpts[box.dataset.armsOpt] = box.checked;
        renderGuideArms();
      };
    });
  }

  // ── The four cells: the fixed queue, previewed as it is dealt ─────────────
  //
  // ONLY UNDER `guide_visual_4`, and that is the point rather than a limitation. Under a rotating
  // design "the four tasks" is not a thing that exists: the slot decides which run fills each cell,
  // so the honest answer is per-participant and this screen could only lie about it. The fixed
  // design is what makes "what is everyone about to see?" a question with one answer, and this is
  // the screen that answers it.
  //
  // HOW IT DIFFERS FROM Guide arms. That tab takes one run and shows BOTH arms, to study the
  // difference between the conditions. This one takes the four cells and shows each in THE ARM IT IS
  // ACTUALLY DEALT IN — cell 1 grounded, cell 2 non-grounded, and so on. Nobody is ever shown the
  // grid Guide arms draws; this is the four screens a participant really meets, in order.
  //
  // IT RESOLVES THROUGH buildGuideVisualQueue, the same function the study deals with, so a cell
  // that is falling back to an unpinned run shows the run it will actually fall back to rather than
  // the one somebody meant to pin.

  let cellsTasks = null;
  let cellsOpen = 0;          // which cell's frame is expanded; the rest are collapsed

  /** One cell's frame, in the arm it is dealt in and under the study's own switches. */
  function cellFrameUrl(task, cell) {
    const params = new URLSearchParams({
      task: task.id,
      arm: cell.arm,
      sim: studyFlags.allowBrowseSim ? '1' : '0',
      delay: String(Math.round(Number(studyFlags.browseSimDelayMs) || 500)),
      trail: studyFlags.showReasoningTrail ? '1' : '0',
      milestones: studyFlags.flagMilestones ? '1' : '0',
    });
    return `guide-arm.html?${params.toString()}`;
  }

  async function renderGuideVisualCells() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Resolving the four cells…</div>';

    let flags;
    try {
      [cellsTasks, flags] = await Promise.all([DB.listStudyGuideTasks(), DB.getStudyFlags()]);
    } catch (error) {
      content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
      return;
    }
    studyFlags = flags;
    // Read again after the await: the design is what puts this tab on the strip, and it can have
    // been changed in another tab while this one was fetching.
    if (currentDesign() !== 'guide_visual_4') return renderAdminShell();

    const dealt = buildGuideVisualQueue(cellsTasks, flags.taskSelection);
    const pins = pinsFor(flags.taskSelection, 'guide_visual_4', '');
    cellsOpen = Math.min(cellsOpen, Math.max(0, dealt.length - 1));

    const missing = GUIDE_VISUAL_CELLS.length - dealt.length;
    const repeated = [...new Set(dealt.map(t => t.id).filter((id, i, all) => all.indexOf(id) !== i))];

    content.innerHTML = `
      <p class="viz-note">The four tasks <b>every participant</b> is dealt, in order, each rendered in
        the arm it is dealt in — resolved through <code>buildGuideVisualQueue</code>, the same
        function the study deals with, so a cell that is falling back shows the run it will really
        fall back to. Which run fills each cell is chosen in <b>Study tasks</b>. Nothing here is
        recorded.</p>

      ${missing > 0 ? `<p class="welcome-status welcome-status-bad">${missing} of the four cells
        cannot be filled at all — the pool has no live Guide × Visual run with the right answer key.
        A participant starting now would be dealt ${dealt.length} task${dealt.length === 1 ? '' : 's'}.</p>` : ''}
      ${repeated.length ? `<p class="welcome-status welcome-status-bad">${esc(repeated.join(', '))}
        fill${repeated.length === 1 ? 's' : ''} more than one cell, so a participant reads the same
        run twice and answers the second from the first.</p>` : ''}

      <div class="cells-grid">
        ${GUIDE_VISUAL_CELLS.map((cell, index) => {
          const task = dealt[index];
          const pinned = typeof pins[index] === 'string' ? pins[index].trim() : '';
          const fellBack = !!task && (!pinned || pinned !== task.id);
          const open = index === cellsOpen;
          return `
            <section class="cells-card${open ? ' is-open' : ''}">
              <button type="button" class="cells-head" data-cell-open="${index}"
                aria-expanded="${open ? 'true' : 'false'}">
                <span class="cells-n">${index + 1}</span>
                <span class="cells-chips">
                  <span class="v2-chip ${cell.correct ? 'is-correct' : 'is-incorrect'}">${cell.correct ? 'Correct' : 'Incorrect'}</span>
                  <span class="v2-chip ${cell.arm === 'nongrounding' ? 'is-nongrounded' : 'is-grounded'}">${
                    cell.arm === 'nongrounding' ? 'Non-grounded' : 'Grounded'}</span>
                </span>
                <span class="cells-title">${task
                  ? esc(task.title || task.goal || task.id)
                  : '<em>nothing eligible in the pool</em>'}</span>
                <span class="cells-toggle" aria-hidden="true">${open ? '▾' : '▸'}</span>
              </button>
              <p class="cells-note">${task ? `
                <code>${esc(task.id)}</code> ·
                ${pinned && pinned === task.id
                  ? 'pinned in Study tasks'
                  : `<b>not pinned</b> — this is the fallback${
                      pinned ? `, because <code>${esc(pinned)}</code> is not in the pool for this cell` : ''}`}
                ${studyFlags.allowBrowseSim
                  ? ` · the walk is offered, ${Math.round(Number(studyFlags.browseSimDelayMs) || 500)}ms a page`
                  : ' · the walk is switched off'}
                ${task.agentCompleted === cell.correct ? '' :
                  ' · <b class="cells-warn">its answer key does not match this cell</b>'}` : ''}
              </p>
              ${task && open ? `
                <iframe class="cells-frame" title="Cell ${index + 1}"
                  src="${esc(cellFrameUrl(task, cell))}"></iframe>
                <div class="preview-chips">
                  <a class="admin-chip" target="_blank" rel="noopener"
                    href="${esc(cellFrameUrl(task, cell))}">Open full size ↗</a>
                  <a class="admin-chip" target="_blank" rel="noopener"
                    href="${esc(`guide-arm.html?task=${encodeURIComponent(task.id)}&arm=${
                      cell.arm === 'nongrounding' ? 'grounding' : 'nongrounding'}`)}">See the other arm ↗</a>
                </div>` : ''}
            </section>`;
        }).join('')}
      </div>

      <p class="viz-note">The frames follow the <b>Study settings</b> switches — the reasoning trail,
        the milestone flags and the browse simulator are all shown here exactly as they are set, so
        this is the screen as it will be dealt rather than a neutral rendering of the material.</p>`;

    content.querySelectorAll('[data-cell-open]').forEach(button => {
      button.onclick = () => {
        // ONE FRAME AT A TIME. Each is a full copy of the renderer with a trajectory's worth of
        // base64 screenshots behind it; four open at once is four of those in memory to look at one.
        const next = Number(button.dataset.cellOpen);
        cellsOpen = next === cellsOpen ? -1 : next;
        renderGuideVisualCells();
      };
    });
  }

  // ── Study tasks: one screen for what the study is actually made of ────────
  //
  // WHY A TAB OF ITS OWN, when both pools already have one. "Edit claims" and "Guide tasks" are
  // AUTHORING screens: they open one item at a time and the Use-in-study box sits at the bottom of a
  // long form, next to the answer text. Deciding what the study contains is a different job done at
  // a different moment — it is about the SET, not about any one item — and doing it in the authoring
  // screens means opening eleven forms and holding the tally in your head.
  //
  // So this screen shows the set. Both pools as checklists, the cells the current design deals, and
  // which task fills each cell, on one page that says what is missing before a participant finds out.
  //
  // TWO KINDS OF DECISION, kept visibly apart:
  //
  //   IN THE POOL   — `in_study` on the row. Under a rotating design this is the whole choice: the
  //                   queue walks whatever is live, so ticking a box is how a task gets dealt.
  //   IN THIS CELL  — a pin in `task_selection`. Only a fixed design needs one, and only a fixed
  //                   design honours all four; under a rotating design a pin overrides one cell and
  //                   leaves the rotation to fill the rest.
  //
  // Nothing here is written until Save is pressed, and the three writes it makes are separate rows
  // in three different tables — so the status line says what landed rather than "Saved".

  let pickerTasks = null;          // every guide task, judged or not
  let pickerDraft = null;          // { inStudyClaims:Set, inStudyGuides:Set, pins:{} }
  let pickerGroup = 'A';           // which group's cells the grouped designs are showing

  /** The pins for the whole study, as a plain object safe to hand to the writer. */
  function pinsObject(draft) {
    return draft && draft.pins && typeof draft.pins === 'object' ? draft.pins : {};
  }

  /** Read one cell's pin out of the draft, in the shape the design stores. */
  function draftPin(draft, design, group, index) {
    return pinAt(pinsObject(draft), design, group, index);
  }

  /**
   * Write one cell's pin into the draft, creating the shape the design needs.
   *
   * An empty id CLEARS the pin rather than storing '' — "not pinned" has to round-trip as absent, or
   * a cleared cell would resolve to a task with no id and fall through to the fallback anyway while
   * the picker went on showing it as pinned.
   */
  function setDraftPin(draft, design, group, index, id) {
    const pins = pinsObject(draft);
    const value = String(id || '').trim();
    if (designHasGroups(design)) {
      const byGroup = (pins[design] && !Array.isArray(pins[design])) ? { ...pins[design] } : {};
      const list = Array.isArray(byGroup[group]) ? byGroup[group].slice() : [];
      list[index] = value || null;
      byGroup[group] = list;
      pins[design] = byGroup;
    } else {
      const list = Array.isArray(pins[design]) ? pins[design].slice() : [];
      list[index] = value || null;
      pins[design] = list;
    }
    draft.pins = pins;
  }

  /** The label a cell carries in the picker and in the coverage readout. */
  function cellLabel(cell, design) {
    const kind = cell.taskType === 'find' ? 'Find' : 'Guide';
    const style = design === 'guide_visual_4' ? 'Visual'
      : (designHasGroups(design) && pickerGroup === 'B') ? 'Visual' : 'Text';
    const arm = cell.arm === 'nongrounding' ? 'Non-grounded' : 'Grounded';
    const correct = cell.correct === null ? 'alternates' : cell.correct ? 'Correct' : 'Incorrect';
    return { kind, style, arm, correct };
  }

  /**
   * The task styles a design can actually deal, per kind.
   *
   * WHAT THE PICKER IS ALLOWED TO OFFER. Listing every row in both tables was wrong under the fixed
   * design in two different ways at once: it offered Find claims, which that design never deals at
   * all, and it offered `guide_text` runs, which can never fill a Guide × Visual cell. Both are
   * choices that cannot take effect, and a screen whose job is "decide what the study contains"
   * must not present them — ticking one and seeing nothing change is how somebody concludes the
   * picker is broken.
   *
   * An empty list means that kind is not dealt at all and its whole section is dropped.
   */
  function poolStylesFor(design) {
    if (design === 'guide_visual_4') return { find: [], guide: ['guide_visual'] };
    return { find: ['find_text', 'find_visual'], guide: ['guide_text', 'guide_visual'] };
  }

  /** Which tasks may fill this cell — the pool, narrowed by everything the cell already fixes. */
  function eligibleFor(cell, design, group, claims, guides) {
    if (cell.taskType === 'find') {
      const style = design === 'guide_visual_4' ? 'find_visual' : stylesFor(group).find;
      return claims.filter(row => row.task_style === style && row.in_study)
        .map(row => ({ id: row.id, label: row.title || row.question || row.id }));
    }
    const style = design === 'guide_visual_4' ? 'guide_visual' : stylesFor(group).guide;
    return guides
      .filter(row => row.task_style === style && row.in_study)
      // A CELL WITH A FIXED CORRECTNESS ONLY OFFERS RUNS OF THAT CORRECTNESS. The verdict is scored
      // against the run's own key, so pinning a "did not complete" run into the Correct cell does
      // not make it correct — it makes the cell a mislabel, and the mislabel is invisible in the
      // results. Narrowing the list is the only place that can be caught.
      .filter(row => cell.correct === null || row.agent_completed === cell.correct)
      .map(row => ({ id: row.id, label: row.title || row.goal || row.id }));
  }

  function pickerCellRowHtml(cell, index, design, group, claims, guides, draft) {
    const { kind, style, arm, correct } = cellLabel(cell, design);
    const options = eligibleFor(cell, design, group, claims, guides);
    const pinned = draftPin(draft, design, group, index);
    // A pin that no longer names anything eligible is shown AS a stale pin rather than silently
    // reset to "not pinned": the cell is not doing what the last person to touch it asked for, and
    // that is worth a line of red rather than a quietly different study.
    const stale = pinned && !options.some(option => option.id === pinned);
    return `
      <tr class="${stale ? 'is-stale' : ''}">
        <td>${index + 1}</td>
        <td><b>${esc(kind)} × ${esc(style)}</b></td>
        <td><span class="v2-chip ${cell.correct === null ? '' : cell.correct ? 'is-correct' : 'is-incorrect'}">${esc(correct)}</span></td>
        <td><span class="v2-chip ${cell.arm === 'nongrounding' ? 'is-nongrounded' : 'is-grounded'}">${esc(arm)}</span></td>
        <td>
          <select class="welcome-input picker-pick" data-pick-cell="${index}">
            <option value="">${options.length
              ? (design === 'guide_visual_4' ? '— pick a run —' : '— leave to the rotation —')
              : '— nothing eligible —'}</option>
            ${options.map(option => `<option value="${esc(option.id)}"${
              option.id === pinned ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}
          </select>
          ${stale ? `<p class="welcome-status welcome-status-bad">Pinned to <code>${esc(pinned)}</code>,
            which is not in the pool for this cell any more — this cell is falling back.</p>` : ''}
        </td>
      </tr>`;
  }

  /** The pool checklist for one table. Both pools render through it; only the chips differ. */
  function poolRowsHtml(rows, kind, selected) {
    if (!rows.length) {
      return `<tr><td colspan="4" class="q-sub">No ${esc(kind)} task exists yet.</td></tr>`;
    }
    return rows.map(row => {
      const style = String(row.task_style || '');
      const visual = style.endsWith('_visual');
      const key = kind === 'Guide'
        ? (typeof row.agent_completed === 'boolean'
            ? (row.agent_completed ? 'Completed' : 'Did not complete') : 'Not keyed')
        : `${window.FindV2Variants.KEYS.filter(k => V.variantOf(row, k).answer_text).length} of 4 written`;
      const keyBad = kind === 'Guide' ? typeof row.agent_completed !== 'boolean'
        : window.FindV2Variants.KEYS.some(k => !V.variantOf(row, k).answer_text);
      return `
        <tr>
          <td><label class="picker-tick"><input type="checkbox" data-pool="${esc(kind)}"
            data-pool-id="${esc(row.id)}"${selected.has(row.id) ? ' checked' : ''}> Include</label></td>
          <td><b>${esc(row.title || row.goal || row.question || row.id)}</b>
            <span class="q-sub">${esc(row.id)}</span></td>
          <td><span class="v2-chip">${visual ? 'Visual' : 'Text'}</span></td>
          <td><span class="v2-chip${keyBad ? ' is-incorrect' : ''}">${esc(key)}</span></td>
        </tr>`;
    }).join('');
  }

  async function renderTaskPicker() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Loading the task pools…</div>';

    let flags;
    try {
      [pickerTasks, flags] = await Promise.all([DB.listAllGuideTasks(), DB.getStudyFlags()]);
      adminClaims = await DB.listAllClaims();
    } catch (error) {
      content.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
      return;
    }
    studyFlags = flags;
    const design = designOf(flags.queueDesign);

    // THE DRAFT IS BUILT ONCE PER SAVE, not per render. Every repaint below re-reads it, so ticking
    // a box, switching group and coming back shows the tick — a re-read from the server between
    // those two would quietly discard it.
    if (!pickerDraft) {
      pickerDraft = {
        inStudyClaims: new Set(adminClaims.filter(row => row.in_study).map(row => row.id)),
        inStudyGuides: new Set(pickerTasks.filter(row => row.in_study).map(row => row.id)),
        pins: JSON.parse(JSON.stringify(flags.taskSelection || {})),
      };
    }

    paintTaskPicker(design);
  }

  function paintTaskPicker(design) {
    const content = document.getElementById('find-v2-admin-content');
    const draft = pickerDraft;
    const guides = pickerTasks || [];
    const cells = cellsOf(design);
    const grouped = designHasGroups(design);
    const group = grouped ? pickerGroup : '';

    // The pools AS THE DRAFT HAS THEM, not as the server has them: every list, every eligibility
    // check and every gap below reads the unsaved ticks, so the screen previews the study you are
    // about to save rather than the one you already saved.
    const claimPool = adminClaims.map(row => ({ ...row, in_study: draft.inStudyClaims.has(row.id) }));
    const guidePool = guides.map(row => ({ ...row, in_study: draft.inStudyGuides.has(row.id) }));

    // NARROWED TO WHAT THIS DESIGN DEALS. Everything below — the lists, the counts, the "N of M"
    // headings — reads these rather than the raw pools, so the screen only ever shows decisions that
    // can take effect. What is left out is counted and named rather than silently dropped.
    const styles = poolStylesFor(design);
    const findClaims = claimPool.filter(row => styles.find.includes(String(row.task_style || '')));
    const guideRows = guidePool.filter(row => styles.guide.includes(String(row.task_style || '')));
    const hiddenGuides = guidePool.length - guideRows.length;
    const hiddenClaims = claimPool.filter(row => String(row.task_style || '').startsWith('find_')).length
      - findClaims.length;
    const guideIncluded = guideRows.filter(row => draft.inStudyGuides.has(row.id)).length;
    const findIncluded = findClaims.filter(row => draft.inStudyClaims.has(row.id)).length;

    const unfilled = cells.filter((cell, index) => {
      const pinned = draftPin(draft, design, group, index);
      const options = eligibleFor(cell, design, group, claimPool, guidePool);
      if (pinned && options.some(option => option.id === pinned)) return false;
      // An unpinned cell is filled by whatever is eligible — the rotation under a rotating design,
      // the first matching run under the fixed one. Either way, nothing eligible means nothing
      // fills it, and that is the only state worth a warning.
      return !options.length;
    });

    // THE SAME RUN IN TWO CELLS. Legal, and occasionally what someone wants — the same trajectory
    // shown grounded and non-grounded is a within-item comparison — but far more often it is a
    // rotation quietly landing on a run that is also pinned somewhere else, and a participant who
    // reads the same trajectory twice has answered the second one before they saw it.
    const filling = cells.map((cell, index) => {
      const pinned = draftPin(draft, design, group, index);
      const options = eligibleFor(cell, design, group, claimPool, guidePool);
      return pinned && options.some(option => option.id === pinned) ? pinned : '';
    }).filter(Boolean);
    const repeated = [...new Set(filling.filter((id, i) => filling.indexOf(id) !== i))];

    content.innerHTML = `
      <p class="viz-note">Everything the study is made of, on one screen: which tasks are in each
        pool, and — for the design now set — which one fills each cell. <b>It lists only what this
        design can actually deal</b>, so a task that could not reach a participant is not offered as
        though it could. <b>Nothing is written until Save is pressed.</b> The queue design itself
        lives in <b>Study settings</b>; this screen fills whichever one is chosen there.</p>

      <h3 class="admin-subtitle">The cells this design deals</h3>
      <p class="viz-note">${design === 'guide_visual_4'
        ? 'This design has <b>no rotation</b>: the four runs named here are the four runs every '
          + 'participant is shown, in this order. A cell left unpicked falls back to any eligible '
          + 'run of the right key, which keeps the study running but means the stimulus is chosen '
          + 'by whatever happens to be first in the pool rather than by you.'
        : 'This design deals from the pool by assignment slot, so a cell left as '
          + '<em>“leave to the rotation”</em> is the normal case and the balanced one. Pinning a '
          + 'cell overrides the rotation <b>for that cell only</b> — useful for holding one stimulus '
          + 'fixed while the rest still vary, and a thing to undo before the real run.'}</p>
      ${grouped ? `
        <div class="preview-chips">
          <span class="q-sub">Cells for:</span>
          ${['A', 'B'].map(g => `<button class="admin-chip${g === pickerGroup ? ' admin-chip-on' : ''}"
            data-picker-group="${g}">Group ${g} · ${g === 'B' ? 'visual' : 'text'}</button>`).join('')}
        </div>` : ''}
      <div class="viz-table-wrap"><table class="viz-table picker-cells">
        <thead><tr><th>#</th><th>Cell</th><th>Answer</th><th>Condition</th><th>Task</th></tr></thead>
        <tbody>${cells.map((cell, index) =>
          pickerCellRowHtml(cell, index, design, group, claimPool, guidePool, draft)).join('')}</tbody>
      </table></div>
      ${unfilled.length ? `<p class="welcome-status welcome-status-bad">${unfilled.length}
        cell${unfilled.length === 1 ? '' : 's'} ${unfilled.length === 1 ? 'has' : 'have'} nothing
        eligible in the pool. Tick a task below that matches the cell's style and answer key.</p>` : ''}
      ${repeated.length ? `<p class="welcome-status welcome-status-bad">${
        repeated.map(id => esc(id)).join(', ')} fill${repeated.length === 1 ? 's' : ''} more than one
        cell, so a participant sees the same run twice — and answers the second one from the
        first. Deliberate only if you meant a within-item comparison.</p>` : ''}

      <h3 class="admin-subtitle">${design === 'guide_visual_4' ? 'Guide × Visual runs' : 'Guide runs'} in the pool
        <span class="q-sub">${guideIncluded} of ${guideRows.length} included</span></h3>
      <p class="viz-note">A run needs an answer key — <b>Completed</b> or <b>Did not complete</b> —
        before it can be dealt. Key it in <b>Guide tasks</b>; this screen only decides whether a
        keyed run is in the study.
        ${hiddenGuides ? `<b>${hiddenGuides} Guide × Text run${hiddenGuides === 1 ? ' is' : 's are'}
          not listed</b> — the design now set deals only visual runs, so including one could have no
          effect. ${hiddenGuides === 1 ? 'It stays' : 'They stay'} in <b>Guide tasks</b>, and
          ${hiddenGuides === 1 ? 'comes' : 'come'} back here if the design changes.` : ''}</p>
      <div class="viz-table-wrap"><table class="viz-table">
        <thead><tr><th></th><th>Run</th><th>Style</th><th>Answer key</th></tr></thead>
        <tbody>${poolRowsHtml(guideRows, 'Guide', draft.inStudyGuides)}</tbody>
      </table></div>

      ${styles.find.length ? `
        <h3 class="admin-subtitle">Find claims in the pool
          <span class="q-sub">${findIncluded} of ${findClaims.length} included</span></h3>
        <p class="viz-note">A claim is dealt in one of four correctness × grounding cells, so a live
          claim wants all four answers written. Write them in <b>Edit claims</b>.</p>
        <div class="viz-table-wrap"><table class="viz-table">
          <thead><tr><th></th><th>Claim</th><th>Style</th><th>Variants</th></tr></thead>
          <tbody>${poolRowsHtml(findClaims, 'Find', draft.inStudyClaims)}</tbody>
        </table></div>`
      : `<p class="viz-note"><b>No Find claims are listed, because this design deals none.</b> The
          four cells above are all Guide × Visual. The claims are untouched and still editable in
          <b>Edit claims</b>; switch the queue design in <b>Study settings</b> to bring them back.
          ${hiddenClaims ? `There ${hiddenClaims === 1 ? 'is' : 'are'} ${hiddenClaims} of them.` : ''}</p>`}

      <div class="admin-row">
        <button class="welcome-btn" id="v2-picker-save">Save the task set</button>
        <button class="admin-chip" id="v2-picker-revert">Discard my changes</button>
      </div>
      <div class="welcome-status" id="v2-picker-status"></div>`;

    content.querySelectorAll('[data-picker-group]').forEach(button => {
      button.onclick = () => { pickerGroup = button.dataset.pickerGroup; paintTaskPicker(design); };
    });
    content.querySelectorAll('[data-pick-cell]').forEach(select => {
      select.onchange = () => {
        setDraftPin(draft, design, group, Number(select.dataset.pickCell), select.value);
        paintTaskPicker(design);
      };
    });
    content.querySelectorAll('[data-pool-id]').forEach(box => {
      box.onchange = () => {
        const set = box.dataset.pool === 'Guide' ? draft.inStudyGuides : draft.inStudyClaims;
        if (box.checked) set.add(box.dataset.poolId); else set.delete(box.dataset.poolId);
        paintTaskPicker(design);
      };
    });
    content.querySelector('#v2-picker-revert').onclick = () => {
      pickerDraft = null;
      renderTaskPicker();
    };
    content.querySelector('#v2-picker-save').onclick = () => saveTaskPicker(design);
  }

  /**
   * The three writes, in the order a half-finished save can survive.
   *
   * POOL FIRST, PINS LAST. A pin is only meaningful if the task it names is in the pool, so writing
   * the pins first and then failing on a pool row would leave the study pinned to a task it does not
   * deal. This way a failure part-way leaves a pool that is right and pins that are still the old
   * ones — which is the state the picker can show and a person can finish.
   *
   * Each pool row is written on its own, and only if it CHANGED. `save_pageguide_find_v2_claim`
   * replaces the whole row, so an untouched claim is not round-tripped through the browser — that is
   * how an unrelated edit made in another tab would get clobbered by this one.
   */
  async function saveTaskPicker(design) {
    const draft = pickerDraft;
    const button = document.getElementById('v2-picker-save');
    const statusEl = document.getElementById('v2-picker-status');
    const say2 = (message, bad = false) => {
      statusEl.textContent = message;
      statusEl.className = `welcome-status${bad ? ' welcome-status-bad' : ''}`;
    };
    button.disabled = true;
    say2('Saving…');

    const guideChanges = (pickerTasks || []).filter(row =>
      row.in_study !== draft.inStudyGuides.has(row.id));
    const claimChanges = adminClaims.filter(row =>
      row.in_study !== draft.inStudyClaims.has(row.id));

    try {
      for (const row of guideChanges) {
        await DB.saveGuideMeta(adminPassword, {
          id: row.id,
          taskStyle: row.task_style,
          agentCompleted: typeof row.agent_completed === 'boolean' ? row.agent_completed : null,
          inStudy: draft.inStudyGuides.has(row.id),
          claimsCompletion: row.claims_completion,
          taskIndex: Number(row.task_index) || 0,
        });
      }
      for (const row of claimChanges) {
        // THE WHOLE ROW, re-read. The list query leaves out `page_html` and the authored evidence,
        // and the claim writer replaces the row it is given — saving the list shape back would erase
        // the captured page of every claim toggled here.
        const full = await DB.getClaim(row.id);
        if (!full) throw new Error(`Claim ${row.id} no longer exists.`);
        await DB.saveClaim(adminPassword, { ...full, in_study: draft.inStudyClaims.has(row.id) });
      }
      const saved = await DB.saveStudyFlags(adminPassword, { ...studyFlags, taskSelection: draft.pins });
      studyFlags = saved;
      pickerDraft = null;
      await renderTaskPicker();
      const parts = [];
      if (guideChanges.length) parts.push(`${guideChanges.length} Guide run${guideChanges.length === 1 ? '' : 's'}`);
      if (claimChanges.length) parts.push(`${claimChanges.length} Find claim${claimChanges.length === 1 ? '' : 's'}`);
      const after = document.getElementById('v2-picker-status');
      if (after) {
        after.textContent = `Saved${parts.length ? `: ${parts.join(' and ')} moved in or out of the pool` : ''}`
          + `${parts.length ? ', and' : '.'} the cell picks are stored.`
          + ' Runs already in progress keep the tasks they were dealt.';
        after.className = 'welcome-status';
      }
    } catch (error) {
      say2(error.message || String(error), true);
      button.disabled = false;
    }
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
            // THE EDIT PATH BACK TO SUPABASE. Sent on every save rather than only when the fold is
            // open: the fields are rendered from the stored row either way, so an untouched card
            // writes back exactly what it read. A blank one sends '' and the function leaves the
            // stored value alone — see sql/180_supabase_v2_guide_name.sql.
            goal: card.querySelector(`textarea[data-guide-goal="${CSS.escape(id)}"]`)?.value ?? null,
            title: card.querySelector(`input[data-guide-title="${CSS.escape(id)}"]`)?.value ?? null,
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
   * `claims_completion` is null until sql/040_supabase_v2_faithfulness.sql is applied. In that window the
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

    // NO GROUPS AND NO SITTINGS TO ALTERNATE BETWEEN. One table, and it is the whole protocol: the
    // same four runs, in this order, for every participant.
    if (design === 'guide_visual_4') {
      const pins = pinsFor(studyFlags.taskSelection, 'guide_visual_4', '');
      return `
        <h3 class="admin-subtitle">What every participant is dealt</h3>
        <p class="viz-note">Generated from <code>GUIDE_VISUAL_CELLS</code> and
          <code>buildGuideVisualQueue</code>, the same two the study runs. Which run fills each cell
          is chosen in <b>Study tasks</b>; a cell shown as <em>not picked</em> falls back to any
          eligible run of that key, which keeps the study running but leaves the stimulus to
          whatever is first in the pool.</p>
        ${table(GUIDE_VISUAL_CELLS.map((cell, i) => row(i + 1, 'Guide', 'Visual', cell.correct, cell.arm,
          pins[i] ? `pinned to ${pins[i]}` : 'not picked — falls back')).join(''))}
        <p class="viz-note"><b>Nothing here varies by participant.</b> That is what makes both
          factors fully within-subjects — every completed sitting contributes to all four cells at
          once, so no cell can be short of another and the recruitment target below has nothing left
          to level. It is also the cost: the four runs are the four conditions, so any way in which
          one run is harder than another is indistinguishable from its condition. Pick four that are
          comparable, and read the per-cell accuracy as a claim about these four runs.</p>`;
    }

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

  function markedWrongStepsCellHtml(row) {
    const steps = Array.isArray(row?.marked_wrong_steps)
      ? row.marked_wrong_steps.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
    if (steps.length) return `<td><b>${esc(steps.join(', '))}</b></td>`;
    if (row?.guide_answer_correct === false) return '<td class="q-sub">None marked</td>';
    return '<td class="q-sub">—</td>';
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
        note: 'run sql/040_supabase_v2_faithfulness.sql to separate a false success from an honest failure' };
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
        const [steps, listed] = await Promise.all([
          DB.getGuideSteps(id),
          // Never fatal: a project that has not applied sql/190_supabase_v2_guide_steps.sql still gets its
          // journey, just without the trim controls.
          DB.listGuideSteps(id).catch(() => null),
        ]);
        const hidden = (listed || []).filter(row => row.hidden);
        const canTrim = Array.isArray(listed);
        holder.innerHTML = steps.length
          ? `${canTrim ? guideTrimNoteHtml(steps.length) : ''}
            <div class="admin-journey">${steps.map(step => `
              <div class="admin-journey-row" data-step-row="${esc(String(step.n ?? ''))}">
                <b>${esc(String(step.n ?? ''))}</b>
                <div>
                  <div>${esc(step.instruction || step.action || '')}</div>
                  ${step.url ? `<div class="q-sub">${esc(step.url)}</div>` : ''}
                  ${canTrim ? `<div class="admin-journey-acts">
                    <button class="admin-chip admin-chip-quiet" data-step-op="hide"
                      data-step-n="${esc(String(step.n ?? ''))}"
                      title="Take this step out of what participants see. Kept, and restorable.">Hide</button>
                    <button class="admin-chip admin-chip-quiet" data-step-op="delete"
                      data-step-n="${esc(String(step.n ?? ''))}"
                      title="Remove this step for good, screenshot and all.">Delete</button>
                  </div>` : ''}
                  ${step.screenshot ? `<img class="admin-journey-shot" src="${esc(shotSrc(step.screenshot))}" alt="step ${esc(String(step.n ?? ''))}">` : '<div class="q-sub">No screenshot saved.</div>'}
                </div>
              </div>`).join('')}</div>
            ${guideHiddenListHtml(hidden)}
            <div class="welcome-status" data-step-status></div>`
          : '<p class="q-sub">No steps recorded for the grounded arm.</p>';
        bindGuideStepOps(holder, id, button);
      } catch (error) {
        holder.innerHTML = `<p class="welcome-status welcome-status-bad">${esc(error.message || String(error))}</p>`;
        button.disabled = false;
      }
    };
  }

  /**
   * Trimming a run: what it does, said once above the steps rather than on every button.
   *
   * The sentence that matters is the renumbering. A researcher hiding step 4 of 13 is not annotating
   * the record, they are changing what "step 6" means — to the participant, to their step marks, and
   * to the answer key — and the panel has to say so before they press it, not after.
   */
  function guideTrimNoteHtml(count) {
    return `
      <p class="q-sub admin-journey-note"><b>${count} step${count === 1 ? '' : 's'} shown to
        participants.</b> Hiding or deleting one <b>renumbers the rest</b>, and the evidence chips,
        milestones and the answer key move with it. <b>Hide</b> keeps the step and can be undone;
        <b>Delete</b> does not.</p>`;
  }

  /** What has been taken out, and the way back. Rendered only when there is something in it. */
  function guideHiddenListHtml(hidden) {
    if (!hidden.length) return '';
    return `
      <div class="admin-journey-hidden">
        <div class="admin-journey-hidden-head">${hidden.length} hidden step${hidden.length === 1 ? '' : 's'}
          <span class="q-sub">not shown to participants, and not counted in the step count</span></div>
        ${hidden.map(row => `
          <div class="admin-journey-hidden-row">
            <span class="q-sub">was step ${esc(String(row.orig_n ?? '?'))}</span>
            <span>${esc(row.instruction || '')}</span>
            <button class="admin-chip admin-chip-quiet" data-step-op="show"
              data-step-n="${esc(String(row.orig_n ?? ''))}">Restore</button>
          </div>`).join('')}
      </div>`;
  }

  /**
   * Hide / Delete / Restore, each one confirmed in the button it is pressed on.
   *
   * DELETE ASKS TWICE, hide does not. The asymmetry is the point of having both: a hide is a
   * decision you can look at and change your mind about, and making it as heavy as a deletion would
   * push people towards deleting because it is the same number of clicks.
   *
   * The journey is re-read from the server afterwards rather than patched in place — the write
   * renumbers four other structures, and a list rebuilt from what came back cannot disagree with
   * what was stored.
   */
  function bindGuideStepOps(holder, id, loader) {
    const status = holder.querySelector('[data-step-status]');
    holder.querySelectorAll('[data-step-op]').forEach(btn => {
      btn.onclick = async () => {
        const op = btn.dataset.stepOp;
        const n = Number(btn.dataset.stepN);
        if (!Number.isInteger(n)) return;
        if (op === 'delete' && btn.dataset.armed !== 'true') {
          btn.dataset.armed = 'true';
          btn.textContent = 'Delete for good — click again';
          return;
        }
        holder.querySelectorAll('[data-step-op]').forEach(b => { b.disabled = true; });
        if (status) {
          status.textContent = op === 'show' ? 'Restoring…' : op === 'hide' ? 'Hiding…' : 'Deleting…';
          status.className = 'welcome-status';
        }
        try {
          await DB.saveGuideSteps(adminPassword, id, op, [n]);
          // Reload through the button's own handler, so the list, the hidden panel and the step
          // count all come from one fresh read.
          loader.disabled = false;
          loader.click();
        } catch (error) {
          holder.querySelectorAll('[data-step-op]').forEach(b => { b.disabled = false; });
          if (status) {
            status.textContent = error.message || String(error);
            status.className = 'welcome-status welcome-status-bad';
          }
        }
      };
    });
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

        <!-- THE TWO NAMES, EDITABLE. Folded, because keying a run is the everyday job on this card
             and renaming one is not — but present, because until now the only way to fix the
             sentence a participant is asked to judge was the SQL editor. The instruction is a
             textarea rather than an input: it is a sentence, and a one-line box that scrolls
             sideways hides the end of the thing being checked. -->
        <details class="admin-guide-name">
          <summary class="q-sub">Rename this task</summary>
          <label class="q-sub admin-guide-field">The task the agent was given
            <textarea class="welcome-input" rows="2" data-guide-goal="${esc(id)}"
              placeholder="Book a lane at the 7am Saturday swim and tell me the booking reference."
              >${esc(row.goal || '')}</textarea>
            <span class="q-sub admin-guide-hint">Shown to the participant, word for word. Their
              verdict is “did the agent do <b>this</b>?”</span>
          </label>
          <label class="q-sub admin-guide-field">Short name
            <input class="welcome-input" data-guide-title="${esc(id)}"
              value="${esc(row.title || '')}" placeholder="Saturday 7am lane booking">
            <span class="q-sub admin-guide-hint">Admin lists and the task picker only. Blank falls
              back to the instruction.</span>
          </label>
        </details>
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
          <!-- THE PARTICIPANT'S SCREEN, not a description of it. Inspect beside this shows the run as
               a researcher's table — both arms' answers, the evidence keyed to its steps, the
               recorded errors — which is the right view for keying a task and the wrong one for
               answering "what will they actually see?". View plays the real task page: two panes, the
               condition banner, the journey, the answer card, the opening lock, the walk. It claims
               no assignment slot and writes nothing, so it can be answered through to the end.
               New tab, because this tab is holding an unsaved key. -->
          <a class="admin-chip" target="_blank" rel="noopener"
            href="${esc(`study.html?task=${encodeURIComponent(id)}&arm=grounding`)}"
            title="Open this run on the real task screen, grounded — nothing is recorded">View ↗</a>
          <a class="admin-chip admin-chip-quiet" target="_blank" rel="noopener"
            href="${esc(`study.html?task=${encodeURIComponent(id)}&arm=nongrounding`)}"
            title="The same run on the real task screen, non-grounded">non-grounded ↗</a>
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

  // Every V2 queue design currently deals four tasks. A completed sitting may span both result
  // tables, so completion is decided only after Find and Guide rows have been joined below.
  const V2_TASKS_PER_SESSION = 4;

  function resultSessionKey(row) {
    if (row?.session_id != null) return `s${row.session_id}`;
    if (row?.client_run_id) return `r${row.client_run_id}`;
    return null;
  }

  /** One V2 participant, merged across the Find and Guide result tables. */
  function resultParticipantSummaries(findRows, guideRows) {
    const summaries = new Map();
    const add = (row, taskType) => {
      const key = resultSessionKey(row);
      if (!key) return;
      if (!summaries.has(key)) {
        summaries.set(key, {
          key,
          participantId: String(row?.participant_id || '').trim() || 'anonymous',
          tasks: new Set(),
          indexes: new Set(),
          find: 0,
          guide: 0,
        });
      }
      const summary = summaries.get(key);
      const participantId = String(row?.participant_id || '').trim();
      if (participantId && (!summary.participantId || summary.participantId === 'anonymous')) {
        summary.participantId = participantId;
      }
      // question_index is global within a sitting (0–3) even though its rows are split across two
      // tables. The fallback keeps old rows without that column distinct by task identity.
      const index = Number(row?.question_index);
      if (Number.isInteger(index) && index >= 0) summary.indexes.add(index);
      const task = Number.isInteger(index) && index >= 0
        ? `q${index}`
        : `${taskType}:${row?.claim_id || row?.task_id || row?.result_key || ''}`;
      if (task) summary.tasks.add(task);
      summary[taskType] += 1;
    };
    (Array.isArray(findRows) ? findRows : []).forEach(row => add(row, 'find'));
    (Array.isArray(guideRows) ? guideRows : []).forEach(row => add(row, 'guide'));

    const sessionLabel = key => {
      if (key.startsWith('s')) return `session ${key.slice(1)}`;
      const run = key.slice(1);
      return `local run ${run.length > 12 ? `${run.slice(0, 12)}…` : run}`;
    };
    return Array.from(summaries.values())
      .map(summary => ({
        ...summary,
        // Strictly one real V2 session represented in BOTH result tables, with every global task
        // position exactly accounted for. Four arbitrary rows (or a client-only fallback run) must
        // not be promoted to a completed participant.
        complete: summary.key.startsWith('s')
          && summary.find > 0
          && summary.guide > 0
          && summary.indexes.size === V2_TASKS_PER_SESSION
          && Array.from({ length: V2_TASKS_PER_SESSION }, (_, index) => index)
            .every(index => summary.indexes.has(index)),
        sessionLabel: sessionLabel(summary.key),
      }))
      .sort((a, b) => a.participantId.localeCompare(b.participantId, undefined, { numeric: true })
        || a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  /**
   * The session keys that submitted all four tasks.
   *
   * Recomputed from the FULL tables rather than from whatever survived the last filter, because
   * completeness is a property of the sitting and must not change depending on what is currently
   * being shown. Both tables are read: a sitting is only complete if its Find and Guide halves are
   * both present, and `includedResultRows` is called once per table.
   */
  function completeResultSessionKeys() {
    return new Set(resultParticipantSummaries(adminFindResults, adminGuideResults)
      .filter(participant => participant.complete)
      .map(participant => participant.key));
  }

  /**
   * The rows every V2 summary, table, chart and test reads.
   *
   * Two filters, and they compose: the standing "completed sittings only" toggle, then the manual
   * exclusions. Neither overrules the other — unticking a completed participant still drops them.
   */
  function includedResultRows(rows) {
    const complete = completedResultsOnly ? completeResultSessionKeys() : null;
    return (Array.isArray(rows) ? rows : []).filter(row => {
      const key = resultSessionKey(row);
      if (excludedResultSessions.has(key)) return false;
      return !complete || complete.has(key);
    });
  }

  function resultParticipantOverviewHtml(findRows, guideRows) {
    const summaries = resultParticipantSummaries(findRows, guideRows);
    const total = summaries.length;
    const complete = summaries.filter(participant => participant.complete).length;
    const excluded = summaries.filter(participant => excludedResultSessions.has(participant.key)).length;
    // What the charts will actually read: held out by the toggle, or unticked by hand.
    const isFilteredOut = participant => completedResultsOnly && !participant.complete;
    const isIncluded = participant => !excludedResultSessions.has(participant.key)
      && !isFilteredOut(participant);
    const included = summaries.filter(isIncluded).length;
    const heldBack = summaries.filter(participant => isFilteredOut(participant)
      && !excludedResultSessions.has(participant.key)).length;
    const includedNote = completedResultsOnly
      ? `${heldBack} incomplete held out${excluded ? `, ${excluded} manually excluded` : ''}`
      : (excluded ? `${excluded} manually excluded` : 'everyone included');
    const stat = (value, label, note) => `<div class="viz-participant-stat">
      <strong>${value}</strong><span>${esc(label)}</span><small>${esc(note)}</small>
    </div>`;

    return `<section class="viz-participants" aria-label="V2 participant counts and exclusions">
      <div class="viz-participant-stats">
        ${stat(total, 'V2 participants', 'submitted at least one task')}
        ${stat(complete, 'Completed', `all ${V2_TASKS_PER_SESSION} V2 tasks`)}
        ${stat(total - complete, 'Incomplete', `fewer than ${V2_TASKS_PER_SESSION} tasks`)}
        ${stat(included, 'Included in results', includedNote)}
      </div>
      <details class="viz-participant-picker" id="v2-participant-picker"${participantResultPickerOpen ? ' open' : ''}>
        <summary>
          <span>Filter out V2 participants</span>
          <small>${included} of ${total} included${total - included ? ` · ${total - included} filtered out` : ''}</small>
        </summary>
        <div class="viz-participant-actions">
          <label class="viz-participant-toggle" title="Hold out every sitting that did not submit all ${V2_TASKS_PER_SESSION} tasks. Stays on across reloads, so a partial sitting that lands later is held out too.">
            <input type="checkbox" id="v2-participants-completed-only"${completedResultsOnly ? ' checked' : ''}${complete ? '' : ' disabled'}>
            <span>Completed sittings only</span>
            <small>${complete} of ${total} submitted all ${V2_TASKS_PER_SESSION}</small>
          </label>
          <button type="button" class="admin-chip" id="v2-participants-all"${excluded ? '' : ' disabled'}>Include everyone</button>
          <button type="button" class="admin-chip" id="v2-participants-exclude-incomplete"${complete === total || completedResultsOnly ? ' disabled' : ''}>Exclude all incomplete</button>
          <span>Uncheck a sitting to remove it from every V2 summary, table, chart and test.</span>
        </div>
        <div class="viz-participant-list">
          ${summaries.map(participant => {
            const isExcluded = excludedResultSessions.has(participant.key);
            const filtered = isFilteredOut(participant);
            // A ticked box on a row the toggle is holding out would be a lie about what the charts
            // read, so the tick comes off and the box goes dead until the toggle is turned back off.
            return `<label class="viz-participant-row${isExcluded || filtered ? ' is-excluded' : ''}">
              <input type="checkbox" class="v2-participant-include" data-session="${esc(participant.key)}"${isExcluded || filtered ? '' : ' checked'}${filtered ? ' disabled' : ''}>
              <code>${esc(participant.participantId)}</code>
              <span>${esc(participant.sessionLabel)}</span>
              <span class="viz-participant-progress">${participant.tasks.size}/${V2_TASKS_PER_SESSION} tasks · ${participant.find} Find + ${participant.guide} Guide · ${participant.complete ? 'completed' : 'incomplete'}${filtered ? ' · held out' : ''}</span>
            </label>`;
          }).join('')}
        </div>
      </details>
      <p class="viz-participant-note">Counts merge <code>pageguide_find_v2_results</code> and
        <code>pageguide_guide_v2_results</code>. “Completed” requires the same non-null V2
        <code>session_id</code> in both tables and exactly the four task positions 0–3. A participant
        who started but submitted no task has no result row and is not counted here.
        <b>Completed sittings only</b> holds every incomplete sitting out of the charts and tests;
        it is a filter on the analysis, so say in the write-up which of the two counts a rate came
        from.</p>
    </section>`;
  }

  function bindResultParticipantFilters() {
    document.getElementById('v2-participant-picker')?.addEventListener('toggle', event => {
      participantResultPickerOpen = event.target.open;
    });
    document.querySelectorAll('.v2-participant-include').forEach(box => {
      box.addEventListener('change', () => {
        participantResultPickerOpen = true;
        if (box.checked) excludedResultSessions.delete(box.dataset.session);
        else excludedResultSessions.add(box.dataset.session);
        renderResultsView();
      });
    });
    document.getElementById('v2-participants-completed-only')?.addEventListener('change', event => {
      participantResultPickerOpen = true;
      completedResultsOnly = event.target.checked;
      renderResultsView();
    });
    document.getElementById('v2-participants-all')?.addEventListener('click', () => {
      participantResultPickerOpen = true;
      // "Everyone" means everyone. Clearing the hand-picked exclusions while a standing filter kept
      // holding sittings out would leave the button unable to do what it says.
      completedResultsOnly = false;
      excludedResultSessions.clear();
      renderResultsView();
    });
    document.getElementById('v2-participants-exclude-incomplete')?.addEventListener('click', () => {
      participantResultPickerOpen = true;
      resultParticipantSummaries(adminFindResults, adminGuideResults)
        .filter(participant => !participant.complete)
        .forEach(participant => excludedResultSessions.add(participant.key));
      renderResultsView();
    });
  }

  async function renderResults() {
    const content = document.getElementById('find-v2-admin-content');
    content.innerHTML = '<div class="viz-loading">Loading private Find V2 results…</div>';
    const [findResult, guideResult, classResult] = await Promise.allSettled([
      DB.listResults(adminPassword),
      DB.listGuideResults(adminPassword),
      DB.classCounts(),
    ]);
    if (findResult.status === 'rejected') {
      const error = findResult.reason;
      content.innerHTML = `<div class="welcome-status welcome-status-bad">${esc(error?.message || error)}</div>`;
      return;
    }
    adminFindResults = findResult.value;
    adminGuideResults = guideResult.status === 'fulfilled' ? guideResult.value : [];
    adminClassCounts = classResult.status === 'fulfilled' ? classResult.value : [];
    adminGuideResultsError = guideResult.status === 'rejected'
      ? String(guideResult.reason?.message || guideResult.reason)
      : '';
    renderResultsView();
  }

  /**
   * The four sittings the queue can deal, and which cells each one fills.
   *
   * `assignment_slot % 4` decides everything: `slot % 2` picks the between-subjects modality
   * (even = A/text, odd = B/visual) and `Math.floor(slot / 2) % 2` picks which of the two
   * correctness sequences `crossedCorrect` walks. There are TWO sequences, not four — the
   * correctness pattern reads the cycle's parity — so four consecutive slots fill every Find cell
   * and every Guide cell exactly once.
   *
   * The consequence this whole panel rests on: A CLASS COUNT IS A CELL n. One completed sitting of
   * class 1 is one observation in Find × Visual correct-grounded AND one in Guide × Visual
   * incorrect-grounded, so levelling the four classes levels both halves of the study at once and
   * there is no separate Find and Guide recruitment to do.
   */
  const RECRUIT_GROUPS = [
    {
      slotClass: 0, label: 'A · text', style: 'text', sequence: 'A',
      find: ['correct_grounding', 'incorrect_nongrounding'],
      guide: ['incorrect_grounding', 'correct_nongrounding'],
    },
    {
      slotClass: 1, label: 'A · visual', style: 'visual', sequence: 'A',
      find: ['correct_grounding', 'incorrect_nongrounding'],
      guide: ['incorrect_grounding', 'correct_nongrounding'],
    },
    {
      slotClass: 2, label: 'B · text', style: 'text', sequence: 'B',
      find: ['incorrect_grounding', 'correct_nongrounding'],
      guide: ['correct_grounding', 'incorrect_nongrounding'],
    },
    {
      slotClass: 3, label: 'B · visual', style: 'visual', sequence: 'B',
      find: ['incorrect_grounding', 'correct_nongrounding'],
      guide: ['correct_grounding', 'incorrect_nongrounding'],
    },
  ];

  /** The one group that fills this cell. Exactly one does, which is what makes the map invertible. */
  function groupForCell(taskType, style, key) {
    return RECRUIT_GROUPS.find(group => group.style === style && group[taskType].includes(key)) || null;
  }

  /**
   * What the result rows actually contain per cell, for completed sittings.
   *
   * Not used to draw the n — that comes from the class counts, which are the design. Used to CHECK
   * it: `pickGuideFor` settles for a Guide run of the wrong correctness when a style's pool has none
   * of the wanted one, which would unbalance the Guide half without moving any class count. A silent
   * discrepancy is the failure this catches.
   */
  function observedCellCounts(findRows, guideRows) {
    const complete = completeResultSessionKeys();
    const counts = new Map();
    const tally = (rows, taskType) => (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!complete.has(resultSessionKey(row))) return;
      const key = row.variant_key || V.variantKey(
        taskType === 'find' ? row.claim_correct_snapshot : row.answer_correct_snapshot,
        row.condition,
      );
      const style = String(row.task_style || '').endsWith('_visual') ? 'visual' : 'text';
      const id = `${taskType}|${style}|${key}`;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    tally(findRows, 'find');
    tally(guideRows, 'guide');
    return counts;
  }

  /**
   * Recruitment standings: where each class is, what is still owed, and what the finished dataset
   * looks like.
   *
   * ALWAYS COMPLETED SITTINGS ONLY, whatever the "Completed sittings only" checkbox says. A partial
   * sitting fills no cell — four of the five on record stopped at Find task 0 or 1 — so counting one
   * toward a group would under-state what is still needed, which is the one error this panel exists
   * to prevent.
   */
  function recruitmentBalanceHtml(findRows, guideRows) {
    const counts = new Map((adminClassCounts || []).map(row => [row.slotClass, row]));
    if (!counts.size) {
      return `<section class="viz-participants v2-recruit">
        <h3 class="admin-subtitle">Recruitment balance</h3>
        <p class="viz-note">This project has not run <code>sql/160_supabase_v2_recruit_quota.sql</code> yet,
          so the per-class standings cannot be read. Run it in the SQL editor and reload.</p>
      </section>`;
    }
    const at = slotClass => counts.get(slotClass) || { started: 0, complete: 0, inflight: 0 };
    const target = Math.max(0, Math.round(Number(studyFlags.slotQuota) || 0));
    const have = RECRUIT_GROUPS.map(group => at(group.slotClass).complete);
    // With no target set, "balance" still has an unambiguous meaning: bring every class up to the
    // fullest one. That is the smallest recruitment that squares the dataset, and it is what the
    // panel shows until somebody commits to a bigger number.
    const goal = target > 0 ? target : Math.max(...have);
    const started = RECRUIT_GROUPS.reduce((sum, group) => sum + at(group.slotClass).started, 0);
    const done = have.reduce((sum, n) => sum + n, 0);
    // The pooled rate, not the per-class one. The per-class rates differ (29% to 64% on the data as
    // it stands) but on 12-14 sittings each that spread is not distinguishable from chance, and
    // projecting from it would recruit to noise.
    const rate = started > 0 ? done / started : 0;
    const owed = RECRUIT_GROUPS.map((group, index) => Math.max(0, goal - have[index]));
    const toRun = owed.map(n => (rate > 0 ? Math.ceil(n / rate) : 0));
    const owedTotal = owed.reduce((sum, n) => sum + n, 0);
    const runTotal = toRun.reduce((sum, n) => sum + n, 0);
    const worst = owed.indexOf(Math.max(...owed));

    const observed = observedCellCounts(findRows, guideRows);
    const drift = [];
    ['find', 'guide'].forEach(taskType => ['text', 'visual'].forEach(style => V.KEYS.forEach(key => {
      const group = groupForCell(taskType, style, key);
      if (!group) return;
      const expected = at(group.slotClass).complete;
      const actual = observed.get(`${taskType}|${style}|${key}`) || 0;
      if (actual !== expected) drift.push(`${taskType} × ${style} · ${V.LABELS[key]} (${actual}, expected ${expected})`);
    })));

    const cellTable = (taskType, title) => `<table class="viz-table v2-recruit-table">
      <caption>${esc(title)}</caption>
      <thead><tr><th>Cell</th><th>Text</th><th>Visual</th></tr></thead>
      <tbody>${V.KEYS.map(key => `<tr>
        <th scope="row">${esc(V.LABELS[key])}</th>
        ${['text', 'visual'].map(style => {
          const group = groupForCell(taskType, style, key);
          const n = group ? at(group.slotClass).complete : 0;
          const short = Math.max(0, goal - n);
          return `<td class="${short ? 'is-bad' : 'is-good'}">${n}${short ? ` → <b>${goal}</b>` : ''}</td>`;
        }).join('')}
      </tr>`).join('')}</tbody>
    </table>`;

    return `<section class="viz-participants v2-recruit">
      <h3 class="admin-subtitle">Recruitment balance</h3>
      <p class="viz-note">Completed sittings only, always — a partial sitting fills no cell.
        ${target > 0
          ? `Target <b>${target}</b> per class, set in Study settings; the next sitting is dealt the
             class furthest from it.`
          : `<b>No target set</b>, so this levels every class up to the fullest one (${goal}). Set a
             target in Study settings to have the queue steer new sittings toward it — until then it
             deals plain round-robin and the shortfall below stays where it is.`}
        A class count is the n of four Find cells <em>and</em> four Guide cells, so one number
        balances both halves.</p>

      <div class="viz-table-wrap"><table class="viz-table v2-recruit-table">
        <caption>Recruit next</caption>
        <thead><tr>
          <th>Group</th><th><code>slot % 4</code></th><th>Sequence</th>
          <th>Started</th><th>Completed</th><th>In flight</th>
          <th>Still owed</th><th>People to run</th>
        </tr></thead>
        <tbody>${RECRUIT_GROUPS.map((group, index) => `<tr${index === worst && owed[index] > 0 ? ' class="is-worst"' : ''}>
          <th scope="row">${esc(group.label)}</th>
          <td><code>${group.slotClass}</code></td>
          <td>${group.sequence}</td>
          <td>${at(group.slotClass).started}</td>
          <td><b>${have[index]}</b></td>
          <td>${at(group.slotClass).inflight}</td>
          <td class="${owed[index] ? 'is-bad' : 'is-good'}">${owed[index] ? `+${owed[index]}` : '—'}</td>
          <td>${toRun[index] ? `≈ ${toRun[index]}` : '—'}</td>
        </tr>`).join('')}
        <tr class="is-total">
          <th scope="row">total</th><td colspan="2"></td>
          <td>${started}</td><td><b>${done}</b></td>
          <td>${RECRUIT_GROUPS.reduce((sum, group) => sum + at(group.slotClass).inflight, 0)}</td>
          <td class="${owedTotal ? 'is-bad' : 'is-good'}">${owedTotal ? `+${owedTotal}` : '—'}</td>
          <td>${runTotal ? `≈ ${runTotal}` : '—'}</td>
        </tr></tbody>
      </table></div>
      <p class="viz-note">“People to run” is the owed completers divided by the observed completion
        rate (<b>${(100 * rate).toFixed(0)}%</b>, ${done} of ${started} sittings). It is a budget, not
        a script: dropout is not predictable, so recruit against the standings and stop when every
        class reaches ${goal}.</p>

      <div class="viz-table-wrap v2-recruit-cells">
        ${cellTable('find', 'Find — n per cell, now → at target')}
        ${cellTable('guide', 'Guide — n per cell, now → at target')}
      </div>

      <div class="viz-table-wrap"><table class="viz-table v2-recruit-table">
        <caption>The dataset, now and once every class reaches ${goal}</caption>
        <thead><tr><th></th><th>Now</th><th>To recruit</th><th>At target</th></tr></thead>
        <tbody>
          <tr><th scope="row">Sittings started</th><td>${started}</td><td>+${runTotal}</td><td>${started + runTotal}</td></tr>
          <tr><th scope="row">Completed sittings (the analysed n)</th><td>${done}</td><td>+${owedTotal}</td><td><b>${goal * 4}</b></td></tr>
          <tr><th scope="row">Find judgments</th><td>${done * 2}</td><td>+${owedTotal * 2}</td><td>${goal * 8}</td></tr>
          <tr><th scope="row">Guide judgments</th><td>${done * 2}</td><td>+${owedTotal * 2}</td><td>${goal * 8}</td></tr>
          <tr><th scope="row">Grounded vs non-grounded, within Find</th><td>${done} vs ${done}</td><td></td><td>${goal * 4} vs ${goal * 4}</td></tr>
          <tr><th scope="row">Grounded vs non-grounded, within Guide</th><td>${done} vs ${done}</td><td></td><td>${goal * 4} vs ${goal * 4}</td></tr>
          <tr><th scope="row">Correct vs incorrect answer, within each</th><td>${done} vs ${done}</td><td></td><td>${goal * 4} vs ${goal * 4}</td></tr>
          <tr><th scope="row">Text vs visual participants</th><td>${have[0] + have[2]} vs ${have[1] + have[3]}</td><td></td><td>${goal * 2} vs ${goal * 2}</td></tr>
          <tr><th scope="row">Any one of the 16 cells</th><td>${Math.min(...have)}–${Math.max(...have)}</td><td></td><td><b>${goal}</b></td></tr>
        </tbody>
      </table></div>
      ${drift.length ? `<p class="welcome-status welcome-status-bad">Cells that do not match their
        class count: ${esc(drift.join('; '))}. A Guide cell drifts when <code>pickGuideFor</code>
        settles for a run of the wrong correctness because that style's pool has none of the wanted
        one — recruiting cannot fix it, authoring the missing run can.</p>`
        : '<p class="viz-note">Every cell matches its class count, so no sitting was dealt a task of the wrong correctness.</p>'}
    </section>`;
  }

  function renderResultsView() {
    const content = document.getElementById('find-v2-admin-content');
    if (!content) return;
    const rows = includedResultRows(adminFindResults);
    const guideRows = includedResultRows(adminGuideResults);
    const rate = subset => {
      if (!subset.length) return '—';
      return `${(100 * subset.filter(row => row.verdict_correct).length / subset.length).toFixed(1)}%`;
    };
    const yes = rows.filter(row => row.participant_verdict).length;
    const cell = key => rows.filter(row => (row.variant_key
      || V.variantKey(row.claim_correct_snapshot, row.condition)) === key);
    content.innerHTML = `
      ${resultParticipantOverviewHtml(adminFindResults, adminGuideResults)}
      ${recruitmentBalanceHtml(adminFindResults, adminGuideResults)}
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
      <div id="find-v2-guide-results"></div>`;

    renderGuideResults(rows, guideRows, adminGuideResultsError);
    bindResultParticipantFilters();
  }

  /**
   * The Guide half of the same session.
   *
   * A participant's fourth task lands in a different table, so a Results tab that only read the Find
   * one showed three quarters of every sitting and gave no hint the rest existed.
   */
  function renderGuideResults(findRows, rows, error = '') {
    const box = document.getElementById('find-v2-guide-results');
    if (!box) return;
    if (error) {
      box.innerHTML = `<p class="welcome-status welcome-status-bad">Guide results: ${esc(error)}</p>`;
      renderCharts(findRows || [], []);
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
        <thead><tr><th>When<span class="q-sub"> · Central</span></th><th>Participant</th><th>Group</th><th>Task</th><th>Why incorrect</th><th>Answer shown</th><th>Grounding</th><th>Refs opened</th><th>Completed?</th><th>Answer</th><th>Steps marked wrong</th><th>Scored</th><th>Time</th></tr></thead>
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
          ${markedWrongStepsCellHtml(row)}
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
