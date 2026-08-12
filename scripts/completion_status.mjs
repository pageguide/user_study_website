#!/usr/bin/env node
//
// How many participants have actually finished, pulled live from Supabase.
//
//   node scripts/completion_status.mjs            # once
//   node scripts/completion_status.mjs --watch    # re-pull every 60s until Ctrl-C
//   node scripts/completion_status.mjs --watch=15 # ...every 15s
//   node scripts/completion_status.mjs --json     # machine-readable, for piping
//
// COUNTS SESSIONS, NOT participant_id. Nearly every participant leaves the id box blank and is
// written as 'anon' (app/welcome.js), so participant_id cannot tell two people apart; session_id
// can. A session is one click of Start.
//
// A session row is created the instant Start is pressed, before any task is seen, so the row count
// of study_sessions is a count of arrivals and always runs far ahead of the count of people who
// answered anything. That gap is the drop-off, not lost data.
//
// Reads the anon key out of app/config.js — the same key the site itself uses, which can read the
// results table but nothing that is not already served to participants.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_PER_SESSION = 8;

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const watchArg = args.find(a => a === '--watch' || a.startsWith('--watch='));
const watchSeconds = watchArg ? Math.max(5, Number(watchArg.split('=')[1]) || 60) : 0;

async function config() {
  const src = await readFile(join(ROOT, 'app/config.js'), 'utf8');
  const url = src.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
  const key = src.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error('Could not read SUPABASE_URL / SUPABASE_ANON_KEY from app/config.js');
  return { url, key };
}

async function fetchAll({ url, key }, path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * The design a session ran under, from its condition_order label.
 *
 * `rr_inter` interleaves the arms task by task; `rr_mixed` is the older design that ran all four
 * grounded tasks first. They are reported on separate lines and never summed into one headline,
 * because pooling them puts the order confound the interleave removed back into the numbers.
 */
function familyOf(label) {
  const text = String(label || '');
  if (text.startsWith('rr_inter')) return 'rr_inter';
  if (text.startsWith('rr_mixed')) return 'rr_mixed';
  return 'other';
}

function orderOf(label) {
  const text = String(label || '');
  if (text.endsWith('_ngfirst')) return 'ngfirst';
  if (text.endsWith('_gfirst')) return 'gfirst';
  return 'n/a';
}

async function collect() {
  const cfg = await config();
  const [results, sessions] = await Promise.all([
    fetchAll(cfg, 'study_task_results_v2?select=session_id,participant_id&limit=50000'),
    fetchAll(cfg, 'study_sessions?select=id,condition_order,created_at&limit=50000'),
  ]);

  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const rowsPerSession = new Map();
  for (const row of results) {
    rowsPerSession.set(row.session_id, (rowsPerSession.get(row.session_id) || 0) + 1);
  }

  const buckets = new Map();
  let complete = 0;
  let started = 0;
  const partials = [];
  for (const [sessionId, n] of rowsPerSession) {
    const label = sessionById.get(sessionId)?.condition_order || '(session not visible)';
    const key = `${familyOf(label)} / ${orderOf(label)}`;
    const bucket = buckets.get(key) || { started: 0, complete: 0 };
    bucket.started++;
    started++;
    if (n >= TASKS_PER_SESSION) { bucket.complete++; complete++; }
    else partials.push({ session_id: sessionId, rows: n, condition_order: label });
    buckets.set(key, bucket);
  }

  return {
    checked_at: new Date().toISOString(),
    finished: complete,
    finished_interleaved: [...buckets].filter(([k]) => k.startsWith('rr_inter'))
      .reduce((sum, [, b]) => sum + b.complete, 0),
    answered_something: started,
    result_rows: results.length,
    session_rows_visible: sessions.length,
    by_condition: Object.fromEntries([...buckets].sort()),
    partial_sessions: partials.sort((a, b) => a.session_id - b.session_id),
  };
}

function render(snap) {
  const lines = [];
  lines.push(`\n  Finished all ${TASKS_PER_SESSION} tasks:  ${snap.finished}`
    + `   (interleaved design only: ${snap.finished_interleaved})`);
  lines.push(`  Answered at least one:  ${snap.answered_something}`);
  lines.push(`  Result rows:            ${snap.result_rows}`);
  lines.push('');
  const width = Math.max(...Object.keys(snap.by_condition).map(k => k.length), 12);
  lines.push(`  ${'condition'.padEnd(width)}   started  finished`);
  for (const [key, b] of Object.entries(snap.by_condition)) {
    lines.push(`  ${key.padEnd(width)}   ${String(b.started).padStart(7)}  ${String(b.complete).padStart(8)}`);
  }
  if (snap.partial_sessions.length) {
    lines.push('');
    lines.push(`  ${snap.partial_sessions.length} partial: `
      + snap.partial_sessions.map(p => `#${p.session_id} (${p.rows})`).join(', '));
  }
  lines.push(`\n  checked ${new Date(snap.checked_at).toLocaleTimeString()}`);
  return lines.join('\n');
}

async function tick() {
  const snap = await collect();
  if (jsonOnly) console.log(JSON.stringify(snap, null, 2));
  else console.log(render(snap));
  return snap;
}

if (watchSeconds) {
  // Each pass reprints in full rather than clearing the screen, so a run left open overnight is a
  // readable log of when people finished instead of a single number with no history.
  for (;;) {
    try { await tick(); } catch (e) { console.error(`  [error] ${e.message}`); }
    await new Promise(r => setTimeout(r, watchSeconds * 1000));
  }
} else {
  await tick();
}
