// The study site — the question pane (RIGHT).
// ===========================================
// A port of renderGuideTrajectoryTask (sidepanel/study.js) into a plain page. It is the INSTRUMENT:
// the task, the timers and the questions, and nothing a participant is asked to judge. The material
// lives in the pane beside it, so one side is what is being judged and the other is what does the
// judging, and neither repeats the other.
//
// EVERY OPTION COMES FROM THE VENDORED MODULE — GUIDE_STUDY_QUESTIONS, GUIDE_PROBLEM_TYPES,
// GUIDE_ERROR_TYPES, _guideErrorsProblem. Retyping any of them here would be the drift that quietly
// stops the web dataset and the extension dataset being the same study: an id that differs by a
// character scores as a different answer, and nothing would fail until analysis.

const Q = window.GUIDE_STUDY_QUESTIONS;

/**
 * REQUIRED QUESTIONS SAY SO, AND SAY WHICH ONE WHEN THEY ARE MISSED.
 *
 * Every question here except the two free-text boxes must be answered — the study cannot use a row
 * with a hole in it — but the only way a participant found that out was by pressing the button and
 * reading a sentence at the bottom of a pane they had already scrolled past. An asterisk sets the
 * expectation, and the highlight answers the question the error message raises: *which* one?
 *
 * Shared with study.js (which loads after this file) through window.QForm, so the Find questions and
 * the follow-up mark themselves the same way rather than growing a second visual language for it.
 */
function requiredMark() {
  return '<span class="q-req" title="Required" aria-label="required">*</span>';
}

function markMissing(el, missing = true) {
  el?.classList.toggle('is-missing', !!missing);
  return el;
}

function clearMissing(root) {
  (root || document).querySelectorAll('.is-missing').forEach(el => el.classList.remove('is-missing'));
}

/** Highlight what is unanswered, and take the participant to the first of them. */
function flagMissing(elements) {
  const missing = elements.filter(Boolean);
  missing.forEach(el => markMissing(el));
  try { missing[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
  return missing.length;
}

/** The message goes when the last thing it was complaining about is answered. */
function refreshError() {
  if (document.querySelector('.is-missing')) return;
  const msg = document.getElementById('q-error-msg');
  if (msg) msg.hidden = true;
}

// Bound ONCE, at load, on the document. The question pane is re-rendered for every task and every
// stage, so a listener attached per render would stack up eight deep by the end of a session.
document.addEventListener('change', (e) => {
  const group = e.target.closest?.('.q-options');
  if (group) { markMissing(group, false); refreshError(); }
});

window.QForm = { requiredMark, markMissing, clearMissing, flagMissing, refreshError };

function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "name — explanation" split at render, so the two halves are legible without a second copy. */
function splitLabel(label) {
  const [name, ...rest] = String(label).split('—');
  return { name: name.trim(), detail: rest.join('—').trim() };
}

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Render one task's questions and resolve when the participant submits.
 *
 * TWO STAGES, TWO TIMERS, exactly as the extension does. The split is at the moment the participant
 * commits to a verdict: before it they are reading the agent's answer and deciding (detection),
 * after it they are hunting through the steps (localization). Averaging the two would hide which
 * one the grounding actually helped, which is the thing the study exists to find out.
 *
 * @param {object} opts - {root, steps, index, total, progressLabel, onSubmit}
 */
function mountInstrument({ root, steps, index, total, goal, progressLabel, onSubmit }) {
  const startedAt = Date.now();
  let choiceElapsed = null;
  let errorsStartedAt = null;
  let answerTimer = null;
  let errorsTimer = null;

  root.innerHTML = `
    <div class="q-head">
      <span class="q-title">📘 Review the task</span>
    </div>
    <div class="q-progress">${escapeHTML(progressLabel || `Task ${index + 1}/${total}`)} · 📘 Follow a Guide</div>
    <div class="q-body">
      <div class="q-task-card">
        <div class="q-timers">
          <div class="q-timer-chip">
            <span class="q-timer-label" id="q-timer-label">Answer time</span>
            <span class="q-timer" id="q-timer">00:00</span>
          </div>
        </div>
        ${escapeHTML(goal || '')}
      </div>

      <div class="q-card">
        <div class="q-card-head"><span class="q-badge">Q1</span>
          <p class="q-text">${escapeHTML(Q.correctness)}${requiredMark()}</p></div>
        <div class="q-options" id="q-correct">
          <!-- The options answer the question AS ASKED. "Yes, the answer is correct" under "did the
               agent complete the task?" is a different question again, and a participant reading
               only the options would answer the wrong one. -->
          <label class="q-opt"><input type="radio" name="q-correct" value="yes"><span>Yes, it completed the task</span></label>
          <label class="q-opt"><input type="radio" name="q-correct" value="no"><span>No, it did not</span></label>
        </div>

        <div id="q-problem-wrap" hidden>
          <label class="q-label">${escapeHTML(Q.problem)}${requiredMark()}</label>
          <div class="q-options" id="q-problems">
            ${window.GUIDE_PROBLEM_TYPES.map(t => {
              const { name, detail } = splitLabel(t.label);
              return `
              <label class="q-opt q-opt-rich">
                <input type="checkbox" name="q-problem" value="${escapeHTML(t.id)}">
                <span class="q-opt-body">
                  <span class="q-opt-name">${escapeHTML(name)}</span>
                  ${detail ? `<span class="q-opt-detail">${escapeHTML(detail)}</span>` : ''}
                </span>
              </label>`;
            }).join('')}
          </div>
          <label class="q-label q-optional">Anything to add? <span class="q-sub">optional</span></label>
          <textarea class="q-field" id="q-problem-text" rows="2"
            placeholder="Only if the options above miss something"></textarea>
        </div>
      </div>

      <div class="q-card" id="q-errors-stage" hidden>
        <div class="q-card-head"><span class="q-badge">Q2</span>
          <p class="q-text">${escapeHTML(Q.errors)}${requiredMark()}</p></div>
        <div class="q-options" id="q-errors">
          ${window.GUIDE_ERROR_TYPES.map((t, i) => {
            const { name, detail } = splitLabel(t.label);
            return `
            <div class="q-error-block">
              <label class="q-opt q-opt-rich">
                <input type="checkbox" name="q-error" value="${escapeHTML(t.id)}">
                <span class="q-error-num">${i + 1}</span>
                <span class="q-opt-body">
                  <span class="q-opt-name">${escapeHTML(name)}</span>
                  ${detail ? `<span class="q-opt-detail">${escapeHTML(detail)}</span>` : ''}
                </span>
              </label>
              <!-- The steps are BUTTONS, not a text field. A field asks the participant to recall a
                   number and type it in a format nobody specified ("3, 5"? "3 and 5"? "step 3"),
                   then asks us to parse it back and decide whether "2-3" means two steps or three.
                   The steps are a known, short, closed set: showing them makes the wrong answer
                   unwritable and the right one one click. -->
              <div class="q-error-steps" data-steps-for="${escapeHTML(t.id)}" hidden>
                <label class="q-label">at step(s)${requiredMark()}</label>
                <div class="q-step-picks">
                  ${steps.map(st => `
                    <button type="button" class="q-step" data-pick-for="${escapeHTML(t.id)}"
                      data-step="${escapeHTML(String(st.n))}"
                      title="${escapeHTML(st.instruction || '')}">${escapeHTML(String(st.n))}</button>`).join('')}
                </div>
              </div>
            </div>`;
          }).join('')}
          <label class="q-opt q-opt-none">
            <input type="checkbox" name="q-error" value="none">
            <span>No error — the agent did this correctly</span>
          </label>
        </div>
      </div>

      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions">
        <button class="q-btn q-btn-primary" id="q-next">Next →</button>
        <button class="q-btn q-btn-primary" id="q-submit" hidden>Submit →</button>
      </div>
    </div>`;

  const $ = (id) => root.querySelector(`#${id}`);
  const errorMsg = $('q-error-msg');
  const showError = (msg) => { errorMsg.textContent = msg; errorMsg.hidden = false; };
  const clearError = () => { errorMsg.hidden = true; };

  answerTimer = setInterval(() => {
    $('q-timer').textContent = fmtTime(Date.now() - startedAt);
  }, 1000);

  // Q1b appears only when the verdict is "did not complete" — it is the follow-up to that answer,
  // and showing it beforehand asks what went wrong with a run nobody has said went wrong.
  root.querySelectorAll('input[name="q-correct"]').forEach(input => {
    input.addEventListener('change', () => { $('q-problem-wrap').hidden = input.value !== 'no'; });
  });

  // Ticking an error type asks where it happened; "No error" is exclusive of the rest.
  root.querySelectorAll('input[name="q-error"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.value === 'none' && input.checked) {
        root.querySelectorAll('input[name="q-error"]').forEach(o => { if (o !== input) o.checked = false; });
      } else if (input.checked) {
        const none = root.querySelector('input[name="q-error"][value="none"]');
        if (none) none.checked = false;
      }
      root.querySelectorAll('[data-steps-for]').forEach(wrap => {
        const box = root.querySelector(`input[name="q-error"][value="${wrap.dataset.stepsFor}"]`);
        wrap.hidden = !(box && box.checked);
      });
    });
  });

  root.querySelectorAll('.q-step').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('is-on');
      markMissing(btn.closest('.q-error-steps'), false);
      refreshError();
    });
  });


  const pickedSteps = (typeId) => Array.from(
    root.querySelectorAll(`.q-step.is-on[data-pick-for="${typeId}"]`))
    .map(b => Number(b.dataset.step))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  $('q-next').onclick = () => {
    clearMissing(root);
    const sel = root.querySelector('input[name="q-correct"]:checked');
    if (!sel) {
      flagMissing([$('q-correct')]);
      return showError('Please answer the highlighted question: did the agent complete the task?');
    }
    // Q1b is required now that it is a closed list: "it did not complete the task" with no problem
    // named is the same half-answer a step-less error type is, and it is the half the ground truth
    // is compared against. The free-text box beside it stays optional.
    if (sel.value === 'no' && !root.querySelector('input[name="q-problem"]:checked')) {
      flagMissing([$('q-problems')]);
      return showError('Please answer the highlighted question: what was the problem?');
    }
    clearError();

    choiceElapsed = Math.max(0, Date.now() - startedAt);
    errorsStartedAt = Date.now();
    $('q-errors-stage').hidden = false;
    $('q-next').hidden = true;
    $('q-submit').hidden = false;
    // Hand over: the answer timer's span is already banked in choiceElapsed, and the total keeps
    // counting from startedAt regardless of what is on screen.
    clearInterval(answerTimer); answerTimer = null;
    $('q-timer-label').textContent = 'Error-check time';
    $('q-timer').textContent = '00:00';
    errorsTimer = setInterval(() => {
      $('q-timer').textContent = fmtTime(Date.now() - errorsStartedAt);
    }, 1000);
    $('q-errors-stage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  $('q-submit').onclick = () => {
    clearMissing(root);
    const checked = Array.from(root.querySelectorAll('input[name="q-error"]:checked'));
    if (!checked.length) {
      flagMissing([$('q-errors')]);
      return showError('Please choose an error type, or “No error”.');
    }

    const errors = checked
      .filter(b => b.value !== 'none')
      .map(b => ({ type: b.value, steps: pickedSteps(b.value) }));

    // An error type with no step is half an answer: it says something went wrong and withholds
    // where, and that cannot be reconstructed afterwards. Same rule, same wording, same function as
    // the extension — _guideErrorsProblem, from the vendored module.
    const problem = window._guideErrorsProblem(errors);
    if (problem) {
      // Point at the type that is missing its step, not at the whole question: with three types on
      // screen, "one of the errors has no step selected" is a riddle.
      flagMissing(errors.filter(e => !e.steps.length)
        .map(e => root.querySelector(`[data-steps-for="${e.type}"]`)));
      return showError(problem);
    }
    clearError();

    clearInterval(answerTimer);
    clearInterval(errorsTimer);
    const correctSel = root.querySelector('input[name="q-correct"]:checked');
    onSubmit({
      answerElapsed: Math.max(0, Date.now() - startedAt),
      answerChoiceMs: choiceElapsed,
      findSupportingMs: errorsStartedAt == null ? null : Math.max(0, Date.now() - errorsStartedAt),
      guideAnswer: {
        correct: correctSel?.value === 'yes',
        problems: Array.from(root.querySelectorAll('input[name="q-problem"]:checked')).map(el => el.value),
        problem: $('q-problem-text')?.value || '',
        errors,
      },
    });
  };

  return () => { clearInterval(answerTimer); clearInterval(errorsTimer); };
}

window.Instrument = { mountInstrument };
