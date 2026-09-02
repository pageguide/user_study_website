#!/usr/bin/env node
/**
 * Write the participant breakdown — one line per SITTING, so a reader can see who is behind the n.
 *
 *   node scripts/breakdonw_participants.mjs                        # → figures/breakdonw_participants.csv
 *   node scripts/breakdonw_participants.mjs --all-tasks            # ignore the default exclusions
 *   node scripts/breakdonw_participants.mjs --selection=file.json  # the dashboard's live selection
 *   node scripts/breakdonw_participants.mjs --session-ids          # keep the raw session_id column
 *
 * WHAT THIS IS FOR. Every other export in this repo aggregates: a mean, an n, a bar. None of them
 * can answer the question a reviewer actually asks of a within-subject design — how many of these
 * people worked BOTH arms, and how much does each cell rest on one person having been dealt one
 * task. The cards now print "46 participants · 31 in both arms"; this is that sentence written out
 * per sitting, which is the form somebody can check rather than take on trust.
 *
 * WHY IT IS NOT DERIVABLE FROM rows.csv. It is, arithmetically — and that is the point: the CSV is
 * a subset of what rows.csv already holds, computed ONCE, here, by the same code the dashboard uses,
 * rather than by whoever needs it next in a spreadsheet whose formulas nobody reviews. The published
 * table and the card header can therefore never disagree.
 *
 * ROWS COUNTED, NOT ROWS EXISTING. Every count below is over the tasks the cards are counting when
 * publish is pressed — the selection, or the committed defaults when none is handed in. `rows_total`
 * is the one exception, deliberately: it is every row the sitting wrote, so a participant who looks
 * thin in a facet can be told apart from one who barely took part at all.
 *
 * THE SESSION ID IS NOT WRITTEN unless it is asked for. `participant` is the same integer
 * scripts/figures.mjs stamps on dataset/rows.csv and rows_master.csv — numbered over the master in
 * the same order — so this table joins to those files row for row, which is what a reader needs.
 * The raw id is a join key into a table that also holds the free-text notes, and figures.mjs leaves
 * it out for that reason; --session-ids is for a local run, not for the published folder.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ROOT, FACETS, csv, dashboardDefinitions, fetchRows, facetRows, selectionSource,
} from './dashboard_defs.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const ALL_TASKS = args.includes('--all-tasks');
const WITH_IDS = args.includes('--session-ids');
const SELECTION_FILE = flag('selection') || '';
const OUT = flag('out') || join(ROOT, 'figures', 'breakdonw_participants.csv');

/** The eight tasks a full sitting walks — the same constant the dashboard completeness check uses. */
const TASKS_PER_SESSION = 8;

const ARMS = [['nongrounding', 'ng'], ['grounding', 'g']];

function main() {
  return (async () => {
    const defs = await dashboardDefinitions();
    const selection = SELECTION_FILE ? JSON.parse(await readFile(SELECTION_FILE, 'utf8')) : null;
    const rows = await fetchRows();

    // NUMBERED OVER THE MASTER, IN THE ORDER IT ARRIVES — the identical rule in scripts/figures.mjs
    // writeDataset(). Numbering over the selection instead would give the same sitting a different
    // number in this file than in rows.csv, and the two would silently describe different people.
    const number = new Map();
    const numberFor = (r) => {
      const key = defs.sessionKey(r);
      if (!key) return null;
      if (!number.has(key)) number.set(key, number.size + 1);
      return number.get(key);
    };
    rows.forEach(numberFor);

    const counted = new Map(FACETS.map(f =>
      [f.key, facetRows(rows, f, defs, { allTasks: ALL_TASKS, selection })]));

    /** One record per sitting, filled from the counted rows and topped up from the master. */
    const people = new Map();
    const record = (key) => {
      if (!people.has(key)) {
        people.set(key, {
          key,
          participant: null,
          rowsTotal: 0,
          tasksAll: new Set(),
          counted: 0,
          tasks: new Set(),
          ng: 0,
          g: 0,
          facets: new Map(FACETS.map(f => [f.key, { ng: 0, g: 0 }])),
        });
      }
      return people.get(key);
    };

    // The master pass first, so a sitting that wrote rows but had every one of them excluded still
    // gets a line. A breakdown that dropped those people would be the one table in the folder that
    // agreed with the exclusions instead of documenting them.
    rows.forEach(r => {
      const key = defs.sessionKey(r);
      if (!key) return;
      const person = record(key);
      person.participant = number.get(key);
      person.rowsTotal++;
      if (r.task_id) person.tasksAll.add(String(r.task_id));
    });

    FACETS.forEach(facet => counted.get(facet.key).forEach(r => {
      const key = defs.sessionKey(r);
      if (!key) return;
      const person = record(key);
      person.counted++;
      if (r.task_id) person.tasks.add(String(r.task_id));
      const arm = r.condition === 'grounding' ? 'g' : 'ng';
      person[arm]++;
      person.facets.get(facet.key)[arm]++;
    }));

    const ordered = Array.from(people.values()).sort((a, b) => a.participant - b.participant);

    const header = [
      'participant',
      ...(WITH_IDS ? ['session_key'] : []),
      'rows_total', 'tasks_total', 'complete',
      'rows_counted', 'tasks_counted', 'facets_counted',
      'nongrounded_rows', 'grounded_rows', 'both_arms',
      ...FACETS.flatMap(f => [`${f.key}_ng`, `${f.key}_g`, `${f.key}_both_arms`]),
    ];

    const body = ordered.map(p => [
      p.participant,
      ...(WITH_IDS ? [p.key] : []),
      p.rowsTotal,
      p.tasksAll.size,
      // DISTINCT TASKS, not rows: a task answered twice would otherwise push an unfinished sitting
      // over the line. Same rule as completeSessionKeys() in app/welcome.js.
      p.tasksAll.size >= TASKS_PER_SESSION,
      p.counted,
      p.tasks.size,
      FACETS.filter(f => p.facets.get(f.key).ng || p.facets.get(f.key).g).length,
      p.ng,
      p.g,
      p.ng > 0 && p.g > 0,
      ...FACETS.flatMap(f => {
        const cell = p.facets.get(f.key);
        return [cell.ng, cell.g, cell.ng > 0 && cell.g > 0];
      }),
    ]);

    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, csv([header, ...body]));

    // What the cards say, recomputed here from the same rows — printed so a run that disagrees with
    // the screen is visible in the terminal rather than only in a PDF three steps later.
    console.log(`\n  ${rows.length} rows read · ${ordered.length} sittings`
      + `${ALL_TASKS ? ' (--all-tasks)' : ''}${selection ? ' · the dashboard’s live selection' : ''}`);
    FACETS.forEach(f => {
      const inFacet = ordered.filter(p => {
        const c = p.facets.get(f.key);
        return c.ng || c.g;
      });
      const both = inFacet.filter(p => {
        const c = p.facets.get(f.key);
        return c.ng && c.g;
      }).length;
      const armRows = ARMS.map(([, k]) => inFacet.reduce((a, p) => a + p.facets.get(f.key)[k], 0));
      console.log(`    ${f.label.padEnd(15)} n ${armRows[0]} vs ${armRows[1]} · `
        + `${inFacet.length} participant${inFacet.length === 1 ? '' : 's'} · ${both} in both arms`
        + `  (tasks from ${selectionSource(f, defs, { allTasks: ALL_TASKS, selection })})`);
    });
    const complete = ordered.filter(p => p.tasksAll.size >= TASKS_PER_SESSION).length;
    console.log(`    ${'overall'.padEnd(15)} ${ordered.length} sittings · ${complete} finished all `
      + `${TASKS_PER_SESSION} tasks · ${ordered.filter(p => p.ng && p.g).length} in both arms`);
    console.log(`\n  wrote ${OUT}${WITH_IDS ? ' (with raw session ids — do not publish this copy)' : ''}\n`);
  })();
}

main().catch(e => {
  console.error(`\n  [breakdonw-participants] ${e.message}\n`);
  process.exit(1);
});
