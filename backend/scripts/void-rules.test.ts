// fix200: what happens to a game past kick-off + 48 h with no final score (src/utils/voidRules.ts). Run: npm run test:void
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, kindOfStatus, sameTeamName, VOID_ATTEMPTS } from '../src/utils/voidRules.ts';

const H = 3600000, DAY = 24 * H;
const KO = '2026-10-11T15:00:00.000Z';
const at = (ms: number) => Date.parse(KO) + ms;
const fresh = { attempts: 0, lastDay: null };

test('younger than kick-off + 48 h: wait (the normal settle job has it)', () => {
  assert.equal(decide(null, { kickoff: KO, ...fresh, now: at(47 * H) }).action, 'wait');
});

test('found with a final score: settled normally', () => {
  const d = decide({ kind: 'final', home: 2, away: 1, raw: 'FT', via: 'teams' }, { kickoff: KO, ...fresh, now: at(3 * DAY) });
  assert.equal(d.action, 'settle');
  if (d.action === 'settle') { assert.equal(d.home, 2); assert.equal(d.away, 1); }
});

test('found postponed with a later date: the kick-off moves', () => {
  const now = at(3 * DAY);
  const d = decide({ kind: 'off', raw: 'PST', date: new Date(now + 5 * DAY).toISOString(), via: 'id' }, { kickoff: KO, ...fresh, now });
  assert.equal(d.action, 'move');
});

test('found postponed / cancelled without a new date: void with the reason', () => {
  const now = at(3 * DAY);
  const pst = decide({ kind: 'off', raw: 'PST', date: KO, via: 'id' }, { kickoff: KO, ...fresh, now });
  assert.equal(pst.action, 'void');
  if (pst.action === 'void') assert.match(pst.reason, /postponed/);
  const canc = decide({ kind: 'off', raw: 'CANC', date: null, via: 'teams' }, { kickoff: KO, ...fresh, now });
  assert.equal(canc.action, 'void');
  if (canc.action === 'void') assert.match(canc.reason, /cancelled/);
});

test('moved to a later date without a status: the kick-off moves', () => {
  const now = at(3 * DAY);
  assert.equal(decide({ kind: 'open', raw: 'NS', date: new Date(now + DAY).toISOString(), via: 'teams' }, { kickoff: KO, ...fresh, now }).action, 'move');
});

test('not found: an attempt a day, void after 3 attempts on 3 different days', () => {
  let attempts = 0, lastDay: string | null = null;
  for (let day = 0; day < VOID_ATTEMPTS; day++) {
    const now = at(2 * DAY + day * DAY + H);
    // two runs the same day count once
    for (let run = 0; run < 2; run++) {
      const d = decide(null, { kickoff: KO, attempts, lastDay, now: now + run * H });
      if (day < VOID_ATTEMPTS - 1) {
        assert.equal(d.action, 'retry', `day ${day + 1} run ${run + 1}`);
        if (d.action === 'retry') { assert.equal(d.attempts, day + 1); attempts = d.attempts; lastDay = new Date(now).toISOString().slice(0, 10); }
      } else {
        assert.equal(d.action, 'void', `day ${day + 1}`);
        if (d.action === 'void') assert.match(d.reason, /not found/);
        break;
      }
    }
  }
});

test('found but never started on the provider: void after 3 days too', () => {
  const d = decide({ kind: 'open', raw: 'NS', date: KO, via: 'id' }, { kickoff: KO, attempts: 2, lastDay: '2026-10-14', now: at(4 * DAY) });
  assert.equal(d.action, 'void');
  if (d.action === 'void') assert.match(d.reason, /still NS/);
});

test('provider statuses and team names', () => {
  assert.equal(kindOfStatus('FT'), 'final');
  assert.equal(kindOfStatus('AET'), 'final');
  assert.equal(kindOfStatus('PST'), 'off');
  assert.equal(kindOfStatus('CANCELLED'), 'off');
  assert.equal(kindOfStatus('NS'), 'open');
  assert.ok(sameTeamName('Al-Hilal', 'Al Hilal Saudi FC'));
  assert.ok(sameTeamName('AEK Athens FC', 'AEK Athens'));
  assert.ok(!sameTeamName('Al-Ahli', 'Al-Nassr'));
});
