// fix260: when the site check fails in CI (GitHub Actions "Site check"), the failing pages in plain words — on the run's
// summary page, and by email to Yarin when the repository has the RESEND_API_KEY and REPORT_EMAIL_TO secrets.
//   node scripts/ci-report.mjs <report.json> [<report.json> …]      (site-report*.json from test:site, links-report.json)
// Env (from the workflow): GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_STEP_SUMMARY, RESEND_API_KEY,
// REPORT_EMAIL_TO, EMAIL_FROM (optional), FAILED_STEPS (typecheck / parity names that failed before the page tests).
import fs from 'node:fs';

const files = process.argv.slice(2).filter(f => fs.existsSync(f));
const reports = files.map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).filter(Boolean);

/** a reason from the tests → plain words */
function words(w) {
  let m;
  if ((m = /^(\d{3}) (GET|POST|PUT|DELETE) (\S+)/.exec(w))) return `the server answered ${m[1]}${+m[1] >= 500 ? ' (a server error)' : m[1] === '404' ? ' (not found)' : ''} for ${m[3]}`;
  if ((m = /^console error: (.*)/.exec(w))) return `a script error in the browser: “${m[1]}”`;
  if ((m = /^page error: (.*)/.exec(w))) return `the page crashed: “${m[1]}”`;
  if (/^error box shown/.test(w)) return `the page shows “Something went wrong”${w.replace(/^error box shown/, '')}`;
  if (/Updating…/.test(w)) return 'the page stays on “Updating…” (no data after 3 seconds)';
  if (/skeleton/.test(w)) return 'the page stays on its loading placeholder (no data after 3 seconds)';
  if (/no content/.test(w)) return 'the page is empty';
  if ((m = /^answers (\d{3})/.exec(w))) return `the address answers ${m[1]}${m[1] === '404' ? ' (page not found)' : +m[1] >= 500 ? ' (a server error)' : ''}`;
  if (/^relative link/.test(w)) return `${w} — the link adds itself to the current address and opens a wrong page`;
  if (/app's 404/.test(w)) return 'the link opens the “This page doesn’t exist” page';
  if (/opens the search/.test(w)) return 'the link opens the search instead of its page (the site drew an address it does not know)';
  if (/redirect loop/.test(w)) return `the address sends the browser round in a circle (${w.replace(/^redirect loop: /, '')})`;
  if (/redirect hops/.test(w)) return `the address moves more than once before it opens (${w})`;
  return w;
}

const lines = [];
const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
const run = process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
lines.push(`The site check failed on commit ${sha || '(unknown)'}, so Railway did not deploy it. The live site still runs the previous build.`);
if (process.env.FAILED_STEPS) lines.push('', `These checks failed before the pages were opened: ${process.env.FAILED_STEPS}.`);
for (const r of reports) {
  if (r.test === 'test:site' && r.pages?.length) {
    lines.push('', `Pages that are broken (${r.pages.length}; ${r.failed} of ${r.opened} page opens failed${r.shard ? `, part ${r.shard}` : ''}):`);
    for (const p of r.pages.slice(0, 60)) {
      const who = p.roles.map(x => ({ out: 'signed-out visitors', free: 'free users', admin: 'the admin', 'admin-locked': 'the admin with the console locked' }[x] || x)).join(', ');
      const where = p.widths.map(x => (x < 500 ? 'phones' : 'computers')).join(' and ');
      lines.push(`• ${p.page} — ${p.why.map(words).join('; ')}. Seen by ${who}, on ${where}, in ${p.languages.length} language${p.languages.length === 1 ? '' : 's'}.`);
    }
    if (r.pages.length > 60) lines.push(`… and ${r.pages.length - 60} more pages (see the run).`);
  }
  if (r.test === 'test:links' && r.links?.length) {
    lines.push('', `Broken links (${r.links.length} of ${r.checked} checked):`);
    for (const l of r.links.slice(0, 60)) lines.push(`• ${l.url} — ${l.why.map(words).join('; ')}${l.from?.length ? ` (linked from ${l.from.join(', ')})` : ''}`);
    if (r.links.length > 60) lines.push(`… and ${r.links.length - 60} more links (see the run).`);
  }
}
if (!reports.length && !process.env.FAILED_STEPS) lines.push('', 'The tests did not finish (no report was written) — open the run to see the error.');
lines.push('', 'What to do: paste this into a Claude chat ("fix these pages"); the fix is pushed to main and the check runs again.');
if (run) lines.push(`The run: ${run}`);
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Site check failed\n\n${text.replace(/^• /gm, '- ')}\n`);

if (process.env.RESEND_API_KEY && process.env.REPORT_EMAIL_TO) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'SportLikely <no-reply@sportlikely.com>', to: process.env.REPORT_EMAIL_TO.split(',').map(s => s.trim()), subject: `Site check failed — ${sha} not deployed`, text })
  }).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
  console.log(r.ok ? 'email sent' : `email not sent (${r.status}): ${await r.text()}`);
} else console.log('(no RESEND_API_KEY / REPORT_EMAIL_TO secret: GitHub’s own failed-run email is the alert)');
