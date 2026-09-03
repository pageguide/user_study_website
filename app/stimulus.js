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
// ONE LAYOUT, TWO ARMS. The arms differ in exactly one way: a grounded step row will show you its
// screenshot, a non-grounded one is text and nothing else. That is the same rule the live panel
// already applies in _buildGoalTimelineRow, which skips the hover/click wiring under
// _isPanelNonGrounding(). Everything else — the order, the wording, the bookends, the answer, the
// trail — is identical, because anything else that differs is a second variable nobody is measuring.
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
}

/** The steps this trajectory shows, for the step buttons in the question pane. */
function stimulusSteps() {
  return (arm && arm.steps) || [];
}

/** The ⓘ toggles. Bound in both arms — knowing what a section is called is not grounding. */
function bindHints() {
  if (els.stage.dataset.bound === '1') return;   // the stage is reused across tasks
  els.stage.dataset.bound = '1';
  els.stage.addEventListener('click', (e) => {
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
  const marking = layout.highlightMilestones && keySteps.size > 0;

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
          ${steps.map(step => {
            const live = showShots && !!step.screenshot;
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
          ${showShots && steps.length && !steps.some(st => st.screenshot) ? `
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
    if (!step?.screenshot) return null;
    return { shot: step.screenshot, title: `Step ${step.n}`, note: step.instruction || '', url: step.url || '' };
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
  if (!step?.screenshot) return null;
  return { shot: step.screenshot, title: `Step ${step.n}`, note: step.instruction || '', url: step.url || '' };
}

/** Whether a milestone has anything to show — evidence naming its step, or the step's own picture. */
function milestoneHasShot(step) {
  if (step == null) return false;
  const named = (arm.answer_evidence || []).some(ev => Number(ev.step) === Number(step) && ev.screenshot);
  return named || !!stepAt(step)?.screenshot;
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
  if (els.stage.dataset.previewsBound === '1') return;
  els.stage.dataset.previewsBound = '1';
  // Held, not merely crossed. Reading the journey sweeps the pointer over every row on the way down.
  let dwellTimer = null;
  let dwellFor = null;
  const cancelDwell = () => { clearTimeout(dwellTimer); dwellTimer = null; dwellFor = null; };
  let hideTimer = null;
  const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const hideNow = () => { cancelHide(); document.getElementById('tv-pop')?.remove(); };
  const scheduleHide = () => { cancelHide(); hideTimer = setTimeout(hideNow, 220); };

  els.stage.addEventListener('mouseover', (e) => {
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
      if (ev.target.closest('.tv-pop-shot')) openLightbox(item);
    });

    document.body.appendChild(pop);
    position(pop, anchor);
  });

  els.stage.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-step], [data-ev-key], [data-ev-step]')) { cancelDwell(); scheduleHide(); }
  });

  // Clicking the row itself opens the big view too — the card is a preview, not a toll gate.
  els.stage.addEventListener('click', (e) => {
    const anchor = e.target.closest('[data-step], [data-ev-key], [data-ev-step]');
    if (!anchor) return;
    // One handler for .tv-chip, .tv-ref, journey rows and trail rows alike — the four ways a Guide
    // participant reaches the evidence behind a claim.
    if (e.isTrusted) reportReference(anchor, 'click');
    const item = previewFor(anchor);
    if (item) { hideNow(); openLightbox(item); }
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

window.Stimulus = { mountStimulus, stimulusSteps, REFERENCE_DWELL_MS };
