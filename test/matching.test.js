import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePair, rankMatches, buildRoomStats, wildcard, tokenize, normaliseTags } from '../src/matching.js';

const person = (id, over = {}) => ({ id, name: id, org: 'Org ' + id, bio: '', interests: [], lookingFor: [], canOffer: [], ...over });

test('normaliseTags lower-cases, trims and de-duplicates', () => {
  assert.deepEqual(normaliseTags([' AI ', 'ai', 'Product  Design', '', 5]), ['ai', 'product design']);
});

test('tokenize drops stopwords and short words', () => {
  assert.deepEqual(tokenize('I am building a UPI app for the canteen'), ['building', 'upi', 'app', 'canteen']);
});

test('two-way complementary needs outrank one-way needs', () => {
  const me = person('me', { lookingFor: ['design help'], canOffer: ['tech help'] });
  const twoWay = person('two', { lookingFor: ['tech help'], canOffer: ['design help'] });
  const oneWay = person('one', { canOffer: ['design help'] });
  const stats = buildRoomStats([me, twoWay, oneWay]);
  const a = scorePair(me, twoWay, stats);
  const b = scorePair(me, oneWay, stats);
  assert.ok(a.score > b.score);
  assert.match(a.reasons[0], /help each other/);
});

test('a rare shared interest counts for more than a common one', () => {
  const crowd = Array.from({ length: 8 }, (_, i) => person('c' + i, { interests: ['ai'] }));
  const me = person('me', { interests: ['ai', 'quantum computing'] });
  const common = person('common', { interests: ['ai'] });
  const rare = person('rare', { interests: ['quantum computing'] });
  const stats = buildRoomStats([me, common, rare, ...crowd]);
  assert.ok(scorePair(me, rare, stats).score > scorePair(me, common, stats).score);
});

test('rankMatches excludes me and already-connected people, sorted by score', () => {
  const me = person('me', { interests: ['fintech'], lookingFor: ['investment'] });
  const vc = person('vc', { canOffer: ['investment'], interests: ['fintech'] });
  const peer = person('peer', { interests: ['fintech'] });
  const stranger = person('x', { interests: ['gardening'] });
  const ranked = rankMatches(me, [me, vc, peer, stranger]);
  assert.deepEqual(ranked.map((r) => r.person.id), ['vc', 'peer']);
  const withoutVc = rankMatches(me, [me, vc, peer], { exclude: new Set(['vc']) });
  assert.deepEqual(withoutVc.map((r) => r.person.id), ['peer']);
});

test('reasons are human-readable and capped at three', () => {
  const me = person('me', { interests: ['music', 'ai'], lookingFor: ['cofounder'], canOffer: ['tech help'], zone: 'Terrace' });
  const other = person('o', { interests: ['music', 'ai'], lookingFor: ['tech help'], canOffer: ['cofounder'], zone: 'Terrace' });
  const r = scorePair(me, other, buildRoomStats([me, other]));
  assert.ok(r.reasons.length <= 3);
  assert.ok(r.reasons.every((s) => typeof s === 'string' && s.length > 10));
});

test('wildcard picks someone outside the top list with a rare shared interest', () => {
  const me = person('me', { interests: ['ai', 'birdwatching'] });
  const top = person('top', { interests: ['ai'] });
  const bird = person('bird', { interests: ['birdwatching'] });
  const w = wildcard(me, [me, top, bird], new Set(['top']));
  assert.equal(w.person.id, 'bird');
  assert.match(w.reason, /birdwatching/);
});

test('scales: ranking one person against 5,000 attendees stays fast', () => {
  const tags = ['ai', 'fintech', 'music', 'climate', 'web3', 'design', 'saas', 'robotics'];
  const needs = ['hiring', 'mentorship', 'investment', 'feedback'];
  const people = Array.from({ length: 5000 }, (_, i) => person('p' + i, {
    interests: [tags[i % 8], tags[(i * 3) % 8]], lookingFor: [needs[i % 4]], canOffer: [needs[(i + 1) % 4]], bio: `builder of ${tags[i % 8]} products`,
  }));
  const t0 = performance.now();
  const stats = buildRoomStats(people);
  rankMatches(people[0], people, { stats });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
