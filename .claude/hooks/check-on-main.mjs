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
if (onMain) process.exit(0);
const msg = `HEAD ${head} (${branch}) is not on origin/main — Railway will not build it. Ship it: git pull --rebase origin main → keep both sides on conflict → typecheck + this fix's tests → git push origin HEAD:main, then check git branch -r --contains HEAD shows origin/main (CLAUDE.md "Shipping"). Payments work is the only exception (branch + ask Yarin).`;
if (input.stop_hook_active) console.log(JSON.stringify({ systemMessage: `⚠ ${msg}` }));
else console.log(JSON.stringify({ decision: 'block', reason: msg }));
