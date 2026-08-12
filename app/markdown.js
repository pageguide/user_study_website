// The markdown an agent's answer is written in.
// =============================================
// ONE RENDERER, used by the stimulus (app/stimulus.js), the Find answer (app/study.js) and the
// editor's live preview (app/welcome.js). It was three copies, and a preview that renders text
// differently from the page it is previewing is worse than no preview — it shows a layout the
// participant will never see and hides the one they will.
//
// RUNS ON ALREADY-ESCAPED TEXT that may ALREADY CONTAIN MARKUP. By the time this is called, the
// citation chips and linked phrases have been spliced in, so the input is a mix of prose and tags.
// That is why the inline pass splits on tags: `_` is legal in an evidence key and common in one
// ("business_post_1"), an answer is one long line, and an emphasis rule let loose on the whole
// string will happily pair the underscore inside one tag's attribute with the underscore inside the
// next tag's — rewriting data-ev-key="orange_added" into data-ev-key="orange<em>added", a chip that
// still draws its number but no longer matches any evidence.

/** Inline emphasis, applied ONLY to the prose between tags. */
function inlineMarkdown(escaped) {
  return String(escaped || '')
    .split(/(<[^>]*>)/)
    .map((part, i) => (i % 2 ? part : inlineSpans(part)))
    .join('');
}

function inlineSpans(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
}

/**
 * What kind of line this is.
 *
 * `- 1. A post by …` is read as an ORDERED item, not a bullet whose text happens to start with a
 * number. People writing a numbered list reach for both marks — the dash for "this is a list", the
 * digit for "this is the third one" — and honouring only the dash produces a bulleted list of items
 * that each begin with a stray "1.".
 */
function classifyLine(line) {
  const text = String(line || '').trim();
  if (!text) return { kind: 'blank' };

  const bullet = text.match(/^[-*+]\s+(.*)$/);
  const body = bullet ? bullet[1] : text;

  const ordered = body.match(/^(\d{1,3})[.)]\s+(.*)$/);
  if (ordered) return { kind: 'ol', number: Number(ordered[1]), text: ordered[2] };
  if (bullet) return { kind: 'ul', text: body };
  return { kind: 'p', text };
}

/**
 * Blocks first, then inline within each one.
 *
 * A blank line ends whatever is open. Consecutive lines inside a paragraph are joined with <br>
 * rather than merged, because an answer written on separate lines was written that way on purpose.
 *
 * An ordered list carries `start` from its first item, so "Business: 1,2,3 / Movies: 1,2,3" restarts
 * at 1 under each heading instead of counting to six.
 */
function renderStudyMarkdown(escaped) {
  const lines = String(escaped || '').split(/\r?\n/);
  const out = [];
  let list = null;          // { kind: 'ul'|'ol', start: number, items: string[] }
  let para = [];

  const flushList = () => {
    if (!list) return;
    const tag = list.kind;
    const attr = tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    out.push(`<${tag}${attr}>${list.items.map(i => `<li>${inlineMarkdown(i)}</li>`).join('')}</${tag}>`);
    list = null;
  };
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`);
    para = [];
  };

  lines.forEach(raw => {
    const line = classifyLine(raw);
    if (line.kind === 'blank') { flushList(); flushPara(); return; }
    if (line.kind === 'p') { flushList(); para.push(line.text); return; }

    flushPara();
    if (list && list.kind !== line.kind) flushList();
    if (!list) list = { kind: line.kind, start: line.kind === 'ol' ? line.number : 1, items: [] };
    list.items.push(line.text);
  });
  flushList();
  flushPara();

  // A single paragraph is unwrapped: most answers are one run of prose, and wrapping every one of
  // them in <p> would add a margin the old renderer never had and shift every card it appears in.
  if (out.length === 1 && out[0].startsWith('<p>')) {
    return out[0].slice(3, -4);
  }
  return out.join('');
}

window.StudyMarkdown = { render: renderStudyMarkdown, inline: inlineMarkdown, classifyLine };
