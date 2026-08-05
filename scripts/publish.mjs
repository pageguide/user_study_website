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

import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8790);

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
  if (!key.startsWith('sb_secret_') && !key.startsWith('eyJ')) {
    return 'SUPABASE_SECRET_KEY does not look like a Supabase secret key (expected sb_secret_… or a '
      + 'service_role JWT).';
  }
  return null;
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
      + 'Check SUPABASE_SECRET_KEY holds the sb_secret_… key, not the publishable one.';
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
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
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
