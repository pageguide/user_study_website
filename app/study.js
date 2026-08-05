// The task screen driver: walk the queue, one trajectory at a time.
//
// Fetches each trajectory only when it is reached. The list query deliberately omits `arms` — a
// nine-step run carries ~1.5MB of base64 screenshots, so pulling the whole bank up front to build a
// queue would cost tens of megabytes before the first question is on screen.

const stimulusPane = document.getElementById('stimulus-pane');
const questionPane = document.getElementById('question-pane');
const S = window.StudySession;

// The data source, chosen once. demo.html sets window.STUDY_SOURCE to a local fixture bank before
// this file loads, so the demo walks THIS code — the same queue, timers, validation and scoring a
// participant gets — rather than a parallel implementation that could drift from it.
const DB = window.STUDY_SOURCE || window.StudyDB;

/** The guide stimulus shell — the same markup study.html ships, rebuilt after a Find task. */
function renderGuideShell() {
  stimulusPane.innerHTML = `
    <header class="tv-head">
      <div class="tv-head-main">
        <div class="tv-kicker">Task</div>
        <h1 class="tv-goal" id="tv-goal">Loading…</h1>
      </div>
      <div class="tv-count" id="tv-count"></div>
    </header>
    <main class="tv-main">
      <section class="tv-stage" id="tv-stage"></section>
    </main>`;
}

function panelMessage(html) {
  questionPane.innerHTML = `<div class="q-body">${html}</div>`;
}

async function boot() {
  // In-memory state wins when it is already populated. That is how the demo hands its fixture queue
  // over without going near localStorage — which matters, because the demo and a real run would
  // otherwise share one storage key, and opening the demo would silently discard the progress of a
  // participant who was midway through the actual study.
  const seeded = S.state.participantId && Array.isArray(S.state.queue) && S.state.queue.length;
  // A review session is checked first and lives in its own sessionStorage key, so entering review
  // mode never disturbs a participant partway through the real study on the same machine.
  const saved = seeded ? S.state : (S.loadReview() || S.loadLocal());
  if (!saved || !saved.participantId || !Array.isArray(saved.queue) || !saved.queue.length) {
    // A demo says outright what is wrong. Bouncing it to the welcome screen would hide the actual
    // fault behind a redirect, which is exactly how this took three attempts to diagnose.
    if (window.STUDY_SOURCE) {
      panelMessage('<p class="q-text">Demo could not start: no queue was seeded.</p>'
        + `<pre class="q-field" style="white-space:pre-wrap">${JSON.stringify({
            participantId: S.state.participantId,
            queue: Array.isArray(S.state.queue) ? S.state.queue.length : typeof S.state.queue,
          }, null, 2)}</pre>`);
      return;
    }
    // Reached directly, or the session was cleared. Send them back rather than inventing a session:
    // a result row with no participant id is a row nobody can use.
    location.replace('index.html');
    return;
  }
  Object.assign(S.state, saved);
  await showTask();
}

async function showTask() {
  const { queue, idx, arm } = S.state;
  if (idx >= queue.length) return finish();

  const task = queue[idx];
  panelMessage('<p class="q-text">Loading the next task…</p>');
  if (task.taskType === 'find') return showFindTask(task);

  let record = null;
  try {
    record = await DB.getStudyTrajectory(task.id);
  } catch (e) {
    console.error('[study] could not load the trajectory:', e);
  }

  if (!record) {
    // Skip rather than strand: one unreadable stimulus must not end the session, and a row that
    // was never shown must not be recorded as an answer.
    console.warn('[study] skipping a trajectory that could not be loaded:', task.id);
    S.state.idx++;
    if (!window.STUDY_SOURCE) S.saveLocal();
    return showTask();
  }

  // REBUILD THE SHELL EVERY TIME. A Find task replaces this pane wholesale (it renders a framed
  // page, not a step list), so after one of those the elements mountStimulus targets no longer
  // exist — and a guide task following a find task rendered into nothing until the page was
  // reloaded. Rebuilding is cheap and removes the ordering dependency entirely.
  renderGuideShell();
  window.Stimulus.mountStimulus(record, arm, {
    goal: document.getElementById('tv-goal'),
    count: document.getElementById('tv-count'),
    stage: document.getElementById('tv-stage'),
  });
  stimulusPane.scrollTop = 0;

  S.state.detachInstrument = window.Instrument.mountInstrument({
    root: questionPane,
    steps: window.Stimulus.stimulusSteps(),
    index: idx,
    total: queue.length,
    goal: record.goal || record.title || '',
    onSubmit: (timings) => askPostQuestions(task, record, timings),
  });
  if (S.state.adminReview) {
    questionPane.insertAdjacentHTML('beforeend', adminNavHtml());
    bindAdminNav();
  }
  questionPane.scrollTop = 0;
}

/**
 * A FIND task, as far as a website can show one.
 *
 * The site cannot RUN a Find task: that needs the extension on a live page to index it, highlight
 * the citations and let a participant pick sentences off it. What it can show is the material — the
 * question, the page, and the agent's recorded answer for this arm — which is what a reviewer
 * checking wording needs, and is the whole reason admin mode exists.
 *
 * Said outright rather than mocked up, because a preview that pretended to be the task would be
 * reviewed as though it were.
 */
async function showFindTask(task) {
  const { arm, idx, queue } = S.state;
  let canned = null;
  let page = null;
  try {
    canned = await DB.getCannedResponse(task.id, arm);
  } catch (e) {
    console.warn('[study] no recorded answer for', task.id, e.message);
  }
  try {
    if (DB.getTaskPage) page = await DB.getTaskPage(task.id, task.url);
  } catch (e) {
    console.warn('[study] no captured page for', task.id, e.message);
  }

  const answer = canned?.answer_display || canned?.answer_raw || '';

  stimulusPane.innerHTML = `
    <header class="tv-head">
      <div class="tv-head-main">
        <div class="tv-kicker">Find task${task.type ? ` · ${esc(task.type)}` : ''}</div>
        <h1 class="tv-goal">${esc(task.question || task.title || '')}</h1>
      </div>
    </header>
    <main class="tv-main">${page?.html
      ? '<iframe class="find-page" id="find-page" title="The page this question is about"></iframe>'
      : `<div class="tv-col">
          <div class="tv-section-title"><span>The page</span></div>
          <p class="tv-answer">${task.url
            ? `<a href="${esc(task.url)}" target="_blank" rel="noreferrer">${esc(task.url)}</a>`
            : 'No page recorded.'}</p>
          <p class="tv-warn">No snapshot has been captured for this task yet, so the page cannot be
            shown here. Capture it from the extension's Find recorder (📄 Capture page), then
            publish. The live URL cannot be embedded: most sites refuse to be framed, and a
            cross-origin frame cannot be scripted, so nothing could be highlighted in it.</p>
        </div>`}</main>`;

  // SAME-ORIGIN ON PURPOSE. srcdoc gives the frame this page's origin, which is the entire reason
  // the snapshot exists: a cross-origin frame cannot be indexed, highlighted or scrolled, so the
  // grounded arm would have nothing to show. The snapshot carries its own restrictive CSP and had
  // its scripts stripped at capture, so nothing in it runs.
  if (page?.html) {
    const frame = document.getElementById('find-page');
    frame.srcdoc = page.html;
    frame.addEventListener('load', () => applyFindGrounding(frame, canned, arm), { once: true });
  }

  const cites = parseFindCitations(answer);

  // A REVIEWER previews; a PARTICIPANT answers. Review mode deliberately shows no questions and no
  // timer: it exists to check the material, and a reviewer filling in Q1 sixteen times would be
  // producing answers that look exactly like data.
  if (S.state.adminReview) {
    questionPane.innerHTML = `
      <div class="q-head"><span class="q-title">🔍 Find task</span></div>
      <div class="q-progress">Task ${idx + 1}/${queue.length} · review</div>
      <div class="q-body">
        <p class="q-text">${esc(task.question || '')}</p>
        ${answerCardHtml(answer, arm)}
        <p class="q-sub">Review mode — nothing is recorded.</p>
        ${adminNavHtml()}
      </div>`;
    bindFindAnswerChips(canned, arm, cites);
    bindAdminNav();
    return;
  }

  renderFindQuestions(task, canned, answer, arm, cites);
}

/** The agent's recorded answer, rendered with its citations and evidence. */
function answerCardHtml(answer, arm) {
  return `
    <div class="q-card" style="margin-top:12px;">
      <div class="q-card-head"><span class="q-badge">A</span>
        <p class="q-text">The agent's answer${arm === 'nongrounding' ? ' (non-grounded)' : ''}</p></div>
      <div class="find-answer">${answer
        ? renderFindAnswer(answer, arm)
        : '<em class="q-sub">No answer was recorded for this task in this arm.</em>'}</div>
    </div>`;
}

/**
 * The participant's Find task: read the answer, pick one, then point at what supports it.
 *
 * Two stages, two timers, and no way past either without answering — see the header of
 * app/find_task.js for why both of those matter.
 */
function renderFindQuestions(task, canned, answer, arm, cites) {
  const { idx, queue } = S.state;
  const options = window.FindTask.answerOptions(task);
  const hops = window.FindTask.evidencePrompts(task);
  const startedAt = Date.now();
  let choiceElapsed = null;
  let supportStartedAt = null;
  let answerTimer = null;
  let supportTimer = null;
  const picked = [null, null];   // one evidence selection per hop

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">🔍 Find the answer</span></div>
    <div class="q-progress">Task ${idx + 1}/${queue.length} · 🔍 Find Information</div>
    <div class="q-body">
      <div class="q-task-card">${esc(task.question || '')}</div>

      <div class="q-timers">
        <div class="q-timer-row" id="q-answer-timer-row">
          <span class="q-timer-label">🔍 Finding the answer</span>
          <span class="q-timer" id="q-answer-timer">00:00</span>
        </div>
        <div class="q-timer-row" id="q-support-timer-row" hidden>
          <span class="q-timer-label">🔎 Finding the evidence</span>
          <span class="q-timer" id="q-support-timer">00:00</span>
        </div>
      </div>

      ${answerCardHtml(answer, arm)}

      <div class="q-card">
        <div class="q-card-head"><span class="q-badge">Q1</span>
          <p class="q-text">Select the answer you found:</p></div>
        <div class="q-options" id="q-find-answer">
          ${options.map((opt, i) => `
            <label class="q-opt q-opt-rich">
              <input type="radio" name="q-find-answer" value="${esc(opt)}">
              <span class="q-opt-body"><span>${esc(opt)}</span></span>
            </label>`).join('')}
        </div>
      </div>

      <div id="q-support-stage" hidden>
        ${hops.map((hop, i) => `
          <div class="q-card">
            <div class="q-card-head"><span class="q-badge">Q${i + 2}</span>
              <p class="q-text">${esc(hop.prompt)}</p></div>
            <p class="q-sub" id="q-hop-hint-${i}">${hop.kind === 'image'
              ? 'Click the image in the page on the left.'
              : 'Click the sentence or paragraph in the page on the left.'}</p>
            <div class="q-picked" id="q-picked-${i}">Nothing selected yet.</div>
            <button class="q-btn" data-pick-hop="${i}">${hop.kind === 'image'
              ? '🖼 Pick an image' : '✏️ Pick a passage'}</button>
          </div>`).join('')}
      </div>

      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions">
        <button class="q-btn q-btn-primary" id="q-find-next">Next →</button>
        <button class="q-btn q-btn-primary" id="q-find-submit" hidden>Submit →</button>
      </div>
    </div>`;

  bindFindAnswerChips(canned, arm, cites);

  const $q = (id) => questionPane.querySelector(`#${id}`);
  const errorEl = $q('q-error-msg');
  const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearError = () => { errorEl.hidden = true; };

  answerTimer = setInterval(() => {
    $q('q-answer-timer').textContent = fmtClock(Date.now() - startedAt);
  }, 1000);

  // ── Picking evidence in the page ──
  // The snapshot is same-origin, so a click inside it can be read. That is the whole reason the
  // snapshot exists rather than a screenshot: the participant points at the real thing.
  let pickingHop = null;
  const frame = () => document.getElementById('find-page');

  const setPicked = (hop, value, label) => {
    picked[hop] = value;
    const box = $q(`q-picked-${hop}`);
    if (box) {
      box.textContent = label;
      box.classList.add('is-picked');
    }
  };

  questionPane.querySelectorAll('[data-pick-hop]').forEach(btn => {
    btn.onclick = () => {
      pickingHop = Number(btn.dataset.pickHop);
      const kind = hops[pickingHop].kind;
      questionPane.querySelectorAll('[data-pick-hop]').forEach(b => b.classList.remove('is-picking'));
      btn.classList.add('is-picking');
      startPicking(frame(), kind, (value, label) => {
        setPicked(pickingHop, value, label);
        btn.classList.remove('is-picking');
        pickingHop = null;
      });
    };
  });

  $q('q-find-next').onclick = () => {
    const sel = questionPane.querySelector('input[name="q-find-answer"]:checked');
    if (!sel) return showError('Please select the answer you found.');
    clearError();

    choiceElapsed = Math.max(0, Date.now() - startedAt);
    supportStartedAt = Date.now();
    $q('q-support-stage').hidden = false;
    $q('q-find-next').hidden = true;
    $q('q-find-submit').hidden = false;
    clearInterval(answerTimer); answerTimer = null;
    $q('q-answer-timer-row').hidden = true;
    $q('q-support-timer-row').hidden = false;
    supportTimer = setInterval(() => {
      $q('q-support-timer').textContent = fmtClock(Date.now() - supportStartedAt);
    }, 1000);
    $q('q-support-stage').scrollIntoView({ block: 'nearest' });
  };

  $q('q-find-submit').onclick = async () => {
    // EVERY hop, not just one. A half-answered pair cannot be reconstructed afterwards, and a
    // participant who could submit with one blank would do it without noticing.
    const missing = picked.findIndex(v => !v);
    if (missing >= 0) return showError(`Please answer Q${missing + 2} — ${hops[missing].kind === 'image'
      ? 'pick the image in the page' : 'pick the passage in the page'}.`);
    clearError();

    clearInterval(answerTimer);
    clearInterval(supportTimer);
    stopPicking(frame());

    const sel = questionPane.querySelector('input[name="q-find-answer"]:checked');
    await submitFindResult(task, {
      answer: sel.value,
      answerElapsed: Math.max(0, Date.now() - startedAt),
      answerChoiceMs: choiceElapsed,
      findSupportingMs: supportStartedAt == null ? null : Math.max(0, Date.now() - supportStartedAt),
      evidenceResponses: picked.map((v, i) => ({ hop: i + 1, prompt: hops[i].prompt, kind: hops[i].kind, ...v })),
    });
  };
}

/** mm:ss, matching the extension's clock. */
function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Let the participant click something inside the snapshot.
 *
 * Hover outlines what would be picked and a click takes it. Paragraph picking walks up to the
 * nearest block so a click on one word selects the sentence it is in rather than the word — the
 * question asks which passage, and a one-word answer could not be scored against a ground truth
 * written as sentences.
 */
function startPicking(frame, kind, onPick) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;
  stopPicking(frame);

  if (!doc.getElementById('pg-pick-style')) {
    const style = doc.createElement('style');
    style.id = 'pg-pick-style';
    style.textContent = `
      .pg-pickable{outline:2px dashed #7857ff!important;outline-offset:2px;cursor:pointer!important;
        background:rgba(120,87,255,.10)!important}
      .pg-picked{outline:3px solid #168f5a!important;outline-offset:2px;
        background:rgba(22,143,90,.14)!important}`;
    doc.head?.appendChild(style);
  }

  const SEL = kind === 'image' ? 'img' : 'p, li, figcaption, blockquote, h1, h2, h3, td';
  let hovered = null;

  const over = (e) => {
    const el = e.target.closest?.(SEL);
    if (el === hovered) return;
    hovered?.classList.remove('pg-pickable');
    hovered = el;
    hovered?.classList.add('pg-pickable');
  };
  const click = (e) => {
    const el = e.target.closest?.(SEL);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    doc.querySelectorAll('.pg-picked').forEach(n => n.classList.remove('pg-picked'));
    el.classList.remove('pg-pickable');
    el.classList.add('pg-picked');
    hovered = null;
    const text = (el.getAttribute?.('alt') || el.textContent || '').replace(/\s+/g, ' ').trim();
    onPick(
      { text: text.slice(0, 600), tag: el.tagName.toLowerCase() },
      text ? text.slice(0, 120) + (text.length > 120 ? '…' : '') : `(${el.tagName.toLowerCase()})`
    );
    stopPicking(frame);
  };

  doc.addEventListener('mouseover', over, true);
  doc.addEventListener('click', click, true);
  doc.__pgPick = { over, click };
}

function stopPicking(frame) {
  let doc;
  try { doc = frame?.contentDocument; } catch (e) { return; }
  if (!doc?.__pgPick) return;
  doc.removeEventListener('mouseover', doc.__pgPick.over, true);
  doc.removeEventListener('click', doc.__pgPick.click, true);
  doc.querySelectorAll('.pg-pickable').forEach(n => n.classList.remove('pg-pickable'));
  delete doc.__pgPick;
}

/** Record the Find result, then move on. Mirrors the guide half's post-task questions. */
async function submitFindResult(task, payload) {
  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">Quick questions</span></div>
    <div class="q-body">
      <p class="q-text">How confident are you in your answer?</p>
      <div class="q-options" id="q-conf">
        ${[['very', '😎 Very confident'], ['somewhat', '🙂 Somewhat confident'],
           ['notsure', '😐 Not sure'], ['guessed', '🤷 Just guessing']]
          .map(([v, l]) => `<label class="q-opt"><input type="radio" name="q-conf" value="${v}"><span>${l}</span></label>`).join('')}
      </div>
      <p class="q-text" style="margin-top:16px;">How helpful was what you were shown?</p>
      <div class="q-options" id="q-help">
        ${[['very', '⭐⭐⭐ Very helpful'], ['somewhat', '⭐⭐ Somewhat helpful'],
           ['notmuch', '⭐ Not very helpful'], ['notatall', 'Not helpful at all']]
          .map(([v, l]) => `<label class="q-opt"><input type="radio" name="q-help" value="${v}"><span>${l}</span></label>`).join('')}
      </div>
      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions"><button class="q-btn q-btn-primary" id="q-find-done">Next task →</button></div>
    </div>`;

  document.getElementById('q-find-done').onclick = async () => {
    const conf = questionPane.querySelector('input[name="q-conf"]:checked');
    const help = questionPane.querySelector('input[name="q-help"]:checked');
    const err = document.getElementById('q-error-msg');
    if (!conf || !help) { err.textContent = 'Please answer both questions.'; err.hidden = false; return; }

    const row = S.buildFindResultRow({
      task, payload, confidence: conf.value, helpfulness: help.value,
    });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();
    try {
      await DB.insertStudyResult(row);
    } catch (e) {
      console.warn('[study] result kept locally only:', e);
    }
    showTask();
  };
}

/** The citation and evidence chips inside a rendered answer. Shared by review and participant. */
function bindFindAnswerChips(canned, arm, cites) {
  const answerEl = questionPane.querySelector('.find-answer');
  if (answerEl && cites.length) {
    answerEl.classList.add('pageguide-clickable');
    answerEl.title = 'Click to show the cited phrases';
    answerEl.onclick = (e) => {
      if (e.target.closest('.find-cite')) return;
      answerEl.classList.toggle('citations-expanded');
    };
  }

  questionPane.querySelectorAll('.find-ev').forEach(chip => {
    chip.onclick = () => {
      const item = (canned?.evidence || [])
        .find(ev => String(ev?.key || '').trim().toLowerCase() === chip.dataset.evKey.trim().toLowerCase());
      openEvidenceLightbox(item, chip.dataset.evKey);
    };
  });

  // Hover names it, click goes to it — the two gestures the panel already gives a citation.
  questionPane.querySelectorAll('.find-cite').forEach(chip => {
    const frame = () => document.getElementById('find-page');
    chip.onmouseenter = () => {
      const f = frame();
      if (f) focusFindCitation(f, chip.dataset.citeText || '', false);
      chip.classList.add('find-cite-active');
    };
    chip.onmouseleave = () => {
      const f = frame();
      if (!chip.dataset.pinned) chip.classList.remove('find-cite-active');
      try { if (f && !chip.dataset.pinned) clearFindFocus(f.contentDocument); } catch (e) {}
    };
    chip.onclick = () => {
      const f = frame();
      if (!f) return;
      questionPane.querySelectorAll('.find-cite').forEach(c => {
        delete c.dataset.pinned;
        c.classList.remove('find-cite-active');
      });
      chip.dataset.pinned = '1';
      chip.classList.add('find-cite-active');
      focusFindCitation(f, chip.dataset.citeText || '', true);
    };
  });
}

/**
 * Pull the grounding markers out of a recorded answer.
 *
 * Two kinds, both produced by the extension and both meaningful here:
 *   [N:"quoted text"]  a citation — N indexes the element on the page, and the QUOTED TEXT is what
 *                      was said there. The text is what survives; see markFindCitations.
 *   [ev:key]           saved visual evidence, matched against canned.evidence by key.
 */
function parseFindCitations(answer) {
  const out = [];
  String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (m, index, text) => {
    out.push({ index: Number(index), text });
    return m;
  });
  return out;
}

/**
 * The answer with its markers turned into chips — what the extension shows, rather than the raw
 * "[43:\"El pedante\"]" a participant should never see.
 *
 * The non-grounded arm gets the markers STRIPPED instead: that arm is defined by their absence, and
 * a raw marker left in the prose would be worse than either — it would tell a non-grounded
 * participant that something was cited while giving them no way to check it.
 */
function renderFindAnswer(answer, arm) {
  const raw = String(answer || '');
  if (arm === 'nongrounding') {
    return renderMarkdown(esc(window.stripNonGroundingMarkers
      ? window.stripNonGroundingMarkers(raw)
      : raw.replace(/\[\d+:"[^"]*"\]/g, '').replace(/\s*\[ev:[^\]]+\]/g, '').replace(/\s+([.,;:!?])/g, '$1')));
  }

  let n = 0;
  let e = 0;
  const withChips = esc(raw)
    // The extension's own markup (parseCitations, sidepanel/panel.js): the cited PHRASE, then a
    // superscript index. The phrase is hidden until the answer is expanded — that is what clicking
    // an answer does in the panel, and it is why a citation reads as "[1]" until asked.
    // esc() has already turned the quotes into &quot;, so the pattern matches the escaped form.
    .replace(/\[(\d+):&quot;([^&]*)&quot;\]/g, (m, index, text) => {
      n++;
      return `<span class="find-cite" data-cite-text="${text}" data-cite-n="${n}"
        title="Show this on the page"
        ><span class="citation-text">${text}</span><sup class="citation-index">[${n}]</sup></span>`;
    })
    // [ev:key] is SAVED VISUAL EVIDENCE: a crop of the region the claim rests on, taken at record
    // time. Its `note` is a description rather than a quotation, so it cannot be found in the page
    // by text — the crop itself is the evidence, and opening it is the only thing that reliably
    // shows what was meant. Rendered as its own numbered series, so it is not mistaken for a
    // citation into the page.
    .replace(/\[ev:([^\]]+)\]/g, (m, key) => {
      e++;
      return `<button type="button" class="find-ev" data-ev-key="${key}"
        title="Open the saved evidence for this claim">📎<sup class="citation-index">[E${e}]</sup></button>`;
    });

  return renderMarkdown(withChips);
}

/**
 * The markdown an answer is written in, as the panel renders it.
 *
 * An agent's answer contains **bold** — "the planet name … is **Jupiter**" — and shown raw those
 * asterisks are visible noise in the middle of the sentence a participant is being asked to judge.
 * Bold first, then single-asterisk italics, in that order: doing italics first would eat one
 * asterisk from every pair and turn **Jupiter** into *Jupiter*.
 *
 * Runs on ALREADY-ESCAPED text, so the only tags in the result are the ones added here.
 */
function renderMarkdown(escaped) {
  return String(escaped || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

/**
 * Mark what the answer cited, inside the snapshot, for the grounded arm only.
 *
 * This is what the whole snapshot exists for: the frame is same-origin, so its document can be
 * walked and marked. Matching is on the QUOTED TEXT from each [N:"…"] marker, not on the index N —
 * an index only means anything if the page is re-indexed exactly as it was at record time, and one
 * lazy image or one A/B variant moves every index. The quoted sentence is the stable handle.
 *
 * Images are cited too ([39:"Title page engraving…"]), and their quoted text is the caption or alt
 * text rather than body copy — so a text miss falls back to matching img[alt] and figure captions,
 * and marks the picture itself.
 *
 * The non-grounded arm gets nothing. That is the arm.
 */
function applyFindGrounding(frame, canned, arm) {
  if (arm === 'nongrounding') return;
  const answer = canned?.answer_raw || canned?.answer_display || '';
  const cites = parseFindCitations(answer);
  if (!cites.length) return;

  let doc;
  try { doc = frame.contentDocument; } catch (e) { return; }
  if (!doc?.body) return;

  // THE EXTENSION'S OWN STYLING, copied from content/content.css rather than approximated. A
  // participant who saw the live page in the extension and the snapshot here must be looking at the
  // same thing: the same tint on a cited phrase, the same outline on a cited picture, and the same
  // "PageGuide highlight" badge when one is pointed at. A second visual language for the same idea
  // would be one more difference between the arms that nobody is measuring.
  const style = doc.createElement('style');
  style.textContent = `
    .pageguide-highlight {
      background-color: color-mix(in srgb, #7857ff 16%, transparent);
      border-radius: 3px; padding: 1px 3px; margin: 0 1px;
      scroll-margin: 90px;
    }
    [data-pageguide-styled] { position: relative; }
    [data-pageguide-styled]:hover,
    .pageguide-preview-target {
      outline: 2px solid #7857ff !important;
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(120,87,255,.14), 0 12px 32px rgba(120,87,255,.22) !important;
      background-color: color-mix(in srgb, #7857ff 38%, transparent);
    }
    /* The badge the live page shows, to the pixel: same words, same pill, same dot. */
    [data-pageguide-styled]:hover::after,
    .pageguide-preview-target::after {
      content: 'PageGuide highlight';
      position: absolute; left: 0; bottom: calc(100% + 8px);
      z-index: 2147483647;
      padding: 6px 9px 6px 24px;
      border: 1px solid rgba(155,132,255,.36);
      border-radius: 999px;
      background:
        radial-gradient(circle at 12px 50%, transparent 0 3px, #b89cff 3px 5px, transparent 5px),
        rgba(32,26,55,.96);
      color: #fff;
      box-shadow: 0 14px 34px rgba(50,35,100,.25);
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space: nowrap;
      pointer-events: none;
    }
    /* A cited picture is outlined rather than tinted — a tint over an engraving hides the engraving,
       which is the thing being asked about. */
    .pageguide-highlight-img {
      outline: 2px solid #7857ff; outline-offset: 3px; border-radius: 2px; scroll-margin: 90px;
    }
    /* The wrapper must lay out like the image it holds, or marking one would reflow the article. */
    .pageguide-highlight-imgwrap { display: inline-block; position: relative; max-width: 100%; line-height: 0; }
    .pageguide-highlight-imgwrap > img { display: block; max-width: 100%; }`;
  doc.head?.appendChild(style);

  cites.forEach(cite => markFindCitation(doc, cite.text));
  drawEvidenceMarks(doc, canned);
}

/**
 * Draw the saved evidence annotations onto the picture they were drawn on.
 *
 * This is what the extension shows and the site was missing. Evidence for an image claim is not
 * "highlight the whole image" — it is a labelled ellipse round the spaceman, a box round the
 * lettering, an arrow to what it is reaching for. Marking the element instead pointed at the right
 * picture while saying nothing about WHERE in it, which for a question like "what is the spaceman
 * doing to the ship?" is most of the answer withheld.
 *
 * Coordinates are normalized (0..1) to the source image, so they survive the snapshot being shown
 * at any width — which is why they can be replayed here at all.
 */
function drawEvidenceMarks(doc, canned) {
  const items = (canned?.evidence || []).filter(e => e?.marks?.annotations?.length);
  if (!items.length) return;

  // "page_image_N" is the Nth image AS THE RECORDER COUNTED THEM, so the same rule has to be used
  // here or the annotation lands on a different picture. The recorder's rule is
  // GV2_FIND_MEDIA_MIN_PX / GV2_FIND_MEDIA_NOISE (content/utils.js): at least 100px on both sides,
  // and not something whose URL or alt marks it as chrome. Guessing at ">= 200px" put Tesla's
  // page_image_6 on the wrong image entirely.
  const NOISE = /logo|icon|avatar|sprite|badge|thumb|advert|\bads?\b|banner|sponsor|placeholder/i;
  const contentImages = Array.from(doc.querySelectorAll('img')).filter(img => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 100 || h < 100) return false;
    return !NOISE.test(`${img.getAttribute('src') || ''} ${img.getAttribute('alt') || ''} ${img.className || ''}`);
  });

  items.forEach(item => {
    const n = Number(String(item.source_image_id || '').match(/(\d+)$/)?.[1] || 1);
    const img = contentImages[n - 1];
    if (!img) return;
    overlayAnnotations(doc, img, item.marks.annotations, item.key);
  });
}

/** Position an SVG over one image and draw its annotations into it. */
function overlayAnnotations(doc, img, annotations, key) {
  const host = img.parentElement?.classList.contains('pageguide-highlight-imgwrap')
    ? img.parentElement
    : (() => { markImage(img, key || ''); return img.parentElement; })();
  if (!host || host.querySelector('.pg-annots')) return;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'pg-annots');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('style',
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible');

  annotations.forEach(a => {
    const colour = a.color || '#ff2d78';
    if (a.type === 'ellipse' && a.bbox) {
      const e = doc.createElementNS(NS, 'ellipse');
      e.setAttribute('cx', (a.bbox.x + a.bbox.w / 2) * 100);
      e.setAttribute('cy', (a.bbox.y + a.bbox.h / 2) * 100);
      e.setAttribute('rx', (a.bbox.w / 2) * 100);
      e.setAttribute('ry', (a.bbox.h / 2) * 100);
      e.setAttribute('fill', 'none');
      e.setAttribute('stroke', colour);
      e.setAttribute('stroke-width', '0.6');
      e.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(e);
      if (a.label) svg.appendChild(_annotLabel(doc, NS, a.bbox.x * 100, a.bbox.y * 100 - 2, a.label, colour));
    } else if ((a.type === 'box' || a.type === 'rect') && a.bbox) {
      const r = doc.createElementNS(NS, 'rect');
      r.setAttribute('x', a.bbox.x * 100);
      r.setAttribute('y', a.bbox.y * 100);
      r.setAttribute('width', a.bbox.w * 100);
      r.setAttribute('height', a.bbox.h * 100);
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', colour);
      r.setAttribute('stroke-width', '0.6');
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(r);
      if (a.label) svg.appendChild(_annotLabel(doc, NS, a.bbox.x * 100, a.bbox.y * 100 - 2, a.label, colour));
    } else if (a.type === 'arrow' && a.from && a.to) {
      const l = doc.createElementNS(NS, 'line');
      l.setAttribute('x1', a.from.x * 100); l.setAttribute('y1', a.from.y * 100);
      l.setAttribute('x2', a.to.x * 100);   l.setAttribute('y2', a.to.y * 100);
      l.setAttribute('stroke', colour);
      l.setAttribute('stroke-width', '0.8');
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(l);
      if (a.label) svg.appendChild(_annotLabel(doc, NS, a.to.x * 100, a.to.y * 100 - 2, a.label, colour));
    }
  });

  host.appendChild(svg);
}

/** A label chip on an annotation, in the annotation's own colour. */
function _annotLabel(doc, NS, x, y, text, colour) {
  const g = doc.createElementNS(NS, 'g');
  const t = doc.createElementNS(NS, 'text');
  t.setAttribute('x', x);
  t.setAttribute('y', Math.max(2, y));
  t.setAttribute('fill', '#fff');
  t.setAttribute('font-size', '2.6');
  t.setAttribute('font-weight', '700');
  t.setAttribute('paint-order', 'stroke');
  t.setAttribute('stroke', colour);
  t.setAttribute('stroke-width', '2.2');
  t.setAttribute('stroke-linejoin', 'round');
  t.textContent = text;
  g.appendChild(t);
  return g;
}

/** Curly quotes, odd spacing and non-breaking spaces all differ between a recorded quote and the
 *  page it came from. Compare on a normalized form so they stop mattering. */
function normText(v) {
  return String(v == null ? '' : v)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mark one cited passage inside the snapshot.
 *
 * The hard case is a CAPTION. A cited image carries text like "Title page engraving from Francesco
 * Belo's El pedante (1538)", and a caption is almost always split across elements — the play title
 * sits in its own <em> or <a>, so no single text node holds the whole string and an exact match
 * finds nothing. That is why this falls back to progressively shorter prefixes and then marks the
 * CONTAINING ELEMENT rather than a sub-range: the goal is to show the participant where the claim
 * came from, and the whole caption is a better answer than nothing.
 *
 * Whatever matches, a picture beside it is outlined too — for an image citation the picture is the
 * evidence, and highlighting only its caption would point next to the thing rather than at it.
 */
function markFindCitation(doc, text) {
  const needle = normText(text);
  if (needle.length < 4) return;            // too short to match uniquely; a false hit is worse

  // 1. The whole quote inside one text node — the clean case, marked precisely.
  if (markText(doc, needle)) return;

  // 2. A prefix inside one text node. Long enough to stay distinctive, short enough to survive the
  //    markup that split the caption up.
  for (const len of [40, 25, 15]) {
    if (needle.length <= len) continue;
    const el = findElementContaining(doc, needle.slice(0, len));
    if (el) { markElement(el, needle); return; }
  }

  // 3. An image whose alt text carries the quote.
  const img = Array.from(doc.querySelectorAll('img'))
    .find(i => normText(i.getAttribute('alt')).includes(needle.slice(0, 25)));
  if (img) markImage(img, needle);
}

/**
 * The smallest element whose own text contains `fragment`, or null.
 *
 * BOUNDED, and that is the point. A quote that is not in the page verbatim — "Foundation series"
 * where the page writes "*Foundation* series", split by an <em> — falls through to searching whole
 * elements, and the smallest element containing a common word like "Foundation" can still be an
 * entire section. Marking that says "the evidence is somewhere in these six paragraphs", which
 * looks like a confident answer and is not one. A missing highlight is better than a wrong one, so
 * a candidate more than ~6× the fragment is refused.
 */
function findElementContaining(doc, fragment) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (normText(node.nodeValue).includes(fragment)) return node.parentElement;
  }
  const maxLength = Math.max(160, fragment.length * 6);
  const candidates = Array.from(doc.querySelectorAll('figcaption, p, li, td, span, h1, h2, h3'))
    .filter(el => normText(el.textContent).includes(fragment))
    .filter(el => normText(el.textContent).length <= maxLength);
  return candidates.sort((a, b) =>
    normText(a.textContent).length - normText(b.textContent).length)[0] || null;
}

/**
 * Highlight an element, and outline the picture it describes.
 *
 * A caption is rarely a sibling of its image. On this page the marked text is a <p> inside
 * .essay__image__caption, and the <img> lives two levels further up in .essay__center-content —
 * so checking only the parent or a <figure> finds nothing. The walk climbs until an ancestor
 * contains an image, which is what "the picture this caption belongs to" actually means in markup.
 *
 * BOUNDED at four levels on purpose: keep climbing and every caption eventually reaches <body>,
 * where it would confidently outline the site's logo.
 */
function markElement(el, needle) {
  el.classList.add('pageguide-highlight');
  el.setAttribute('data-pageguide-styled', '');
  el.dataset.pgCite = needle;

  let node = el;
  for (let depth = 0; depth < 4 && node; depth++) {
    const img = node.querySelector?.('img');
    if (img) { markImage(img, needle); return; }
    node = node.parentElement;
  }
}

/**
 * Mark a cited image — via a WRAPPER, because an image cannot carry the badge itself.
 *
 * ::before and ::after do not render on replaced elements, and <img> is one. The badge is a
 * ::after, so putting the class on the image gives an outline and no label: the picture is pointed
 * at with nothing saying why, which is the one thing the badge exists to say. Wrapping the image in
 * an inline-block span gives the pseudo-element something it can actually attach to.
 */
function markImage(img, needle) {
  if (img.parentElement?.classList.contains('pageguide-highlight-imgwrap')) return;  // already marked
  const doc = img.ownerDocument;
  const wrap = doc.createElement('span');
  wrap.className = 'pageguide-highlight-imgwrap pageguide-highlight-img';
  wrap.setAttribute('data-pageguide-styled', '');
  wrap.dataset.pgCite = needle;
  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(img);
}

/**
 * Point at a citation inside the snapshot — the panel's own gesture.
 *
 * Mirrors pageguidePreviewIndex in the extension: the cited thing is scrolled into view and given
 * `.pageguide-preview-target`, which is what draws the outline and the "PageGuide highlight" badge.
 * Same class, same CSS, so it reads as the identical affordance rather than a lookalike.
 *
 * @param {boolean} sticky - true on click (stays until the next one), false on hover (transient)
 */
function focusFindCitation(frame, text, sticky = true) {
  let doc;
  try { doc = frame.contentDocument; } catch (e) { return; }
  if (!doc) return;

  const needle = normText(text).toLowerCase();
  const marks = Array.from(doc.querySelectorAll('[data-pageguide-styled]'));

  // EXACT FIRST. One citation's text is often a substring of another's: "El pedante" is the play,
  // and it also appears inside "Title page engraving from Francesco Belo's El pedante (1538)". A
  // substring search in document order therefore sent the chip for the play to the picture of its
  // title page — the wrong evidence, pointed at confidently. Each mark records the exact quote it
  // was created for, so that is what is matched on before anything looser is tried.
  const target = marks.find(el => normText(el.dataset.pgCite).toLowerCase() === needle)
    || marks.find(el => normText(el.dataset.pgCite).toLowerCase().includes(needle.slice(0, 40)))
    || marks.find(el => normText(el.textContent).toLowerCase().includes(needle.slice(0, 40)));
  if (!target) return;

  clearFindFocus(doc);
  target.classList.add('pageguide-preview-target');
  // block:'start', not 'center'. A cited engraving is often taller than the frame, and centring a
  // tall element puts its TOP off-screen — which is precisely where the "PageGuide highlight" badge
  // sits, so the label naming the thing would be the one part scrolled out of view. 'start' plus
  // the 90px scroll-margin in the injected CSS leaves exactly enough room above it for the badge.
  // NO SMOOTH BEHAVIOUR. Inside a srcdoc iframe, scrollIntoView({behavior:'smooth'}) silently does
  // nothing at all — measured: 0px moved with smooth, 394px with the default. It fails without an
  // error, so the chip appears to do nothing and the citation is never reached. An instant jump
  // that works beats an animation that does not.
  if (sticky) target.scrollIntoView({ block: 'start' });
}

/** Only one thing is ever pointed at, so the badge cannot appear twice at once. */
function clearFindFocus(doc) {
  if (!doc) return;
  doc.querySelectorAll('.pageguide-preview-target')
    .forEach(el => el.classList.remove('pageguide-preview-target'));
}

/** Wrap the first occurrence of `needle` in a highlight. Returns whether it matched. */
function markText(doc, needle) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const target = normText(needle).toLowerCase();
  let node;
  while ((node = walker.nextNode())) {
    const hit = normText(node.nodeValue).toLowerCase().indexOf(target);
    if (hit < 0) continue;
    const range = doc.createRange();
    range.setStart(node, hit);
    range.setEnd(node, hit + needle.length);
    const mark = doc.createElement('span');
    mark.className = 'pageguide-highlight';
    mark.setAttribute('data-pageguide-styled', '');
    mark.dataset.pgCite = needle;
    try { range.surroundContents(mark); } catch (e) { return false; }  // spans elements: leave it
    return true;
  }
  return false;
}

/**
 * The saved evidence crop, full size.
 *
 * Mirrors openMemoryShotLightbox in the panel: the picture, what it was saved as, and the note that
 * says why it backs the claim. An evidence marker whose crop never made it says so rather than
 * opening an empty box — a chip that does nothing reads as broken, not as empty.
 */
function openEvidenceLightbox(item, key) {
  document.getElementById('find-ev-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'find-ev-lightbox';
  overlay.className = 'ev-lightbox';
  overlay.innerHTML = `
    <div class="ev-dialog" role="dialog" aria-modal="true" aria-label="Saved evidence">
      <div class="ev-head">
        <span>📎 Saved evidence${key ? ` — ${esc(key)}` : ''}</span>
        <button type="button" class="ev-close" aria-label="Close">×</button>
      </div>
      ${item?.shot
        ? `<img src="data:image/jpeg;base64,${item.shot}" alt="${esc(item.note || key || 'evidence')}">`
        : '<p class="ev-empty">No image was saved with this evidence.</p>'}
      ${item?.note ? `<div class="ev-note">${esc(item.note)}</div>` : ''}
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.ev-close')) overlay.remove();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(overlay);
}

/** Minimal escaping for the Find preview; the stimulus pane has its own for the guide half. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Prev/Next/Exit, for paging through the material without answering anything. */
function adminNavHtml() {
  if (!S.state.adminReview) return '';
  return `
    <div class="q-actions">
      <button class="q-btn" id="admin-prev"${S.state.idx === 0 ? ' disabled' : ''}>← Prev</button>
      <button class="q-btn q-btn-primary" id="admin-next">Next →</button>
    </div>
    <div class="q-actions"><button class="q-btn" id="admin-quit">Leave review</button></div>`;
}

function bindAdminNav() {
  if (!S.state.adminReview) return;
  const prev = document.getElementById('admin-prev');
  const next = document.getElementById('admin-next');
  const quit = document.getElementById('admin-quit');
  if (prev) prev.onclick = () => { S.state.idx = Math.max(0, S.state.idx - 1); S.saveReview(); showTask(); };
  if (next) next.onclick = () => { S.state.idx++; S.saveReview(); showTask(); };
  if (quit) quit.onclick = () => { S.clearReview(); location.href = 'index.html'; };
}

/**
 * The two post-task questions, asked exactly as the extension asks them.
 *
 * Kept on the same screen rather than a page of their own: they are about the task just finished,
 * and a participant who has navigated away from it is answering from memory.
 */
function askPostQuestions(task, record, timings) {
  const opt = (name, value, label) =>
    `<label class="q-opt"><input type="radio" name="${name}" value="${value}"><span>${label}</span></label>`;

  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">Quick questions</span></div>
    <div class="q-body">
      <p class="q-text">How confident are you in your answer?</p>
      <div class="q-options" id="q-conf">
        ${opt('q-conf', 'very', '😎 Very confident')}
        ${opt('q-conf', 'somewhat', '🙂 Somewhat confident')}
        ${opt('q-conf', 'notsure', '😐 Not sure')}
        ${opt('q-conf', 'guessed', '🤷 Just guessing')}
      </div>
      <p class="q-text" style="margin-top:16px;">How helpful was what you were shown?</p>
      <div class="q-options" id="q-help">
        ${opt('q-help', 'very', '⭐⭐⭐ Very helpful')}
        ${opt('q-help', 'somewhat', '⭐⭐ Somewhat helpful')}
        ${opt('q-help', 'notmuch', '⭐ Not very helpful')}
        ${opt('q-help', 'notatall', 'Not helpful at all')}
      </div>
      <div class="q-error-msg" id="q-error-msg" hidden></div>
      <div class="q-actions"><button class="q-btn q-btn-primary" id="q-done">Next task →</button></div>
    </div>`;

  document.getElementById('q-done').onclick = async () => {
    const conf = questionPane.querySelector('input[name="q-conf"]:checked');
    const help = questionPane.querySelector('input[name="q-help"]:checked');
    const err = document.getElementById('q-error-msg');
    if (!conf || !help) {
      err.textContent = 'Please answer both questions.';
      err.hidden = false;
      return;
    }

    const row = S.buildResultRow({
      task, record, timings, confidence: conf.value, helpfulness: help.value,
    });
    S.state.results.push(row);
    S.state.idx++;
    if (!window.STUDY_SOURCE && !S.state.adminReview) S.saveLocal();

    // ADMIN REVIEW WRITES NOTHING. A reviewer clicking through sixteen tasks to check wording would
    // otherwise leave sixteen rows indistinguishable from a participant who answered impossibly
    // fast, and no column would say otherwise.
    if (S.state.adminReview) {
      console.log('[admin] would have saved:', row);
    } else {
      // Written now rather than batched at the end: a participant who closes the tab three tasks in
      // should leave three rows behind, not none. A failed write keeps the local copy, which the
      // final screen can still export.
      try {
        await DB.insertStudyResult(row);
      } catch (e) {
        console.warn('[study] result kept locally only:', e);
      }
    }

    showTask();
  };
}

function finish() {
  stimulusPane.innerHTML = '<div class="tv-done">Thank you — that was the last task.</div>';
  questionPane.innerHTML = `
    <div class="q-head"><span class="q-title">✅ All done</span></div>
    <div class="q-body">
      <p class="q-text">You have finished all ${S.state.results.length} tasks. Thank you.</p>
      <p class="q-sub">You can close this tab. If the researcher asked for a copy of your responses,
        use the button below.</p>
      <div class="q-actions">
        <button class="q-btn" id="q-download">⬇ Download my responses</button>
      </div>
    </div>`;

  document.getElementById('q-download').onclick = () => {
    const blob = new Blob([JSON.stringify(S.state.results, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study_${S.state.participantId || 'anon'}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!window.STUDY_SOURCE) S.clearLocal();
}

boot();
