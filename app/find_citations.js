// Citation markers in an agent answer — parsing, stripping, and spotting the malformed ones.
// =========================================================================================
// The authored form is [368:"exact quote"]: an index into the page and the phrase it points at.
// One regex used to handle it, /\[(\d+):"([^"]*)"\]/, and it was too strict for what people
// actually type. Two shapes slipped past it and reached participants as raw text:
//
//   [720: "…"]                                  a space after the colon
//   [281:"approach", 766:"Oxford University"]   two citations sharing one pair of brackets
//
// Neither is a typo worth refusing — they are what an author writes — so the reader is tolerant of
// both. And crucially this went wrong in BOTH arms, not just one: the non-grounded arm showed the
// bracket because stripping missed it, and the grounded arm showed it because chip-rendering missed
// it too, so the marker sat there as prose instead of becoming a reference.
//
// Anything that opens like a citation and cannot be read as one is an ARTIFACT: it is removed from
// what the participant sees, and reported to the editor so it can be fixed at the source. Removing
// it silently in both arms would be hiding the problem; leaving it in would be showing a participant
// "[765: Oxford".

(function () {
  // A whole bracket group: one or more `index:"quote"` pairs, commas between, whitespace anywhere.
  const GROUP = /\[\s*\d+\s*:\s*"[^"]*"(?:\s*,\s*\d+\s*:\s*"[^"]*"\s*)*\]/g;
  // One pair inside a group.
  const PAIR = /(\d+)\s*:\s*"([^"]*)"/g;
  // Opens like a citation but is not a readable group — an unclosed bracket, a missing quote, a
  // truncated paste. Deliberately stops at a newline so it cannot swallow a paragraph.
  const ARTIFACT = /\[\s*\d+\s*:[^\]\n]*\]?/g;
  const EVIDENCE = /\[ev:([^\]\n]+)\]/g;

  /** Every citation in the answer, in the order it appears, flattened across grouped brackets. */
  function parse(text) {
    const out = [];
    String(text || '').replace(GROUP, (group) => {
      group.replace(PAIR, (m, index, quote) => {
        out.push({ index: Number(index), text: quote });
        return m;
      });
      return group;
    });
    return out;
  }

  /** The saved-evidence keys referenced by the answer. */
  function evidenceKeys(text) {
    const keys = [];
    String(text || '').replace(EVIDENCE, (m, key) => {
      const clean = String(key || '').trim();
      if (clean) keys.push(clean);
      return m;
    });
    return keys;
  }

  /**
   * The answer as the non-grounded arm shows it: no markers, and no wreckage where they were.
   *
   * The tidy-up matters as much as the removal. Taking "[45:\"El pedante\"]" out of "…is *El
   * pedante* [45:\"El pedante\"], written by…" leaves a space before the comma, and a participant
   * reading " , written by" is being shown that something was deleted — which is exactly what this
   * arm must not reveal.
   */
  /**
   * Close the hole a removed marker leaves behind.
   *
   * Shared by strip() and removeAt(), because the wreckage is the same either way: taking
   * "[45:\"El pedante\"]" out of "…is *El pedante* [45:\"El pedante\"], written by…" strands a space
   * in front of the comma, and " , written by" reads as a typo in the agent's prose rather than as
   * a marker we removed. One rule, so the two paths cannot drift.
   */
  function tidy(text) {
    return String(text || '')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  function strip(text) {
    return tidy(String(text || '')
      .replace(GROUP, '')
      .replace(ARTIFACT, '')
      .replace(EVIDENCE, ''));
  }

  /**
   * The answer with the Nth citation removed — N counted the way the reader sees it.
   *
   * THE DISPLAYED NUMBER IS POSITIONAL, NOT STORED. renderAnswer numbers chips with a running
   * counter in document order, so the "[3]" on screen is the third citation in the text and has
   * nothing to do with the 368 inside `[368:"…"]`, which is a page index. That is why deleting one
   * needs no renumbering pass: remove the marker and every later chip renders one lower by itself.
   *
   * A GROUP CAN HOLD SEVERAL. `[281:"approach", 766:"Oxford University"]` is two citations sharing a
   * bracket, so removing one rebuilds the group from the pairs that remain and drops the brackets
   * only when nothing is left. Deleting the second of those must not take the first with it.
   *
   * Returns the text unchanged if there is no Nth citation, so a stale button cannot quietly rewrite
   * an answer by deleting whatever now sits at that position.
   */
  function removeAt(text, n) {
    const raw = String(text || '');
    const target = Number(n);
    if (!Number.isInteger(target) || target < 1) return raw;

    let seen = 0;
    let removed = false;
    const out = raw.replace(GROUP, (group) => {
      if (removed) return group;
      const kept = [];
      let hit = false;
      group.replace(PAIR, (m, index, quote) => {
        seen += 1;
        if (!hit && seen === target) { hit = true; return m; }
        kept.push(`${index}:"${quote}"`);
        return m;
      });
      if (!hit) return group;
      removed = true;
      return kept.length ? `[${kept.join(', ')}]` : '';
    });
    return removed ? tidy(out) : raw;
  }

  /**
   * Bracket text that opens like a citation and cannot be read as one.
   *
   * What the editor warns about. Returned rather than thrown: a half-written answer is a normal
   * state to be in while authoring, and the warning belongs beside the box being typed into.
   */
  function artifacts(text) {
    const found = [];
    String(text || '').replace(GROUP, (g) => ' '.repeat(g.length))
      .replace(ARTIFACT, (m) => { found.push(m.trim()); return m; });
    return found;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * The answer as the participant sees it in one arm — chips in the grounded one, nothing in the
   * other.
   *
   * Lives here rather than in the player so the ADMIN EDITOR CAN SHOW THE SAME THING. An author
   * checking whether a marker survived stripping, or whether a bracket became a reference, needs the
   * renderer the participant gets; a preview built from a second implementation is a preview of the
   * wrong thing, and that is precisely how "[765: Oxford" reached a live answer.
   *
   * MARKERS OUT FIRST AS PLACEHOLDERS, THEN ESCAPE. Matching citation syntax in already-escaped text
   * means matching `&quot;` rather than `"` — a second pattern to keep in step with the first, and
   * the reason the tolerant shapes were missed on the rendering side as well as the stripping side.
   * \u0000 cannot occur in an answer and passes through escaping untouched.
   */
  function renderAnswer(answer, arm) {
    const markdown = (html) => (window.StudyMarkdown ? window.StudyMarkdown.render(html) : html);
    const raw = String(answer || '');
    if (arm === 'nongrounding') return markdown(esc(strip(raw)));

    const chips = [];
    let n = 0;
    let e = 0;

    let staged = raw.replace(GROUP, (group) => {
      const parts = [];
      group.replace(PAIR, (m, index, text) => {
        n++;
        // The extension's own markup (parseCitations, sidepanel/panel.js): the cited PHRASE, then a
        // superscript index. The phrase stays hidden until the answer is expanded, which is why a
        // citation reads as "[1]" until asked.
        //
        // ON ONE LINE, deliberately. The markdown renderer is line-based and joins a paragraph's
        // lines with <br>; a newline inside this tag would put that <br> inside it and its `>` would
        // close the span early, leaving the title attribute on the page as prose.
        parts.push(`<span class="find-cite" data-cite-text="${esc(text)}" data-cite-n="${n}" title="Show this on the page"><span class="citation-text">${esc(text)}</span><sup class="citation-index">[${n}]</sup></span>`);
        return m;
      });
      chips.push(parts.join(' '));
      return `\u0000c${chips.length - 1}\u0000`;
    });

    staged = staged.replace(EVIDENCE, (m, key) => {
      e++;
      chips.push(`<button type="button" class="find-ev" data-ev-key="${esc(String(key).trim())}" title="Open the saved evidence for this claim">📎<sup class="citation-index">[E${e}]</sup></button>`);
      return `\u0000c${chips.length - 1}\u0000`;
    });

    // Whatever still opens like a citation could not be read as one. Showing a participant
    // "[765: Oxford" is worse than showing nothing; artifacts() is what tells the author about it.
    staged = staged.replace(ARTIFACT, '').replace(/[ \t]+([.,;:!?])/g, '$1');

    return markdown(esc(staged).replace(/\u0000c(\d+)\u0000/g, (m, i) => chips[Number(i)] || ''));
  }

  window.FindCitations = {
    GROUP, PAIR, ARTIFACT, EVIDENCE, parse, evidenceKeys, strip, tidy, removeAt, artifacts, renderAnswer, esc,
  };
}());
