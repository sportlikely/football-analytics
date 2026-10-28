#!/usr/bin/env node
// fix233: Stop hook — at the end of a task, is this chat's HEAD on origin/main? (CLAUDE.md "Shipping (read first)")
// First stop with HEAD not on main: Claude is asked to ship it (pull --rebase, typecheck, push HEAD:main) or say why not
// (payments work stays on a branch). The second stop is never blocked (stop_hook_active): the warning is shown instead.
// No git, no network or a fetch over 15 s: says nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
const git = (...a) => execFileSync('git', a, { cwd: input.cwd || process.cwd(), encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let onMain = true, head = '', branch = '';
try {
  head = git('rev-parse', '--short', 'HEAD');
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('fetch', '-q', 'origin', 'main');
  onMain = git('branch', '-r', '--contains', 'HEAD').split('\n').map(s => s.trim()).includes('origin/main');
} catch { process.exit(0); }
// fix260: a fix is done only when test:site is green locally (on this exact code) AND in CI ("Site check" on GitHub)
let siteMsg = '';
try {
  const root = git('rev-parse', '--show-toplevel');
  const tree = git('rev-parse', 'HEAD^{tree}');
  let rep = null;
  try { rep = JSON.parse(readFileSync(`${root}/backend/site-report.json`, 'utf8')); } catch { /* never run */ }
  if (!rep) siteMsg = 'test:site has not run on this machine (npm run test:site in backend).';
  else if (!rep.full) siteMsg = 'the last test:site run was a partial one (SITE_LANGS / SITE_ONLY / SITE_SHARD set) — run the full npm run test:site.';
  else if (rep.failed) siteMsg = `the last test:site run failed (${rep.failed} page opens on ${rep.pages?.length ?? '?'} pages, backend/site-report.json) — fix them and run it again.`;
  // the site is built from backend/ and frontend/ only: a workflow / notes edit after the run needs no new run
  else if (!['backend', 'frontend'].every(d => { try { return git('rev-parse', `${rep.tree}:${d}`) === git('rev-parse', `${tree}:${d}`); } catch { return false; } })) siteMsg = `test:site was green on other code (report ${rep.at}) — run npm run test:site again on HEAD ${head}.`;
} catch { /* no git */ }
if (onMain && !siteMsg) process.exit(0);
if (onMain) {
  const m = `${siteMsg} A fix is done only when test:site is green locally AND the "Site check" run on GitHub is green (CLAUDE.md "Shipping"; Railway deploys only after it).`;
  if (input.stop_hook_active) console.log(JSON.stringify({ systemMessage: `⚠ ${m}` }));
  else console.log(JSON.stringify({ decision: 'block', reason: m }));
  process.exit(0);
}
const msg = `HEAD ${head} (${branch}) is not on origin/main — Railway will not build it. Ship it: git pull --rebase origin main → keep both sides on conflict → typecheck + this fix's tests → git push origin HEAD:main, then check git branch -r --contains HEAD shows origin/main (CLAUDE.md "Shipping"). Payments work is the only exception (branch + ask Yarin).${siteMsg ? ` Also: ${siteMsg}` : ''}`;
if (input.stop_hook_active) console.log(JSON.stringify({ systemMessage: `⚠ ${msg}` }));
else console.log(JSON.stringify({ decision: 'block', reason: msg }));
