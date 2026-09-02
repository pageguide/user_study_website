#!/usr/bin/env node
// Post a rescued result backup into Supabase.
// ==========================================
// When a result cannot be written, the study parks it in localStorage and the finish screen offers
// it as a download — so a session whose network or schema was broken is recoverable rather than
// lost. This is the other half of that: it takes the downloaded file and writes the rows.
//
//   node scripts/import_pending_results.mjs ~/Downloads/pageguide-find-v2-pending.json
//
// It accepts either shape the backup can take: the raw array the study stores, or an object with a
// `pending` / `results` / `rows` array inside it. Each entry may be a bare result row or the
// {saved_at, error, row} wrapper the study writes.
//
// A row is routed by its own columns — `claim_id` means Find, `task_id` means Guide — because the
// two live in different tables and a misrouted row inserts cleanly into the wrong one.
//
// Rows already present are reported and skipped, so re-running after a partial import is safe.
// Uses the V2 SECRET key from .env: the browser's anon role deliberately cannot read this table, so
// checking what is already there is not something the page could have done for itself.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const out = {};
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}

const env = loadEnv();
const URL_V2 = env.SUPABASE_URL_V2 || env.SUPABASE_URL_V;
const KEY_V2 = env.SUPABASE_SECRET_KEY_V2 || env.SUPABASE_SECRET_KEY_V;

const file = process.argv[2];
if (!file) {
  console.error('\n  usage: node scripts/import_pending_results.mjs <backup.json>\n');
  process.exit(1);
}
if (!existsSync(file)) { console.error(`\n  No such file: ${file}\n`); process.exit(1); }
if (!URL_V2 || !KEY_V2) {
  console.error('\n  SUPABASE_URL_V2 / SUPABASE_SECRET_KEY_V2 are not set in .env\n');
  process.exit(1);
}
if (KEY_V2.startsWith('sb_publishable_')) {
  console.error('\n  SUPABASE_SECRET_KEY_V2 holds the publishable key, which cannot read this table.\n');
  process.exit(1);
}

async function rest(path, init = {}) {
  const res = await fetch(`${URL_V2}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY_V2,
      Authorization: `Bearer ${KEY_V2}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} — ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const parsed = JSON.parse(readFileSync(file, 'utf8'));
const list = Array.isArray(parsed)
  ? parsed
  : (parsed.pending || parsed.results || parsed.rows || []);
if (!Array.isArray(list) || !list.length) {
  console.error('\n  No result rows found in that file.\n');
  process.exit(1);
}

// Unwrap {saved_at, error, row}, and drop anything that is not a result row.
const rows = list.map(item => (item && item.row ? item.row : item))
  .filter(row => row && typeof row === 'object' && row.result_key);

const find = rows.filter(row => row.claim_id);
const guide = rows.filter(row => !row.claim_id && row.task_id);
const unknown = rows.length - find.length - guide.length;

console.log(`\n${rows.length} row${rows.length === 1 ? '' : 's'} in the backup: `
  + `${find.length} Find, ${guide.length} Guide${unknown ? `, ${unknown} unrecognised (skipped)` : ''}\n`);

let written = 0;
let already = 0;
let failed = 0;

for (const [table, set] of [['pageguide_find_v2_results', find], ['pageguide_guide_v2_results', guide]]) {
  for (const row of set) {
    const key = encodeURIComponent(row.result_key);
    try {
      const existing = await rest(`${table}?select=result_key&result_key=eq.${key}&limit=1`);
      if (existing && existing.length) {
        already++;
        console.log(`  already there  ${row.result_key}`);
        continue;
      }
      await rest(table, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      written++;
      console.log(`  written        ${row.result_key}  (${row.participant_id})`);
    } catch (e) {
      failed++;
      console.error(`  FAILED         ${row.result_key} — ${e.message}`);
    }
  }
}

console.log(`\n${written} written, ${already} already present, ${failed} failed.`);
process.exit(failed ? 1 : 0);
