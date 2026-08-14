#!/usr/bin/env node
//
// Publish the paper's behavioural figures.
// ======================================
//
//   node scripts/figures.mjs                 # write figures/ from the live table
//   node scripts/figures.mjs --all-tasks     # ignore the dashboard's default exclusions
//   node scripts/figures.mjs --out some/dir  # somewhere other than figures/
//
// TWO FIGURES, the pair the paper needs:
//
//   1. behavior_pooled       non-grounded vs grounded, every counted row pooled
//   2. behavior_by_facet     the same six signals split by Find/Guide × Text/Visual
//
// Bars are means; whiskers are ±1 standard error (sd/√n), which is what "mean ± SE" means in the
// caption and is NOT a confidence interval — at these n a 95% interval is roughly twice as long,
// and the two are read very differently by a reviewer. The CSV beside each figure carries n, mean,
// sd and se per cell so a caption can quote any of them without re-deriving it from the picture.
//
// WHY IT LIFTS ITS DEFINITIONS OUT OF app/welcome.js RATHER THAN RESTATING THEM. A figure in a
// paper and a card on the dashboard that disagree is the worst outcome available here, and it is
// the likely one: the dashboard's rules are not simple (which tasks a facet counts by default,
// which column a behavioural metric prefers, how a row's style is decided), and a copy of them in
// this file would drift the first time one is changed. So the shared pieces are read out of
// app/welcome.js at run time and evaluated here. If that file is refactored so a name below no
// longer exists, this script fails loudly on the next run rather than quietly plotting something
// else — which is the failure mode worth having.
//
// Reads the anon key from app/config.js, the same key the site serves to participants.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const useAllTasks = args.includes('--all-tasks');
const outArg = args.find(a => a.startsWith('--out='));
const OUT_DIR = join(ROOT, outArg ? outArg.split('=')[1] : 'figures');
/**
 * A task selection handed in from the dashboard, or '' for the committed defaults.
 *
 * The dashboard's tick boxes live in memory and are never written to FACET_TASK_EXCLUSIONS, so
 * without this the figures would be built from a different study than the screen was showing when
 * somebody pressed publish — the exact confusion a "publish what I am looking at" button exists to
 * remove.
 */
const selectionArg = args.find(a => a.startsWith('--selection='));
const SELECTION_FILE = selectionArg ? selectionArg.split('=').slice(1).join('=') : '';
let SELECTION = null;

// ── The dashboard's own definitions ──────────────────────────────────────────────────────────────

/**
 * Pull named declarations out of app/welcome.js and evaluate them here.
 *
 * The file is a browser script — no exports, no module system — so this is source extraction rather
 * than an import. It is deliberately brittle about names: a missing one throws.
 *
 * `stimulusStyleById` is stubbed. In the browser it reads the queue the welcome screen already
 * built, which does not exist in Node; every row written since the study went live carries an
 * explicit `task_style`, and taskStyle() consults that first. The stub means a row that somehow
 * lacks one falls through to the same id/evidence heuristics the dashboard uses, instead of this
 * script inventing a third answer.
 */
async function dashboardDefinitions() {
  const src = await readFile(join(ROOT, 'app/welcome.js'), 'utf8');

  const takeFunction = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`app/welcome.js no longer defines ${name}() — figures.mjs must be updated with it.`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`Could not read the body of ${name}() out of app/welcome.js.`);
  };

  const takeConst = (name) => {
    const m = src.match(new RegExp(`const ${name} = [\\s\\S]*?\\n(?:\\}|\\]);`));
    if (!m) throw new Error(`app/welcome.js no longer defines ${name} — figures.mjs must be updated with it.`);
    return m[0];
  };

  const body = [
    'const stimulusStyleById = () => new Map();',
    takeConst('FACET_TASK_EXCLUSIONS'),
    takeConst('BEHAVIOR_METRICS'),
    takeFunction('num'),
    takeFunction('avgValues'),
    takeFunction('taskStyle'),
    takeFunction('behaviorValue'),
    takeFunction('answerCorrect'),
    takeFunction('judgeTime'),
    takeFunction('locateTime'),
    takeFunction('totalTime'),
    takeFunction('f1'),
    takeFunction('evidenceQuality'),
    takeFunction('localizationParts'),
    'return { FACET_TASK_EXCLUSIONS, BEHAVIOR_METRICS, num, taskStyle, behaviorValue,'
      + ' answerCorrect, judgeTime, locateTime, totalTime, f1, evidenceQuality, localizationParts };',
  ].join('\n\n');

  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

// ── Data ─────────────────────────────────────────────────────────────────────────────────────────

async function supabase() {
  const src = await readFile(join(ROOT, 'app/config.js'), 'utf8');
  const url = src.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
  const key = src.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error('Could not read SUPABASE_URL / SUPABASE_ANON_KEY from app/config.js');
  const rows = await fetch(`${url}/rest/v1/study_task_results_v2?select=*&limit=50000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (!rows.ok) throw new Error(`Supabase ${rows.status}: ${await rows.text().catch(() => '')}`);
  return rows.json();
}

/** The four cards, in the order the dashboard draws them. */
const FACETS = [
  { key: 'find_text', taskType: 'find', style: 'text', label: 'Find × Text', short: 'Find\n×Text' },
  { key: 'find_visual', taskType: 'find', style: 'visual', label: 'Find × Visual', short: 'Find\n×Visual' },
  { key: 'guide_text', taskType: 'guide', style: 'text', label: 'Guide × Text', short: 'Guide\n×Text' },
  { key: 'guide_visual', taskType: 'guide', style: 'visual', label: 'Guide × Visual', short: 'Guide\n×Visual' },
];

/**
 * The two arms, in fixed order, in the two colours the figures use everywhere.
 *
 * A MUTED ROSE AND A MUTED BLUE, not the dashboard's orange/blue: a paper figure is read on white
 * paper next to body text, and the screen pair is louder than a printed page wants. These are the
 * softer tints with the saturation dialled back only as far as it can go while still passing —
 * every hex here was chosen by running the six checks, not by eye:
 *
 *     lightness band   both inside L 0.43–0.77
 *     chroma floor     both >= 0.1, so neither reads as grey in print
 *     CVD separation   ΔE 15.7 (protan) · 26.7 (tritan)
 *     normal vision    ΔE 21.6
 *     contrast         both >= 3:1 against white
 *
 * The pastel end of this family — anything around #bf7f80 / #7fa3c7 — fails two of those: the blue
 * drops under the chroma floor and the pair falls to ΔE 13.8 in normal vision, which is two bars a
 * full-colour reader has to work to tell apart. Do not soften these further without re-running the
 * validator.
 *
 * ORDER IS FIXED AND MEANS SOMETHING. Non-grounded is always first and always rose; a figure that
 * repainted the arms because one had no rows would be unreadable against its own caption.
 */
const ARMS = [
  { id: 'nongrounding', label: 'Non-grounded', color: '#bf5a64' },
  { id: 'grounding', label: 'Grounded', color: '#5183c9' },
];

/**
 * The rows each facet counts, with the dashboard's default exclusions applied.
 *
 * --all-tasks turns them off, which is the honest way to check what a default is doing rather than
 * arguing about it: run both and compare the two figures.
 */
function facetRows(rows, facet, defs) {
  const inFacet = rows.filter(r => r.task_type === facet.taskType && defs.taskStyle(r) === facet.style);
  if (useAllTasks) return inFacet;
  const asked = SELECTION?.[facet.key];
  if (Array.isArray(asked)) return inFacet.filter(r => asked.includes(String(r.task_id || '')));
  const excluded = defs.FACET_TASK_EXCLUSIONS[facet.key]?.ids || [];
  return inFacet.filter(r => !excluded.includes(String(r.task_id || '')));
}

/** Where a facet's task list came from, for the provenance file. */
function selectionSource(facet, defs) {
  if (useAllTasks) return 'every task (--all-tasks)';
  if (Array.isArray(SELECTION?.[facet.key])) return 'the dashboard, as it stood at publish time';
  return defs.FACET_TASK_EXCLUSIONS[facet.key] ? 'the committed defaults' : 'every task';
}

function stats(values) {
  const v = values.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, sd: null, se: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1
    ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
    : 0;
  return { n: v.length, mean, sd, se: sd / Math.sqrt(v.length) };
}

// ── SVG ──────────────────────────────────────────────────────────────────────────────────────────

const INK = '#16161a';
const MUTED = '#5c5c66';
const RULE = '#d8d8e0';
const SURFACE = '#ffffff';

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * An axis that ends on a round number, with ticks a person would have chosen.
 *
 * Bars are read against their axis, so a top tick of 14437 makes every bar in that panel a
 * comparison against an arbitrary number. 1-2-5 steps keep the six panels' axes readable as a set
 * even though their units differ by four orders of magnitude.
 */
function niceScale(max) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
  return { max: top, ticks };
}

function tickLabel(v, max) {
  if (max >= 1000) return v >= 1000 ? `${v / 1000}k` : String(v);
  if (max >= 10) return String(Math.round(v));
  if (max >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * One bar: rounded only at the data end, square on the baseline.
 *
 * A bar rounded at the bottom floats off its own axis, and a bar rounded at both ends reads as a
 * pill rather than a measurement from zero.
 */
function bar(x, y, w, h, fill) {
  const r = Math.min(4, w / 2, Math.max(0, h));
  if (h <= 0.5) return `<rect x="${x.toFixed(1)}" y="${(y + h - 0.5).toFixed(1)}" width="${w.toFixed(1)}" height="0.5" fill="${fill}"></rect>`;
  return `<path d="M${x.toFixed(1)},${(y + h).toFixed(1)} L${x.toFixed(1)},${(y + r).toFixed(1)}`
    + ` Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}`
    + ` L${(x + w - r).toFixed(1)},${y.toFixed(1)}`
    + ` Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)}`
    + ` L${(x + w).toFixed(1)},${(y + h).toFixed(1)} Z" fill="${fill}"></path>`;
}

/** ±1 SE, drawn as a capped whisker. Clipped at the axis floor so it cannot point below zero. */
function whisker(cx, yOf, mean, se, max) {
  if (se == null || !(se > 0)) return '';
  const hi = Math.min(max, mean + se);
  const lo = Math.max(0, mean - se);
  const cap = 5;
  return `<g stroke="${INK}" stroke-width="1.2" fill="none" opacity="0.75">
      <line x1="${cx.toFixed(1)}" y1="${yOf(lo).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yOf(hi).toFixed(1)}"></line>
      <line x1="${(cx - cap).toFixed(1)}" y1="${yOf(hi).toFixed(1)}" x2="${(cx + cap).toFixed(1)}" y2="${yOf(hi).toFixed(1)}"></line>
      <line x1="${(cx - cap).toFixed(1)}" y1="${yOf(lo).toFixed(1)}" x2="${(cx + cap).toFixed(1)}" y2="${yOf(lo).toFixed(1)}"></line>
    </g>`;
}

/**
 * One panel: a titled axis with a group of bars under it.
 *
 * `groups` is [{ label, bars: [{ value, se, color }] }]. One group per panel gives the pooled
 * figure; four groups gives the by-facet one, so both figures are the same drawing code and cannot
 * end up with different bar widths, tick rules or whisker semantics.
 */
/**
 * A distribution drawn as a box with its own rows scattered beside it.
 *
 * WHY BOTH. A box alone hides how many rows made it — a five-row box and a fifty-row box are the
 * same drawing — and at this study's cell sizes that is the first thing a reader needs. The points
 * are every row in the cell, so a box resting on four observations cannot be mistaken for a
 * distribution.
 *
 * JITTER IS DETERMINISTIC, seeded from the row's own key. Regenerating the figure for a revision
 * must not reshuffle the dots: a reviewer comparing two drafts would see movement that means
 * nothing, and a figure that changes when nothing changed is a figure nobody trusts.
 */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function hashJitter(key, i) {
  let h = 2166136261;
  const s = `${key}:${i}`;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}

/** The Tukey upper fence of a set of values — the top of the whisker, not the top of the data. */
function upperFence(values) {
  const v = values.filter(x => x != null && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const q1 = quantile(v, 0.25);
  const q3 = quantile(v, 0.75);
  const hi = q3 + 1.5 * (q3 - q1);
  return [...v].reverse().find(x => x <= hi) ?? v[v.length - 1];
}

function boxAndPoints(bx, w, yOf, spec, max) {
  const values = spec.points.filter(v => v != null && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!values.length) return '';
  const q1 = quantile(values, 0.25);
  const med = quantile(values, 0.5);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  // Tukey whiskers: the furthest row still within 1.5 IQR, not the extreme itself, so one very slow
  // task does not stretch the whisker over the box it belongs to.
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const lo = values.find(v => v >= loFence) ?? values[0];
  const hi = [...values].reverse().find(v => v <= hiFence) ?? values[values.length - 1];
  const cx = bx + w / 2;

  const dots = values.map((v, i) => {
    const dx = cx + hashJitter(spec.key || '', i) * (w * 0.72);
    return `<circle cx="${dx.toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="1.9" fill="${INK}" opacity="0.42"></circle>`;
  }).join('');

  return `<g>
    <line x1="${cx.toFixed(1)}" y1="${yOf(hi).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yOf(q3).toFixed(1)}" stroke="${INK}" stroke-width="1"></line>
    <line x1="${cx.toFixed(1)}" y1="${yOf(q1).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yOf(lo).toFixed(1)}" stroke="${INK}" stroke-width="1"></line>
    <line x1="${(cx - w / 4).toFixed(1)}" y1="${yOf(hi).toFixed(1)}" x2="${(cx + w / 4).toFixed(1)}" y2="${yOf(hi).toFixed(1)}" stroke="${INK}" stroke-width="1"></line>
    <line x1="${(cx - w / 4).toFixed(1)}" y1="${yOf(lo).toFixed(1)}" x2="${(cx + w / 4).toFixed(1)}" y2="${yOf(lo).toFixed(1)}" stroke="${INK}" stroke-width="1"></line>
    <rect x="${bx.toFixed(1)}" y="${yOf(q3).toFixed(1)}" width="${w.toFixed(1)}"
      height="${Math.max(1, yOf(q1) - yOf(q3)).toFixed(1)}" rx="2"
      fill="${spec.color}" fill-opacity="0.85" stroke="${INK}" stroke-width="1"></rect>
    <line x1="${bx.toFixed(1)}" y1="${yOf(med).toFixed(1)}" x2="${(bx + w).toFixed(1)}" y2="${yOf(med).toFixed(1)}" stroke="${INK}" stroke-width="1.6"></line>
    ${dots}
  </g>`;
}

function panel({ x, y, w, h, title, subtitle, groups, showAxisTitle, axisTitle, max: forcedMax, markW = 26 }) {
  const padL = 44;
  const padT = 26;
  const padB = 34;
  const plotW = w - padL - 6;
  const plotH = h - padT - padB;
  // A panel is scaled by everything drawn in it, whiskers and box tails included — an axis topped
  // by the tallest MEAN would crop the error bar that says how little the mean is pinned down.
  const values = groups.flatMap(g => g.bars.flatMap(b => (
    b.points ? b.points : [(b.value || 0) + (b.se || 0), b.value || 0]
  )));
  const { max, ticks } = niceScale(forcedMax ?? Math.max(...values, 0));
  const yOf = (v) => y + padT + plotH - (Math.min(v, max) / max) * plotH;

  const groupW = plotW / groups.length;
  // 2px of surface between adjacent bars, per the mark spec: touching fills read as one shape.
  const gap = 2;
  const barW = Math.min(markW, (groupW - 16 - gap * (groups[0].bars.length - 1)) / groups[0].bars.length);

  const marks = groups.map((g, gi) => {
    const groupLeft = x + padL + gi * groupW;
    const inner = g.bars.length * barW + (g.bars.length - 1) * gap;
    const start = groupLeft + (groupW - inner) / 2;
    const bars = g.bars.map((b, bi) => {
      const bx = start + bi * (barW + gap);
      if (b.points) return boxAndPoints(bx, barW, yOf, b, max);
      if (b.value == null) return '';
      const top = yOf(b.value);
      return bar(bx, top, barW, y + padT + plotH - top, b.color)
        + whisker(bx + barW / 2, yOf, b.value, b.se, max);
    }).join('');
    const label = g.label
      ? g.label.split('\n').map((line, li) => `<text x="${(groupLeft + groupW / 2).toFixed(1)}"
          y="${(y + padT + plotH + 14 + li * 11).toFixed(1)}" text-anchor="middle"
          font-size="10" fill="${MUTED}">${esc(line)}</text>`).join('')
      : '';
    return bars + label;
  }).join('');

  return `<g>
    <text x="${(x + padL).toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="12" font-weight="700" fill="${INK}">${esc(title)}</text>
    ${subtitle ? `<text x="${(x + padL).toFixed(1)}" y="${(y + 24).toFixed(1)}" font-size="9.5" fill="${MUTED}">${esc(subtitle)}</text>` : ''}
    ${ticks.map(t => `<line x1="${(x + padL).toFixed(1)}" y1="${yOf(t).toFixed(1)}"
        x2="${(x + padL + plotW).toFixed(1)}" y2="${yOf(t).toFixed(1)}"
        stroke="${RULE}" stroke-width="1" ${t === 0 ? '' : 'opacity="0.6"'}></line>
      <text x="${(x + padL - 6).toFixed(1)}" y="${(yOf(t) + 3.5).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="${MUTED}">${esc(tickLabel(t, max))}</text>`).join('')}
    ${marks}
    ${showAxisTitle ? `<text transform="translate(${(x + 12).toFixed(1)},${(y + padT + plotH / 2).toFixed(1)}) rotate(-90)"
      text-anchor="middle" font-size="10.5" fill="${MUTED}">${esc(axisTitle || 'Mean per task')}</text>` : ''}
  </g>`;
}

function legend(x, y) {
  return `<g>${ARMS.map((arm, i) => `
    <rect x="${x + i * 150}" y="${y - 9}" width="11" height="11" rx="2.5" fill="${arm.color}"></rect>
    <text x="${x + i * 150 + 17}" y="${y}" font-size="11" fill="${INK}">${esc(arm.label)}</text>`).join('')}</g>`;
}

function svgDocument(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
  viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">
  <rect width="${width}" height="${height}" fill="${SURFACE}"></rect>
  ${body}
</svg>
`;
}

// ── The two figures ──────────────────────────────────────────────────────────────────────────────

const PANEL_LETTERS = 'abcdefgh';

function pooledFigure(metrics, cells) {
  const panelW = 200;
  const panelH = 210;
  const width = 24 + metrics.length * panelW;
  const height = panelH + 52;
  const body = metrics.map((m, i) => panel({
    x: 12 + i * panelW,
    y: 8,
    w: panelW,
    h: panelH,
    title: `${PANEL_LETTERS[i]}) ${m.label}`,
    showAxisTitle: i === 0,
    groups: [{
      label: '',
      bars: ARMS.map(arm => ({ ...cells.get(`pooled|${m.key}|${arm.id}`), color: arm.color })),
    }],
  })).join('');
  return svgDocument(width, height, body + legend(width / 2 - 150, height - 16));
}

function facetFigure(metrics, cells) {
  const panelW = 250;
  const panelH = 230;
  const perRow = 3;
  const rows = Math.ceil(metrics.length / perRow);
  const width = 24 + perRow * panelW;
  const height = 16 + rows * panelH + 40;
  const body = metrics.map((m, i) => panel({
    x: 12 + (i % perRow) * panelW,
    y: 8 + Math.floor(i / perRow) * panelH,
    w: panelW,
    h: panelH,
    title: `${PANEL_LETTERS[i]}) ${m.label}`,
    showAxisTitle: i % perRow === 0,
    groups: FACETS.map(f => ({
      label: f.short,
      bars: ARMS.map(arm => ({ ...cells.get(`${f.key}|${m.key}|${arm.id}`), color: arm.color })),
    })),
  })).join('');
  return svgDocument(width, height, body + legend(width / 2 - 150, height - 14));
}



/**
 * Task accuracy per facet — the study's Figure 5 shape.
 *
 * A fixed 0–1 axis on every panel, not a scale fitted to each. Four panels auto-scaled to their own
 * data would put a 60% bar and a 96% bar at the same height, which is the single most effective way
 * to mislead with a bar chart. The cost is that the Guide × Text panel looks half empty; that is
 * what 60% looks like.
 */
function accuracyFigure(defs, counted) {
  const panelW = 210;
  const panelH = 240;
  const width = 24 + FACETS.length * panelW;
  const height = panelH + 46;
  const body = FACETS.map((f, i) => panel({
    x: 12 + i * panelW,
    y: 8,
    w: panelW,
    h: panelH,
    title: `${PANEL_LETTERS[i]}) ${f.label}`,
    showAxisTitle: i === 0,
    axisTitle: 'Accuracy',
    max: 1,
    markW: 40,
    groups: [{
      label: '',
      bars: ARMS.map(arm => {
        const st = stats(counted.get(f.key)
          .filter(r => r.condition === arm.id)
          .map(r => {
            const v = defs.answerCorrect(r);
            return v === true ? 1 : v === false ? 0 : null;
          }));
        return { value: st.mean, se: st.se, color: arm.color };
      }),
    }],
  })).join('');
  return svgDocument(width, height, body + legend(width / 2 - 150, height - 14));
}

/**
 * Task completion time per facet, as a box with its rows beside it.
 *
 * RESTRICTED TO CORRECTLY ANSWERED TASKS, which is what makes it a completion time rather than a
 * dwell time: a wrong answer given in nine seconds is fast in a way nobody wants credit for, and
 * pooling it with the correct ones lets a condition look quicker by being worse. The count that
 * survives is on the panel, because the restriction removes a different number of rows per cell.
 *
 * TIME IS JUDGE + LOCATE, the two stages summed — `time_ms` and `answer_time_ms` hold the same
 * whole-task duration, and the parts are what the study times separately.
 */
function timeFigure(defs, counted) {
  const panelW = 230;
  const panelH = 310;
  const width = 24 + FACETS.length * panelW;
  const height = panelH + 46;
  const body = FACETS.map((f, i) => {
    const groups = [{
      label: '',
      bars: ARMS.map(arm => ({
        color: arm.color,
        key: `${f.key}|${arm.id}`,
        points: counted.get(f.key)
          .filter(r => r.condition === arm.id && defs.answerCorrect(r) === true)
          .map(r => defs.totalTime(r))
          .filter(v => v != null)
          .map(ms => ms / 1000),
      })),
    }];
    const n = groups[0].bars.map(b => b.points.length);
    // SCALED BY THE WHISKER, NOT BY THE WORST ROW. One 4000-second task — someone who left the tab
    // open — flattens all four boxes into a line at the bottom, and the figure then shows nothing
    // except that an outlier exists. The axis stops just above the highest whisker and the panel
    // says in words how many rows are above it, which is the fact the squashed version was
    // conveying by accident.
    const fence = Math.max(...groups[0].bars.map(b => upperFence(b.points)), 0);
    const top = fence * 1.12;
    const above = groups[0].bars.reduce((a, b) => a + b.points.filter(v => v > top).length, 0);
    return panel({
      x: 12 + i * panelW,
      y: 8,
      w: panelW,
      h: panelH,
      title: `${PANEL_LETTERS[i]}) ${f.label}  (n ${n[0]} vs ${n[1]})`,
      subtitle: above ? `${above} row${above === 1 ? '' : 's'} above the axis` : '',
      showAxisTitle: i === 0,
      axisTitle: 'Time (s), correct answers only',
      max: top,
      markW: 44,
      groups,
    });
  }).join('');
  return svgDocument(width, height, body + legend(width / 2 - 150, height - 14));
}

/**
 * The two halves of localization, per facet.
 *
 * The halves are NOT the same question across task types — Find's are its two hops, Guide's are the
 * error type and the step — so each panel names its own pair rather than sharing one legend of
 * part-labels. localizationParts() is the dashboard's, so a bar here cannot mean something a card
 * does not.
 */
function localizationFigure(defs, counted) {
  const panelW = 230;
  const panelH = 250;
  const width = 24 + FACETS.length * panelW;
  const height = panelH + 46;
  const body = FACETS.map((f, i) => panel({
    x: 12 + i * panelW,
    y: 8,
    w: panelW,
    h: panelH,
    title: `${PANEL_LETTERS[i]}) ${f.label}`,
    showAxisTitle: i === 0,
    axisTitle: 'F1',
    max: 1,
    markW: 30,
    groups: defs.localizationParts(f).map(part => ({
      label: part.label.replace(' · ', '\n'),
      bars: ARMS.map(arm => {
        const st = stats(counted.get(f.key)
          .filter(r => r.condition === arm.id)
          .map(r => {
            const v = part.metric(r);
            return v === true ? 1 : v === false ? 0 : defs.num(v);
          }));
        return { value: st.mean, se: st.se, color: arm.color };
      }),
    })),
  })).join('');
  return svgDocument(width, height, body + legend(width / 2 - 150, height - 14));
}

// ── The published dataset ────────────────────────────────────────────────────────────────────────

/**
 * The rows behind the figures, written out as a dataset anyone can re-plot from.
 *
 * WHAT IS DELIBERATELY NOT IN IT. Two things, and both are omissions rather than oversights:
 *
 *   `notes` — the free text participants typed after a task. It is the one column that can carry
 *     something about a person rather than about a task, and a public dataset is the wrong place to
 *     find that out. Anyone who needs it has the database.
 *   `participant_id` / `session_id` — replaced with `participant`, a small integer assigned here.
 *     The session id is a database key, not a person, but it is also a join key into a table that
 *     does hold the notes, and an index costs nothing while closing that door.
 *
 * Everything the four cards compute from is kept, so the figures and every number on the dashboard
 * can be reproduced from this file alone.
 */
const DATASET_COLUMNS = [
  'task_id', 'task_type', 'task_style', 'facet', 'condition', 'question_index',
  'time_ms', 'answer_multiple_choice_ms', 'find_supporting_answer_ms',
  'score_answer_correct', 'score_verdict_correct',
  'score_evidence_precision', 'score_evidence_recall',
  'score_type_precision', 'score_type_recall',
  'score_step_precision', 'score_step_recall', 'score_no_error_agreement',
  'confidence', 'helpfulness',
  'scroll_count', 'ctrl_f_count', 'text_select_count', 'click_count', 'mouse_move_px',
  'website_click_count', 'panel_click_count',
];

async function writeDataset(defs, metrics, counted, pooledTable, facetTable, outcomes) {
  const dir = join(ROOT, 'dataset');
  await mkdir(dir, { recursive: true });

  const participants = new Map();
  const rowsOut = [['participant', ...DATASET_COLUMNS]];
  FACETS.forEach(facet => counted.get(facet.key).forEach(r => {
    const sessionKey = r.session_id != null ? `s${r.session_id}` : `r${r.client_run_id}`;
    if (!participants.has(sessionKey)) participants.set(sessionKey, participants.size + 1);
    const behaviour = (key, column) => defs.behaviorValue(r, key, column);
    rowsOut.push([
      participants.get(sessionKey),
      r.task_id, r.task_type, r.task_style, facet.label, r.condition, r.question_index,
      r.time_ms, r.answer_multiple_choice_ms, r.find_supporting_answer_ms,
      r.score_answer_correct, r.score_verdict_correct,
      r.score_evidence_precision, r.score_evidence_recall,
      r.score_type_precision, r.score_type_recall,
      r.score_step_precision, r.score_step_recall, r.score_no_error_agreement,
      r.confidence, r.helpfulness,
      behaviour('scroll_count', 'scroll_user_count'), behaviour('ctrl_f_count', 'ctrl_f_count'),
      behaviour('text_select_count', 'text_select_count'), behaviour('click_count', 'click_count'),
      behaviour('mouse_move_px', 'mouse_move_px'),
      behaviour('website_click_count', null), behaviour('panel_click_count', null),
    ]);
  }));

  const excluded = FACETS.map(f => {
    const e = defs.FACET_TASK_EXCLUSIONS[f.key];
    return e ? `| ${f.label} | ${e.ids.join(', ')} | ${e.why} |` : null;
  }).filter(Boolean);

  await writeFile(join(dir, 'rows.csv'), csv(rowsOut));
  await writeFile(join(dir, 'behavior_pooled.csv'), csv(pooledTable));
  await writeFile(join(dir, 'behavior_by_facet.csv'), csv(facetTable));
  await writeFile(join(dir, 'outcomes.csv'), csv(outcomes));
  await writeFile(join(dir, 'README.md'), [
    '---',
    'license: cc-by-4.0',
    'tags: [human-study, web-agents, grounding, hci]',
    '---',
    '',
    '# PageGuide user study — results',
    '',
    'One row per answered task from the PageGuide web study, on the task selection the analysis',
    'dashboard uses by default. `rows.csv` is the row-level data; the two `behavior_*.csv` files are',
    'the aggregates plotted in the behavioural figures (mean, sd, se and n per cell). `outcomes.csv`',
    'carries accuracy, localization F1 and its two halves, and the timing stages — mean, sd, se,',
    'median and quartiles per cell.',
    '',
    `Exported ${new Date().toISOString()} · ${rowsOut.length - 1} rows · ${participants.size} participants.`,
    '',
    '## Conditions',
    '',
    'Every participant sees both arms, interleaved task by task:',
    '',
    '- `nongrounding` — the agent reports an answer with no evidence attached.',
    '- `grounding` — the same claims, with citations into the page and saved image crops.',
    '',
    '## Task selection',
    '',
    'Some tasks are excluded from their card by default. The figures and these files use the same',
    'selection, so they agree with the dashboard:',
    '',
    '| Facet | Left out | Why |',
    '|---|---|---|',
    ...excluded,
    '',
    '## What is not here',
    '',
    'Participants\' free-text notes are omitted, and session ids are replaced with a per-export',
    '`participant` integer. Both are deliberate: the notes are the only column that can carry',
    'something about a person rather than about a task.',
    '',
    '## Scoring',
    '',
    'Localization quality is F1. For Find it is over the passages picked; for Guide it is the mean of',
    'an F1 over the error types named and an F1 over the steps blamed, with a correct "no error"',
    'scoring in full on a run that contains none. A null precision means the participant predicted',
    'nothing, which is zero true positives, so its F1 is 0 rather than missing.',
    '',
  ].join('\n'));

  console.log(`  dataset: ${rowsOut.length - 1} rows · ${participants.size} participants → ${dir}`);
  return dir;
}


/**
 * Every number the three outcome figures draw, in one table.
 *
 * Medians and quartiles for the time panels rather than a mean: a box plot's own summary is what a
 * caption should quote, and a reader who sees "median 52s" beside a box whose line sits at 52s can
 * check the figure against the file in one glance.
 */
function outcomeTable(defs, counted) {
  const table = [['facet', 'measure', 'condition', 'n', 'mean', 'sd', 'se', 'median', 'q1', 'q3']];
  const add = (facet, measure, arm, values) => {
    const st = stats(values);
    const sorted = values.filter(v => v != null && Number.isFinite(v)).slice().sort((a, b) => a - b);
    table.push([facet.label, measure, arm.label, st.n,
      st.mean == null ? '' : st.mean.toFixed(4),
      st.sd == null ? '' : st.sd.toFixed(4),
      st.se == null ? '' : st.se.toFixed(4),
      sorted.length ? quantile(sorted, 0.5).toFixed(4) : '',
      sorted.length ? quantile(sorted, 0.25).toFixed(4) : '',
      sorted.length ? quantile(sorted, 0.75).toFixed(4) : '']);
  };
  const asNumber = (v) => (v === true ? 1 : v === false ? 0 : defs.num(v));

  FACETS.forEach(facet => ARMS.forEach(arm => {
    const rows = counted.get(facet.key).filter(r => r.condition === arm.id);
    add(facet, 'accuracy', arm, rows.map(r => asNumber(defs.answerCorrect(r))));
    add(facet, 'localization F1', arm, rows.map(r => asNumber(defs.evidenceQuality(r))));
    defs.localizationParts(facet).forEach(part =>
      add(facet, `F1 · ${part.label}`, arm, rows.map(r => asNumber(part.metric(r)))));
    add(facet, 'judge time (s)', arm, rows.map(r => defs.judgeTime(r)).filter(v => v != null).map(v => v / 1000));
    add(facet, 'locate time (s)', arm, rows.map(r => defs.locateTime(r)).filter(v => v != null).map(v => v / 1000));
    add(facet, 'total time (s), all rows', arm,
      rows.map(r => defs.totalTime(r)).filter(v => v != null).map(v => v / 1000));
    add(facet, 'total time (s), correct only', arm,
      rows.filter(r => defs.answerCorrect(r) === true)
        .map(r => defs.totalTime(r)).filter(v => v != null).map(v => v / 1000));
  }));
  return table;
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────

function csv(lines) {
  return lines.map(r => r.map(v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

async function main() {
  const defs = await dashboardDefinitions();
  if (SELECTION_FILE) SELECTION = JSON.parse(await readFile(SELECTION_FILE, 'utf8'));
  const rows = await supabase();

  // The five the dashboard's cards carry, plus page clicks — the closest thing this study records
  // to the paper's "page visits", since a web run has no tab of its own to count visits to.
  const metrics = defs.BEHAVIOR_METRICS.concat([
    { key: 'website_click_count', column: 'website_click_count', label: 'Page clicks' },
  ]).map((m, i) => ({
    ...m,
    label: ['Scroll count', 'Ctrl+F', 'Text selections', 'Mouse clicks', 'Mouse distance (px)', 'Page clicks'][i] || m.label,
  }));

  const counted = new Map(FACETS.map(f => [f.key, facetRows(rows, f, defs)]));
  const pooled = FACETS.flatMap(f => counted.get(f.key));

  const cells = new Map();
  const table = [['facet', 'metric', 'condition', 'n', 'mean', 'sd', 'se']];
  const record = (scope, label, metric, rowsForScope) => {
    ARMS.forEach(arm => {
      const s = stats(rowsForScope
        .filter(r => r.condition === arm.id)
        .map(r => defs.behaviorValue(r, metric.key, metric.column)));
      cells.set(`${scope}|${metric.key}|${arm.id}`, { value: s.mean, se: s.se, n: s.n });
      table.push([label, metric.label, arm.label, s.n,
        s.mean == null ? '' : s.mean.toFixed(4),
        s.sd == null ? '' : s.sd.toFixed(4),
        s.se == null ? '' : s.se.toFixed(4)]);
    });
  };

  metrics.forEach(m => record('pooled', 'All tasks', m, pooled));
  const pooledTable = table.slice();
  const facetTable = [table[0]];
  metrics.forEach(m => FACETS.forEach(f => {
    const before = table.length;
    record(f.key, f.label, m, counted.get(f.key));
    facetTable.push(...table.slice(before));
  }));

  await mkdir(OUT_DIR, { recursive: true });
  const suffix = useAllTasks ? '_all_tasks' : '';
  await writeDataset(defs, metrics, counted, pooledTable, facetTable, outcomeTable(defs, counted));
  const outcomes = outcomeTable(defs, counted);
  const files = [
    [`behavior_pooled${suffix}.svg`, pooledFigure(metrics, cells)],
    [`behavior_by_facet${suffix}.svg`, facetFigure(metrics, cells)],
    [`accuracy${suffix}.svg`, accuracyFigure(defs, counted)],
    [`time_completion${suffix}.svg`, timeFigure(defs, counted)],
    [`localization_f1${suffix}.svg`, localizationFigure(defs, counted)],
    [`behavior_pooled${suffix}.csv`, csv(pooledTable)],
    [`behavior_by_facet${suffix}.csv`, csv(facetTable)],
    [`outcomes${suffix}.csv`, csv(outcomes)],
  ];
  for (const [name, content] of files) await writeFile(join(OUT_DIR, name), content);

  // PROVENANCE, WRITTEN EVERY RUN. A figure in a paper is a claim about a dataset that has since
  // grown, and six months from now the only way to tell which run produced it is a file that says.
  const excluded = FACETS.map(f => {
    const e = defs.FACET_TASK_EXCLUSIONS[f.key];
    return e ? `- **${f.label}** — left out by default: ${e.ids.join(', ')} (${e.why})` : null;
  }).filter(Boolean);
  await writeFile(join(OUT_DIR, `PROVENANCE${suffix}.md`), [
    '# How these figures were made',
    '',
    `Generated by \`scripts/figures.mjs\` on ${new Date().toISOString()}.`,
    '',
    `- \`study_task_results_v2\`: ${rows.length} rows read, ${pooled.length} counted.`,
    `- Bars are means; whiskers are ±1 standard error (sd/√n), not a confidence interval.`,
    `- Task selection: ${useAllTasks ? '**--all-tasks** — every task, defaults ignored.'
      : SELECTION ? '**sent by the dashboard** — the tasks its cards were counting at publish time.'
        : 'the committed defaults, as below.'}`,
    '',
    ...FACETS.map(f => `- ${f.label}: ${selectionSource(f, defs)} — `
      + `${Array.from(new Set(counted.get(f.key).map(r => String(r.task_id || '')))).sort().join(', ') || 'no tasks'}`),
    '',
    ...(useAllTasks || SELECTION ? [] : excluded),
    '',
    'Per-cell n, mean, sd and se are in the CSV files beside the figures.',
    '',
    ...FACETS.map(f => `- ${f.label}: ${counted.get(f.key).length} rows`),
    '',
  ].join('\n'));

  console.log(`\n  ${rows.length} rows read · ${pooled.length} counted${useAllTasks ? ' (--all-tasks)' : ''}`);
  FACETS.forEach(f => console.log(`    ${f.label.padEnd(15)} ${counted.get(f.key).length} rows`));
  console.log(`\n  wrote ${files.length + 1} files to ${OUT_DIR}\n`);
}

main().catch(e => {
  console.error(`\n  [figures] ${e.message}\n`);
  process.exit(1);
});
