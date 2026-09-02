#!/usr/bin/env node
// Copy the recorded Guide trajectories from the V1 project into Find V2.
// =====================================================================
// V2 began Find-only, so its Guide task table is empty while thirteen recorded runs — with their
// reasoning trails and per-milestone notes already written — sit in the V1 project as
// `study_guide_trajectories`. This moves them across.
//
// IT COPIES THE SHAPE UNCHANGED. `arms.{grounding,nongrounding}.{steps, answer, trail}` is what
// app/stimulus.js reads, and app/stimulus.js is a port of the extension's viewer. Storing the rows
// verbatim means a participant judging a migrated run is looking at what the recorder produced,
// rather than at something a translation layer rebuilt — which is the entire reason that viewer was
// ported instead of rewritten.
//
// THE SOURCE IS THE AUTHORITY for what kind of task a run is and whether it succeeded. Both were
// already authored in V1's recorder and both come across:
//
//   condition 'text' | 'visual'          -> task_style  guide_text | guide_visual
//   ground_truth.correctness             -> agent_completed
//     'success' -> true, 'failure' -> false
//
// `correctness` is NOT the agent's own summary, and the difference matters: three of these runs open
// "I have completed the task" and are keyed `failure` — one hallucinated the numbers it reported, one
// silently dropped half the shopping list. Keying off the summary text would score exactly those
// backwards, which is why the recorder's judgement is what travels.
//
// Re-running RE-SYNCS those two fields plus in_study from V1. `task_index` is local ordering and is
// preserved. One retired source run is deliberately kept out: its shorter Business/Movies copy is
// the live study item, and a later migration must not silently restore the Technology version.
//
// .env (gitignored, repo root) needs both projects:
//
//   SUPABASE_URL=...              SUPABASE_SECRET_KEY=sb_secret_...       # V1, the source
//   SUPABASE_URL_V2=...           SUPABASE_SECRET_KEY_V2=sb_secret_...    # V2, the destination

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read .env by hand, exactly as scripts/publish.mjs does — no dependency tree to go stale. */
function loadEnv() {
  const out = {};
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}

/** Said plainly, because a wrong key here is where people get stuck. */
function keyProblem(label, url, key) {
  if (!url) return `${label} URL is not set in .env`;
  if (!key) return `${label} secret key is not set in .env`;
  if (key.startsWith('sb_publishable_')) {
    return `${label} holds the PUBLISHABLE key, which cannot read or write these tables. `
      + 'Use the secret key from Supabase → Project Settings → API.';
  }
  if (!key.startsWith('sb_secret_') && !key.startsWith('eyJ')) {
    return `${label} does not look like a Supabase secret key (expected sb_secret_… or a JWT).`;
  }
  return null;
}

async function rest(url, key, path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const env = loadEnv();
const SRC = {
  url: env.SUPABASE_URL,
  key: env.SUPABASE_SECRET_KEY,
  label: 'SUPABASE_URL / SUPABASE_SECRET_KEY (V1 source)',
};
// _V2 is what this repo's .env actually uses; _V is accepted so an older .env still works.
const DST = {
  url: env.SUPABASE_URL_V2 || env.SUPABASE_URL_V,
  key: env.SUPABASE_SECRET_KEY_V2 || env.SUPABASE_SECRET_KEY_V,
  label: 'SUPABASE_URL_V2 / SUPABASE_SECRET_KEY_V2 (V2 destination)',
};

for (const p of [keyProblem(SRC.label, SRC.url, SRC.key), keyProblem(DST.label, DST.url, DST.key)]) {
  if (p) { console.error(`\n  ${p}\n`); process.exit(1); }
}
if (SRC.url === DST.url) {
  console.error('\n  SUPABASE_URL and SUPABASE_URL_V are the same project. The source and the '
    + 'destination must differ, or this would copy rows onto themselves.\n');
  process.exit(1);
}

console.log(`source      ${SRC.url}`);
console.log(`destination ${DST.url}\n`);

const source = await rest(SRC.url, SRC.key, 'study_guide_trajectories?select=*&order=captured_at.asc');
if (!Array.isArray(source) || !source.length) {
  console.error('  No rows in study_guide_trajectories. Nothing to migrate.');
  process.exit(1);
}
console.log(`read ${source.length} trajectories from V1\n`);

// What is already in V2, so local ordering survives a re-sync.
const existing = await rest(DST.url, DST.key,
  'pageguide_guide_v2_tasks?select=id,task_style,agent_completed,in_study,task_index');
const PRESERVED = new Map((existing || []).map(r => [r.id, r]));

// Superseded by gv2-ed35d549-ct71ub-bm. See scripts/prune_business_movies_guide.mjs.
const LOCALLY_ARCHIVED_SOURCE_IDS = new Set(['gv2-ed35d549-ct71ub']);

/** 'success' -> completed, 'failure' -> not. Anything else is unjudged, and stays unjudged. */
function completedFrom(groundTruth) {
  const value = String(groundTruth?.correctness || '').toLowerCase();
  if (value === 'success') return true;
  if (value === 'failure') return false;
  return null;
}

let inserted = 0;
let updated = 0;
let failed = 0;

for (const [i, row] of source.entries()) {
  const keep = PRESERVED.get(row.id);
  const arms = row.arms && typeof row.arms === 'object' ? row.arms : {};
  const steps = (arms.grounding?.steps || []).length;

  const groundTruth = row.ground_truth && typeof row.ground_truth === 'object' ? row.ground_truth : {};
  const completed = completedFrom(groundTruth);

  const record = {
    id: row.id,
    source_trajectory_id: row.id,
    title: row.title || '',
    goal: row.goal || row.title || '',
    url: '',
    arms,
    guide_ground_truth: groundTruth,
    step_count: steps,
    // From V1, which authored all three. Only the ordering is local.
    task_style: row.condition === 'visual' ? 'guide_visual' : 'guide_text',
    agent_completed: completed,
    in_study: LOCALLY_ARCHIVED_SOURCE_IDS.has(row.id) ? false : row.in_study === true,
    task_index: keep ? Number(keep.task_index) || 0 : i,
  };

  // ONE ROW PER REQUEST. The steps carry base64 screenshots; a thirteen-row batch is megabytes and
  // fails as a single opaque error rather than as twelve successes and one problem.
  try {
    await rest(DST.url, DST.key, 'pageguide_guide_v2_tasks?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(record),
    });
    if (keep) updated++; else inserted++;
    const mark = completed == null ? 'NEEDS A KEY' : (completed ? 'completed' : 'did not complete');
    console.log(`  ${keep ? 'updated' : 'inserted'}  ${row.id.padEnd(24)} ${String(steps).padStart(2)} steps  `
      + `${record.task_style.padEnd(12)} ${mark.padEnd(18)}${record.in_study ? '· in study' : ''}`);
  } catch (e) {
    failed++;
    console.error(`  FAILED    ${row.id} — ${e.message}`);
  }
}

console.log(`\n${inserted} inserted, ${updated} updated, ${failed} failed.`);

// What the round robin can actually deal. A group needs one live guide task of each correctness, or
// its rotation shows the same kind of run to everyone — worth saying here rather than leaving to be
// noticed halfway through a pilot.
const live = source.filter(r => r.in_study === true && !LOCALLY_ARCHIVED_SOURCE_IDS.has(r.id));
for (const [cond, group] of [['text', 'A / text'], ['visual', 'B / visual']]) {
  const of = live.filter(r => r.condition === cond);
  const yes = of.filter(r => completedFrom(r.ground_truth) === true).length;
  const no = of.filter(r => completedFrom(r.ground_truth) === false).length;
  const warn = !yes || !no ? '  ← rotation will repeat one kind' : '';
  console.log(`  group ${group.padEnd(12)} ${of.length} live · ${yes} completed · ${no} did not complete${warn}`);
}
const unkeyed = source.filter(r => completedFrom(r.ground_truth) === null).length;
if (unkeyed) {
  console.log(`\n  ${unkeyed} task${unkeyed === 1 ? '' : 's'} have no correctness recorded in V1 and`);
  console.log('  cannot go live until keyed in Admin → Guide tasks.');
}
process.exit(failed ? 1 : 0);
