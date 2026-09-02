#!/usr/bin/env node
// Do the pages this repo serves actually parse?
// =============================================
// Run before every deploy, next to scripts/sync-vendor.sh:
//
//     node scripts/check-page-scripts.mjs
//
// CLASSIC <script> TAGS SHARE ONE GLOBAL LEXICAL SCOPE. Two files that each declare a top-level
// `const REFERENCE_DWELL_MS` are fine apart and fatal together: the duplicate declaration is a PARSE
// error, so the second file never runs — not one function of it — and there is no exception to catch
// and nothing that degrades. What a participant sees is the static HTML shell with both panes stuck
// on their "Loading…" placeholders, which reads as a slow network rather than as a dead page.
//
// That is not hypothetical. It cost a pilot session: `REFERENCE_DWELL_MS` was added to app/study.js
// and app/stimulus.js in the same change, study.html loads both, and the task page stopped booting
// while every request in the Network tab came back 200.
//
// So this concatenates each page's <script src=…> files IN THE ORDER THE PAGE LOADS THEM and parses
// the result the way the browser would. It catches duplicate top-level declarations across files,
// and ordinary syntax errors, without a browser or a build step.
//
// WHAT IT DOES NOT CATCH: inline <script> blocks (preview.html wraps its own in an IIFE for exactly
// this reason), anything that only fails at runtime, and a name collision between a `var`/function
// declaration and a `let`/`const` in a file the page does not load together.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pages = readdirSync(root).filter(name => name.endsWith('.html')).sort();
const work = mkdtempSync(join(tmpdir(), 'pagecheck-'));

let failed = 0;
for (const page of pages) {
  const html = readFileSync(join(root, page), 'utf8');
  // Only src= scripts: an inline block is scoped by whatever the page wrote around it.
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(m => m[1].split('?')[0])
    .filter(src => !/^https?:/.test(src))
    .filter(src => existsSync(join(root, src)));
  if (!srcs.length) continue;

  const bundle = srcs
    .map(src => `\n//=== ${src} ===\n${readFileSync(join(root, src), 'utf8')}`)
    .join('');
  const out = join(work, `${page}.bundle.js`);
  writeFileSync(out, bundle);

  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    console.log(`✓ ${page.padEnd(22)} ${srcs.length} scripts`);
  } catch (error) {
    failed++;
    const stderr = String(error.stderr || '');
    // The line number is into the concatenation, so name the FILE it lands in — that is the one a
    // person has to open, and the bundle is a temporary file they will never see.
    const line = Number(/\.bundle\.js:(\d+)/.exec(stderr)?.[1] || 0);
    const upTo = bundle.split('\n').slice(0, line);
    const inFile = [...upTo].reverse().find(l => l.startsWith('//=== '))?.slice(6, -4) || '(unknown)';
    const why = stderr.split('\n').find(l => /Error/.test(l)) || stderr.trim().split('\n')[0];
    console.log(`✗ ${page.padEnd(22)} ${why.trim()}`);
    console.log(`  in ${inFile}, loaded by ${page}`);
  }
}

rmSync(work, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} page${failed === 1 ? '' : 's'} would not boot in a browser.`);
  process.exit(1);
}
console.log(`\n${pages.length} pages checked, all parse.`);
