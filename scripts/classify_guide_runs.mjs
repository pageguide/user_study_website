#!/usr/bin/env node
// Fill in `claims_completion` on the Guide runs.
// =============================================
// Run once after sql/040_supabase_v2_faithfulness.sql:  node scripts/classify_guide_runs.mjs
// Re-running is safe; pass --force to re-derive rows that already have a value.
//
// The classification the study turns on needs TWO facts, not one:
//
//   claims the job is done + it was     -> CORRECT   (faithful success)
//   claims the job is done + it was not -> INCORRECT (false success)   <- the study item
//   admits it could not finish          -> honest failure, excluded
//
// `agent_completed` is the second fact and was migrated from V1. This derives the first from how the
// agent's own answer OPENS, which is a heuristic and is treated as one: every row is printed with
// the opening words it was judged on, so a wrong call is visible here rather than discovered as a
// mislabelled item in the study. Admin can override any of them afterwards.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
}
const URL = env.SUPABASE_URL_V2, KEY = env.SUPABASE_SECRET_KEY_V2;
if (!URL || !KEY) { console.error('\n  SUPABASE_URL_V2 / SUPABASE_SECRET_KEY_V2 not set in .env\n'); process.exit(1); }
const FORCE = process.argv.includes('--force');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} — ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

/** Does the answer claim the task is done? Judged on how it opens. */
const ADMITS = /^(i could not|i was unable|i did not|i couldn't|the guide was unable|unable to)/;
const claimsCompletion = (answer) => !ADMITS.test(String(answer || '').trim().toLowerCase());

let list;
try {
  list = await api('pageguide_guide_v2_tasks?select=id,task_style,in_study,agent_completed,claims_completion&order=id');
} catch (e) {
  if (/claims_completion/.test(e.message)) {
    console.error('\n  The claims_completion column does not exist. Run sql/040_supabase_v2_faithfulness.sql first.\n');
    process.exit(1);
  }
  throw e;
}

let set = 0, kept = 0;
const tally = { correct: 0, incorrect: 0, honest: 0, unkeyed: 0 };
console.log('');
for (const row of list) {
  if (row.claims_completion !== null && !FORCE) {
    kept++;
  } else {
    // One row at a time: `arms` holds a screenshot per step, and asking for thirteen answers in one
    // query times the statement out.
    const one = await api(`pageguide_guide_v2_tasks?select=ans:arms->grounding->>answer&id=eq.${encodeURIComponent(row.id)}`);
    const answer = (Array.isArray(one) && one[0] && one[0].ans) || '';
    row.claims_completion = claimsCompletion(answer);
    await api(`pageguide_guide_v2_tasks?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ claims_completion: row.claims_completion }),
    });
    set++;
    console.log(`  ${row.id.padEnd(24)} claims=${String(row.claims_completion).padEnd(5)} « ${answer.slice(0, 58)}…`);
  }
  const s = row.agent_completed == null ? 'unkeyed'
    : row.claims_completion === false ? 'honest'
    : row.agent_completed ? 'correct' : 'incorrect';
  tally[s]++;
}

console.log(`\n${set} classified, ${kept} already set.\n`);
console.log(`  CORRECT   (faithful success)      ${tally.correct}`);
console.log(`  INCORRECT (false success)         ${tally.incorrect}`);
console.log(`  honest failure (excluded)         ${tally.honest}`);
console.log(`  not keyed                         ${tally.unkeyed}`);

for (const style of ['guide_text', 'guide_visual']) {
  const of = list.filter(r => r.task_style === style && r.claims_completion !== false && r.agent_completed != null);
  const c = of.filter(r => r.agent_completed).length;
  const i = of.length - c;
  const live = of.filter(r => r.in_study);
  console.log(`  ${style.padEnd(13)} usable ${of.length} (${c} correct, ${i} incorrect) · live ${live.length}`
    + (i === 0 ? '   ← no INCORRECT item: this group cannot test a false success' : ''));
}
