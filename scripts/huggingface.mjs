#!/usr/bin/env node
//
// Publish the exported dataset to a Hugging Face dataset repo.
// ===========================================================
//
//   node scripts/huggingface.mjs                    # push dataset/ to the default repo
//   node scripts/huggingface.mjs --repo user/name   # somewhere else
//   node scripts/huggingface.mjs --dir some/dir     # something else
//   node scripts/huggingface.mjs --dry-run          # list what would be sent, send nothing
//
// NO `huggingface_hub`, AND NO pip INSTALL. This repo has no dependency tree on purpose (see
// scripts/publish.mjs), and the upload is one authenticated HTTP call to the commit endpoint —
// a Python package to make it would be the largest thing in the project.
//
// IT PUSHES A DIRECTORY YOU CHOSE, NEVER `.`. The obvious version of this — upload_folder with
// folder_path="." — would walk this repo from its root and publish `.env` along with everything
// else, and `.env` holds the Supabase SECRET key and an OpenRouter key. Gitignoring a file keeps it
// out of git; it does nothing to stop an uploader that reads the working directory. So the default
// is `dataset/`, which is written by scripts/figures.mjs and contains only what belongs in public.
//
// THE TOKEN IS NEVER PRINTED, and is looked for in this order:
//
//   HF_TOKEN in the environment
//   HF_TOKEN in .env, beside SUPABASE_SECRET_KEY
//   ~/.cache/huggingface/token, where `huggingface-cli login` leaves it
//
// A write token is required; a read token fails at the commit with a 403.

import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return args[args.indexOf(hit) + 1] || fallback;
};

const REPO = argOf('repo', 'Thang203/user_study_result');
const DIR = join(ROOT, argOf('dir', 'dataset'));
const DRY_RUN = args.includes('--dry-run');
const BRANCH = argOf('branch', 'main');

/** The token, from the first place that has one. Returned, never logged. */
export async function findToken() {
  if (process.env.HF_TOKEN) return { token: process.env.HF_TOKEN.trim(), from: 'HF_TOKEN in the environment' };
  try {
    const env = await readFile(join(ROOT, '.env'), 'utf8');
    const m = env.match(/^\s*HF_TOKEN\s*=\s*(.+)$/m);
    if (m) return { token: m[1].replace(/^['"]|['"]$/g, '').trim(), from: '.env' };
  } catch (e) { /* no .env is fine */ }
  try {
    const cached = await readFile(join(homedir(), '.cache/huggingface/token'), 'utf8');
    if (cached.trim()) return { token: cached.trim(), from: '~/.cache/huggingface/token' };
  } catch (e) { /* not logged in */ }
  throw new Error('No Hugging Face token. Put HF_TOKEN=hf_… in .env, or run `huggingface-cli login`.');
}

/** Every file under a directory, relative-pathed, in a stable order. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push({ path: relative(base, full).split(sep).join('/'), full });
  }
  return out;
}

/**
 * One commit, as NDJSON: a header line, then a line per file.
 *
 * The whole upload is a single commit rather than a file at a time, so the repo never sits in a
 * state where the figures and the rows they were made from disagree — which is the version of this
 * that would quietly mislead somebody who cloned it mid-push.
 */
async function commit({ token, files, repo, branch }) {
  const header = {
    key: 'header',
    value: {
      summary: `Update study dataset (${files.length} file${files.length === 1 ? '' : 's'})`,
      description: 'Exported by scripts/figures.mjs on the dashboard\'s default task selection.',
    },
  };
  const lines = [JSON.stringify(header)];
  for (const file of files) {
    const content = await readFile(file.full);
    lines.push(JSON.stringify({
      key: 'file',
      value: { path: file.path, encoding: 'base64', content: content.toString('base64') },
    }));
  }

  const res = await fetch(
    `https://huggingface.co/api/datasets/${repo}/commit/${encodeURIComponent(branch)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
      body: lines.join('\n'),
    },
  );
  const body = await res.text();
  if (!res.ok) {
    // The token is in the request, never in the message: a failure here is often pasted into chat.
    throw new Error(`Hugging Face refused the commit (${res.status}). ${body.slice(0, 400)}`);
  }
  return body;
}

/**
 * Push one directory to one dataset repo, as a single commit.
 *
 * Exported so the row publisher can reuse it: two copies of an authenticated upload is two places
 * for a token to end up somewhere it should not.
 */
export async function uploadDirectory({ repo, dir, branch = 'main', dryRun = false, log = console.log }) {
  let files;
  try {
    await stat(dir);
    files = await walk(dir);
  } catch (e) {
    throw new Error(`Nothing to upload: ${dir} does not exist.`);
  }
  if (!files.length) throw new Error(`Nothing to upload: ${dir} is empty.`);

  const total = (await Promise.all(files.map(async f => (await stat(f.full)).size)))
    .reduce((a, b) => a + b, 0);
  log(`\n  ${repo}  ←  ${relative(ROOT, dir)}/  (${files.length} files, ${(total / 1024).toFixed(1)} KB)`);
  files.forEach(f => log(`    ${f.path}`));

  if (dryRun) {
    log('\n  --dry-run: nothing was sent.\n');
    return { repo, files: files.length, sent: false };
  }

  const { token, from } = await findToken();
  log(`\n  token read from ${from}`);
  await commit({ token, files, repo, branch });
  log(`  ✓ pushed → https://huggingface.co/datasets/${repo}\n`);
  return { repo, files: files.length, sent: true };
}

async function main() {
  await uploadDirectory({ repo: REPO, dir: DIR, branch: BRANCH, dryRun: DRY_RUN });
}

// Only when run directly: importing this file must not push anything.
if (process.argv[1] && process.argv[1].endsWith('huggingface.mjs')) {
  main().catch(e => {
    console.error(`\n  [huggingface] ${e.message}\n`);
    process.exit(1);
  });
}
