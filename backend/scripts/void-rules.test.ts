// fix200: what happens to a game past kick-off + 48 h with no final score (src/utils/voidRules.ts). Run: npm run test:void
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, kindOfStatus, sameTeamName } from '../src/utils/voidRules.ts';

const H = 3600000, DAY = 24 * H;
const KO = '2026-10-11T15:00:00.000Z';
const at = (ms: number) => Date.parse(KO) + ms;
const fresh = { attempts: 0, lastDay: null };

test('younger than kick-off + 24 h: wait (the normal settle job has it); fix240: from 24 h looked up again', () => {
  assert.equal(decide(null, { kickoff: KO, ...fresh, now: at(23 * H) }).action, 'wait');
  assert.equal(decide(null, { kickoff: KO, ...fresh, now: at(25 * H) }).action, 'retry');
  const fin = decide({ kind: 'final', home: 1, away: 1, raw: 'FT', via: 'twin' }, { kickoff: KO, ...fresh, now: at(25 * H) });
  assert.equal(fin.action, 'settle');
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

test('fix240: not found at 48 h → watched (fix253: void by itself at 7 days), attempts count days', () => {
  const d1 = decide(null, { kickoff: KO, attempts: 0, lastDay: null, now: at(30 * H) });
  assert.equal(d1.action, 'retry');
  const d2 = decide(null, { kickoff: KO, attempts: 1, lastDay: new Date(at(30 * H)).toISOString().slice(0, 10), now: at(49 * H) });
  assert.equal(d2.action, 'review');
  if (d2.action === 'review') { assert.equal(d2.attempts, 2); assert.match(d2.note, /not found/); }
  const d3 = decide(null, { kickoff: KO, attempts: 5, lastDay: null, now: at(6 * DAY) });
  assert.equal(d3.action, 'review');
  assert.equal(decide(null, { kickoff: KO, attempts: 5, lastDay: null, now: at(10 * DAY) }).action, 'void'); // fix253
});

test('fix240: found but never started on the provider at 48 h: Needs you', () => {
  const d = decide({ kind: 'open', raw: 'NS', date: KO, via: 'id' }, { kickoff: KO, attempts: 2, lastDay: '2026-10-14', now: at(4 * DAY) });
  assert.equal(d.action, 'review');
  if (d.action === 'review') assert.match(d.note, /still NS/);
});

test('fix240: abandoned by the provider → void with the reason', () => {
  const d = decide({ kind: 'off', raw: 'ABD', date: KO, via: 'id' }, { kickoff: KO, ...fresh, now: at(26 * H) });
  assert.equal(d.action, 'void');
  if (d.action === 'void') assert.match(d.reason, /abandoned/);
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
