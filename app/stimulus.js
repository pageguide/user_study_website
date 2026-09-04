// The study site — the trajectory viewer (LEFT PANE).
// ==================================================
// A PORT of study/trajectory_view.js from the PageGuide extension, changed in exactly one place:
// where the record comes from. The extension reads chrome.storage.local; this reads the
// study_guide_trajectories row the site already fetched. Everything else — the layout, the arm
// gate, the hover/click gestures, the wording — is deliberately identical, because a participant
// running in the browser must be judging the same material as one running in the extension.
//
// The left half of a guide study task: what the agent did, at a size where it can be checked.
//
// This page MIRRORS THE LIVE RUN rather than inventing a way to look at a trajectory. A live user
// sees a "View Journey" card — a vertical list of steps, hover a row for that step's screenshot,
// click the screenshot for a full-size one (renderGoalTimeline / showGoalStepPreview /
// openMemoryShotLightbox, sidepanel/panel.js) — followed by the agent's answer and its reasoning
// trail. A participant judging that run should be looking at the same thing, or the study measures
// how well people read a study interface.
//
// ONE LAYOUT, TWO ARMS. The grounded arm is the checkable one, and everything that makes a step
// checkable travels together: the MILESTONE flags that say which steps are worth checking, the hover
// that shows the page a step acted on, and the click that opens it full size. The non-grounded arm is
// the same steps as text and nothing else. That is the same rule the live panel already applies in
// _buildGoalTimelineRow, which skips the hover/click wiring under _isPanelNonGrounding().
//
// The flags used to render in BOTH arms, which made them a fifth thing the non-grounded participant
// was handed — and a signpost to a door that is not there, since a flagged row it cannot open is a
// line of text like every other row. Moving them into the grounded bundle makes the manipulation
// wider than "the screenshots are missing", deliberately.
//
// Everything else — the order, the wording, the bookends, the answer, the trail, the browse
// simulator — is identical, because anything else that differs is a second variable nobody is
// measuring.
//
// Reads the published trajectory (study_guide_trajectories) rather than any live state: what a
// participant sees has to be what the researcher authored, edits and uploaded screenshots included.

// Resolved when the pane is mounted, not at load: on the site the stimulus lives inside the task
// screen rather than owning the document, so these elements may not exist yet.
let els = { goal: null, count: null, stage: null };

let arm = null;

// Which way round the two sections go, whether the journey opens folded, and whether the steps the
// trail calls out are flagged in the journey. Set per mount rather than read from a global so one
// file can serve both studies without either knowing about the other.
let layout = {
  trailFirst: false, journeyCollapsed: false, highlightMilestones: false,
  // WHICH SECTIONS ARE ON THE PAGE AT ALL. Every one of them is on by default, because that is the
  // stimulus: dropping one is a change to what a participant is asked to judge from, not a display
  // preference. Named here so the four can be varied deliberately (Admin -> Session preview) rather
  // than by editing render() and forgetting to put it back.
  sections: { states: true, journey: true, answer: true, trail: true },
};

// Gated on the arm, not on whether the data happens to carry a screenshot. _stripGuideArm nulls
// them, but an arm can also be hand-edited in the recorder, and one uploaded image would undo the
// condition for that participant without anyone noticing.
//
// The two STATE shots are the exception and are shown in both arms — see _stripGuideArm. The arms
// differ in whether each ACTION can be checked, not in whether the outcome is known.
let showShots = true;

// ── The browse simulator ──────────────────────────────────────────────────────
//
// WHAT IT IS. A non-grounded participant is shown what the agent did as text: step 7 says "clicked
// Departures", and there is no way to see the page it was looking at when it did. The simulator
// hands that back on request — a button that opens the run as a slideshow, one page state per step,
// walked with Back and Next.
//
// OFFERED IN BOTH ARMS, and that is a deliberate reversal of how it started. It began as the
// non-grounded arm's one way back to the pages, which made it part of what separated the conditions
// — and a manipulation nobody had decided to run. As a constant it is cleaner: the arms now differ
// ONLY in whether the evidence sits beside each claim (a grounded step is checkable with a hover, a
// non-grounded one is text), and both get the same optional walk through the same pages. The
// simulator's usage also becomes a measure that is directly comparable across the arms, which it
// could never be while only one of them had the button.
//
// WHERE THE PICTURES COME FROM. In the non-grounded arm `arm` is the STRIPPED arm — _stripGuideArm
// nulled every step screenshot, which is the definition of that arm and must not be undone. So the
// simulator reads the untouched record instead, in both arms alike: if the grounded arm was never
// recorded there is nothing to simulate and the button is not rendered.
let sourceRecord = null;
let allowBrowseSim = false;

// HOW LONG A PAGE TAKES TO COME UP. The walk models browsing, and browsing is not instant — with no
// delay at all the buttons scrub, and a participant can flick through fourteen pages in a second
// without any of them having been on screen long enough to read. It also makes a held-down arrow
// key advance at a readable rate instead of emptying the run in one press.
//
// SET PER MOUNT, from `browse_sim_delay_ms`, because it is the one number here that changes what
// the instrument measures: the cost of looking is the whole difference between "the evidence was
// available" and "the evidence was worth going to get". This is the fallback for a caller that
// passes none, and it matches the column default.
const BROWSE_STEP_DEFAULT_MS = 500;
let browseStepMs = BROWSE_STEP_DEFAULT_MS;

// Per mount. Reset with the task, because the question it answers — "did THIS participant open the
// simulator on THIS task, and how far BACK did they walk it?" — is per task, and a running total
// across a four-task queue would attribute task 1's looking to task 4.
//
// `nearest` is the LOWEST frame index reached, because the walk opens on the last page and travels
// backwards — see openBrowseSim. It starts at Infinity rather than 0 so that "never moved" and
// "walked all the way to the first page" are not the same number.
let browseSim = { opens: 0, steps: 0, nearest: Infinity, firstOpenMs: null, mountedAt: 0 };

// THE SAME OVERLAY REACHED THE OTHER WAY, counted separately.
//
// Clicking a step in the grounded journey opens the run at that step and can be paged from there,
// so the two entry points share every line of the walker. They are not the same gesture, though:
// pressing the button is "I am going to go and look through this run", while expanding a step is "I
// want a closer look at THIS one" and the paging is what happens once someone is already in there.
// Pooling them would let a study that never offers the button still report browse_sim activity.
let stepWalk = { opens: 0, steps: 0, mountedAt: 0 };

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Mount the stimulus for one trajectory.
 *
 * Takes the record and the arm rather than reading a query string: the site walks a queue, so the
 * task on screen is decided by the session, not by the URL. Everything after this point is the
 * extension's code unchanged.
 *
 * @param {object} record - a study_guide_trajectories row
 * @param {'grounding'|'nongrounding'} armName
 * @param {{goal: Element, count: Element, stage: Element}} mount
 * @param {{trailFirst?: boolean, journeyCollapsed?: boolean, highlightMilestones?: boolean}} [options]
 *   - V2's Guide task leads with the reasoning trail and folds the journey away beneath it. Defaults
 *   to V1's layout, whose recorded runs were judged with the journey open and first and must stay
 *   that way. `highlightMilestones` is OFF by default and is a study variable, not a polish: see the
 *   note above the flag in render(). `sections` drops one of the four blocks from the page; every
 *   one of them is shown unless it is explicitly `false`.
 */
function mountStimulus(record, armName, mount, options) {
  els = mount;
  layout = {
    trailFirst: !!options?.trailFirst,
    journeyCollapsed: !!options?.journeyCollapsed,
    highlightMilestones: !!options?.highlightMilestones,
    // Absent means shown. A caller that passes nothing gets the whole stimulus, so a section can
    // only ever go missing because someone asked for it to.
    sections: {
      states: options?.sections?.states !== false,
      journey: options?.sections?.journey !== false,
      answer: options?.sections?.answer !== false,
      trail: options?.sections?.trail !== false,
    },
  };
  showShots = armName !== 'nongrounding';
  document.body.classList.toggle('tv-nogrounding', !showShots);
  sourceRecord = record || null;
  // BOTH ARMS. See the note above the declaration: the walk is a constant of the study now, not a
  // non-grounded affordance, so the only thing gating it is whether the study offers it at all.
  allowBrowseSim = options?.allowBrowseSim === true;
  const delay = Number(options?.browseSimDelayMs);
  browseStepMs = Number.isFinite(delay)
    ? Math.min(5000, Math.max(0, Math.round(delay))) : BROWSE_STEP_DEFAULT_MS;
  browseSim = { opens: 0, steps: 0, nearest: Infinity, firstOpenMs: null, mountedAt: Date.now() };
  stepWalk = { opens: 0, steps: 0, mountedAt: Date.now() };
  closeBrowseSim();

  if (!record) {
    els.goal.textContent = 'This task could not be loaded.';
    return;
  }

  // No cross-arm fallback. Showing the grounded trajectory to a non-grounded participant because
  // their arm was never recorded does not degrade gracefully — it hands them the exact thing the
  // arm exists to withhold, and nothing downstream would ever say so.
  //
  // Deriving it is a different matter: _stripGuideArm is the definition of the non-grounded arm,
  // not a substitute for it, so an unstripped trajectory shows text rather than an apology.
  arm = record.arms?.[armName] || null;
  if (!arm && armName === 'nongrounding' && record.arms?.grounding && typeof window._stripGuideArm === 'function') {
    arm = window._stripGuideArm(record.arms.grounding);
  }
  els.goal.textContent = record.goal || record.title || '';
  if (!arm) {
    els.stage.innerHTML = '<div class="tv-empty">This task has no trajectory recorded for this condition.</div>';
    return;
  }

  const n = (arm.steps || []).length;
  els.count.textContent = `${n} step${n === 1 ? '' : 's'}`;
  render();
  bindHints();
  bindStates();
  bindPreviews();
  bindBrowseSim();

  // The answer, into whichever node the caller gave for it. Rendered after the stage so a caller
  // that supplies one gets the same arm-dependent markup the stage would have drawn.
  if (els.answer) {
    els.answer.innerHTML = answerSectionHtml();
    bindAnswerNode(els.answer);
    bindHintsOn(els.answer);
  }
}

/**
 * The agent's answer, rendered exactly as the left pane would render it.
 *
 * FOR THE QUESTION PANE. The answer is the claim being judged, and it belongs beside the question
 * that asks about it rather than buried between the journey and the trail, where a participant had
 * to scroll away from the Yes/No to re-read the thing they were saying Yes or No about.
 *
 * Built here rather than in study.js because the rendering is arm-dependent and non-trivially so:
 * `richText` numbers the surviving [ev:…] markers into chips and underlines the linked phrases in
 * the grounded arm, and does neither in the non-grounded one. A second copy of that rule in the
 * question pane is a second thing to get wrong, and the two would disagree silently.
 */
function answerSectionHtml() {
  if (!arm) return '';
  return `
    ${sectionTitle('Agent answer', showShots
      ? 'What the agent reported back when it finished — the claim you are being asked to judge. A numbered chip marks a claim the agent backed with something it saw; hover it to see what.'
      : 'What the agent reported back when it finished — the claim you are being asked to judge.')}
    <div class="tv-answer">${richText(arm.answer)}</div>`;
}

/**
 * Wire hover and click on an answer rendered outside the stage.
 *
 * The chips only mean anything if they open what they point at, and bindPreviews listens on the
 * stage — so an answer moved to the question pane would render its chips and then do nothing when
 * they were pressed, which is worse than not drawing them.
 */
function bindAnswerNode(node) {
  if (!node || !showShots) return;
  bindPreviewsOn(node);
}

/** The steps this trajectory shows, for the step buttons in the question pane. */
function stimulusSteps() {
  return (arm && arm.steps) || [];
}

/** The ⓘ toggles. Bound in both arms — knowing what a section is called is not grounding. */
function bindHints() {
  bindHintsOn(els.stage);
}

/** The ⓘ toggles for one container — the stage, or the answer wherever it was mounted. */
function bindHintsOn(host) {
  if (!host || host.dataset.bound === '1') return;   // the node is reused across tasks
  host.dataset.bound = '1';
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('.tv-info');
    if (!btn) return;
    const hint = btn.parentElement.querySelector('.tv-hint');
    if (!hint) return;
    hint.hidden = !hint.hidden;
    btn.setAttribute('aria-expanded', hint.hidden ? 'false' : 'true');
    btn.classList.toggle('is-open', !hint.hidden);
  });
}

/**
 * Click a state to see it. Bound in BOTH arms — unlike the step previews.
 *
 * The arms differ in whether each ACTION can be checked against the page it was taken on. The
 * before/after pair is the outcome, which both arms are asked to judge; withholding it from one of
 * them would make the condition about who was told whether the task succeeded.
 */
function bindStates() {
  // GUARDED, like bindHints. The stage node is rebuilt per task today, which is the only reason a
  // second listener never accumulated here; reuse that node once and every state open would be
  // counted twice.
  if (els.stage.dataset.statesBound === '1') return;
  els.stage.dataset.statesBound = '1';
  els.stage.addEventListener('click', (e) => {
    const btn = e.target.closest('.tv-state-btn');
    if (!btn) return;
    const state = btn.dataset.state === 'initial' ? arm.initial_state : arm.final_state;
    if (!state?.screenshot) return;
    // The one reference kind a NON-GROUNDED participant can still open — the before/after pair is
    // shown in both arms, on purpose. A non-zero count on a non-grounded row is not a bug.
    if (e.isTrusted) reportReference(btn, 'click');
    openLightbox({
      shot: state.screenshot,
      title: btn.dataset.state === 'initial' ? 'Before the agent started' : 'After the agent finished',
      note: state.url || '',
    });
  });
}

/**
 * The two page states, as one section above the journey. Shown in both arms.
 *
 * Their own section rather than two pictures bracketing the steps: they are not steps and they are
 * not evidence, they are the pair a participant compares to answer "did this actually get done?".
 * Side by side and openable in either order, that comparison is one click each; spread top and
 * bottom of a long page, it is a scroll and a memory test.
 *
 * A state with no screenshot still renders, disabled and saying so. Rendering nothing is how this
 * looked for a run that predated the bookends — indistinguishable from the feature not existing.
 */
function statesSection() {
  // A THUMBNAIL, NOT JUST A LABEL. "Click to view" describes a picture without showing that there
  // is one, and a card that looks like a heading gets read as a heading — the two state shots are
  // the fastest way to see whether the job got done, and they were the least-opened thing on the
  // screen. The thumbnail is the same JPEG the lightbox opens, drawn small; nothing extra is
  // fetched, since the whole trajectory is already in memory by the time this renders.
  const cell = (state, kicker, caption, key) => {
    const has = !!state?.screenshot;
    return `
      <button type="button" class="tv-state-btn${has ? '' : ' is-empty'}" data-state="${key}"${has ? '' : ' disabled'}>
        ${has ? `<span class="tv-state-thumb">
          <img src="data:image/jpeg;base64,${state.screenshot}" alt="" loading="lazy">
        </span>` : ''}
        <span class="tv-state-text">
          <span class="tv-state-kicker">${esc(kicker)}</span>
          <span class="tv-state-cap">${esc(caption)}</span>
          <span class="tv-state-hint">${has ? 'Click to enlarge' : 'Not recorded for this run'}</span>
        </span>
      </button>`;
  };
  return `
    ${sectionTitle('The page before and after', 'The page as it was before the agent started, and as it was left once it stopped. Comparing the two is the quickest way to see whether the task actually got done.')}
    <div class="tv-states">
      ${cell(arm.initial_state, 'Before', 'The page before the agent started', 'initial')}
      ${cell(arm.final_state, 'After', 'The page once the agent finished', 'final')}
    </div>`;
}

/**
 * Text with each [ev:key] marker turned into a numbered chip. Used for the answer AND the trail's
 * summary, since either can cite evidence and a raw "[ev:54]" in prose is worse than no marker.
 *
 * Ported from _studyGuideAnswerHtml (sidepanel/study.js), where it used to run in the panel. The
 * chips are what tie a claim to the thing backing it — "added a Navel Orange to the cart [1]" — and
 * they carry the same hover/click gestures as everything else on this page.
 */
function chipify(html) {
  const byKey = new Map();
  (arm.answer_evidence || []).forEach(ev => {
    if (ev?.key) byKey.set(String(ev.key).trim().toLowerCase(), ev);
  });
  // NUMBERED BY WHAT SURVIVES, not by position in the source. Removing three of five markers must
  // leave chips 1 and 2, not 2 and 5 — a numbering with holes in it reads as evidence that failed
  // to load rather than as evidence that was never claimed.
  let shown = 0;
  return String(html || '')
    .replace(/\[ev:\s*([^\]]+)\]/gi, (match, rawKey) => {
      const hit = byKey.get(String(rawKey).trim().toLowerCase());
      // A marker whose evidence did not survive is dropped rather than shown as raw text.
      if (!hit) return '';
      shown++;
      return `<button type="button" class="tv-chip" data-ev-key="${esc(hit.key)}" title="See what this rests on">${shown}</button>`;
    })
    // CLOSE THE GAP THE MARKER LEFT. The marker sat behind a space, so dropping it stranded that
    // space in front of the punctuation: "the cart now contains 3 items , with the quantity set
    // to 2 ." Cosmetic, but it is the sentence a participant is being asked to judge, and it reads
    // as a typo in the agent's answer rather than as evidence we chose not to show.
    // _stripGuideEvidenceMarkers does the same tidy-up on the non-grounded side.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
}

/**
 * Underline the phrases that rest on something, in place.
 *
 * A port of _answerLinkedSummaryHtml (sidepanel/panel.js): each segment names a phrase copied
 * verbatim out of the text, so it is located by substring and wrapped where it sits. The underline
 * is the part a trailing number cannot do — it says WHICH WORDS the evidence backs, so a claim and
 * its proof stay attached instead of being a sentence and a footnote.
 *
 * Overlapping segments are dropped rather than nested: two underlines fighting over the same words
 * would break the text into pieces that read as neither phrase.
 */
function linkPhrases(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const ranges = [];
  (arm.answer_segments || []).forEach(seg => {
    const phrase = String(seg?.phrase || '').trim();
    if (!phrase) return;
    const start = lower.indexOf(phrase.toLowerCase());
    if (start < 0) return;                       // the answer was edited out from under the segment
    const end = start + phrase.length;
    if (ranges.some(r => start < r.end && end > r.start)) return;
    if (!segmentHasTarget(seg)) return;          // nothing to open: leave it as prose
    ranges.push({ start, end, seg });
  });
  if (!ranges.length) return esc(raw);

  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  ranges.forEach(({ start, end, seg }) => {
    out += esc(raw.slice(cursor, start));
    const attr = seg.key
      ? ` data-ev-key="${esc(seg.key)}"`
      : ` data-ev-step="${esc(String(seg.step))}"`;
    out += `<span class="tv-ref"${attr} title="${esc(seg.note || 'See what this rests on')}">${esc(raw.slice(start, end))}</span>`;
    cursor = end;
  });
  return out + esc(raw.slice(cursor));
}

/** Whether a segment leads anywhere — evidence by key, or a step with a picture. */
function segmentHasTarget(seg) {
  if (seg?.key) {
    return (arm.answer_evidence || []).some(ev =>
      String(ev.key || '').trim().toLowerCase() === String(seg.key).trim().toLowerCase() && ev.screenshot);
  }
  return milestoneHasShot(seg?.step);
}

/** The shared renderer (app/markdown.js) — see there for why it splits on tags. */
function renderMarkdown(escaped) {
  return window.StudyMarkdown.render(escaped);
}

/** Both passes over one piece of prose: underline the linked phrases, then number the markers. */
function richText(text) {
  if (!showShots) return renderMarkdown(esc(text || ''));
  return renderMarkdown(chipify(linkPhrases(text)));
}

/**
 * A section heading with a hint folded away behind an ⓘ.
 *
 * Collapsed by default and on every render: "agent answer", "reasoning trail" and "view journey" are
 * this product's words, not everyone's, and a participant who has never seen PageGuide is guessing
 * at the difference between the answer and the trail. Spelling it out inline would put three
 * paragraphs of instruction above the material they were brought here to read, so the explanation
 * waits until it is asked for.
 */
function sectionTitle(text, hint) {
  return `
    <div class="tv-section-title">
      <span>${esc(text)}</span>
      <button type="button" class="tv-info" data-hint aria-expanded="false" aria-label="What is this?">i</button>
      <div class="tv-hint" hidden>${esc(hint)}</div>
    </div>`;
}

function render() {
  const steps = arm.steps || [];
  const milestones = (arm.trail?.milestones || []);

  // THE STEPS THE TRAIL CALLS OUT, FLAGGED IN THE JOURNEY.
  //
  // The trail names some of the journey's steps and not others, and a participant reading a
  // thirty-step list has no way to tell which ones the agent treated as milestones without holding
  // the trail in their head and matching numbers by eye. Flagging them turns that lookup into a
  // glance.
  //
  // A STUDY VARIABLE, NOT A NICETY, and now a strong one: the legend tells a participant they can
  // check the marked steps INSTEAD OF the whole journey. That is licence to stop reading, and the
  // steps it licenses stopping at are the ones the agent CHOSE to narrate — which for a misreported
  // run is exactly where the discrepancy is not. Switchable per study (flag_milestones) so a
  // condition can be run without it; see supabase_v2_milestone_flag.sql.
  const keySteps = new Set(milestones.map(m => Number(m.step)).filter(n => Number.isFinite(n)));

  // GROUNDED ONLY. The flags used to render in both arms, which made them a fifth thing the
  // non-grounded participant was given and quietly widened what the arm meant. They belong with the
  // evidence: a milestone flag says "this step is one of the ones worth checking", and in the
  // non-grounded arm there is nothing to check it against — the row it points at is a line of text
  // like every other row. Pointing at steps a participant cannot open is a signpost to a door that
  // is not there.
  //
  // So the grounded arm is now the whole bundle — milestone flags, hover for the page, click for
  // the full size — and the non-grounded arm is the steps as text. That is a WIDER manipulation
  // than "the screenshots are missing", and deliberately so; `flag_milestones` still switches the
  // flags off for the grounded arm when a condition wants the journey unmarked.
  const marking = showShots && layout.highlightMilestones && keySteps.size > 0;

  // THE CLICK AFFORDANCE, SAID OUT LOUD.
  //
  // The grounded arm IS the screenshot behind each step, and until now the only place that said so
  // was the ⓘ beside "View Journey" — collapsed by default, so a participant who never pressed it
  // was never told the rows open. That is the manipulation going unused for want of a sentence.
  //
  // NOT GATED ON `marking`. It sits under the milestone legend when there is one, but it is about a
  // different thing: milestones are which steps are worth checking, this is how to check one. Tying
  // it to the milestone flag would mean switching that study variable off also hid how to use the
  // journey, which is not a trade either setting is meant to make.
  const canPeek = showShots && steps.some((st, i) => shotAt(arm, i));

  const journeyHtml = `
      ${sectionTitle('View Journey', showShots
        ? 'Every action the agent took, in the order it took them. Hover a step to see the page it was looking at when it acted; click for a full-size view.'
        : 'Every action the agent took, in the order it took them.')}

      <details class="tv-journey"${layout.journeyCollapsed ? '' : ' open'}>
        <summary class="tv-journey-summary">The steps${marking
          ? ` <span class="tv-key-count">${keySteps.size} milestones</span>` : ''}</summary>
        <div class="tv-journey-list">
          ${marking ? `<p class="tv-key-legend">The steps marked <span class="tv-key-flag">milestone</span>
            are the important steps. You can check <b>these</b> rather than viewing the entire journey.</p>` : ''}
          ${canPeek ? `<p class="tv-key-legend tv-peek-legend">You can
            <span class="tv-peek-word">click</span> the steps to view it fully.</p>` : ''}
          ${steps.map((step, i) => {
            const live = showShots && !!shotAt(arm, i);
            const key = marking && keySteps.has(Number(step.n));
            return `
            <div class="tv-journey-row${live ? ' is-shot' : ''}${key ? ' is-key' : ''}"
              data-journey-step="${esc(String(step.n))}"${live ? ` data-step="${esc(String(step.n))}"` : ''}>
              <span class="tv-dot"></span>
              <span class="tv-journey-text">${key ? '<span class="tv-key-flag">milestone</span>' : ''}<b>${esc(String(step.n))}</b> ${esc(step.instruction || '')}</span>
              <span class="tv-step-actions">
                ${live ? '<span class="tv-peek" aria-hidden="true">⌕</span>' : ''}
                <button type="button" class="tv-mark-wrong" data-mark-step="${esc(String(step.n))}"
                  aria-pressed="false" aria-label="Mark step ${esc(String(step.n))} as wrong" hidden>
                  <span class="tv-mark-plus" aria-hidden="true">+</span><span class="tv-mark-label">Mark wrong</span>
                </button>
              </span>
            </div>`;
          }).join('')}
          ${showShots && steps.length && !steps.some((st, i) => shotAt(arm, i)) ? `
            <p class="tv-warn">No step screenshots were saved with this trajectory, so there is nothing to preview. Re-capture it from the run to add them.</p>` : ''}
        </div>
      </details>`;

  // THE TRAIL IS NEUTRAL, DELIBERATELY.
  //
  // Every milestone carries {status, errorLabel} from the recorder, and this briefly rendered them —
  // an amber flag reading "loop" on the step that went wrong. That was a mistake: the participant's
  // whole task is to decide whether the agent completed the job, and a marked-up step answers that
  // question for them before they have looked at anything. The trail has to read the same whether
  // the run succeeded or failed, or it is a hint rather than a stimulus.
  //
  // The fields are still in the data and the editor still shows them, so restoring the flags is a
  // small change if the design ever calls for a condition that reveals them.
  const trailHtml = (layout.sections.trail && (arm.trail?.summary || milestones.length)) ? `
      ${sectionTitle('Reasoning trail', 'The agent\'s own account of what it did and why, written after the run. It picks out the steps it treated as milestones — some of the journey above, not all of it — in the agent\'s words rather than as actions.')}
      <div class="tv-trail">
        ${arm.trail?.summary ? `<p class="tv-trail-summary">${richText(arm.trail.summary)}</p>` : ''}
        ${milestones.map(m => {
          const live = showShots && milestoneHasShot(m.step);
          return `
          <div class="tv-journey-row${live ? ' is-shot' : ''}"${live ? ` data-ev-step="${esc(String(m.step))}"` : ''}>
            <span class="tv-dot"></span>
            <span class="tv-journey-text"><b>${esc(String(m.step ?? ''))}</b> ${esc(m.text || '')}</span>
            ${live ? '<span class="tv-peek" aria-hidden="true">⌕</span>' : ''}
          </div>`;
        }).join('')}
      </div>` : '';

  // The answer sits between them either way: it is the claim being judged, and it reads as a
  // conclusion to whichever account came first.
  const answerHtml = `
      ${sectionTitle('Agent answer', showShots
        ? 'What the agent reported back when it finished — the claim you are being asked to judge. A numbered chip marks a claim the agent backed with something it saw; hover it to see what.'
        : 'What the agent reported back when it finished — the claim you are being asked to judge.')}
      <div class="tv-answer">${richText(arm.answer)}</div>`;

  // The answer sits between the two accounts either way; with a section switched off the remaining
  // ones close up rather than leaving a gap where it was.
  const ordered = layout.trailFirst
    ? [trailHtml, layout.sections.answer ? answerHtml : '', layout.sections.journey ? journeyHtml : '']
    : [layout.sections.journey ? journeyHtml : '', layout.sections.answer ? answerHtml : '', trailHtml];

  els.stage.innerHTML = `
    <div class="tv-col">
      ${layout.sections.states ? statesSection() : ''}
      ${browseSimButtonHtml()}
      ${ordered.join('')}
      ${ordered.every(part => !part) && !layout.sections.states
        ? '<div class="tv-empty">Every section is switched off — there is nothing here to judge from.</div>' : ''}
    </div>`;
}

/** The step that a number refers to, if the trajectory has it. */
function stepAt(n) {
  return (arm.steps || []).find(st => Number(st.n) === Number(n)) || null;
}

/**
 * THE SCREENSHOT TO SHOW FOR A STEP — the page AFTER it acted, not before.
 *
 * The recorder captures each step's screenshot as the page it was looking at when it decided to
 * act, so `steps[i].screenshot` is the state BEFORE step i runs. Rendered next to step i's own
 * instruction that reads as an off-by-one, and not subtly: "Click on the search icon to search for
 * RBD Library" sat beside a picture of the Samford Hall panel, which is where the PREVIOUS step had
 * left the page. A participant checking whether the agent did what it said is comparing a sentence
 * against the screen from before the sentence happened.
 *
 * So a step displays the NEXT step's capture, which is the same pixels the recorder took one moment
 * later — the page once this action had landed. The last step has no next capture and falls back to
 * `final_state`, which is exactly the page after the last action, so the shift closes cleanly at
 * both ends rather than leaving the final step blank.
 *
 * NOTHING IS RE-SAVED. This is a display rule and only a display rule: the stored trajectory is
 * untouched, so it stays whatever the recorder wrote and this can be reverted by deleting one
 * function. It assumes pre-action capture throughout; a run recorded post-action would be pushed
 * one the other way, which is worth checking on any trajectory imported from a different recorder.
 *
 * @param {object} armObj - the arm holding the steps and the bookends
 * @param {number} i - position in `armObj.steps`, not the step's printed number
 */
function shotAt(armObj, i) {
  const steps = (armObj && armObj.steps) || [];
  if (i < 0 || i >= steps.length) return null;
  if (i + 1 < steps.length) return steps[i + 1].screenshot || null;
  return (armObj && armObj.final_state && armObj.final_state.screenshot) || null;
}

/** The same rule, addressed by the step's printed number rather than its position. */
function shotForStep(armObj, n) {
  const steps = (armObj && armObj.steps) || [];
  return shotAt(armObj, steps.findIndex(st => Number(st.n) === Number(n)));
}

/**
 * What a hovered row, chip or milestone should show.
 *
 * A milestone resolves to its step's own picture when no saved evidence names that step — which is
 * the normal case, since the answer's evidence clusters on the finish step while the trail narrates
 * every step. Matching evidence only was why hovering "Clicked the globe icon" showed nothing at
 * all: a wired row that silently does nothing reads as broken, not as empty.
 */
function previewFor(el) {
  if (el.dataset.step != null) {
    const step = stepAt(el.dataset.step);
    const shot = shotForStep(arm, el.dataset.step);
    if (!step || !shot) return null;
    return { shot, title: `Step ${step.n}`, note: step.instruction || '', url: step.url || '' };
  }

  const items = arm.answer_evidence || [];
  if (el.dataset.evKey != null) {
    const hit = items.find(ev => String(ev.key || '').trim().toLowerCase() === String(el.dataset.evKey).trim().toLowerCase());
    if (!hit?.screenshot) return null;
    return { shot: hit.screenshot, title: hit.step != null ? `Step ${hit.step}` : 'Evidence', note: hit.note || hit.key || '', url: '' };
  }

  const n = el.dataset.evStep;
  const evidence = items.find(ev => Number(ev.step) === Number(n) && ev.screenshot);
  if (evidence) {
    return { shot: evidence.screenshot, title: `Step ${n}`, note: evidence.note || evidence.key || '', url: '' };
  }
  const step = stepAt(n);
  const shot = shotForStep(arm, n);
  if (!step || !shot) return null;
  return { shot, title: `Step ${step.n}`, note: step.instruction || '', url: step.url || '' };
}

/**
 * The step number an anchor points at, or null.
 *
 * The three attributes are the three ways a row or chip names a step — a journey row carries
 * `data-step`, a trail milestone `data-ev-step`, and an answer chip only a key, whose evidence may
 * or may not record which step it came from. Only a resolved number can open the walk at the right
 * place; anything else falls back to the single-picture lightbox.
 */
function stepNumberOf(el) {
  if (el.dataset.step != null) return Number(el.dataset.step);
  if (el.dataset.evStep != null) return Number(el.dataset.evStep);
  if (el.dataset.evKey != null) {
    const hit = (arm.answer_evidence || []).find(ev =>
      String(ev.key || '').trim().toLowerCase() === String(el.dataset.evKey).trim().toLowerCase());
    if (hit?.step != null) return Number(hit.step);
  }
  return null;
}

/** Whether a milestone has anything to show — evidence naming its step, or the step's own picture. */
function milestoneHasShot(step) {
  if (step == null) return false;
  const named = (arm.answer_evidence || []).some(ev => Number(ev.step) === Number(step) && ev.screenshot);
  return named || !!shotForStep(arm, step);
}

/**
 * Hover for the screenshot, click it for the big one — the live run's two gestures.
 *
 * The hide is DELAYED and cancellable, exactly as _scheduleGoalPreviewHide does in the panel. The
 * click target lives inside the card, so a card that closed the moment the pointer left the row
 * would make the second gesture unreachable: you would watch the thing you were trying to click
 * disappear as you moved towards it.
 */
function bindPreviews() {
  if (!showShots) return;   // no card, no lightbox, nothing to click: that is the arm.
  bindPreviewsOn(els.stage);
}

/**
 * The hover/click wiring, for one container.
 *
 * Was hard-wired to the stage. It takes a node now because the answer lives in the OTHER pane, and
 * its chips have to behave the same as the ones that used to sit beside the journey — same dwell,
 * same card, same lightbox — without the question pane knowing anything about how that works.
 */
function bindPreviewsOn(host) {
  if (!host || host.dataset.previewsBound === '1') return;
  host.dataset.previewsBound = '1';
  // Held, not merely crossed. Reading the journey sweeps the pointer over every row on the way down.
  let dwellTimer = null;
  let dwellFor = null;
  const cancelDwell = () => { clearTimeout(dwellTimer); dwellTimer = null; dwellFor = null; };
  let hideTimer = null;
  const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const hideNow = () => { cancelHide(); document.getElementById('tv-pop')?.remove(); };
  const scheduleHide = () => { cancelHide(); hideTimer = setTimeout(hideNow, 220); };

  host.addEventListener('mouseover', (e) => {
    const anchor = e.target.closest('[data-step], [data-ev-key], [data-ev-step]');
    if (!anchor) { if (!e.target.closest('#tv-pop')) { cancelDwell(); scheduleHide(); } return; }
    cancelHide();
    if (e.isTrusted && dwellFor !== anchorKey(anchor)) {
      cancelDwell();
      dwellFor = anchorKey(anchor);
      dwellTimer = setTimeout(() => reportReference(anchor, 'hover'), REFERENCE_DWELL_MS);
    }
    if (document.getElementById('tv-pop')?.dataset.for === anchorKey(anchor)) return;
    const item = previewFor(anchor);
    if (!item) return;
    hideNow();

    const pop = document.createElement('div');
    pop.id = 'tv-pop';
    pop.className = 'tv-pop';
    pop.dataset.for = anchorKey(anchor);
    pop.innerHTML = `
      <img class="tv-pop-shot" src="data:image/jpeg;base64,${item.shot}" alt="${esc(item.title)}" title="Click for a bigger view">
      <div class="tv-pop-title">${esc(item.title)}</div>
      <div class="tv-pop-note">${esc(item.note)}</div>
      ${item.url ? `<div class="tv-step-url">${esc(item.url)}</div>` : ''}`;
    // A data: URI still decodes asynchronously, so at append time the card is a caption with a
    // zero-height picture above it — about 60px where the finished card is nearer 370. Positioned
    // once off that measurement, a chip low in the answer got a card placed just below it and then
    // grown off the bottom of a FIXED-position viewport: the note visible, the screenshot cut away
    // and unreachable by scrolling. Measure again once the shot has a size.
    pop.querySelector('.tv-pop-shot')?.addEventListener('load', () => {
      if (pop.isConnected) position(pop, anchor);
    });
    pop.addEventListener('mouseenter', cancelHide);
    pop.addEventListener('mouseleave', scheduleHide);
    pop.addEventListener('click', (ev) => {
      if (ev.target.closest('.tv-pop-shot')) openStepWalk(item, stepNumberOf(anchor));
    });

    document.body.appendChild(pop);
    position(pop, anchor);
  });

  host.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-step], [data-ev-key], [data-ev-step]')) { cancelDwell(); scheduleHide(); }
  });

  // Clicking the row itself opens the big view too — the card is a preview, not a toll gate.
  host.addEventListener('click', (e) => {
    const anchor = e.target.closest('[data-step], [data-ev-key], [data-ev-step]');
    if (!anchor) return;
    // One handler for .tv-chip, .tv-ref, journey rows and trail rows alike — the four ways a Guide
    // participant reaches the evidence behind a claim.
    if (e.isTrusted) reportReference(anchor, 'click');
    const item = previewFor(anchor);
    // OPENED AS A WALK, positioned at the step that was clicked, so the pages either side of it are
    // one press away rather than a close-and-find-the-next-row away.
    if (item) { hideNow(); openStepWalk(item, stepNumberOf(anchor)); }
  });
}

// How long a preview must be held before it counts as looked at. Short enough that a deliberate
// check registers, long enough that crossing a chip on the way somewhere else does not.
//
// DECLARED ONCE, HERE, AND EXPORTED. app/study.js makes the same judgement about the same gesture and
// used to declare its own `const REFERENCE_DWELL_MS` — but classic <script> tags share ONE global
// lexical scope, and study.html loads both files, so two top-level `const`s of one name is a PARSE
// error that kills the whole of study.js. The page then renders its static shell and stops: both
// panes sit on "Loading…" forever, and the console blames a line in a file that looks fine. This
// file is the one loaded on every page that shows a trajectory, so the constant lives here and
// study.js reads it off the export.
const REFERENCE_DWELL_MS = 400;

/**
 * Tell the study page a reference was opened, if a study page is listening.
 *
 * OPTIONAL BY DESIGN. This viewer is also loaded by V1 and by preview.html, neither of which has the
 * task telemetry, so it reports through a hook it does not require. The viewer stays a viewer.
 */
function reportReference(el, via) {
  if (!el) return;
  const kind = el.classList?.contains('tv-chip') ? 'chip'
    : el.classList?.contains('tv-ref') ? 'ref'
    : el.classList?.contains('tv-state-btn') ? 'state' : 'step';
  try { window.StudyTelemetry?.reference(kind, anchorKey2(el), via); } catch (e) { /* not listening */ }
}

/** anchorKey, but tolerant of the state buttons, which carry data-state instead. */
function anchorKey2(el) {
  if (el.dataset?.state != null) return `t${el.dataset.state}`;
  if (el.dataset?.step == null && el.dataset?.evKey == null && el.dataset?.evStep == null) return '';
  return anchorKey(el);
}

function anchorKey(el) {
  return el.dataset.step != null ? `s${el.dataset.step}`
    : el.dataset.evKey != null ? `k${el.dataset.evKey}` : `e${el.dataset.evStep}`;
}

/**
 * Sit under the row, clamped to the viewport — the card is taller than most rows have room for.
 *
 * Below if it fits, above if it fits there instead, and otherwise WHEREVER IT FITS: the last case is
 * the one that matters, because a chip in the middle of a long answer has room for a 370px card in
 * neither direction, and the old code fell through to "below" and let the screenshot hang off the
 * bottom edge. The card is fixed-position, so anything past that edge cannot be scrolled to — it is
 * simply gone. Pushing the card up to sit flush against the bottom keeps the picture on screen; the
 * max-height in stimulus.css catches the remaining case where even the whole viewport is too short.
 */
function position(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  const fitsBelow = r.bottom + box.height + 12 <= window.innerHeight;
  const fitsAbove = r.top - box.height - 8 > 0;
  const top = fitsBelow ? r.bottom + 8
    : fitsAbove ? r.top - box.height - 8
    : window.innerHeight - box.height - 8;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8))}px`;
}

/** The full-size view. Same id and close behaviour as the panel's lightbox. */
/**
 * The frames the simulator walks: the run's page states, in the order the agent saw them.
 *
 * READ FROM THE RECORD, NEVER FROM `arm`. In the non-grounded arm `arm` is the stripped copy and its
 * screenshots are all null by design — reading them here would give an empty slideshow, and
 * un-stripping `arm` to fill it would put the screenshots back into the journey as well and quietly
 * end the condition.
 *
 * THE BOOKENDS ARE PART OF THE WALK. "Before the agent started" and "After it finished" are already
 * shown in both arms as their own section, so including them costs the condition nothing — and a
 * slideshow that begins at step 1 asks the participant to judge a change from a state it never
 * showed them. A step with no capture is skipped rather than rendered blank: the agent's own record
 * is what it is, and a grey rectangle in the middle of the walk reads as a broken viewer.
 */
function browseSimFrames() {
  const source = sourceRecord?.arms?.grounding;
  if (!source) return [];
  const frames = [];
  if (source.initial_state?.screenshot) {
    frames.push({
      shot: source.initial_state.screenshot,
      title: 'Before the agent started',
      note: source.initial_state.url || '',
      step: null,
    });
  }
  (Array.isArray(source.steps) ? source.steps : []).forEach((step, i) => {
    // The same one-step shift the journey uses, for the same reason — see shotAt. A walk that
    // labelled its pages differently from the rows they were reached from would be worse than the
    // off-by-one it was fixing.
    const shot = shotAt(source, i);
    if (!shot) return;
    frames.push({
      shot,
      title: `Step ${step.n}`,
      note: step.instruction || '',
      url: step.url || '',
      step: Number(step.n),
    });
  });
  // The last step now DISPLAYS the final state — it is the page that step produced — so appending the
  // bookend as well would put the same picture on two consecutive pages of the walk, once as "Step
  // 12" and once as "After the agent finished". Kept only when it differs, which is the case when the
  // run's last step had no capture of its own to be shifted onto.
  const last = frames[frames.length - 1];
  if (source.final_state?.screenshot && last?.shot !== source.final_state.screenshot) {
    frames.push({
      shot: source.final_state.screenshot,
      title: 'After the agent finished',
      note: source.final_state.url || '',
      step: null,
    });
  }
  return frames;
}

/**
 * The button that opens it, or ''.
 *
 * ABOVE THE JOURNEY AND NOT INSIDE IT. Inside the steps list it would read as a control on one step;
 * this is a control on the run. The wording says what it costs — the pages are there, going through
 * them is work — rather than promising "see the evidence", which would make the non-grounded arm
 * sound like a broken grounded one.
 */
function browseSimButtonHtml() {
  if (!allowBrowseSim) return '';
  const frames = browseSimFrames();
  if (!frames.length) return '';
  return `
    <div class="tv-browse-offer">
      <button type="button" class="tv-browse-open" id="tv-browse-open">
        <span class="tv-browse-icon" aria-hidden="true">↩</span>
        <span class="tv-browse-open-text">
          <b>Simulate the browsing</b>
          <small>Opens on the page the agent finished on, and steps back through the
            ${frames.length} page${frames.length === 1 ? '' : 's'} it saw.</small>
        </span>
      </button>
    </div>`;
}

/** One frame of the overlay, painted into an already-open shell. */
function paintBrowseSim(overlay, frames, index) {
  const frame = frames[index];
  if (!frame) return;
  overlay.querySelector('.tv-browse-shot').src = `data:image/jpeg;base64,${frame.shot}`;
  overlay.querySelector('.tv-browse-shot').alt = frame.title;
  overlay.querySelector('.tv-browse-title').textContent = frame.title;
  overlay.querySelector('.tv-browse-note').textContent = frame.note || '';
  overlay.querySelector('.tv-browse-url').textContent = frame.url || '';
  overlay.querySelector('.tv-browse-pos').textContent = `${index + 1} of ${frames.length}`;
  // DISABLED AT THE ENDS RATHER THAN WRAPPING. A walk that loops has no beginning, and "did you get
  // back to the first page?" is one of the two things this instrument measures.
  overlay.querySelector('.tv-browse-back').disabled = index === 0;
  overlay.querySelector('.tv-browse-next').disabled = index === frames.length - 1;
  const bar = overlay.querySelector('.tv-browse-bar-fill');
  if (bar) bar.style.width = `${frames.length > 1 ? (index / (frames.length - 1)) * 100 : 100}%`;
}

function closeBrowseSim() {
  document.getElementById('pageguide-browse-sim')?.remove();
}

/** Where in the walk a given step number sits, or -1. */
function walkIndexOfStep(frames, n) {
  return frames.findIndex(frame => frame.step != null && Number(frame.step) === Number(n));
}

/**
 * Open the walk.
 *
 * Its own overlay rather than a mode of openLightbox: the lightbox shows ONE picture and closes on
 * any click outside it, and both of those are wrong here. A walk has a position, a Back and a Next,
 * and a participant who clicks slightly wide of the image on page 9 of 14 must not lose their place.
 * So this closes on the ✕ and on Escape, and on nothing else.
 */
/**
 * Open the run at `start` and let it be paged.
 *
 * ONE WALKER, TWO DOORS. The simulate-browsing button opens it at the last page with a page load in
 * front of every move; clicking a step in the grounded journey opens it AT THAT STEP with no delay
 * at all. Everything else — the clamping at both ends, the arrow keys, the caption, the click for
 * full size, what closes it — is the same, and had to stay the same: two overlays that page through
 * the same screenshots with subtly different rules is two sets of behaviour to keep in step, and the
 * participant is not told which one they are in.
 *
 * WHY THE STEP ROUTE HAS NO DELAY, and it is not an inconsistency. The button's delay is the study
 * variable — it is the cost of going to look, deliberately imposed. Expanding a step is the grounded
 * arm's own affordance, already paid for by the click, and the paging is just "and the one after
 * that": charging half a second there would be taxing the condition rather than measuring it.
 *
 * `counter` is whichever tally this door keeps; see the note above `stepWalk`.
 */
function openWalk({ frames, start, delayMs, counter, onOpen }) {
  if (!frames.length) return;
  closeBrowseSim();

  let index = Math.min(frames.length - 1, Math.max(0, start));
  let moving = false;
  counter.opens += 1;
  onOpen?.(index);

  const overlay = document.createElement('div');
  overlay.id = 'pageguide-browse-sim';
  overlay.className = 'tv-browse';
  overlay.innerHTML = `
    <div class="tv-browse-dialog" role="dialog" aria-modal="true" aria-label="The pages the agent saw">
      <div class="tv-browse-head">
        <span class="tv-browse-title"></span>
        <span class="tv-browse-pos"></span>
        <button type="button" class="tv-browse-close" aria-label="Close">×</button>
      </div>
      <div class="tv-browse-bar"><span class="tv-browse-bar-fill"></span></div>
      <div class="tv-browse-viewport"><img class="tv-browse-shot" alt=""></div>
      <div class="tv-browse-foot">
        <button type="button" class="tv-browse-back">← Back</button>
        <div class="tv-browse-caption">
          <span class="tv-browse-note"></span>
          <span class="tv-browse-url"></span>
        </div>
        <button type="button" class="tv-browse-next">Next →</button>
      </div>
    </div>`;

  /**
   * Move one page, with the load in front of it.
   *
   * `moving` is the whole of the rate limit: a press that lands inside the delay is DROPPED, not
   * queued. Queueing would let a held arrow key bank up a dozen moves that then play out after the
   * key is released, which is the scrubbing this delay exists to stop, arriving late.
   *
   * The frame is repainted at the END of the delay rather than the start, so the page that is on
   * screen during it is the one being left rather than the one arriving — a load shows you the old
   * page, not the new one with a spinner over it.
   */
  const go = (next) => {
    if (moving) return;
    const clamped = Math.min(frames.length - 1, Math.max(0, next));
    if (clamped === index) return;

    // NO DELAY MEANS NO DELAY, not a deferred tick. The drop-don't-queue rule below is there to stop
    // a held key scrubbing through a run that is meant to cost something per page; with the delay at
    // zero there is nothing to protect, and deferring by even one macrotask opens a window in which
    // the second half of an ordinary double-click is thrown away. The step route runs at zero.
    if (delayMs <= 0) {
      index = clamped;
      counter.steps += 1;
      if (counter.nearest !== undefined) counter.nearest = Math.min(counter.nearest, index);
      paintBrowseSim(overlay, frames, index);
      return;
    }

    moving = true;
    overlay.classList.add('is-loading');
    overlay.querySelector('.tv-browse-back').disabled = true;
    overlay.querySelector('.tv-browse-next').disabled = true;
    setTimeout(() => {
      // The walk can have been closed, or the task changed, inside the delay. Touching a detached
      // node would be harmless; painting over a LATER task's overlay would not.
      if (document.getElementById('pageguide-browse-sim') !== overlay) return;
      index = clamped;
      counter.steps += 1;
      if (counter.nearest !== undefined) counter.nearest = Math.min(counter.nearest, index);
      overlay.classList.remove('is-loading');
      paintBrowseSim(overlay, frames, index);
      moving = false;
    }, delayMs);
  };

  overlay.addEventListener('click', (event) => {
    if (event.target.closest('.tv-browse-close')) return closeBrowseSim();
    if (event.target.closest('.tv-browse-back')) return go(index - 1);
    if (event.target.closest('.tv-browse-next')) return go(index + 1);
    // The full-size view of the page currently on screen. The walk stays open behind it.
    if (event.target.closest('.tv-browse-viewport')) openLightbox(frames[index]);
  });

  // Arrow keys as well as the buttons: this is a slideshow, and the two gestures are the two people
  // reach for. Removed with the overlay so a later task's keystrokes do not reach a dead node.
  const onKey = (event) => {
    if (!document.getElementById('pageguide-browse-sim')) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (event.key === 'Escape') { closeBrowseSim(); document.removeEventListener('keydown', onKey); }
    else if (event.key === 'ArrowLeft') go(index - 1);
    else if (event.key === 'ArrowRight') go(index + 1);
  };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  paintBrowseSim(overlay, frames, index);
  if (counter.nearest !== undefined) counter.nearest = Math.min(counter.nearest, index);
}

/**
 * The simulate-browsing button: the whole run, from the end, with the page load.
 *
 * IT OPENS ON THE LAST PAGE AND TRAVELS BACKWARDS. The task is to judge a claim about an outcome,
 * and the outcome is where the run ENDS. Starting at the first page asks a participant to replay the
 * run forwards and hold it in their head until they reach something that bears on the answer;
 * starting at the end puts the state the agent is describing on screen first, and every press of
 * Back asks the question that actually matters — how did it get here, and does that support what it
 * said? The buttons keep their ordinary meaning (Back is earlier, Next is later), so opening at the
 * end opens with Next already spent and Back the live control, with nothing to relabel or explain.
 */
function openBrowseSim() {
  const frames = browseSimFrames();
  openWalk({
    frames,
    start: frames.length - 1,
    delayMs: browseStepMs,
    counter: browseSim,
    onOpen: () => {
      if (browseSim.firstOpenMs == null) browseSim.firstOpenMs = Date.now() - browseSim.mountedAt;
    },
  });
}

/**
 * Expanding one step in the grounded journey — and then being able to page from it.
 *
 * A click on a step used to open a single picture in a dead-end lightbox: to see the step before it
 * you closed the box, found the previous row, and clicked again. That is three gestures to answer
 * "and what did the page look like a moment earlier?", which is the question checking a step
 * actually consists of — a screenshot means little except against the one beside it.
 *
 * Falls back to the plain lightbox when this item is not a step the walk contains (an evidence chip
 * with no step number, a state bookend opened from its own card). A walk of one frame with both
 * buttons dead would be a lightbox wearing a costume.
 */
function openStepWalk(item, stepNumber) {
  const frames = browseSimFrames();
  const start = walkIndexOfStep(frames, stepNumber);
  if (start < 0) return openLightbox(item);
  openWalk({ frames, start, delayMs: 0, counter: stepWalk });
}

/** Guarded like bindHints, and for the same reason: the stage node can outlive one task. */
function bindBrowseSim() {
  if (!els.stage || els.stage.dataset.browseBound === '1') return;
  els.stage.dataset.browseBound = '1';
  els.stage.addEventListener('click', (event) => {
    if (event.target.closest('.tv-browse-open')) openBrowseSim();
  });
}

/**
 * What the simulator was used for on this task, for the result row.
 *
 * NULL WHEN THE STUDY DOES NOT OFFER IT, and a zeroed object when it was offered and refused. The
 * two are different facts and only one of them is about the participant: "this study had no button"
 * and "this participant did not press it" would otherwise be the same row, and the second is the
 * interesting one — a session that never opened the walk is a session that judged the run from what
 * was on the page, which is the condition the study ran before the button existed.
 *
 * Now that BOTH arms offer it, these numbers are comparable across the arms rather than being a
 * property of one of them: "did grounding change how much people went and looked?" is a question
 * this can answer, and could not while only the non-grounded arm had the control.
 */
/**
 * Paging done from an expanded step, as opposed to from the button.
 *
 * Absent when nothing was expanded. Reported apart from `browse_sim` for the reason given above
 * `stepWalk`: they are two gestures, and one of them exists in the grounded arm whether or not the
 * study offers the simulator at all.
 */
function stepWalkStats() {
  if (!stepWalk.opens) return null;
  return { opens: stepWalk.opens, moves: stepWalk.steps };
}

function browseSimStats() {
  if (!allowBrowseSim) return null;
  const frames = browseSimFrames().length;
  const opened = browseSim.opens > 0 && Number.isFinite(browseSim.nearest);
  return {
    offered: frames > 0,
    frames,
    opens: browseSim.opens,
    moves: browseSim.steps,
    // MEASURED BACKWARDS, because that is the direction the walk runs. `nearest_page` is the
    // earliest page reached, 1-based so it reads against `frames` with no offset to remember: it
    // equals `frames` for somebody who opened the walk and never pressed Back, and 1 for somebody
    // who retraced the whole run. `pages_back` is the same fact as a count of pages actually walked.
    //
    // These replace the old `furthest` / `reached_end` pair rather than reinterpreting it. The walk
    // used to start at page 1 and those names meant the opposite thing; keeping them would leave
    // every row ambiguous about which direction it was recorded under.
    nearest_page: opened ? browseSim.nearest + 1 : 0,
    pages_back: opened ? (frames - 1) - browseSim.nearest : 0,
    reached_first: opened && browseSim.nearest === 0,
    first_open_ms: browseSim.firstOpenMs,
  };
}

function openLightbox(item) {
  document.getElementById('pageguide-memory-shot-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'tv-lightbox';
  overlay.innerHTML = `
    <div class="tv-lightbox-dialog" role="dialog" aria-modal="true" aria-label="${esc(item.title)}">
      <div class="tv-lightbox-head">
        <span>${esc(item.title)}</span>
        <button type="button" class="tv-lightbox-close" aria-label="Close">×</button>
      </div>
      <img src="data:image/jpeg;base64,${item.shot}" alt="${esc(item.title)}">
      ${item.note ? `<div class="tv-lightbox-note">${esc(item.note)}</div>` : ''}
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.tv-lightbox-close')) overlay.remove();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(overlay);
}

window.Stimulus = { mountStimulus, stimulusSteps, browseSimStats, stepWalkStats, answerSectionHtml, bindAnswerNode, REFERENCE_DWELL_MS };
