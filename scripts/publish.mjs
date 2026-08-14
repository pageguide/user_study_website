#!/usr/bin/env node
// Publish the study's stimuli to Supabase.
// =======================================
// WHY THIS EXISTS AT ALL. The stimulus tables are anon-READ only: the extension and the website both
// ship the anon key, so an anon write policy would let anyone holding either overwrite the study's
// material mid-run. Writing needs the secret/service_role key — and Supabase now refuses that key
// outright from any browser context:
//
//     401 "Forbidden use of secret API key in browser"
//
// A Chrome side panel is a browser. So the privileged half of the job lives here, in a terminal,
// where a privileged key is allowed to be. The key is read from .env and never leaves this process:
// the extension posts it a JSON bundle and gets back a report.
//
//   node scripts/publish.mjs --serve          listen for the extension's ⬆ Publish button
//   node scripts/publish.mjs stimuli.json     upload a bundle exported to a file
//
// .env (gitignored, alongside this repo's root):
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY=sb_secret_...

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8790);
const ADMIN_SAVE_TOKEN = process.env.PAGEGUIDE_ADMIN_SAVE_TOKEN || randomBytes(18).toString('base64url');

/**
 * Read .env by hand rather than pulling in dotenv.
 *
 * A publish helper with a dependency tree is a publish helper that stops working the day
 * node_modules is stale, and this file has to work months from now with nothing installed.
 */
function loadEnv() {
  const candidates = [join(ROOT, '.env'), join(ROOT, '..', 'pageguide', '.env')];
  const out = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      // Strip surrounding quotes, which people add and .env does not want.
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
    }
    if (out.SUPABASE_URL && out.SUPABASE_SECRET_KEY) return { env: out, file };
  }
  return { env: out, file: candidates.find(existsSync) || null };
}

/** What is wrong with the configuration, or null. Said plainly, because this is where people get stuck. */
function configProblem(env) {
  if (!env.SUPABASE_URL) return 'SUPABASE_URL is not set in .env';
  if (!env.SUPABASE_SECRET_KEY) return 'SUPABASE_SECRET_KEY is not set in .env';
  const key = env.SUPABASE_SECRET_KEY;
  if (key.startsWith('sb_publishable_')) {
    return 'SUPABASE_SECRET_KEY holds the PUBLISHABLE key (sb_publishable_…), which cannot write '
      + 'stimuli. Copy the secret key (sb_secret_…) from Project Settings → API.';
  }
  if (key.startsWith('eyJ')) {
    // A JWT, but WHICH one? The anon key is also a JWT beginning "eyJ", so accepting any of them
    // let the anon key through — and an anon key does not fail loudly here, it fails at the far end
    // as "42501 new row violates row-level security policy", once per row, with nothing pointing
    // back at the key. The role is right there in the payload; read it rather than guess.
    const role = _jwtRole(key);
    if (role && role !== 'service_role') {
      return `SUPABASE_SECRET_KEY holds a "${role}" JWT, not the service_role one. An anon key `
        + 'passes every check here and is then refused by RLS on every insert (42501). Copy the '
        + 'service_role key from Project Settings → API.';
    }
    return null;
  }
  if (!key.startsWith('sb_secret_')) {
    return 'SUPABASE_SECRET_KEY does not look like a Supabase secret key (expected sb_secret_… or a '
      + 'service_role JWT).';
  }
  return null;
}

/** The `role` claim of a JWT, or null if it cannot be read. Payload only — no verification. */
function _jwtRole(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const role = JSON.parse(json)?.role;
    return typeof role === 'string' ? role : null;
  } catch (e) {
    return null;
  }
}

/** Which column(s) make a row unique, per table — so re-publishing replaces rather than duplicates. */
const CONFLICT = {
  // Order matters: study_task_pages references study_tasks, so the tasks must exist first.
  study_guide_trajectories: 'id',
  study_tasks: 'id',
  study_task_pages: 'task_id',
  study_canned_responses: 'task_id,condition',
  study_ground_truth: 'task_id',
};

/**
 * Upsert one table's rows.
 *
 * One request per row, not one bulk insert: a bulk insert is rejected WHOLE, so a single malformed
 * trajectory would take the other fifteen with it and report nothing about which one was at fault.
 */
async function publishTable(env, table, rows) {
  const out = { table, ok: 0, failed: 0, firstError: null, failedIds: [] };
  if (!Array.isArray(rows) || !rows.length) return out;
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(CONFLICT[table] || 'id')}`;

  const post = (row) => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });

  for (const row of rows) {
    const id = row.task_id || row.id || '(unnamed)';
    try {
      let res = await post(row);
      // 52x is Cloudflare saying the database never answered — the project is down or saturated,
      // not the row's fault. Every remaining row would fail the same way, and each attempt is more
      // load on something already struggling, so the whole table is abandoned rather than retried.
      // A megabyte-scale snapshot insert on a small instance is quite capable of causing this.
      if (res.status >= 520 && res.status <= 530) {
        out.failed++;
        out.failedIds.push(id);
        out.firstError = `${res.status} the database did not respond — the project is down or `
          + 'overloaded. Stop publishing, let it recover, and check the project status in the '
          + 'Supabase dashboard before trying again.';
        return out;
      }
      // 57014 is Postgres cancelling on statement_timeout, and a page snapshot is megabytes — the
      // insert is genuinely slow, not wrong. Worth exactly one retry: it usually lands, and a
      // permanent failure fails the same way twice rather than being retried forever.
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (body.includes('57014')) {
          process.stdout.write(`  … ${id} timed out, retrying once\n`);
          res = await post(row);
        } else {
          out.failed++;
          out.failedIds.push(id);
          if (!out.firstError) out.firstError = `${res.status} ${body.slice(0, 300)}`;
          continue;
        }
      }
      if (res.ok) out.ok++;
      else {
        out.failed++;
        out.failedIds.push(id);
        if (!out.firstError) out.firstError = `${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`;
      }
    } catch (e) {
      out.failed++;
      out.failedIds.push(id);
      if (!out.firstError) out.firstError = e?.message || String(e);
    }
  }
  return out;
}

/** Translate a PostgREST failure into something that says what to do about it. */
function explain(error) {
  const t = String(error || '');
  if (t.includes('Forbidden use of secret API key')) {
    return 'Supabase refused the secret key because the request looked like it came from a browser. '
      + 'This script is meant to run in a terminal — do not paste the key into a page.';
  }
  if (t.includes('42501')) {
    return 'Postgres 42501: row-level security refused the write, so the key was treated as anon. '
      + 'The stimulus tables are anon-READ only by design. Check SUPABASE_SECRET_KEY holds the '
      + 'service_role / sb_secret_… key — note the ANON key is also a JWT starting "eyJ", so the '
      + 'two are easy to swap, and swapping them looks exactly like this.';
  }
  if (t.includes('PGRST205') || t.includes('Could not find the table')) {
    return 'That table does not exist yet — run supabase_schema.sql in the Supabase SQL editor.';
  }
  if (t.includes('PGRST204')) {
    return 'A column is missing — re-run supabase_schema.sql, which adds the newer ones.';
  }
  if (t.includes('57014')) {
    return 'Postgres cancelled the insert on statement_timeout. The row is almost certainly a large '
      + 'page snapshot. Re-capture it (images are downscaled now), or raise the timeout for the '
      + "upload role:  alter role service_role set statement_timeout = '120s';";
  }
  return t.slice(0, 300);
}

async function publishBundle(env, bundle) {
  const report = [];
  for (const table of Object.keys(CONFLICT)) {
    const rows = bundle?.[table];
    if (!Array.isArray(rows) || !rows.length) continue;
    report.push(await publishTable(env, table, rows));
  }
  return report;
}

async function applyReviewPatch(env, patchFile) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(resolve(patchFile), 'utf8'));
  } catch (e) {
    console.error(`✗ Could not read review patch: ${e?.message || e}`);
    process.exit(2);
  }
  const taskId = String(payload?.task_id || '').trim();
  const condition = String(payload?.condition || '').trim();
  const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : null;
  if (!taskId || !condition || !patch) {
    console.error('✗ Review patch must contain task_id, condition and patch.');
    process.exit(2);
  }
  const allowed = {};
  ['answer_raw', 'answer_display', 'citation_anchors', 'evidence'].forEach(k => {
    if (Object.prototype.hasOwnProperty.call(patch, k)) allowed[k] = patch[k];
  });
  if (!Object.keys(allowed).length) {
    console.error('✗ Review patch has no allowed fields.');
    process.exit(2);
  }

  const url = `${env.SUPABASE_URL}/rest/v1/study_canned_responses`
    + `?task_id=eq.${encodeURIComponent(taskId)}&condition=eq.${encodeURIComponent(condition)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(allowed),
  });
  if (!res.ok) {
    console.error(`✗ ${res.status} ${await res.text().catch(() => '')}`);
    process.exit(1);
  }
  console.log(`✓ Updated study_canned_responses for ${taskId} / ${condition}`);
}

function cleanReviewPatch(payload) {
  const taskId = String(payload?.task_id || '').trim();
  const condition = String(payload?.condition || '').trim();
  const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : null;
  if (!taskId || !condition || !patch) {
    return { error: 'task_id, condition and patch are required' };
  }
  const allowed = {};
  ['answer_raw', 'answer_display', 'citation_anchors', 'evidence'].forEach(k => {
    if (Object.prototype.hasOwnProperty.call(patch, k)) allowed[k] = patch[k];
  });
  if (!Object.keys(allowed).length) return { error: 'patch has no allowed fields' };
  return { taskId, condition, patch: allowed };
}

function tokenMatches(got) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(ADMIN_SAVE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function updateCannedResponse(env, payload) {
  const clean = cleanReviewPatch(payload);
  if (clean.error) return { status: 400, body: { error: clean.error } };
  const url = `${env.SUPABASE_URL}/rest/v1/study_canned_responses`
    + `?task_id=eq.${encodeURIComponent(clean.taskId)}&condition=eq.${encodeURIComponent(clean.condition)}`
    + '&select=task_id,condition';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(clean.patch),
  });
  if (!res.ok) {
    return { status: res.status, body: { error: await res.text().catch(() => '') } };
  }
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return { status: 404, body: { error: `No canned response matched ${clean.taskId} / ${clean.condition}` } };
  }
  return { status: 200, body: { ok: true, updated: rows[0] } };
}

/**
 * Save an edited trajectory, with the key that is allowed to.
 *
 * The site's editor cannot write this table — anon may read the stimuli and nothing else, on
 * purpose — so it hands the patch here. Only the columns the editor actually edits are accepted:
 * a request that could set any column would let the browser rewrite ids, conditions or capture
 * times through a loopback port.
 */
const TRAJECTORY_PATCH_COLUMNS = ['arms', 'ground_truth', 'in_study', 'goal', 'title', 'condition'];

async function updateTrajectory(env, payload) {
  const id = String(payload?.id || '').trim();
  if (!id) return { status: 400, body: { error: 'No trajectory id given.' } };
  const patch = {};
  TRAJECTORY_PATCH_COLUMNS.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(payload?.patch || {}, k)) patch[k] = payload.patch[k];
  });
  if (!Object.keys(patch).length) {
    return { status: 400, body: { error: 'Nothing to update.' } };
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/study_guide_trajectories`
    + `?id=eq.${encodeURIComponent(id)}&select=id,in_study`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    return { status: res.status, body: { error: await res.text().catch(() => '') } };
  }
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return { status: 404, body: { error: `No trajectory matched ${id}` } };
  }
  return { status: 200, body: { ok: true, updated: rows[0] } };
}

/**
 * Save an edited Find task, with the key that is allowed to.
 *
 * `id` is deliberately NOT patchable even though the editor shows it: it is the key every other
 * table points at — study_canned_responses, study_ground_truth, study_task_pages and every result
 * row already written — and renaming it here would silently orphan all four.
 *
 * `answer` and `distractors` ARE patchable, because fixing a wrong option is the main reason to open
 * this. The consequence belongs to whoever clicks Save: rows already collected were scored against
 * the old options, so a change after data collection makes past and future rows answer different
 * questions. The editor says so on screen next to those fields.
 */
const TASK_PATCH_COLUMNS = ['title', 'question', 'answer', 'distractors', 'url', 'type',
  'in_study', 'task_index'];

async function updateTask(env, payload) {
  const id = String(payload?.id || '').trim();
  if (!id) return { status: 400, body: { error: 'No task id given.' } };
  const patch = {};
  TASK_PATCH_COLUMNS.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(payload?.patch || {}, k)) patch[k] = payload.patch[k];
  });
  if (!Object.keys(patch).length) {
    return { status: 400, body: { error: 'Nothing to update.' } };
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/study_tasks`
    + `?id=eq.${encodeURIComponent(id)}&select=id,in_study`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    return { status: res.status, body: { error: await res.text().catch(() => '') } };
  }
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return { status: 404, body: { error: `No Find task matched ${id}` } };
  }
  return { status: 200, body: { ok: true, updated: rows[0] } };
}


/**
 * Run one of this repo's own scripts and report what it said.
 *
 * WHY THE DASHBOARD CANNOT DO EITHER OF THESE ITSELF. Publishing figures writes files, and a page
 * cannot write to the repo it was served from. Uploading to Hugging Face needs a write token, and a
 * token in a file served to participants is a published token. Both therefore go the same way every
 * other privileged action in this project goes: the browser asks this loopback helper, which holds
 * the credentials and is reachable from nothing but this machine.
 *
 * ONLY THE TWO SCRIPTS NAMED BELOW, with a fixed argument list. The endpoint takes a key, not a
 * command line — an endpoint that ran what it was handed would be a remote shell on a port with one
 * shared token in front of it.
 */
const ADMIN_TASKS = {
  // EVERY JOB TAKES THE SELECTION, none of them assume the committed defaults. A button that
  // published what the code says while the researcher was looking at something they had just tuned
  // is the one failure this whole path exists to avoid, and it would be invisible: the export would
  // be internally consistent and quietly about a different study.
  figures: {
    scripts: ['scripts/figures.mjs'],
    label: 'publish figures',
    takesSelection: true,
  },
  huggingface: {
    // Rebuilt before it is sent. Uploading whatever happened to be on disk would publish the last
    // person's selection the moment anyone tuned a card without pressing the other button first.
    scripts: ['scripts/figures.mjs', 'scripts/huggingface.mjs'],
    label: 'rebuild and upload the figures dataset',
    takesSelection: true,
    selectionFor: 'scripts/figures.mjs',
  },
  'publish-rows': {
    scripts: ['scripts/publish_rows.mjs'],
    label: 'publish rows to Hugging Face',
    takesSelection: true,
  },
};

/**
 * A repo id, or nothing. `owner/name`, and nothing else.
 *
 * The value arrives from a page, so it is checked rather than trusted: it ends up in a URL path,
 * and a string with a `..` or a slash too many in it would address something other than the dataset
 * it claims to.
 */
function cleanRepo(value) {
  const repo = String(value || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

/**
 * The dashboard's live task selection, reduced to what it is allowed to be.
 *
 * `{ facet: [task id, …] }` and nothing else — keys must be known facets, values arrays of plain
 * ids. This is the one place a page's own state reaches a process running with credentials, so it
 * is rebuilt here from scratch rather than passed through: whatever shape arrives, what leaves is
 * this shape or an error.
 */
const FACET_KEYS = ['find_text', 'find_visual', 'guide_text', 'guide_visual'];

function cleanSelection(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'selection must be an object' };
  const out = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!FACET_KEYS.includes(key)) return { error: `unknown facet "${key}"` };
    if (!Array.isArray(ids)) return { error: `selection.${key} must be an array` };
    if (ids.length > 500) return { error: `selection.${key} is too long` };
    const clean = ids.map(id => String(id)).filter(id => /^[\w.-]{1,64}$/.test(id));
    if (clean.length !== ids.length) return { error: `selection.${key} holds an unusable task id` };
    out[key] = clean;
  }
  return { selection: out };
}

async function runAdminTask(name, payload = {}) {
  const task = ADMIN_TASKS[name];
  if (!task) return { status: 400, body: { error: `Unknown task "${name}".` } };

  let selectionFile = null;
  const extra = [];
  if (task.takesSelection) {
    const repo = payload.repo === undefined ? null : cleanRepo(payload.repo);
    if (payload.repo !== undefined && !repo) {
      return { status: 400, body: { error: 'repo must look like "owner/name".' } };
    }
    if (repo) extra.push({ flag: `--repo=${repo}`, only: null });

    const cleaned = cleanSelection(payload.selection);
    if (cleaned?.error) return { status: 400, body: { error: cleaned.error } };
    if (cleaned?.selection) {
      // Handed over as a file rather than on the command line: a task list is long enough to hit
      // argument limits, and a file cannot be misread as another flag.
      selectionFile = join(tmpdir(), `pageguide-selection-${randomBytes(6).toString('hex')}.json`);
      await writeFile(selectionFile, JSON.stringify(cleaned.selection));
      extra.push({ flag: `--selection=${selectionFile}`, only: task.selectionFor || null });
    }
  }

  // The scripts run in order and the chain stops at the first failure: a dataset that failed to
  // build must not then be uploaded, which would push the previous run's files under a summary
  // claiming they are this one's.
  return (async () => {
    let output = '';
    for (const script of task.scripts) {
      const args = extra.filter(e => !e.only || e.only === script).map(e => e.flag);
      const out = await runScript(script, args);
      output += out.output;
      if (out.code !== 0) {
        return { status: 500, body: { error: output.trim() || `${task.label} failed in ${script}.` } };
      }
    }
    return { status: 200, body: { ok: true, task: task.label, output: output.trim() } };
  })().finally(() => {
    if (selectionFile) rm(selectionFile, { force: true }).catch(() => {});
  });
}

function runScript(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    child.on('error', e => resolve({ code: 1, output: `${out}\n${e.message}` }));
    child.on('close', code => resolve({ code, output: out }));
  });
}

// ── The analysis endpoint ────────────────────────────────────────────────────────────────────────
// WHY THIS LIVES HERE AND NOT IN THE BROWSER. An LLM key is a spending credential. app/config.js is
// served to every participant, so anything in it is public — the same reason the Supabase secret key
// never leaves this process. The dashboard therefore asks this loopback helper, which holds the key
// and never returns it.
//
// WHAT IT SENDS. Aggregates only, by default: per-facet means and counts that the dashboard has
// already computed and drawn. No participant ids, no session ids, no raw rows. The participants'
// free-text notes are the one thing that could carry something personal, so they are sent only when
// the researcher ticks the box — and the request says outright that it is doing so.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// OpenRouter has no bare `google/gemini-3-flash`; the Gemini 3 Flash listing is the `-preview` id.
// Override with OPENROUTER_MODEL for any other id from https://openrouter.ai/models.
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

const ANALYSIS_SYSTEM = [
  'You are a research assistant analysing a within-subjects HCI study.',
  '',
  'The study asks whether GROUNDING — showing a participant the evidence behind a web agent\'s',
  'answer — makes it faster and more accurate to verify that answer. Every participant sees eight',
  'tasks: four grounded, four non-grounded, spread over four facets (Find/Guide × Text/Visual).',
  'Find tasks ask whether an answer to a question about a page is right, and where the evidence for',
  'it is. Guide tasks ask whether an agent completed a navigation task, and at which step it went',
  'wrong.',
  '',
  'You are given the aggregated results, one cell per facet and condition. Every metric reads',
  'non-grounded → grounded.',
  '',
  'Answer the four research questions, in this order, with a heading for each:',
  '1. Find × Text — does grounding make verifying an on-page answer faster?',
  '2. Find × Visual — the same, when the answer needs the page\'s visuals.',
  '3. Guide × Visual — how does visual evidence support checking a run step by step?',
  '4. Guide × Text — how does textual evidence support it?',
  '',
  'Rules you must follow:',
  '- Lead each answer with the finding in one sentence, then the numbers that support it.',
  '- Find questions lead on time-to-locate, with accuracy as the guardrail; Guide questions lead on',
  '  error-type and step F1, with time and accuracy as guardrails. A win on one number while',
  '  another moves against it is not a win — say so.',
  '- n is small. Say "directional" or "too early to call" where it is, and never present a',
  '  difference from a handful of rows as an established effect. Do not compute p-values.',
  '- Only use the numbers you are given. If a cell is missing or null, say it is not measured yet',
  '  rather than inferring it.',
  '- Finish with two or three sentences on what would most change the picture — which cell needs',
  '  more rows, which measure looks unreliable.',
  'Write plain prose in Markdown. No preamble about what you are about to do.',
].join('\n');

function analysisProblem(env) {
  if (!env.OPENROUTER_API_KEY) {
    return 'OPENROUTER_API_KEY is not set in .env — add it and restart the helper.';
  }
  return null;
}

async function runAnalysis(env, payload) {
  const problem = analysisProblem(env);
  if (problem) return { status: 400, body: { error: problem } };

  const model = String(payload?.model || env.OPENROUTER_MODEL || DEFAULT_MODEL).trim();
  const summary = payload?.summary;
  if (!summary || typeof summary !== 'object') {
    return { status: 400, body: { error: 'summary (the aggregated results) is required' } };
  }
  const notes = Array.isArray(payload?.notes) ? payload.notes.slice(0, 200) : [];

  const user = [
    'Aggregated results:',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    notes.length
      ? `\nThe participants' free-text notes (${notes.length}), for what they say about WHY:\n`
        + notes.map(n => `- ${String(n).slice(0, 600)}`).join('\n')
      : '\nNo participant notes were included in this request.',
  ].join('\n');

  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        // OpenRouter attributes the call to the app; both headers are optional and neither
        // identifies a participant.
        'HTTP-Referer': 'https://github.com/pageguide/user_study_website',
        'X-Title': 'PageGuide user study dashboard',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    return { status: 502, body: { error: `Could not reach OpenRouter: ${e?.message || e}` } };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message || body?.error || `HTTP ${res.status}`;
    return { status: res.status, body: { error: `OpenRouter refused the request: ${detail}` } };
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) {
    return { status: 502, body: { error: 'OpenRouter returned no analysis text.' } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      model: body?.model || model,
      analysis: text,
      usage: body?.usage || null,
      notes_included: notes.length,
      generated_at: new Date().toISOString(),
    },
  };
}

function summarize(report) {
  if (!report.length) return 'nothing to publish — the bundle was empty';
  return report
    .map(r => `${r.table}: ${r.ok}`
      + (r.failed ? ` (${r.failed} failed${r.failedIds?.length ? ': ' + r.failedIds.join(', ') : ''})` : ''))
    .join(' · ');
}

// ── Entry points ──

const { env, file } = loadEnv();
const problem = configProblem(env);
const args = process.argv.slice(2);

if (problem) {
  console.error(`✗ ${problem}`);
  console.error(`  Looked for .env at: ${file || `${ROOT}/.env`}`);
  console.error('  Expected:\n    SUPABASE_URL=https://xxxx.supabase.co\n    SUPABASE_SECRET_KEY=sb_secret_...');
  process.exit(2);
}

if (args[0] === '--apply-review-patch') {
  if (!args[1]) {
    console.error('✗ Usage: node scripts/publish.mjs --apply-review-patch review_patch.json');
    process.exit(2);
  }
  await applyReviewPatch(env, args[1]);
  process.exit(0);
}

/**
 * Count the pictures in every task's material and store the number.
 *
 * Runs here rather than in the dashboard because the material is huge and the answer never changes:
 * a Find page is megabytes of saved HTML, a guide run is a dozen base64 screenshots, and the count
 * is a property of the task, not of any participant. Counting it once turns a 50 MB question into
 * two integers per row.
 *
 * An <img> with no src, or one sized 1×1, is not counted — a tracking pixel is not something a
 * participant can look at, and including it would make a page look richer than it reads.
 */
async function countImages(env) {
  const H = {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  };
  const get = async (p) => (await fetch(`${env.SUPABASE_URL}/rest/v1/${p}`, { headers: H })).json();
  const patch = async (p, body) => fetch(`${env.SUPABASE_URL}/rest/v1/${p}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });

  const pages = await get('study_task_pages?select=task_id');
  for (const { task_id: id } of pages) {
    const [row] = await get(`study_task_pages?select=html&task_id=eq.${encodeURIComponent(id)}`);
    const tags = String(row?.html || '').match(/<img\b[^>]*>/gi) || [];
    const real = tags.filter(t => /\bsrc\s*=\s*["']?\S/i.test(t) && !/\b(width|height)\s*=\s*["']?[01]["']?[\s>]/i.test(t));
    await patch(`study_task_pages?task_id=eq.${encodeURIComponent(id)}`, { image_count: real.length });
    console.log(`  ${id}: ${real.length} images`);
  }

  const trajectories = await get('study_guide_trajectories?select=id');
  for (const { id } of trajectories) {
    const [row] = await get(`study_guide_trajectories?select=arms&id=eq.${encodeURIComponent(id)}`);
    const g = row?.arms?.grounding || {};
    const steps = (g.steps || []).filter(s => s?.screenshot).length;
    const evidence = (g.answer_evidence || []).filter(e => e?.screenshot).length;
    await patch(`study_guide_trajectories?id=eq.${encodeURIComponent(id)}`, { image_count: steps + evidence });
    console.log(`  ${id}: ${steps} step shots + ${evidence} evidence = ${steps + evidence}`);
  }
  console.log('✓ image counts written');
}

if (args[0] === '--count-images') {
  await countImages(env);
  process.exit(0);
}

if (args[0] === '--serve') {
  // The extension cannot hold the secret key, so it posts the bundle here instead. Bound to
  // 127.0.0.1: this endpoint uploads with a privileged key and has no business being reachable from
  // anywhere but this machine.
  const server = createServer((req, res) => {
    const cors = {
      // The caller is a chrome-extension:// page, whose origin is not knowable ahead of time. The
      // endpoint is loopback-only and lives for the length of one publishing session, so it is
      // reachable by this machine's browser and nothing else.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-PageGuide-Admin-Token',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'POST' && req.url.startsWith('/admin/analysis')) {
      if (!tokenMatches(req.headers['x-pageguide-admin-token'])) {
        res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad or missing admin save token.' }));
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'The request was not valid JSON.' }));
          return;
        }
        console.log(`→ analysis requested (${payload?.notes?.length || 0} notes included)`);
        const out = await runAnalysis(env, payload);
        if (out.status !== 200) console.error(`  ✗ ${out.body.error}`);
        res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/admin/trajectory')) {
      if (!tokenMatches(req.headers['x-pageguide-admin-token'])) {
        res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad or missing admin save token.' }));
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'The request was not valid JSON.' }));
          return;
        }
        const steps = payload?.patch?.arms?.grounding?.steps?.length;
        console.log(`→ trajectory ${payload?.id} (${steps == null ? '?' : steps} steps)`);
        const out = await updateTrajectory(env, payload);
        if (out.status !== 200) console.error(`  ✗ ${out.body.error}`);
        res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/admin/run/')) {
      if (!tokenMatches(req.headers['x-pageguide-admin-token'])) {
        res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad or missing admin save token.' }));
        return;
      }
      const name = req.url.split('/admin/run/')[1].split('?')[0];
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        let payload = {};
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw) {
          try {
            payload = JSON.parse(raw);
          } catch (e) {
            res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'The request was not valid JSON.' }));
            return;
          }
        }
        console.log(`→ ${ADMIN_TASKS[name]?.label || name}`);
        const out = await runAdminTask(name, payload);
        if (out.status !== 200) console.error(`  ✗ ${out.body.error}`);
        res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/admin/task')) {
      if (!tokenMatches(req.headers['x-pageguide-admin-token'])) {
        res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad or missing admin save token.' }));
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'The request was not valid JSON.' }));
          return;
        }
        const keys = Object.keys(payload?.patch || {}).join(', ');
        console.log(`→ find task ${payload?.id} (${keys || 'nothing'})`);
        const out = await updateTask(env, payload);
        if (out.status !== 200) console.error(`  ✗ ${out.body.error}`);
        res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/admin/canned-response')) {
      if (!tokenMatches(req.headers['x-pageguide-admin-token'])) {
        res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad or missing admin save token.' }));
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'The request was not valid JSON.' }));
          return;
        }
        const out = await updateCannedResponse(env, payload);
        res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/publish')) {
      res.writeHead(404, cors); res.end('not found'); return;
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let bundle;
      try {
        bundle = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'The bundle was not valid JSON.' }));
        return;
      }
      const report = await publishBundle(env, bundle);
      const failure = report.find(r => r.firstError);
      console.log(`→ ${summarize(report)}`);
      if (failure) console.error(`  ✗ ${explain(failure.firstError)}`);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        summary: summarize(report),
        report,
        help: failure ? explain(failure.firstError) : null,
      }));
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`✓ Publish helper listening on http://127.0.0.1:${PORT}`);
    console.log(`  Key loaded from ${file}. It stays in this process — nothing is pasted anywhere.`);
    console.log(`  Admin save token: ${ADMIN_SAVE_TOKEN}`);
    console.log(`  Analysis: ${env.OPENROUTER_API_KEY
      ? `ready (model ${env.OPENROUTER_MODEL || DEFAULT_MODEL})`
      : 'OFF — set OPENROUTER_API_KEY in .env to enable the dashboard\'s Rerun analysis button'}`);
    console.log('  Now press ⬆ Publish to web in the extension\'s recorder. Ctrl-C when you are done.');
  });
} else if (args[0]) {
  const path = resolve(args[0]);
  if (!existsSync(path)) { console.error(`✗ No such bundle: ${path}`); process.exit(2); }
  const report = await publishBundle(env, JSON.parse(readFileSync(path, 'utf8')));
  const failure = report.find(r => r.firstError);
  console.log(summarize(report));
  if (failure) { console.error(`✗ ${explain(failure.firstError)}`); process.exit(1); }
  console.log('✓ Published.');
} else {
  console.log('Usage:\n  node scripts/publish.mjs --serve        listen for the extension\'s Publish button'
    + '\n  node scripts/publish.mjs stimuli.json    upload an exported bundle');
  process.exit(1);
}
