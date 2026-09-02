/**
 * The dashboard's own definitions, read out of app/welcome.js at run time.
 *
 * WHY EXTRACTION AND NOT A COPY. A figure in a paper, a row in the results table and a card on the
 * dashboard that disagree is the worst outcome available here, and it is the likely one: the rules
 * are not simple (which tasks a facet counts by default, which column a behavioural metric prefers,
 * how a row's style is decided, what counts as localization). A restatement in a script drifts the
 * first time one of them is changed, and nothing fails until somebody quotes the wrong number.
 *
 * So every script that reports numbers reads them from here, and this reads them from the browser
 * file. It is deliberately brittle about names: a rename in app/welcome.js fails the next run loudly
 * rather than quietly plotting something else.
 *
 * `stimulusStyleById` is stubbed. In the browser it reads the queue the welcome screen built, which
 * does not exist in Node; every row written since the study went live carries an explicit
 * `task_style`, and taskStyle() consults that first. The stub means a row that somehow lacks one
 * falls through to the same id/evidence heuristics the dashboard uses, instead of a script inventing
 * a third answer.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The four cards, in the order the dashboard draws them. */
export const FACETS = [
  { key: 'find_text', taskType: 'find', style: 'text', label: 'Find × Text', short: 'Find\n×Text' },
  { key: 'find_visual', taskType: 'find', style: 'visual', label: 'Find × Visual', short: 'Find\n×Visual' },
  { key: 'guide_text', taskType: 'guide', style: 'text', label: 'Guide × Text', short: 'Guide\n×Text' },
  { key: 'guide_visual', taskType: 'guide', style: 'visual', label: 'Guide × Visual', short: 'Guide\n×Visual' },
];

export async function dashboardDefinitions() {
  const src = await readFile(join(ROOT, 'app/welcome.js'), 'utf8');

  const takeFunction = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`app/welcome.js no longer defines ${name}() — scripts/dashboard_defs.mjs must be updated with it.`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`Could not read the body of ${name}() out of app/welcome.js.`);
  };

  const takeConst = (name) => {
    const m = src.match(new RegExp(`const ${name} = [\\s\\S]*?\\n(?:\\}|\\]);`));
    if (!m) throw new Error(`app/welcome.js no longer defines ${name} — scripts/dashboard_defs.mjs must be updated with it.`);
    return m[0];
  };

  const body = [
    'const stimulusStyleById = () => new Map();',
    takeConst('FACET_TASK_EXCLUSIONS'),
    takeConst('BEHAVIOR_METRICS'),
    takeConst('SELF_REPORT_METRICS'),
    takeFunction('num'),
    takeFunction('avgValues'),
    takeFunction('taskStyle'),
    takeFunction('behaviorValue'),
    takeFunction('selfReportValue'),
    takeFunction('answerCorrect'),
    takeFunction('judgeTime'),
    takeFunction('locateTime'),
    takeFunction('totalTime'),
    takeFunction('f1'),
    takeFunction('evidenceQuality'),
    takeFunction('localizationParts'),
    takeFunction('sessionKey'),
    'return { FACET_TASK_EXCLUSIONS, BEHAVIOR_METRICS, SELF_REPORT_METRICS, num, avgValues,'
      + ' taskStyle, behaviorValue, selfReportValue, answerCorrect, judgeTime, locateTime,'
      + ' totalTime, f1, evidenceQuality, localizationParts, sessionKey };',
  ].join('\n\n');

  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

/** Every result row, read with the anon key the site already serves to participants. */
export async function fetchRows() {
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

/**
 * The rows one facet counts, with the same three states the dashboard has.
 *
 * `selection` is what its cards were counting at publish time and always wins; `allTasks` turns
 * every default exclusion off, which is the honest way to check what a default is doing rather than
 * arguing about it: run both and compare.
 */
export function facetRows(rows, facet, defs, { allTasks = false, selection = null } = {}) {
  const inFacet = rows.filter(r => r.task_type === facet.taskType && defs.taskStyle(r) === facet.style);
  if (allTasks) return inFacet;
  const asked = selection?.[facet.key];
  if (Array.isArray(asked)) return inFacet.filter(r => asked.includes(String(r.task_id || '')));
  const excluded = defs.FACET_TASK_EXCLUSIONS[facet.key]?.ids || [];
  return inFacet.filter(r => !excluded.includes(String(r.task_id || '')));
}

/** Where a facet's task list came from, for the provenance line. */
export function selectionSource(facet, defs, { allTasks = false, selection = null } = {}) {
  if (allTasks) return 'every task (--all-tasks)';
  if (Array.isArray(selection?.[facet.key])) return 'the dashboard, as it stood at publish time';
  return defs.FACET_TASK_EXCLUSIONS[facet.key] ? 'the committed defaults' : 'every task';
}

export function stats(values) {
  const v = values.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, sd: null, se: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1
    ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
    : 0;
  return { n: v.length, mean, sd, se: sd / Math.sqrt(v.length) };
}

/** Booleans count as 1/0, so accuracy and a duration go through the same path. */
export function metricValues(rows, metricFn) {
  return rows
    .map(metricFn)
    .map(v => (v === true ? 1 : v === false ? 0 : (v == null || v === '' ? null : Number(v))))
    .filter(v => v != null && Number.isFinite(v));
}

export function csv(lines) {
  return lines.map(r => r.map(v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}
