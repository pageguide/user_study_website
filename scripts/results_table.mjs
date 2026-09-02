#!/usr/bin/env node
/**
 * Fill the finalized results table — one row per category, both arms side by side.
 *
 *   node scripts/results_table.mjs                       # fill the sheet in ~/Downloads, and figures/
 *   node scripts/results_table.mjs --table=/some/x.csv   # write the sheet somewhere else
 *   node scripts/results_table.mjs --all-tasks           # ignore the dashboard's default exclusions
 *   node scripts/results_table.mjs --selection=file.json # the dashboard's live task selection
 *
 * WHAT THIS IS FOR. The figures show the shape of a result; a paper still needs the numbers written
 * out, and they get typed into a spreadsheet by hand — which is where a transcription error enters a
 * paper and is never caught, because nothing downstream disagrees with it. This writes the sheet
 * instead, from the same rows the dashboard's four cards are counting at the moment the button is
 * pressed.
 *
 * IT KEEPS THE SHEET'S OWN SHAPE. The header is two rows — a group name over a Non-grounded /
 * PageGuide pair — and the six category rows are in the order the sheet already has them. If the
 * template on disk has a header this script does not recognise, it says so per column and writes its
 * own header rather than filling the wrong cells silently.
 *
 * THE REPORTED MEASURES CARRY A SPREAD COLUMN. Accuracy, the four localization halves — Find's two
 * hops, Guide's error type and step — mouse travel, and the two self-report scales are written as a
 * mean and, in the group beside it, the sample SD (n-1) of the same values in the same arm. Mouse
 * travel and the scales are here for opposite reasons: travel is a long-tailed count where the mean
 * alone is unreadable without knowing how far it is dragged, and confidence/helpfulness are ordinal
 * points where the spread is the whole question of whether people agreed. A mean of a 0/1 measure says nothing about
 * how divided the rows behind it were, and the paper reports both; the SD is computed from exactly
 * the values the mean was computed from, so an n of 0 or 1 leaves the mean and the SD equally blank
 * or zero rather than inventing a spread.
 *
 * EVERY MEAN LEAVES OUT THE ROWS THAT HAVE NO VALUE for that measure rather than counting them as
 * zero — the same rule the cards use — so the n behind a cell can be smaller than the row count in
 * the first columns. The two n columns are ROWS, not people; Participants is the distinct sittings
 * behind them.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ROOT, FACETS, dashboardDefinitions, fetchRows, facetRows, metricValues, stats, csv,
} from './dashboard_defs.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const ALL_TASKS = args.includes('--all-tasks');
const SELECTION_FILE = flag('selection') || '';
/** The sheet the paper is written from. Filled in place: the header stays, the numbers are replaced. */
const TABLE = flag('table')
  || join(homedir(), 'Downloads', 'Aug 19 - User Study Results Finalized - Sheet1.csv');
/** The copy that travels with the figures, so the published folder carries the table too. */
const REPO_COPY = flag('copy') || join(ROOT, 'figures', 'results_table.csv');

// ── The columns, exactly as the sheet has them ───────────────────────────────────────────────────

/**
 * The five that describe the cell, then a pair of columns per measure.
 *
 * `ng`/`g` are the sub-header words the sheet already uses, and they are NOT consistent in it —
 * "Non-grounded" in some groups, "Non Grounded" in others, "Grounded" for the first two and
 * "PageGuide" after that. They are reproduced as they are rather than tidied: this file is meant to
 * drop into the existing sheet, and a header that differs from the one beside it in the workbook is
 * a merge conflict waiting to happen in a document nobody diffs.
 */
const LEAD_COLUMNS = ['Type', 'Non_grounded_n', 'Grounded_n', 'Participants', 'N_tasks'];

function measureColumns(defs) {
  const findParts = defs.localizationParts({ taskType: 'find', style: 'text' });
  const guideParts = defs.localizationParts({ taskType: 'guide', style: 'text' });
  const seconds = (ms) => (ms == null ? null : ms / 1000);
  const fixed = (places) => (v) => (v == null ? '' : v.toFixed(places));
  const behavior = (label) => {
    const m = defs.BEHAVIOR_METRICS.find(b => b.label === label);
    if (!m) throw new Error(`app/welcome.js no longer carries the "${label}" behaviour metric.`);
    return (row) => defs.behaviorValue(row, m.key, m.column);
  };

  return [
    // Time is written in seconds because that is the unit the sheet's header names; the table is
    // read by people, and 262463 ms is not a number anybody holds in their head.
    { group: 'Judge Time (s)', ng: 'Non-grounded', g: 'Grounded', value: r => seconds(defs.judgeTime(r)), format: fixed(1) },
    { group: 'Locate Time (s)', ng: 'Non-grounded', g: 'Grounded', value: r => seconds(defs.locateTime(r)), format: fixed(1) },
    // Proportions, not percentages: the sheet's own charts do the ×100, and a column that had been
    // scaled once already is the easiest way to publish a number twice as large as the truth.
    { sd: true, group: 'Accuracy', ng: 'Non-grounded', g: 'PageGuide', value: defs.answerCorrect, format: fixed(3) },
    // Find's two hops are hit rates — Q1b will not submit without a pick for each, so a hop has one
    // pick against one accepted set and its F1 IS whether that hop was right. Blank on Guide rows.
    { sd: true, group: 'Find Result (First part)', ng: 'Non Grounded', g: 'PageGuide', value: findParts[0].metric, format: fixed(3) },
    { sd: true, group: 'Find Result (Second part)', ng: 'Non Grounded', g: 'PageGuide', value: findParts[1].metric, format: fixed(3) },
    // Guide's two halves, kept apart: naming the error type and blaming the right step fail
    // differently, and every facet localizes a step far worse than it names a type.
    { sd: true, group: 'Guide Result (Error Part)', ng: 'Non Grounded', g: 'PageGuide', value: guideParts[0].metric, format: fixed(3) },
    { sd: true, group: 'Guide Result (Step Error)', ng: 'Non Grounded', g: 'PageGuide', value: guideParts[1].metric, format: fixed(3) },
    { group: 'Localization', ng: 'Non Grounded', g: 'PageGuide', value: defs.evidenceQuality, format: fixed(3) },
    { group: 'Scrolls', ng: 'Non-grounded', g: 'PageGuide', value: behavior('Scrolls'), format: fixed(2) },
    { group: 'Ctr-F', ng: 'Non-grounded', g: 'PageGuide', value: behavior('Ctrl-F'), format: fixed(2) },
    { group: 'Selections', ng: 'Non-grounded', g: 'PageGuide', value: behavior('Selections'), format: fixed(2) },
    { group: 'Clicks', ng: 'Non-grounded', g: 'PageGuide', value: behavior('Clicks'), format: fixed(2) },
    { sd: true, group: 'Mouse Travel (px)', ng: 'Non-grounded', g: 'PageGuide', value: behavior('Mouse travel'), format: fixed(0) },
    // Said as a point on the four-point scale it came off, never as a percentage: averaging an
    // ordinal scale already assumes its steps are even, and rescaling it hides which scale it was.
    { sd: true, group: 'Confidence (/4)', ng: 'Non-grounded', g: 'PageGuide', value: r => defs.selfReportValue(r, defs.SELF_REPORT_METRICS[0]), format: fixed(2) },
    { sd: true, group: 'Helpfulness (/4)', ng: 'Non-grounded', g: 'PageGuide', value: r => defs.selfReportValue(r, defs.SELF_REPORT_METRICS[1]), format: fixed(2) },
  ];
}

/**
 * The six rows the sheet has, in its order.
 *
 * The two averages pool ROWS across the pair of facets rather than averaging the two facet means.
 * The facets do not hold equal numbers of rows, so the two answers differ, and pooling is the one
 * that says "the average Find task": a mean of means would weight a facet with 20 rows the same as
 * one with 60.
 */
const TABLE_ROWS = [
  { label: 'FindxVisual', facets: ['find_visual'] },
  { label: 'FindxText', facets: ['find_text'] },
  { label: 'avg (Find)', facets: ['find_visual', 'find_text'] },
  { label: 'GuidexText', facets: ['guide_text'] },
  { label: 'GuidexVisual', facets: ['guide_visual'] },
  { label: 'avg (Guide)', facets: ['guide_text', 'guide_visual'] },
];

const ARMS = [{ id: 'nongrounding', key: 'ng' }, { id: 'grounding', key: 'g' }];

/**
 * The columns as the sheet lays them out: a measure marked `sd` becomes two groups, its mean and
 * then its spread, so the pair sits side by side under headers that name which is which.
 */
function withSpreadColumns(columns) {
  return columns.flatMap(c => (c.sd
    ? [c, { ...c, group: `${c.group} SD`, stat: 'sd' }]
    : [c]));
}

function headerRows(columns) {
  const top = [...LEAD_COLUMNS];
  const sub = LEAD_COLUMNS.map(() => '');
  columns.forEach(c => { top.push(c.group, ''); sub.push(c.ng, c.g); });
  return [top, sub];
}

/** One measure over one arm — its mean, or its sample SD for a spread column — plus the n it rests on. */
function cell(rows, column, arm, defs) {
  const values = metricValues(rows.filter(r => r.condition === arm.id), column.value);
  const stat = column.stat === 'sd' ? stats(values).sd : defs.avgValues(values);
  return { text: column.format(stat), n: values.length };
}

function main() {
  return (async () => {
    const defs = await dashboardDefinitions();
    const selection = SELECTION_FILE ? JSON.parse(await readFile(SELECTION_FILE, 'utf8')) : null;
    const rows = await fetchRows();
    const columns = withSpreadColumns(measureColumns(defs));

    const counted = new Map(FACETS.map(f =>
      [f.key, facetRows(rows, f, defs, { allTasks: ALL_TASKS, selection })]));

    const [top, sub] = headerRows(columns);
    const out = [top, sub];
    TABLE_ROWS.forEach(spec => {
      const facetRowsForLine = spec.facets.flatMap(key => counted.get(key));
      const line = [
        spec.label,
        facetRowsForLine.filter(r => r.condition === 'nongrounding').length,
        facetRowsForLine.filter(r => r.condition === 'grounding').length,
        new Set(facetRowsForLine.map(r => defs.sessionKey(r)).filter(Boolean)).size,
        new Set(facetRowsForLine.map(r => String(r.task_id || '')).filter(Boolean)).size,
      ];
      columns.forEach(c => ARMS.forEach(arm => line.push(cell(facetRowsForLine, c, arm, defs).text)));
      out.push(line);
    });

    const text = csv(out);
    await mkdir(dirname(TABLE), { recursive: true });
    await reportTemplateDrift(top, sub);
    await writeFile(TABLE, text);
    await mkdir(dirname(REPO_COPY), { recursive: true });
    await writeFile(REPO_COPY, text);

    const total = FACETS.reduce((a, f) => a + counted.get(f.key).length, 0);
    console.log(`\n  ${rows.length} rows read · ${total} counted${ALL_TASKS ? ' (--all-tasks)' : ''}`
      + `${selection ? ' · the dashboard’s live selection' : ''}`);
    TABLE_ROWS.forEach((spec, i) => console.log(`    ${spec.label.padEnd(13)} `
      + `${out[i + 2][1]} non-grounded · ${out[i + 2][2]} grounded rows`));
    console.log(`\n  wrote ${TABLE}`);
    console.log(`  wrote ${REPO_COPY}\n`);
  })();
}

/**
 * Say so when the sheet on disk is not the sheet this was written for.
 *
 * A column added or renamed in the spreadsheet would otherwise be filled with the measure that used
 * to sit in that position — internally consistent, and wrong in a way no chart would reveal. The
 * file is still written: what it holds is correct and self-describing, and its header now says which
 * columns moved.
 */
async function reportTemplateDrift(top, sub) {
  if (!existsSync(TABLE)) {
    console.log(`  (no sheet at ${TABLE} yet — writing a new one with this header)`);
    return;
  }
  const lines = (await readFile(TABLE, 'utf8')).split(/\r?\n/).slice(0, 2);
  const same = (a, b) => csv([a]).trim() === String(b || '').trim();
  if (same(top, lines[0]) && same(sub, lines[1])) return;
  console.log('  ! the sheet’s header is not the one this script fills:');
  if (!same(top, lines[0])) console.log(`      was: ${lines[0]}\n      now: ${csv([top]).trim()}`);
  if (!same(sub, lines[1])) console.log(`      was: ${lines[1]}\n      now: ${csv([sub]).trim()}`);
  console.log('    The numbers below it are correct for the header written above them — check that '
    + 'no column of yours was dropped.');
}

main().catch(e => {
  console.error(`\n  [results-table] ${e.message}\n`);
  process.exit(1);
});
