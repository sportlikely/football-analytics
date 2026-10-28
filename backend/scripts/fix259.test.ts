// fix259: "Copy for Claude to fix" — the text format for 3 card types, the secret filter, the 12 KB limit, the
// data-health history and the related fixes; the button never on a public page. Run: npm run test:fix259
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assemble, header, checkSection, siteErrorSection, crmThreadSection, deploySection, perfSection, scrubSecrets, relatedFixes,
  footerLine, FOR_CLAUDE_MAX
} from '../src/utils/forClaude.ts';
import { addToHistory } from '../src/utils/healthStore.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const AT = Date.UTC(2026, 9, 28, 12, 5); // 14:05 in Israel (UTC+2 after the clocks went back)
const head = header({ place: 'Admin → Site health → Speed', at: AT, build: 'index-AbC123xy', commit: '3c8b5353f0e1d2c3b4a5' });

test('header: place, Israel time, build, main commit (7 characters)', () => {
  assert.equal(head, 'SportLikely · Admin → Site health → Speed · 28 Oct 14:05 Israel time · build index-AbC123xy · main 3c8b535');
  assert.match(header({ place: 'X', at: AT, build: null, commit: null }), /build unknown · main unknown$/);
});

test('card type 1 — a data-health check: id, label, level, full detail, every item, last 3 values, measured time, related fixes', () => {
  const c = { id: 'perf:web-stalls', label: 'Web stalls (pages never wait)', level: 'fail' as const, detail: 'x'.repeat(400) + ' END', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] };
  const hist = [
    { at: '2026-10-28T12:00:00Z', level: 'fail' as const, detail: '3 stalls, worst 2,400 ms' },
    { at: '2026-10-28T11:55:00Z', level: 'warn' as const, detail: '1 stall, worst 700 ms' },
    { at: '2026-10-28T11:50:00Z', level: 'ok' as const, detail: 'no stall' }
  ];
  const perf = { data: { web: { stallsLastHour: 3, worstLastHour: 2400, uptimeMin: 50, diagStalls: [{ at: '2026-10-28T11:59:00Z', ms: 2400, job: 'http GET /api/today', cpu: { top: [{ fn: 'JSON.parse', at: 'app.ts:12', ms: 900 }] } }], shortBlocks: [{ at: '2026-10-28T11:58:00Z', ms: 180, job: 'page build', cpu: ['gzipSync zlib 120 ms'] }] }, worker: { heapMb: 900, heapLimitMb: 1536 }, slowRequests: [{ path: '/api/today', ms: 1300 }] } };
  const notes = [{ file: 'perf.md', text: '- The `perf:web-stalls` check (fix202, fix232) counts freezes.\n- Unrelated line fix999.' }];
  const text = assemble(head, [checkSection(c, { measuredAt: '2026-10-28T12:00:00Z', history: hist, plain: { title: 'Website freezes', what: 'Whether pages wait.' } }), perfSection(perf)],
    footerLine(relatedFixes(notes, [c.id, c.label])));
  const lines = text.split('\n');
  assert.equal(lines[0], head);
  for (const want of ['## Check: Website freezes', 'Check id: perf:web-stalls', 'Label: Web stalls (pages never wait) (shown as "Website freezes")', 'Level: red (problem)',
    `Detail: ${'x'.repeat(400)} END`, 'Measured: 28 Oct 14:00 Israel time (2026-10-28T12:00:00Z)', 'Items (8):', '- h',
    'Last values (newest first):', '- 28 Oct 14:00: red (problem) — 3 stalls, worst 2,400 ms', '- 28 Oct 13:50: green (OK) — no stall',
    '## Speed (from /api/perf)', 'Website freezes with the code that ran (diagStalls):', 'Website short blocks (shortBlocks):', 'Slow requests:']) assert.ok(lines.includes(want), `missing line: ${want}`);
  assert.match(text, /2400 ms · http GET \/api\/today · code: JSON\.parse app\.ts:12 900 ms/);
  assert.equal(lines.at(-1), 'Related fixes: fix232, fix202');
});

test('card type 2 — site errors: message, page, where (stack), builds, browser family, times', () => {
  const rows = [{ message: "Cannot read properties of null (reading 'useState')", pageKind: '/match/:id', pages: ['/football/match/a-vs-b-2026-10-28'], where: 'at Ze (https://sportlikely.com/assets/index-AbC123xy.js:1:2345)\nat Object.render', builds: ['index-AbC123xy'], browsers: ['Chrome · Android'], count: 14, firstAt: '2026-10-27T09:00:00Z', lastAt: '2026-10-28T11:00:00Z' }];
  const text = assemble(head, [siteErrorSection(rows)], footerLine([]));
  assert.match(text, /## Site errors \(newest first\)\n1\. 14× "Cannot read properties of null \(reading 'useState'\)"\n {3}page \/match\/:id \(\/football\/match\/a-vs-b-2026-10-28\)\n {3}last 28 Oct 13:00 · first 27 Oct 11:00 Israel time · builds index-AbC123xy · browsers Chrome · Android\n {3}stack: at Ze \(https:\/\/sportlikely\.com\/assets\/index-AbC123xy\.js:1:2345\)\n {6}at Object\.render/);
  assert.match(text, /Related fixes: none named in docs\/notes$/);
  // a deploy row: the time and the 5xx counts
  const d = deploySection([{ started_at: '2026-10-28T10:00:00Z', requests: 900, files: 2, pages: 0, api: 5, health: 12, statuses: '{"502":2,"503":5}' }]);
  assert.match(d.lines[0], /^28 Oct 12:00 Israel time \(2026-10-28T10:00:00Z\): 900 requests — files 2, pages 0, API 5/);
});

test('card type 3 — a CRM support message: the thread by customer id, never the email or name', () => {
  const t = {
    message: { id: 41, at: '2026-10-28T08:00:00Z', topic: 'billing', message: 'Hi, I paid but still see Free.\nMy email is dana.cohen@example.com, card 4111 1111 1111 1111', page: '/premium', status: 'open', userId: 1234 },
    replies: [{ at: '2026-10-28T09:00:00Z', byName: 'Yarin', kind: 'note', body: 'Checked Lemon Squeezy: order exists.' }],
    account: { id: 1234, plan: 'free', createdAt: '2026-09-01T00:00:00Z', lastLoginAt: '2026-10-28T07:59:00Z' },
    others: [{ id: 30, at: '2026-10-01T00:00:00Z', topic: 'question', status: 'closed' }]
  };
  const text = assemble(header({ place: 'CRM → Support inbox → message #41', at: AT, build: 'index-AbC123xy', commit: 'abcdef0' }), [crmThreadSection(t)], footerLine([]));
  assert.match(text, /Message #41 from customer #1234 · 28 Oct 10:00 Israel time · topic billing · status open · sent from \/premium/);
  assert.match(text, /> Hi, I paid but still see Free\./);
  assert.match(text, /Internal note by Yarin · 28 Oct 11:00:/);
  assert.match(text, /Other messages from the same person: #30 question \(closed, 2026-10-01\)/);
  assert.ok(!text.includes('dana.cohen@example.com') && !text.includes('4111 1111'), 'no customer email or card number');
  assert.match(text, /My email is \[email\], card \[number hidden\]/);
});

test('secret filter: server secrets, key=value, bearer, JWT, long keys, emails, card numbers, IPs — and normal text stays', () => {
  const secret = 'Zx9-very-secret-value-42';
  const raw = [
    `env API_FOOTBALL_KEY=${secret}`, `fetch https://v3.football.api-sports.io/fixtures?league=39&apikey=abcd1234efgh&season=2026`,
    'headers {"Authorization":"Bearer abc.def.ghi-123456789"}', 'token: tok_live_0123456789', 'password=hunter2!!',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'BACKUP_KEY looks like 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'stripe sk_live_51HxYzAbCdEfGh', 'user yarin@example.com signed in', 'card 4242 4242 4242 4242', 'from 203.0.113.77', 'v6 2001:db8:85a3:8d3:1319:8a2e:370:7348',
    'Normal: 1730123456789 requests, 3 stalls, worst 2,400 ms, /api/admin/client-errors, index-AbC123xy, fix259, 2026-10-28T12:00:00Z'
  ].join('\n');
  const s = scrubSecrets(raw, [secret]);
  for (const bad of [secret, 'abcd1234efgh', 'abc.def.ghi-123456789', 'tok_live_0123456789', 'hunter2', 'eyJhbGciOiJIUzI1NiJ9', '9f86d081884c7d659a2feaa0c55ad015',
    'sk_live_51HxYzAbCdEfGh', 'yarin@example.com', '4242 4242 4242 4242', '203.0.113.77', '1319:8a2e:370:7348']) assert.ok(!s.includes(bad), `still there: ${bad}\n${s}`);
  assert.ok(s.includes('league=39') && s.includes('season=2026'), 'other query parameters stay');
  assert.ok(s.includes('from 203.0.113.x'), 'the network part of an address stays');
  assert.ok(s.endsWith('Normal: 1730123456789 requests, 3 stalls, worst 2,400 ms, /api/admin/client-errors, index-AbC123xy, fix259, 2026-10-28T12:00:00Z'), s.split('\n').at(-1));
  // assemble runs the filter over everything, header and footer included
  const all = assemble(`head ${secret}`, [{ title: `t apikey=${secret}`, lines: [`l ${secret}`] }], `foot ${secret}`, { secrets: [secret] });
  assert.ok(!all.includes(secret));
});

test('the server secret list comes from the variables with secret names (and never short values)', async () => {
  // services/forClaude.ts imports the database; its rule is repeated here to keep this test pure
  const src = fs.readFileSync(path.join(root, 'backend/src/services/forClaude.ts'), 'utf8');
  assert.match(src, /KEY\|TOKEN\|SECRET\|PASS\|PRIVATE/);
  assert.match(src, /assemble\(head, sections, footerLine\(relatedFixes\(notes\(\), keys\)\), \{ secrets: secretValues\(\) \}\)/);
});

test('size limit: 12 KB at most, the rest as "… (N more)"', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `row ${i}: ${'y'.repeat(60)}`);
  const text = assemble(head, [{ title: 'Big', lines }, { title: 'After', lines: ['a', 'b'] }], footerLine(['fix259']));
  assert.ok(Buffer.byteLength(text, 'utf8') <= FOR_CLAUDE_MAX, `${Buffer.byteLength(text, 'utf8')} bytes`);
  assert.equal(FOR_CLAUDE_MAX, 12 * 1024);
  assert.match(text, /\n… \(\d+ more\)\n/);
  const n = Number(text.match(/… \((\d+) more\)/)![1]);
  assert.equal(text.split('\n').filter(l => l.startsWith('row ')).length + n, 2000, 'shown + "more" = all rows');
  assert.ok(text.startsWith(head) && text.endsWith('Related fixes: fix259'), 'header and footer always kept');
  // one huge line is cut too
  const one = assemble(head, [{ title: 'Line', lines: ['z'.repeat(50000)] }], 'f');
  assert.ok(Buffer.byteLength(one, 'utf8') <= FOR_CLAUDE_MAX && /more characters\)/.test(one));
  // multi-byte text stays under the byte limit
  const he = assemble(head, [{ title: 'עברית', lines: Array.from({ length: 3000 }, () => 'שלום עולם → ✓') }], 'f');
  assert.ok(Buffer.byteLength(he, 'utf8') <= FOR_CLAUDE_MAX);
});

test('data-health history keeps the last 3 values per check, newest first; gone checks drop', () => {
  let h = {};
  for (let i = 1; i <= 5; i++) h = addToHistory(h, { level: 'ok', at: `t${i}`, checks: [{ id: 'a', label: 'A', level: i === 5 ? 'fail' : 'ok', detail: `v${i}` }, ...(i < 5 ? [{ id: 'b', label: 'B', level: 'ok' as const, detail: 'x' }] : [])] });
  assert.deepEqual((h as any).a.map((p: any) => p.detail), ['v5', 'v4', 'v3']);
  assert.equal((h as any).a[0].level, 'fail');
  assert.equal((h as any).b, undefined);
});

test('related fixes come from the notes lines that name the item', () => {
  const notes = [{ file: 'x.md', text: 'Deploys: "Errors during the last deploy" (fix227, fix232b) — `deploy-errors`.\nThe matches list (fix100) is unrelated.' }];
  assert.deepEqual(relatedFixes(notes, ['deploy-errors', 'Errors during the last deploy']), ['fix232b', 'fix227']);
  assert.deepEqual(relatedFixes(notes, ['matches']), [], 'a plain word id needs backticks or quotes');
});

test('the button is only on admin / CRM pages, and the endpoints are not public', () => {
  const fe = path.join(root, 'frontend/src');
  const users: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(f.name) && /CopyForClaude|lib\/forClaude/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(fe, p)); } };
  walk(fe);
  const allowed = ['pages/Admin.tsx', 'pages/Crm.tsx', 'components/admin/', 'components/VisitorsCard.tsx', 'components/LeagueFixCard.tsx', 'lib/forClaude.ts'];
  for (const u of users) assert.ok(allowed.some(a => u === a || u.startsWith(a)), `CopyForClaude used outside admin / CRM: ${u}`);
  assert.ok(users.includes('pages/Admin.tsx') && users.includes('pages/Crm.tsx') && users.includes('components/admin/AdminParts.tsx'));
  // the admin-only cards are used only by Admin.tsx
  const app = fs.readFileSync(path.join(fe, 'App.tsx'), 'utf8');
  for (const card of ['VisitorsCard', 'LeagueFixCard']) {
    for (const u of fs.readdirSync(path.join(fe, 'pages'))) if (u !== 'Admin.tsx' && fs.statSync(path.join(fe, 'pages', u)).isFile()) assert.ok(!fs.readFileSync(path.join(fe, 'pages', u), 'utf8').includes(`components/${card}`), `${card} in pages/${u}`);
    assert.ok(!app.includes(`components/${card}`));
  }
  const be = fs.readFileSync(path.join(root, 'backend/src/app.ts'), 'utf8');
  const open = be.match(/const OPEN_API = ([^\n]+)/)?.[1] || '';
  assert.ok(!/for-claude/.test(open), 'never in OPEN_API');
  assert.match(be, /app\.post\('\/api\/admin\/for-claude'/);
  assert.match(be, /app\.post\('\/api\/crm\/for-claude'[\s\S]{0,400}crm-message' \? 'inbox\.read' : scope === 'crm-customer' \? 'customers\.view'/);
});
