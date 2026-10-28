// fix264: team aliases (Bodø/Glimt, fuzzy twin proposals), top-scorer name matching, venue look-up order. Run: npm run test:fix264
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamKey, teamSimilarity, proposeTwin, samePlayerName, nameSearchTerms, plainName } from '../src/utils/nameMatch.ts';
import { geoQueries, cleanCity } from '../src/utils/gameExtras.ts';

const KO = '2026-10-30T17:45:00Z';

test('Bodø/Glimt: both providers\' spellings give one key', () => {
  assert.equal(teamKey('FK Bodø/Glimt'), 'bodo glimt');
  assert.equal(teamKey('Bodo/Glimt'), 'bodo glimt');
  assert.equal(teamKey('Strømsgodset IF'), teamKey('Stromsgodset IF'));
  assert.equal(teamKey('Real Madrid CF'), 'real madrid');
});

test('twin proposal: one clear fuzzy match is applied, kick-off within 15 min', () => {
  const p = proposeTwin({ home: 'FK Bodø/Glimt', away: 'SK Brann', kickoff: KO }, [
    { id: 1, home: 'Bodo/Glimt', away: 'Brann', kickoff: KO },
    { id: 2, home: 'Molde', away: 'Rosenborg', kickoff: KO }
  ]);
  assert.equal(p.best?.id, 1);
  assert.equal(p.apply, true);
});

test('twin proposal: one side known + the other close → applied; two look-alikes → only listed', () => {
  const one = proposeTwin({ home: 'Wolverhampton Wanderers FC', away: 'Watford FC', kickoff: KO }, [
    { id: 7, home: 'Wolverhampton', away: 'Watford', kickoff: KO, sameAway: true },
    { id: 8, home: 'Millwall', away: 'Hull City', kickoff: KO }
  ]);
  assert.equal(one.apply, true);
  const two = proposeTwin({ home: 'Sporting', away: 'Benfica B', kickoff: KO }, [
    { id: 1, home: 'Sporting CP B', away: 'Benfica B', kickoff: KO },
    { id: 2, home: 'Sporting Braga B', away: 'Benfica B', kickoff: KO }
  ]);
  assert.equal(two.apply, false, 'not 0.2 ahead of the next candidate');
  assert.ok(two.best);
});

test('twin proposal: nothing alike, or kick-off far apart → not applied', () => {
  assert.equal(proposeTwin({ home: 'Celtic', away: 'Hearts', kickoff: KO }, [{ id: 1, home: 'Ajax', away: 'PSV', kickoff: KO }]).apply, false);
  assert.equal(proposeTwin({ home: 'Celtic', away: 'Hearts', kickoff: KO }, [{ id: 1, home: 'Celtic', away: 'Hearts', kickoff: '2026-10-30T19:45:00Z' }]).apply, false);
  assert.equal(proposeTwin({ home: 'Celtic', away: 'Hearts', kickoff: KO }, []).best, null);
  assert.ok(teamSimilarity('Heart of Midlothian', 'Hearts') < teamSimilarity('Bodø/Glimt', 'Bodo Glimt'));
});

test('player names: accents stripped, first + last token inside one club', () => {
  assert.equal(plainName('Pau Víctor'), 'pau victor');
  assert.equal(samePlayerName('Marcus Thuram-Ulien', 'Marcus Thuram'), false, 'strict: different last word');
  assert.equal(samePlayerName('Marcus Thuram-Ulien', 'Marcus Thuram', true), true);
  assert.equal(samePlayerName('Pau Victor Delgado', 'Pau Víctor', true), true);
  assert.equal(samePlayerName('Pau Víctor', 'Pau Victor Delgado', true), true);
  // the old rules still hold
  assert.equal(samePlayerName('E. Haaland', 'Erling Haaland'), true);
  assert.equal(samePlayerName('Vinícius Júnior', 'Vinicius Junior'), true);
  assert.equal(samePlayerName('Yassir Zabiri', 'Mohamed Yassir Zabiri'), true);
  // a different first name never matches loosely
  assert.equal(samePlayerName('Khéphren Thuram', 'Marcus Thuram-Ulien', true), false);
  assert.equal(samePlayerName('Pau Cubarsí', 'Pau Victor', true), false);
});

test('player search words: the last word and the one before it', () => {
  assert.deepEqual(nameSearchTerms('Marcus Thuram-Ulien'), ['ulien', 'thuram']);
  assert.deepEqual(nameSearchTerms('Pau Victor Delgado'), ['delgado', 'victor']);
  assert.deepEqual(nameSearchTerms('Pau Víctor'), ['victor']);
  assert.deepEqual(nameSearchTerms('Pedri'), ['pedri']);
});

test('venues: stadium name + town first (OpenStreetMap), then the town, tennis by town only', () => {
  const q = geoQueries({ sport: 'football', venue: 'Celtic Park', city: 'Glasgow', country: 'Scotland' });
  assert.deepEqual(q[0], { via: 'osm', q: 'Celtic Park, Glasgow, Scotland', source: 'venue (OpenStreetMap)' });
  assert.equal(q[1].via, 'open-meteo');
  assert.equal(q[1].q, 'Glasgow');
  const noTown = geoQueries({ sport: 'football', venue: 'Aspmyra Stadion', city: null, country: 'Norway' });
  assert.equal(noTown[0].q, 'Aspmyra Stadion, Norway');
  assert.ok(noTown.some(x => x.via === 'open-meteo' && x.q === 'Aspmyra Stadion'));
  assert.equal(cleanCity('Saint Paul, Minnesota'), 'Saint Paul');
  assert.equal(cleanCity('Lima (Peru)'), 'Lima');
  const tennis = geoQueries({ sport: 'tennis', venue: 'Paris, France', city: 'Paris', country: 'France' });
  assert.ok(tennis.every(x => !x.q.includes('Paris, France, France')));
  assert.equal(tennis[0].q, 'Paris');
});
