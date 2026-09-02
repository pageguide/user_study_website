#!/usr/bin/env node
/**
 * Publish the matplotlib figure code, with the data it plots, into its own repo.
 *
 * WHY THIS EXISTS. `figures_code/` in this repo is the source of truth for the plotting code, but
 * the code is only useful to someone holding the numbers it draws — and those numbers change every
 * time the dashboard's task selection changes. This script copies both in one gesture: the scripts
 * as they stand here, and the CSVs as they stand in `figures/` and `dataset/` right now.
 *
 * RUN scripts/figures.mjs FIRST if you want the current selection. The dashboard button does
 * exactly that: figures.mjs rebuilds the CSVs from the rows the cards are counting, and this then
 * ships them. Running this alone publishes whatever was last built, which is the honest behaviour
 * for a command line but the wrong one for a button.
 *
 *   node scripts/figures_code.mjs                       # → ~/Downloads/figures-code, commit + push
 *   node scripts/figures_code.mjs --out=/some/where      # somewhere else
 *   node scripts/figures_code.mjs --no-push              # commit locally only
 *   node scripts/figures_code.mjs --no-commit            # just write the files
 *   node scripts/figures_code.mjs --no-figures           # skip drawing the PDFs
 *
 * The PDFs are drawn here too, into `figures/` beside the code, and committed with it: the folder
 * is meant to answer "what do the figures look like" without anyone installing matplotlib first.
 * Pressing the button again re-runs the whole trip, so whatever moved — a CSV, a script, a PDF —
 * is what lands in the next commit, and a press that changed nothing makes no commit at all.
 *
 * The target is treated as a git repo the researcher owns: it is pulled up to date if it is behind,
 * initialised if empty, committed if anything changed, and pushed only if it has a remote. A push
 * that fails is reported, not swallowed — but the files are already on disk by then, so nothing is
 * lost.
 *
 * THE PULL COMES FIRST, before a single file is written, and that ordering is the whole of it. A
 * folder behind its remote — someone published from another machine, someone edited it on GitHub —
 * has its push rejected at the very end, after the figures have been drawn and committed. Pulling
 * at the top catches that while the working tree is still clean, which is the only moment a
 * fast-forward cannot collide with the CSVs and PDFs this run is about to rewrite. If the remote
 * moves anyway while the run is in flight, the push is retried once after a rebase.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'figures_code');

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const OUT = flag('out') || join(homedir(), 'Downloads', 'figures-code');
const DO_COMMIT = !args.includes('--no-commit');
const DO_PUSH = DO_COMMIT && !args.includes('--no-push');
const DO_RENDER = !args.includes('--no-figures');

/**
 * The data each script reads, copied under `data/` beside the code.
 *
 * PROVENANCE.md travels with them on purpose: the CSVs alone do not say which tasks were counted,
 * and a figure whose selection is unknown is a figure nobody can quote.
 */
const DATA_FILES = [
  ['figures/behavior_pooled.csv', 'behavior_pooled.csv'],
  ['figures/behavior_by_facet.csv', 'behavior_by_facet.csv'],
  ['figures/outcomes.csv', 'outcomes.csv'],
  // The paper's table, filled by scripts/results_table.mjs from the same rows these CSVs came from.
  // It is here so the folder answers "what are the numbers" as well as "what do they look like".
  ['figures/results_table.csv', 'results_table.csv'],
  // Who is behind the n, sitting by sitting — written by scripts/breakdonw_participants.mjs from
  // the same rows. The aggregates above cannot say how many people worked both arms, and that is
  // the first thing asked of a within-subject result.
  ['figures/breakdonw_participants.csv', 'breakdonw_participants.csv'],
  ['dataset/rows.csv', 'rows.csv'],
  // THE MASTER AND THE SELECTION, so the published Python can do the filtering itself rather than
  // being handed rows.csv and asked to trust that it holds the right ones. results_table_subset.py
  // narrows the first by the second and rebuilds the table out of the result.
  ['dataset/rows_master.csv', 'rows_master.csv'],
  ['dataset/selection.json', 'selection.json'],
  ['post_study/post_study.csv', 'post_study.csv'],
  ['figures/PROVENANCE.md', 'PROVENANCE.md'],
];

function run(command, commandArgs, cwd, env = null) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd, env: env ? { ...process.env, ...env } : process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => resolve({ code: 1, out: `${out}${e.message}` }));
    child.on('close', code => resolve({ code, out: out.trim() }));
  });
}

const git = (...gitArgs) => run('git', gitArgs, OUT);

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`✗ No figures_code/ in this repo (looked in ${SOURCE}).`);
    process.exit(1);
  }
  // BEFORE A SINGLE FILE IS WRITTEN. If that folder is behind its remote — a publish from another
  // machine, an edit made on GitHub — the push at the end is rejected and the whole trip has to be
  // repeated. Pulling here rather than later is what makes it safe: this is the one moment the
  // working tree is clean, so a fast-forward cannot collide with the CSVs and PDFs about to be
  // rewritten. Pull after they are written and git refuses precisely when the remote touched the
  // same files, which is the common case.
  await pullIfBehind();

  await mkdir(join(OUT, 'data'), { recursive: true });

  // REPLACE, DON'T MERGE. A .py left behind from an earlier export would keep being committed and
  // would keep looking current, so the target's own scripts are cleared before the copy — only at
  // the top level, so a .venv or a figures/ output folder in there survives.
  const stale = (await readdir(OUT)).filter(name => name.endsWith('.py'));
  await Promise.all(stale.map(name => rm(join(OUT, name), { force: true })));

  const code = (await readdir(SOURCE))
    .filter(name => name.endsWith('.py') || name === 'README.md' || name === 'requirements.txt');
  for (const name of code) {
    await copyFile(join(SOURCE, name), join(OUT, name));
  }

  const missing = [];
  let copied = 0;
  for (const [from, to] of DATA_FILES) {
    const src = join(ROOT, from);
    if (!existsSync(src)) { missing.push(from); continue; }
    await copyFile(src, join(OUT, 'data', to));
    copied++;
  }

  // `figures/` is NOT ignored: the rendered PDFs are part of what this publishes, so a co-author
  // who only wants the picture never has to install anything. The interpreter's own leavings are.
  await writeFile(join(OUT, '.gitignore'), ['.venv/', '__pycache__/', '*.pyc', ''].join('\n'));

  console.log(`✓ ${code.length} code files and ${copied} data files → ${OUT}`);
  if (missing.length) {
    console.log(`  (missing here, so not copied: ${missing.join(', ')} — run scripts/figures.mjs first)`);
  }

  if (DO_RENDER) await renderFigures();

  if (!DO_COMMIT) return;

  if (!existsSync(join(OUT, '.git'))) {
    const init = await git('init', '-b', 'main');
    if (init.code !== 0) return fail(`git init failed: ${init.out}`);
  }

  await git('add', '-A');
  const staged = await git('diff', '--cached', '--name-only');
  if (!staged.out) {
    console.log('✓ Nothing changed since the last publish — no commit made.');
    return;
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const note = await provenanceLine();
  const message = `Publish figure code and data (${stamp} UTC)${note ? `\n\n${note}` : ''}`;
  const commit = await git('commit', '-m', message);
  if (commit.code !== 0) return fail(`git commit failed: ${commit.out}`);
  const files = staged.out.split('\n').filter(Boolean).length;
  console.log(`✓ Committed ${files} changed file${files === 1 ? '' : 's'}.`);

  if (!DO_PUSH) return;
  const remote = await git('remote');
  if (!remote.out) {
    console.log('✓ Committed locally. No git remote is set on that folder, so nothing was pushed.');
    return;
  }
  const origin = remote.out.split('\n')[0];
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out || 'main';
  let push = await git('push', '-u', origin, branch);
  if (push.code !== 0) {
    // The remote moved between the pull at the top of this run and now — a race with another
    // publish, or a folder that was already behind before this check existed. The commit is made
    // and the tree is clean, so replaying it on top of theirs is safe and needs no stash.
    console.log('  (the push was rejected, so pulling and replaying this commit on top of it…)');
    const rebase = await git('pull', '--rebase', origin, branch);
    if (rebase.code !== 0) {
      return fail(`Committed, but the folder is behind ${origin}/${branch} and the rebase stopped: `
        + `${rebase.out}\n  Nothing is lost — the files and the commit are in ${OUT}. `
        + `Sort the conflict there and push.`);
    }
    push = await git('push', '-u', origin, branch);
    if (push.code !== 0) return fail(`Committed and rebased, but the push still failed: ${push.out}`);
  }
  console.log(`✓ Pushed ${branch} to ${origin}.`);
}

/**
 * Bring the target folder up to date with its remote, if it is behind and can be.
 *
 * NOT A FAILURE WHEN IT CANNOT. Every branch here logs and returns rather than exiting: the point of
 * this script is to get the code, the data and the figures onto disk, and a folder with no remote,
 * no network or a divergent history should still get all three. What must not happen is a silent
 * skip — each case says which one it was, so "it did not pull" is never a guess.
 *
 * A DIRTY TREE IS LEFT ALONE. It means an earlier publish wrote files and did not commit them, and
 * merging on top of that is how someone's uncommitted work disappears. The pull is skipped, said
 * out loud, and the push at the end handles it by rebasing once the commit exists.
 */
async function pullIfBehind() {
  if (!existsSync(join(OUT, '.git'))) return;
  if (!(await git('remote')).out) return;
  if (!(await git('rev-parse', '--verify', 'HEAD')).out) return;   // nothing committed yet

  const origin = (await git('remote')).out.split('\n')[0];
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out || 'main';
  const fetched = await git('fetch', origin, branch);
  if (fetched.code !== 0) {
    console.log(`  (could not reach ${origin}, so nothing was pulled: ${fetched.out.split('\n').pop()})`);
    return;
  }

  // Both counts, not just one: behind says whether to pull, ahead says whether a fast-forward is
  // even possible. A folder that is both has a history of its own and is not this script's to
  // resolve.
  const counts = await git('rev-list', '--left-right', '--count', `HEAD...FETCH_HEAD`);
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  if (!behind) return;

  const dirty = (await git('status', '--porcelain')).out;
  if (dirty) {
    console.log(`  (${origin}/${branch} is ${behind} commit${behind === 1 ? '' : 's'} ahead, but that `
      + 'folder has uncommitted changes, so nothing was pulled — they would be merged over.)');
    return;
  }
  if (ahead) {
    console.log(`  (${origin}/${branch} and that folder have both moved — ${ahead} local, ${behind} `
      + 'remote — so nothing was pulled; this run will commit and rebase onto theirs.)');
    return;
  }

  const pulled = await git('pull', '--ff-only', origin, branch);
  if (pulled.code !== 0) {
    console.log(`  (the pull failed, so this run publishes on top of the older copy: ${pulled.out.split('\n').pop()})`);
    return;
  }
  console.log(`✓ Pulled ${behind} commit${behind === 1 ? '' : 's'} from ${origin}/${branch} before publishing.`);
}

/**
 * Draw the PDFs, so the folder holds the figures and not only the recipe for them.
 *
 * A MISSING INTERPRETER IS NOT A FAILED PUBLISH. The code and the data are already written by the
 * time this runs, and they are the part that cannot be reproduced elsewhere — a machine without
 * matplotlib should still get its commit, with a line saying which step was skipped and how to
 * turn it on. Only `--no-figures` skips it silently, because then it was asked for.
 *
 * SOURCE_DATE_EPOCH is set because matplotlib stamps a creation date into every PDF. Without it,
 * seven files change on every press whether or not a single number moved, and "nothing changed
 * since the last publish" could never be true.
 */
async function renderFigures() {
  const python = await findPython();
  if (!python) {
    console.log('  (no Python with matplotlib found, so the PDFs were not redrawn — install it with '
      + `\`cd ${OUT} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt\`, `
      + 'or pass --no-figures to stop looking)');
    return;
  }
  const made = await run(python, ['make_all.py', '--format=pdf'], OUT, { SOURCE_DATE_EPOCH: '0' });
  if (made.code !== 0) {
    console.log(`  (the figures failed to draw, so the previous PDFs are unchanged: ${made.out.split('\n').pop()})`);
    return;
  }
  const pdfs = existsSync(join(OUT, 'figures'))
    ? (await readdir(join(OUT, 'figures'))).filter(n => n.endsWith('.pdf')).length
    : 0;
  console.log(`✓ ${pdfs} figure${pdfs === 1 ? '' : 's'} redrawn into ${join(OUT, 'figures')}`);
}

/** The first interpreter that can actually import matplotlib — a venv in the target wins. */
async function findPython() {
  const candidates = [
    process.env.PAGEGUIDE_PYTHON,
    join(OUT, '.venv', 'bin', 'python'),
    'python3',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = await run(candidate, ['-c', 'import matplotlib'], OUT);
    if (probe.code === 0) return candidate;
  }
  return null;
}

/** One line saying which selection the published CSVs came from, for the commit body. */
async function provenanceLine() {
  try {
    const text = await readFile(join(ROOT, 'figures', 'PROVENANCE.md'), 'utf8');
    return text.split('\n').find(line => line.startsWith('- Task selection:'))?.trim() || '';
  } catch (e) {
    return '';
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

main().catch(e => fail(e?.message || String(e)));
