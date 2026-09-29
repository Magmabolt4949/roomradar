import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { createApp } from '../src/server.js';

const app = createApp({ dbFile: ':memory:', presenceTimeoutMs: 300, sweepEveryMs: 100 });
await new Promise((r) => app.server.listen(0, r));
const base = `http://localhost:${app.server.address().port}`;
after(() => app.stop());

async function req(path, { method = 'GET', body, token, key } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token && { 'x-token': token }), ...(key && { 'x-host-key': key }) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

let eventId, hostKey, alice, bob;

test('organiser creates an event', async () => {
  const r = await req('/api/events', { method: 'POST', body: { name: 'Friday Mixer', zones: ['stage', 'terrace'] } });
  assert.equal(r.status, 201);
  eventId = r.body.event.id; hostKey = r.body.hostKey;
  assert.match(eventId, /^[A-Z2-9]{6}$/);
  assert.deepEqual(r.body.event.zones, ['Stage', 'Terrace']);
});

test('attendees check in and see each other, ranked with reasons', async () => {
  alice = (await req(`/api/events/${eventId}/checkin`, { method: 'POST', body: { name: 'Alice', interests: ['fintech'], lookingFor: ['design help'], canOffer: ['tech help'], contact: 'alice@example.com' } })).body;
  bob = (await req(`/api/events/${eventId}/checkin`, { method: 'POST', body: { name: 'Bob', interests: ['fintech'], lookingFor: ['tech help'], canOffer: ['design help'], contact: 'linkedin.com/in/bob' } })).body;
  const m = await req('/api/matches', { token: alice.token });
  assert.equal(m.body.matches[0].person.name, 'Bob');
  assert.match(m.body.matches[0].reasons[0], /help each other/);
  assert.equal(m.body.matches[0].person.contact, undefined, 'contact must stay private before a connection');
  const room = await req('/api/room', { token: alice.token });
  assert.equal(room.body.presentCount, 2);
});

test('a wave notifies in real time; a wave back connects and reveals contacts', async () => {
  const sock = ioc(base, { auth: { token: bob.token } });
  const gotWave = new Promise((r) => sock.on('wave', r));
  await new Promise((r) => sock.on('connect', r));
  const w1 = await req(`/api/wave/${bob.attendee.id}`, { method: 'POST', token: alice.token });
  assert.equal(w1.body.mutual, false);
  assert.equal((await gotWave).from.name, 'Alice');
  const w2 = await req(`/api/wave/${alice.attendee.id}`, { method: 'POST', token: bob.token });
  assert.equal(w2.body.mutual, true);
  assert.equal(w2.body.contact, 'alice@example.com');
  const inbox = await req('/api/inbox', { token: alice.token });
  assert.equal(inbox.body.connections[0].contact, 'linkedin.com/in/bob');
  sock.close();
});

test('organiser dashboard needs the host key and shows live stats', async () => {
  assert.equal((await req(`/api/host/${eventId}`, { key: 'wrong' })).status, 403);
  const d = await req(`/api/host/${eventId}`, { key: hostKey });
  assert.equal(d.body.stats.present, 2);
  assert.equal(d.body.stats.connections, 1);
  const csv = await req(`/api/host/${eventId}/export.csv?key=${hostKey}`);
  assert.match(csv.body, /Alice/);
});

test('people who go quiet are checked out automatically', async () => {
  await new Promise((r) => setTimeout(r, 700));
  const d = await req(`/api/host/${eventId}`, { key: hostKey });
  assert.equal(d.body.stats.present, 0);
  assert.equal(d.body.stats.left, 2);
});

test('rejects bad input with a clear message', async () => {
  const r = await req(`/api/events/${eventId}/checkin`, { method: 'POST', body: { name: '   ' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /name/);
  assert.equal((await req('/api/me', { token: 'nope' })).status, 401);
});
