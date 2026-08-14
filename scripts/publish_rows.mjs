#!/usr/bin/env node
//
// Publish the study's rows to Hugging Face, on the selection the dashboard is showing.
// ==================================================================================
//
//   node scripts/publish_rows.mjs                          # the committed defaults
//   node scripts/publish_rows.mjs --selection=sel.json      # a selection from the dashboard
//   node scripts/publish_rows.mjs --repo user/name          # somewhere else
//   node scripts/publish_rows.mjs --dry-run                 # build it, send nothing
//
// WHAT MAKES THIS DIFFERENT FROM scripts/figures.mjs. That one exports the aggregates the paper's
// figures are drawn from, always on the committed defaults. This one exports the ROWS of
// study_task_results_v2 that the four cards are counting RIGHT NOW — including boxes ticked in the
// dashboard that were never committed to FACET_TASK_EXCLUSIONS. That is what the button in the
// visualisation panel sends: the researcher tunes a card, then publishes exactly what they are
// looking at.
//
// THE SELECTION IS DATA, NOT CODE. It arrives as `{ facet: [task ids] }` and every id is checked
// against the ids actually present in that facet; anything unrecognised is dropped rather than
// trusted. A selection file that named a table, a column or a path would do nothing here.
//
// WHAT IS PUBLISHED, AND WHAT IS HELD BACK. Every scoring, timing and behavioural column of
// study_task_results_v2 goes, because the point is that somebody can recompute the paper's numbers.
// Two things do not:
//
//   `notes` — free text a participant typed. The only column that can carry something about a
//     person rather than about a task, and a public repo is the wrong place to find that out.
//   `participant_id`, `session_id`, `client_run_id` — replaced by `participant`, an integer
//     assigned at export. A session id is a join key into a table that does hold the notes.
//
// Everything else is verbatim, including `question_or_task` and the participant's own answer, so
// the export is auditable against the dashboard rather than a summary of it.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { uploadDirectory } from './huggingface.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : (args[args.indexOf(hit) + 1] || fallback);
};

const REPO = argOf('repo', 'Thang203/user_study_data_pageguide');
const OUT_DIR = join(ROOT, argOf('out', 'dataset_rows'));
const SELECTION_FILE = argOf('selection', '');
const DRY_RUN = args.includes('--dry-run');

const FACETS = [
  { key: 'find_text', taskType: 'find', style: 'text', label: 'Find × Text' },
  { key: 'find_visual', taskType: 'find', style: 'visual', label: 'Find × Visual' },
  { key: 'guide_text', taskType: 'guide', style: 'text', label: 'Guide × Text' },
  { key: 'guide_visual', taskType: 'guide', style: 'visual', label: 'Guide × Visual' },
];

/** Columns that never leave. See the note at the top of the file. */
const WITHHELD = new Set(['notes', 'participant_id', 'session_id', 'client_run_id', 'id', 'result_key']);

/** The dashboard's own rules, read out of app/welcome.js so this cannot drift from the cards. */
async function dashboardDefinitions() {
  const src = await readFile(join(ROOT, 'app/welcome.js'), 'utf8');
  const takeFunction = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`app/welcome.js no longer defines ${name}().`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`Could not read ${name}() out of app/welcome.js.`);
  };
  const takeConst = (name) => {
    const m = src.match(new RegExp(`const ${name} = [\\s\\S]*?\\n(?:\\}|\\]);`));
    if (!m) throw new Error(`app/welcome.js no longer defines ${name}.`);
    return m[0];
  };
  return new Function([
    'const stimulusStyleById = () => new Map();',
    takeConst('FACET_TASK_EXCLUSIONS'),
    takeFunction('num'),
    takeFunction('taskStyle'),
    'return { FACET_TASK_EXCLUSIONS, taskStyle };',
  ].join('\n\n'))();
}

async function fetchRows() {
  const src = await readFile(join(ROOT, 'app/config.js'), 'utf8');
  const url = src.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
  const key = src.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error('Could not read Supabase config from app/config.js');
  const res = await fetch(`${url}/rest/v1/study_task_results_v2?select=*&order=created_at.asc&limit=50000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

/**
 * Which task ids each facet counts — the dashboard's selection if one was handed in, else the
 * committed defaults.
 *
 * A facet missing from the selection means "everything", not "nothing": the dashboard only sends a
 * list for a facet it is narrowing, and treating silence as an empty set would publish an empty
 * dataset the first time somebody added a facet to the study.
 */
function selectionFor(rows, defs, selection) {
  const chosen = new Map();
  FACETS.forEach(facet => {
    const present = Array.from(new Set(rows
      .filter(r => r.task_type === facet.taskType && defs.taskStyle(r) === facet.style)
      .map(r => String(r.task_id || ''))
      .filter(Boolean)));
    const asked = selection?.[facet.key];
    if (Array.isArray(asked)) {
      const kept = present.filter(id => asked.includes(id));
      chosen.set(facet.key, { ids: kept, source: 'the dashboard' });
      return;
    }
    const excluded = defs.FACET_TASK_EXCLUSIONS[facet.key]?.ids || [];
    chosen.set(facet.key, {
      ids: present.filter(id => !excluded.includes(id)),
      source: excluded.length ? 'the committed defaults' : 'every task',
    });
  });
  return chosen;
}

function csv(lines) {
  return lines.map(r => r.map(v => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

async function main() {
  const defs = await dashboardDefinitions();
  const rows = await fetchRows();
  let selection = null;
  if (SELECTION_FILE) {
    selection = JSON.parse(await readFile(SELECTION_FILE, 'utf8'));
  }
  const chosen = selectionFor(rows, defs, selection);

  // Column order comes from the table itself rather than a list here, so a column added to
  // study_task_results_v2 tomorrow is published without this file needing to know about it.
  const columns = Array.from(new Set(rows.flatMap(r => Object.keys(r)))).filter(c => !WITHHELD.has(c));
  const participants = new Map();
  const out = [['participant', 'facet', ...columns]];
  const perFacet = new Map();

  FACETS.forEach(facet => {
    const ids = new Set(chosen.get(facet.key).ids);
    const kept = rows.filter(r => r.task_type === facet.taskType
      && defs.taskStyle(r) === facet.style
      && ids.has(String(r.task_id || '')));
    perFacet.set(facet.key, kept.length);
    kept.forEach(r => {
      const session = r.session_id != null ? `s${r.session_id}` : `r${r.client_run_id}`;
      if (!participants.has(session)) participants.set(session, participants.size + 1);
      out.push([participants.get(session), facet.label, ...columns.map(c => r[c])]);
    });
  });

  const totalRows = out.length - 1;
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'rows.csv'), csv(out));
  await writeFile(join(OUT_DIR, 'README.md'), [
    '---',
    'license: cc-by-4.0',
    'tags: [human-study, web-agents, grounding, hci]',
    '---',
    '',
    '# PageGuide user study — task results',
    '',
    'Every answered task from the PageGuide web study that the analysis is currently counting, one',
    'row per task, straight from `study_task_results_v2`.',
    '',
    `Exported ${new Date().toISOString()} · ${totalRows} rows · ${participants.size} participants.`,
    '',
    '## Conditions',
    '',
    'Each participant sees both arms, interleaved task by task:',
    '',
    '- `nongrounding` — the agent reports an answer with no evidence attached.',
    '- `grounding` — the same claims, with citations into the page and saved image crops.',
    '',
    '## Which tasks are counted',
    '',
    '| Facet | Rows | Tasks | Selected by |',
    '|---|---|---|---|',
    ...FACETS.map(f => `| ${f.label} | ${perFacet.get(f.key)} | ${chosen.get(f.key).ids.join(', ') || '—'} `
      + `| ${chosen.get(f.key).source} |`),
    '',
    'Some tasks are held out of a card — a disputed answer key, a duplicate re-recording, a run whose',
    'ground truth cannot be scored in full. The table above is exactly what produced this export.',
    '',
    '## What is not here',
    '',
    'Participants\' free-text notes are omitted, and the session id is replaced by a per-export',
    '`participant` integer. Both are deliberate: the notes are the only column that can carry',
    'something about a person rather than about a task.',
    '',
    '## Scoring',
    '',
    '`score_*_precision` / `score_*_recall` are the raw rates; the dashboard combines them as F1.',
    'For Find that is over the passages picked, for Guide the mean of an F1 over the error types',
    'named and an F1 over the steps blamed, with a correct "no error" scoring in full on a run that',
    'contains none. A null precision means the participant predicted nothing — zero true positives —',
    'so its F1 is 0 rather than missing.',
    '',
  ].join('\n'));

  console.log(`\n  ${totalRows} rows · ${participants.size} participants · ${columns.length} columns`);
  FACETS.forEach(f => console.log(`    ${f.label.padEnd(15)} ${String(perFacet.get(f.key)).padStart(4)} rows `
    + `· ${chosen.get(f.key).ids.length} tasks (${chosen.get(f.key).source})`));

  await uploadDirectory({ repo: REPO, dir: OUT_DIR, dryRun: DRY_RUN });
}

main().catch(e => {
  console.error(`\n  [publish-rows] ${e.message}\n`);
  process.exit(1);
});
