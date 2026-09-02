#!/usr/bin/env node
// Replace the live Business / Movies / Technology Guide run with a Business / Movies copy.
// =======================================================================================
//
// The original trajectory is retained as an archive. The copy removes the Technology leg and all
// metadata that points at it, then takes the original's study slot. Running without --apply is a
// read-only dry run; the privileged write is deliberately explicit.
//
//   node scripts/prune_business_movies_guide.mjs
//   node scripts/prune_business_movies_guide.mjs --apply
//
// .env (repo root) needs SUPABASE_URL_V2 and SUPABASE_SECRET_KEY_V2.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ID = 'gv2-ed35d549-ct71ub';
const COPY_ID = 'gv2-ed35d549-ct71ub-bm';
const TASK_INDEX = 12;
const TITLE = 'Search the Business and Movies spaces. For each space, find the 3 posts with the highest engagement and summarize them.';
const STEP_7 = 'Save the post about Johnny Depp as the third high-engagement Movies post.';
const STEP_8 = 'Summarize the top 3 posts for Business, Movies, and finish the task.';
const TRAIL_SUMMARY = 'I have completed the task. I identified the top engagement posts across two spaces, including Elon Musk\'s wealth in Business and Johnny Depp\'s career in Movies.';
const APPLY = process.argv.includes('--apply');

function loadEnv() {
  const file = join(ROOT, '.env');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}

function configProblem(env) {
  if (!env.SUPABASE_URL_V2) return 'SUPABASE_URL_V2 is not set in .env.';
  if (!env.SUPABASE_SECRET_KEY_V2) return 'SUPABASE_SECRET_KEY_V2 is not set in .env.';
  if (env.SUPABASE_SECRET_KEY_V2.startsWith('sb_publishable_')) {
    return 'SUPABASE_SECRET_KEY_V2 contains the publishable key; this maintenance task needs the secret key.';
  }
  return null;
}

async function rest(config, path, init = {}) {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pruneAnswer(answer) {
  return String(answer || '')
    .replace(/\n\s*\*\*Technology:\*\*[\s\S]*$/i, '')
    .trim();
}

function isTechnologyEvidence(item) {
  const key = String(item?.key || '');
  const text = [item?.key, item?.note, item?.phrase, item?.source_text].filter(Boolean).join(' ');
  return /^tech(?:nology)?_/i.test(key)
    || /\bTechnology\b|WhatsApp|artificial intelligence|spying on|David Crockett|Kirti Singh|Muriel/i.test(text);
}

function pruneArm(sourceArm) {
  if (!sourceArm) return sourceArm;
  const arm = clone(sourceArm);
  const sourceSteps = Array.isArray(arm.steps) ? arm.steps : [];
  const firstSeven = sourceSteps.filter(step => Number(step?.n) >= 1 && Number(step?.n) <= 7);
  const oldFinish = sourceSteps.find(step => Number(step?.n) === 14);
  const moviesState = firstSeven.find(step => Number(step?.n) === 7);
  if (firstSeven.length !== 7 || !oldFinish || !moviesState) {
    throw new Error('The source trajectory no longer has the expected steps 1–7 and 14; refusing to guess at a changed recording.');
  }

  const stepSeven = { ...clone(moviesState), n: 7, instruction: STEP_7, target_text: '' };
  const finish = {
    ...clone(oldFinish),
    n: 8,
    action: 'finish',
    instruction: STEP_8,
    target_text: '',
    url: moviesState.url || '',
    screenshot: moviesState.screenshot ?? null,
  };
  arm.steps = firstSeven.slice(0, 6).map((step, index) => ({ ...clone(step), n: index + 1 }))
    .concat(stepSeven, finish);

  arm.answer = pruneAnswer(arm.answer);
  if (Array.isArray(arm.answer_evidence)) {
    arm.answer_evidence = arm.answer_evidence.filter(item => !isTechnologyEvidence(item));
  }
  if (Array.isArray(arm.answer_segments)) {
    arm.answer_segments = arm.answer_segments.filter(item => !isTechnologyEvidence(item));
  }

  if (arm.trail && typeof arm.trail === 'object') {
    arm.trail.summary = TRAIL_SUMMARY;
    arm.trail.milestones = (Array.isArray(arm.trail.milestones) ? arm.trail.milestones : [])
      .filter(milestone => Number(milestone?.step) <= 7)
      .map(milestone => Number(milestone?.step) === 7
        ? { ...milestone, text: 'Captured the Johnny Depp post.' }
        : milestone);
  }

  arm.final_state = {
    ...(arm.final_state && typeof arm.final_state === 'object' ? arm.final_state : {}),
    url: moviesState.url || '',
    screenshot: moviesState.screenshot ?? null,
  };
  return arm;
}

function pruneGroundTruth(source) {
  const groundTruth = clone(source) || {};
  const keptSteps = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [14, 8]]);
  if (Array.isArray(groundTruth.errors)) {
    groundTruth.errors = groundTruth.errors
      .map(error => ({
        ...error,
        steps: [...new Set((Array.isArray(error?.steps) ? error.steps : [])
          .map(step => keptSteps.get(Number(step)))
          .filter(Number.isFinite))],
      }))
      .filter(error => error.steps.length);
    groundTruth.no_error = groundTruth.errors.length === 0;
  }
  return groundTruth;
}

function copyIfPresent(target, source, key) {
  if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = clone(source[key]);
}

function buildCopy(source) {
  const record = {
    id: COPY_ID,
    source_trajectory_id: SOURCE_ID,
    title: TITLE,
    goal: TITLE,
    step_count: 8,
    task_style: 'guide_text',
    agent_completed: false,
    claims_completion: true,
    in_study: false,
    task_index: TASK_INDEX,
    // These legacy V2 fields are unused by the Guide player. Keeping them empty avoids preserving
    // stale Technology prose outside the authoritative `arms` trajectory.
    trajectory: [],
    answer_variants: {},
    arms: {},
    guide_ground_truth: pruneGroundTruth(source.guide_ground_truth),
  };

  ['source_task_id', 'url', 'correctness_mode', 'trajectory_bytes'].forEach(key => {
    copyIfPresent(record, source, key);
  });
  for (const [name, arm] of Object.entries(source.arms || {})) {
    record.arms[name] = pruneArm(arm);
  }
  return record;
}

function searchableStrings(value, path = '') {
  if (typeof value === 'string') return /screenshot$/i.test(path) ? [] : [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => searchableStrings(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => searchableStrings(item, path ? `${path}.${key}` : key));
}

function validate(record, expectedInStudy = false) {
  const problems = [];
  const arm = record.arms?.grounding;
  const steps = Array.isArray(arm?.steps) ? arm.steps : [];
  const numbers = steps.map(step => Number(step?.n));
  const errors = Array.isArray(record.guide_ground_truth?.errors) ? record.guide_ground_truth.errors : [];
  const forbidden = /\bTechnology\b|tech_post_|WhatsApp|artificial intelligence|spying on|David Crockett|Kirti Singh|Muriel/i;
  const leftovers = searchableStrings(record).filter(([, text]) => forbidden.test(text));

  if (record.id !== COPY_ID) problems.push(`id is ${record.id}, expected ${COPY_ID}`);
  if (record.title !== TITLE || record.goal !== TITLE) problems.push('title/goal do not match the Business and Movies task');
  if (record.step_count !== 8 || steps.length !== 8) problems.push('trajectory does not contain exactly 8 steps');
  if (numbers.join(',') !== '1,2,3,4,5,6,7,8') problems.push(`step numbers are ${numbers.join(',')}`);
  if (steps[6]?.instruction !== STEP_7 || steps[6]?.target_text) problems.push('step 7 was not pruned correctly');
  if (steps[7]?.instruction !== STEP_8 || steps[7]?.action !== 'finish') problems.push('step 8 is not the requested finish step');
  if (steps[7]?.url !== steps[6]?.url || steps[7]?.screenshot !== steps[6]?.screenshot) {
    problems.push('finish state does not use the final Movies state');
  }
  if (arm?.final_state?.url !== steps[6]?.url || arm?.final_state?.screenshot !== steps[6]?.screenshot) {
    problems.push('final_state does not use the final Movies state');
  }
  if (record.agent_completed !== false || record.claims_completion !== true) {
    problems.push('false-success classification changed');
  }
  if (record.task_style !== 'guide_text' || Number(record.task_index) !== TASK_INDEX) {
    problems.push('study style/order changed');
  }
  if (record.in_study !== expectedInStudy) problems.push(`in_study is ${record.in_study}, expected ${expectedInStudy}`);
  if (errors.some(error => (error.steps || []).some(step => !numbers.includes(Number(step))))) {
    problems.push('ground truth refers to a removed step');
  }
  if (leftovers.length) problems.push(`Technology material remains at ${leftovers.map(([path]) => path).join(', ')}`);

  const markers = [...String(arm?.answer || '').matchAll(/\[ev:\s*([^\]]+)\]/gi)].map(match => match[1].trim());
  const evidenceKeys = new Set((arm?.answer_evidence || []).map(item => String(item?.key || '').trim()));
  const missingEvidence = markers.filter(key => !evidenceKeys.has(key));
  if (missingEvidence.length) problems.push(`answer markers lack evidence: ${missingEvidence.join(', ')}`);
  if (problems.length) throw new Error(`Validation failed:\n  - ${problems.join('\n  - ')}`);
  return {
    id: record.id,
    title: record.title,
    steps: numbers,
    answer_sections: [...String(arm.answer || '').matchAll(/^\*\*([^*]+):\*\*/gm)].map(match => match[1]),
    evidence_keys: [...evidenceKeys],
    milestones: (arm.trail?.milestones || []).map(milestone => milestone.step),
    ground_truth_errors: errors,
    final_url: arm.final_state?.url || '',
    in_study: record.in_study,
  };
}

const env = loadEnv();
const problem = configProblem(env);
if (problem) {
  console.error(`\n  ${problem}\n`);
  process.exit(1);
}
const config = { url: env.SUPABASE_URL_V2, key: env.SUPABASE_SECRET_KEY_V2 };

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}  ${SOURCE_ID} -> ${COPY_ID}`);
const rows = await rest(config, `pageguide_guide_v2_tasks?select=*&id=eq.${encodeURIComponent(SOURCE_ID)}&limit=1`);
const source = Array.isArray(rows) ? rows[0] : null;
if (!source) throw new Error(`No Guide task found for ${SOURCE_ID}.`);

const duplicate = buildCopy(source);
console.log(JSON.stringify(validate(duplicate, false), null, 2));

if (!APPLY) {
  const existingRows = await rest(config,
    `pageguide_guide_v2_tasks?select=id,in_study,task_index,step_count&id=eq.${encodeURIComponent(COPY_ID)}&limit=1`);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing) {
    console.log(`\nExisting duplicate: ${existing.id} · ${existing.step_count} steps · order ${existing.task_index}`
      + ` · ${existing.in_study ? 'in study' : 'held out'}. The stable id means --apply updates this row rather than creating another.`);
  }
  console.log(existing
    ? '\nDry run passed. Re-run with --apply only if the archived/live swap needs to be restored.'
    : '\nDry run passed. Re-run with --apply to create the duplicate and swap the live study row.');
  process.exit(0);
}

// Stage the new row held out. The original stays live until the complete copy has been written,
// fetched back, and validated against exactly what Supabase stored.
await rest(config, 'pageguide_guide_v2_tasks?on_conflict=id', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(duplicate),
});
const stagedRows = await rest(config,
  `pageguide_guide_v2_tasks?select=*&id=eq.${encodeURIComponent(COPY_ID)}&limit=1`);
const staged = Array.isArray(stagedRows) ? stagedRows[0] : null;
if (!staged) throw new Error('The duplicate was not readable after staging; the original remains live.');
validate(staged, false);

await rest(config, `pageguide_guide_v2_tasks?id=eq.${encodeURIComponent(SOURCE_ID)}`, {
  method: 'PATCH',
  headers: { Prefer: 'return=minimal' },
  body: JSON.stringify({ in_study: false }),
});
await rest(config, `pageguide_guide_v2_tasks?id=eq.${encodeURIComponent(COPY_ID)}`, {
  method: 'PATCH',
  headers: { Prefer: 'return=minimal' },
  body: JSON.stringify({ in_study: true }),
});

const finalRows = await rest(config,
  `pageguide_guide_v2_tasks?select=id,title,in_study,task_index,step_count&id=in.(${SOURCE_ID},${COPY_ID})&order=id`);
const archived = finalRows.find(row => row.id === SOURCE_ID);
const live = finalRows.find(row => row.id === COPY_ID);
if (!archived || archived.in_study !== false || !live || live.in_study !== true
    || Number(live.task_index) !== TASK_INDEX || Number(live.step_count) !== 8) {
  throw new Error(`Study swap verification failed: ${JSON.stringify(finalRows)}`);
}
console.log(`\nApplied successfully. ${SOURCE_ID} is archived; ${COPY_ID} is live at order ${TASK_INDEX}.`);
