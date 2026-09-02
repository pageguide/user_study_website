// The results charts — time and accuracy, by grounding and by correctness.
// ========================================================================
// Inline SVG, no chart library: the admin panel is served as static files with no build step, and a
// CDN dependency would make the results page fail closed the first time someone opened it offline.
//
// TWO MEASURES, TWO FORMS, and that is deliberate:
//
//   Time is continuous, so it gets a box plot — with every raw point drawn on top of it. At five
//   observations a cell, quartiles are shaky enough that a box alone would imply a distribution
//   nobody measured; the points are what the reader should actually be looking at, and the box is
//   the summary sitting behind them.
//
//   Accuracy is BINARY per row (the verdict was right or it was not). A box plot of zeros and ones
//   is degenerate — the box spans the whole axis and the median sits on one end — so it gets a
//   proportion bar with a Wilson interval instead. That is the honest form for a rate, and the
//   interval is what stops five-for-five reading as certainty.
//
// Colour: two categorical slots, blue for grounded and orange for non-grounded, validated against
// this page's white surface (worst-pair CVD ΔE 24.7, normal-vision 33.6, both ≥3:1 contrast).
// Grounding is also encoded by position within each pair and by direct labels, so the pair is never
// distinguished by colour alone.

(function () {
  const S = () => window.FindV2Stats;

  const C = {
    grounded: '#2a78d6',
    nongrounded: '#eb6834',
    ink: '#16161a',
    muted: 'rgba(0,0,0,0.55)',
    line: 'rgba(0,0,0,0.12)',
    surface: '#ffffff',
  };

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** The four cells, in a fixed order so the two charts and the stats always line up. */
  const CELLS = [
    { key: 'correct_grounding', correct: true, arm: 'grounding', label: 'Correct', arml: 'Grounded' },
    { key: 'correct_nongrounding', correct: true, arm: 'nongrounding', label: 'Correct', arml: 'Non-grounded' },
    { key: 'incorrect_grounding', correct: false, arm: 'grounding', label: 'Incorrect', arml: 'Grounded' },
    { key: 'incorrect_nongrounding', correct: false, arm: 'nongrounding', label: 'Incorrect', arml: 'Non-grounded' },
  ];

  function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    return `${(ms / 1000).toFixed(1)}s`;
  }

  /**
   * A box plot of one measure across the four cells.
   *
   * `groups` is [{cell, values}]. A cell with no values is drawn as an explicit empty slot rather
   * than skipped: a gap the reader has to notice is how a missing condition gets mistaken for a
   * condition that scored zero.
   */
  function boxChart(groups, { title, unit, height = 210 }) {
    const W = 460;
    const H = height;
    const padL = 52;
    const padR = 12;
    const padT = 26;
    const padB = 46;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const all = groups.flatMap(g => g.values).filter(Number.isFinite);
    if (!all.length) {
      return `<div class="viz-empty">${esc(title)} — no data yet.</div>`;
    }
    const lo = 0;
    const hi = Math.max(...all) * 1.12 || 1;
    const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

    const slotW = plotW / groups.length;
    const boxW = Math.min(46, slotW * 0.5);

    // Recessive grid: five ticks, hairline, behind everything.
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => lo + f * (hi - lo));
    const grid = ticks.map(t => `
      <line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
        stroke="${C.line}" stroke-width="1"/>
      <text x="${padL - 7}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end"
        font-size="10" fill="${C.muted}">${unit === 'ms' ? fmtMs(t) : t.toFixed(0)}</text>`).join('');

    const marks = groups.map((g, i) => {
      const cx = padL + slotW * (i + 0.5);
      const colour = g.cell.arm === 'grounding' ? C.grounded : C.nongrounded;
      const b = S().boxStats(g.values);
      if (!b) {
        return `
          <rect x="${(cx - boxW / 2).toFixed(1)}" y="${padT}" width="${boxW}" height="${plotH}"
            fill="${C.line}" opacity="0.25" rx="4"/>
          <text x="${cx.toFixed(1)}" y="${(padT + plotH / 2).toFixed(1)}" text-anchor="middle"
            font-size="9.5" fill="${C.muted}"><tspan x="${cx.toFixed(1)}" dy="0">not in</tspan><tspan x="${cx.toFixed(1)}" dy="12">this design</tspan></text>`;
      }
      // Jitter is deterministic, so the same data always draws the same picture — a chart that
      // reshuffles its points on every render looks like the numbers changed.
      const pts = b.points.map((v, k) => {
        const dx = ((k % 5) - 2) * 4.2;
        return `<circle cx="${(cx + dx).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.1"
          fill="${colour}" fill-opacity="0.55" stroke="${C.surface}" stroke-width="1.5">
          <title>${esc(g.cell.label)} · ${esc(g.cell.arml)}: ${unit === 'ms' ? fmtMs(v) : v}</title></circle>`;
      }).join('');
      return `
        <line x1="${cx}" x2="${cx}" y1="${y(b.whiskerHigh).toFixed(1)}" y2="${y(b.whiskerLow).toFixed(1)}"
          stroke="${colour}" stroke-width="2"/>
        <line x1="${(cx - boxW / 4).toFixed(1)}" x2="${(cx + boxW / 4).toFixed(1)}"
          y1="${y(b.whiskerHigh).toFixed(1)}" y2="${y(b.whiskerHigh).toFixed(1)}" stroke="${colour}" stroke-width="2"/>
        <line x1="${(cx - boxW / 4).toFixed(1)}" x2="${(cx + boxW / 4).toFixed(1)}"
          y1="${y(b.whiskerLow).toFixed(1)}" y2="${y(b.whiskerLow).toFixed(1)}" stroke="${colour}" stroke-width="2"/>
        <rect x="${(cx - boxW / 2).toFixed(1)}" y="${y(b.q3).toFixed(1)}" width="${boxW}"
          height="${Math.max(2, y(b.q1) - y(b.q3)).toFixed(1)}" rx="4"
          fill="${colour}" fill-opacity="0.14" stroke="${colour}" stroke-width="2"/>
        <line x1="${(cx - boxW / 2).toFixed(1)}" x2="${(cx + boxW / 2).toFixed(1)}"
          y1="${y(b.med).toFixed(1)}" y2="${y(b.med).toFixed(1)}" stroke="${colour}" stroke-width="2.5"/>
        ${pts}
        <text x="${cx.toFixed(1)}" y="${(y(b.whiskerHigh) - 7).toFixed(1)}" text-anchor="middle"
          font-size="10" font-weight="700" fill="${C.ink}">${unit === 'ms' ? fmtMs(b.med) : b.med.toFixed(0)}</text>`;
    }).join('');

    const axis = groups.map((g, i) => {
      const cx = padL + slotW * (i + 0.5);
      return `
        <text x="${cx.toFixed(1)}" y="${(H - padB + 15).toFixed(1)}" text-anchor="middle"
          font-size="10.5" font-weight="700" fill="${C.ink}">${esc(g.cell.label)}</text>
        <text x="${cx.toFixed(1)}" y="${(H - padB + 28).toFixed(1)}" text-anchor="middle"
          font-size="9.5" fill="${C.muted}">${esc(g.cell.arml)}</text>
        <text x="${cx.toFixed(1)}" y="${(H - padB + 40).toFixed(1)}" text-anchor="middle"
          font-size="9.5" fill="${C.muted}">n=${g.values.length}</text>`;
    }).join('');

    return `
      <figure class="viz-fig">
        <figcaption class="viz-fig-title">${esc(title)}</figcaption>
        <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="${esc(title)}">
          ${grid}${marks}${axis}
        </svg>
      </figure>`;
  }

  /** Proportion with a Wilson interval, across the four cells. */
  function rateChart(groups, { title, height = 210 }) {
    const W = 460;
    const H = height;
    const padL = 52;
    const padR = 12;
    const padT = 26;
    const padB = 46;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const y = (v) => padT + plotH - v * plotH;
    const slotW = plotW / groups.length;
    const barW = Math.min(38, slotW * 0.42);

    const grid = [0, 0.25, 0.5, 0.75, 1].map(t => `
      <line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
        stroke="${C.line}" stroke-width="1"/>
      <text x="${padL - 7}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end"
        font-size="10" fill="${C.muted}">${Math.round(t * 100)}%</text>`).join('');

    const marks = groups.map((g, i) => {
      const cx = padL + slotW * (i + 0.5);
      const colour = g.cell.arm === 'grounding' ? C.grounded : C.nongrounded;
      if (!g.n) {
        return `
          <rect x="${(cx - barW / 2).toFixed(1)}" y="${padT}" width="${barW}" height="${plotH}"
            fill="${C.line}" opacity="0.25" rx="4"/>
          <text x="${cx.toFixed(1)}" y="${(padT + plotH / 2).toFixed(1)}" text-anchor="middle"
            font-size="9.5" fill="${C.muted}"><tspan x="${cx.toFixed(1)}" dy="0">not in</tspan><tspan x="${cx.toFixed(1)}" dy="12">this design</tspan></text>`;
      }
      const w = S().wilson(g.k, g.n);
      const top = y(w.p);
      return `
        <rect x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW}"
          height="${Math.max(2, padT + plotH - top).toFixed(1)}" rx="4"
          fill="${colour}" fill-opacity="0.85">
          <title>${esc(g.cell.label)} · ${esc(g.cell.arml)}: ${g.k}/${g.n} = ${(w.p * 100).toFixed(0)}%</title>
        </rect>
        <line x1="${cx}" x2="${cx}" y1="${y(w.hi).toFixed(1)}" y2="${y(w.lo).toFixed(1)}"
          stroke="${C.ink}" stroke-width="2" stroke-opacity="0.55"/>
        <line x1="${(cx - 6).toFixed(1)}" x2="${(cx + 6).toFixed(1)}" y1="${y(w.hi).toFixed(1)}" y2="${y(w.hi).toFixed(1)}"
          stroke="${C.ink}" stroke-width="2" stroke-opacity="0.55"/>
        <line x1="${(cx - 6).toFixed(1)}" x2="${(cx + 6).toFixed(1)}" y1="${y(w.lo).toFixed(1)}" y2="${y(w.lo).toFixed(1)}"
          stroke="${C.ink}" stroke-width="2" stroke-opacity="0.55"/>
        <text x="${cx.toFixed(1)}" y="${(y(w.hi) - 7).toFixed(1)}" text-anchor="middle"
          font-size="10" font-weight="700" fill="${C.ink}">${(w.p * 100).toFixed(0)}%</text>`;
    }).join('');

    const axis = groups.map((g, i) => {
      const cx = padL + slotW * (i + 0.5);
      return `
        <text x="${cx.toFixed(1)}" y="${(H - padB + 15).toFixed(1)}" text-anchor="middle"
          font-size="10.5" font-weight="700" fill="${C.ink}">${esc(g.cell.label)}</text>
        <text x="${cx.toFixed(1)}" y="${(H - padB + 28).toFixed(1)}" text-anchor="middle"
          font-size="9.5" fill="${C.muted}">${esc(g.cell.arml)}</text>
        <text x="${cx.toFixed(1)}" y="${(H - padB + 40).toFixed(1)}" text-anchor="middle"
          font-size="9.5" fill="${C.muted}">${g.n ? `${g.k}/${g.n}` : 'n=0'}</text>`;
    }).join('');

    return `
      <figure class="viz-fig">
        <figcaption class="viz-fig-title">${esc(title)}</figcaption>
        <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="${esc(title)}">
          ${grid}${marks}${axis}
        </svg>
      </figure>`;
  }

  function legendHtml() {
    return `
      <div class="viz-legend">
        <span><i style="background:${C.grounded}"></i>Grounded</span>
        <span><i style="background:${C.nongrounded}"></i>Non-grounded</span>
        <span class="viz-legend-note">Box = quartiles and median; dots = every individual task.
          Bars = accuracy with a 95% Wilson interval.</span>
      </div>`;
  }

  window.FindV2Charts = { CELLS, boxChart, rateChart, legendHtml, fmtMs, colours: C };
}());
