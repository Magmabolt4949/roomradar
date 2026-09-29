import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { openDb, publicProfile } from './db.js';
import { rankMatches, wildcard, buildRoomStats, normaliseTags } from './matching.js';
import { templateIcebreakers, aiIcebreaker } from './icebreakers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ dbFile, presenceTimeoutMs, sweepEveryMs } = {}) {
  const db = openDb(dbFile);
  const PRESENCE_TIMEOUT = presenceTimeoutMs ?? Number(process.env.PRESENCE_TIMEOUT_MIN || 15) * 60_000;
  const SWEEP_EVERY = sweepEveryMs ?? 60_000;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });

  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
  // Fonts are bundled, not loaded from Google, so the app works on flaky venue Wi-Fi.
  for (const pkg of ['bricolage-grotesque', 'atkinson-hyperlegible']) {
    app.use(`/fonts/${pkg}`, express.static(path.join(__dirname, '..', 'node_modules', '@fontsource', pkg, 'files'), { maxAge: '30d', immutable: true }));
  }

  // ---------- helpers ----------
  const clean = (s, max = 120) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
  const tags = (arr, max = 12) => normaliseTags(Array.isArray(arr) ? arr.map((t) => clean(t, 40)) : []).slice(0, max);
  const matchZone = (ev, z) => (typeof z === 'string' ? ev.zones.find((x) => x.toLowerCase() === z.trim().toLowerCase()) || null : null);
  const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  function auth(req, res, next) {
    const me = db.byToken(req.get('x-token') || '');
    if (!me) return res.status(401).json({ error: 'Your check-in has expired. Scan the event QR code to check in again.' });
    req.me = me;
    db.touch(me.id);
    next();
  }

  function hostAuth(req, res, next) {
    if (!db.checkHostKey(req.params.id, req.query.key || req.get('x-host-key'))) {
      return res.status(403).json({ error: 'This organiser link is not valid for this event.' });
    }
    req.event = db.getEvent(req.params.id);
    next();
  }

  // Debounced room broadcast: a check-in rush of 200 people sends a handful of
  // updates per second, not 200.
  const pending = new Map();
  function broadcastRoom(eventId) {
    if (pending.has(eventId)) return;
    pending.set(eventId, setTimeout(() => {
      pending.delete(eventId);
      io.to(`event:${eventId}`).emit('room:changed');
      io.to(`host:${eventId}`).emit('host:changed');
    }, 400));
  }

  // ---------- events ----------
  app.post('/api/events', (req, res) => {
    const name = clean(req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Give your event a name.' });
    const zones = tags(req.body.zones, 10).map((z) => z.replace(/\b\w/g, (c) => c.toUpperCase()));
    const ev = db.createEvent({ name, venue: clean(req.body.venue, 80), zones });
    const url = baseUrl(req);
    res.status(201).json({ event: { ...ev, hostKey: undefined }, hostKey: ev.hostKey, joinUrl: `${url}/e/${ev.id}`, hostUrl: `${url}/host/${ev.id}?key=${ev.hostKey}` });
  });

  app.get('/api/events/:id', (req, res) => {
    const ev = db.getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'No event with that code. Check the code on the poster at the entrance.' });
    res.json({ event: ev, presentCount: db.present(ev.id).length });
  });

  /** Aggregate-only view for the entrance screen: no names, so it's safe to display publicly. */
  app.get('/api/events/:id/pulse', (req, res) => {
    const ev = db.getEvent(req.params.id);
    if (!ev) return res.sendStatus(404);
    const present = db.present(ev.id);
    const counts = {};
    for (const a of present) for (const t of a.interests) counts[t] = (counts[t] || 0) + 1;
    res.json({
      event: ev,
      presentCount: present.length,
      topInterests: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5),
      connections: db.counts(ev.id).connections,
    });
  });

  app.get('/api/events/:id/qr.svg', async (req, res) => {
    const ev = db.getEvent(req.params.id);
    if (!ev) return res.sendStatus(404);
    const svg = await QRCode.toString(`${baseUrl(req)}/e/${ev.id}`, { type: 'svg', margin: 1, color: { dark: '#1B2340', light: '#FFFFFF' } });
    res.type('image/svg+xml').send(svg);
  });

  // ---------- attendee ----------
  app.post('/api/events/:id/checkin', (req, res) => {
    const ev = db.getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'No event with that code.' });
    const b = req.body || {};
    const name = clean(b.name, 60);
    if (!name) return res.status(400).json({ error: 'Add your name so people know who you are.' });
    const zone = matchZone(ev, b.zone);
    const { attendee, token } = db.checkIn(ev.id, {
      name, role: clean(b.role, 60), org: clean(b.org, 60), bio: clean(b.bio, 280),
      interests: tags(b.interests), lookingFor: tags(b.lookingFor, 5), canOffer: tags(b.canOffer, 5),
      wearing: clean(b.wearing, 80), emoji: clean(b.emoji, 8) || '👋', zone, contact: clean(b.contact, 120),
    });
    broadcastRoom(ev.id);
    res.status(201).json({ token, attendee });
  });

  app.get('/api/me', auth, (req, res) => {
    res.json({ me: req.me, event: db.getEvent(req.me.eventId) });
  });

  app.patch('/api/me', auth, (req, res) => {
    const ev = db.getEvent(req.me.eventId);
    const zone = req.body.zone === undefined ? undefined : matchZone(ev, req.body.zone);
    const me = db.updateAttendee(req.me.id, { zone, wearing: req.body.wearing === undefined ? undefined : clean(req.body.wearing, 80) });
    broadcastRoom(me.eventId);
    res.json({ me });
  });

  app.post('/api/me/leave', auth, (req, res) => {
    const me = db.setPresence(req.me, 'left');
    broadcastRoom(me.eventId);
    res.json({ me });
  });

  app.post('/api/me/return', auth, (req, res) => {
    const me = req.me.status === 'left' ? db.setPresence(req.me, 'present') : req.me;
    broadcastRoom(me.eventId);
    res.json({ me });
  });

  /** Everyone currently in the room, with my relationship to each. */
  app.get('/api/room', auth, (req, res) => {
    const me = req.me;
    const people = db.present(me.eventId);
    const wavedAt = db.wavedAt(me.id);
    const wavedMe = new Set(db.wavesTo(me.id).map((w) => w.from_id));
    const connected = new Set(db.connectionsOf(me.id).map((c) => c.otherId));
    const stats = buildRoomStats(people);
    const scores = new Map(rankMatches(me, people, { limit: people.length, stats }).map((m) => [m.person.id, m]));
    res.json({
      people: people.filter((p) => p.id !== me.id).map((p) => ({
        ...publicProfile(p),
        relation: connected.has(p.id) ? 'connected' : wavedMe.has(p.id) ? 'waved-at-you' : wavedAt.has(p.id) ? 'you-waved' : null,
        matchScore: scores.get(p.id)?.score || 0,
        topReason: scores.get(p.id)?.reasons[0] || null,
      })),
      presentCount: people.length,
    });
  });

  /** Ranked suggestions plus one wildcard, each with reasons and openers. */
  app.get('/api/matches', auth, (req, res) => {
    const me = req.me;
    const people = db.present(me.eventId);
    const stats = buildRoomStats(people);
    const connected = new Set(db.connectionsOf(me.id).map((c) => c.otherId));
    const wavedAt = db.wavedAt(me.id);
    const top = rankMatches(me, people, { limit: 8, exclude: connected, stats });
    const wc = wildcard(me, people, new Set([...top.map((m) => m.person.id), ...connected]), stats);
    res.json({
      matches: top.map((m) => ({
        person: publicProfile(m.person),
        score: m.score,
        reasons: m.reasons,
        icebreakers: templateIcebreakers(me, m.person, m),
        youWaved: wavedAt.has(m.person.id),
      })),
      wildcard: wc && { person: publicProfile(wc.person), reason: wc.reason, youWaved: wavedAt.has(wc.person.id) },
      aiAvailable: !!process.env.ANTHROPIC_API_KEY,
    });
  });

  app.get('/api/icebreaker/:otherId', auth, async (req, res) => {
    const other = db.byId(req.params.otherId);
    if (!other || other.eventId !== req.me.eventId) return res.sendStatus(404);
    const people = db.present(req.me.eventId);
    const [m] = rankMatches(req.me, [other], { stats: buildRoomStats(people) });
    const match = m || { reasons: [], sharedInterests: [], youNeed: [], theyNeed: [] };
    const line = (await aiIcebreaker(req.me, other, match)) || templateIcebreakers(req.me, other, match)[0];
    res.json({ line });
  });

  /** Wave at someone. If they already waved at you, you're connected and see each other's contact. */
  app.post('/api/wave/:otherId', auth, (req, res) => {
    const me = req.me;
    const other = db.byId(req.params.otherId);
    if (!other || other.eventId !== me.eventId || other.id === me.id) return res.status(404).json({ error: 'That person is not at this event.' });
    const { mutual } = db.wave(me.eventId, me.id, other.id);
    if (mutual) {
      io.to(`att:${other.id}`).emit('connection', { person: publicProfile(me), contact: me.contact });
      io.to(`att:${me.id}`).emit('connection', { person: publicProfile(other), contact: other.contact });
    } else {
      io.to(`att:${other.id}`).emit('wave', { from: publicProfile(me) });
    }
    broadcastRoom(me.eventId);
    res.json({ mutual, contact: mutual ? other.contact : undefined });
  });

  /** Waves waiting for a reply, and people you've connected with (contacts revealed). */
  app.get('/api/inbox', auth, (req, res) => {
    const me = req.me;
    const connections = db.connectionsOf(me.id).map((c) => {
      const p = db.byId(c.otherId);
      return { person: publicProfile(p), contact: p.contact, at: c.at };
    });
    const connectedIds = new Set(connections.map((c) => c.person.id));
    const waves = db.wavesTo(me.id)
      .filter((w) => !connectedIds.has(w.from_id))
      .map((w) => ({ person: publicProfile(db.byId(w.from_id)), at: w.created_at }));
    res.json({ waves, connections });
  });

  // ---------- organiser ----------
  app.get('/api/host/:id', hostAuth, (req, res) => {
    const ev = req.event;
    const everyone = db.all(ev.id);
    const present = everyone.filter((a) => a.status === 'present');
    const interestCounts = {};
    for (const a of present) for (const t of a.interests) interestCounts[t] = (interestCounts[t] || 0) + 1;
    const needCounts = {};
    for (const a of present) for (const t of a.lookingFor) needCounts[t] = (needCounts[t] || 0) + 1;
    const { waves, connections } = db.counts(ev.id);
    res.json({
      event: ev,
      stats: { present: present.length, checkedIn: everyone.length, left: everyone.length - present.length, waves, connections },
      topInterests: Object.entries(interestCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
      topNeeds: Object.entries(needCounts).sort((a, b) => b[1] - a[1]).slice(0, 6),
      timeline: db.timeline(ev.id),
      attendees: everyone.map((a) => ({ ...publicProfile(a) })),
    });
  });

  app.post('/api/host/:id/announce', hostAuth, (req, res) => {
    const text = clean(req.body.text, 200);
    db.setAnnouncement(req.event.id, text);
    io.to(`event:${req.event.id}`).emit('announcement', { text });
    res.json({ ok: true });
  });

  app.get('/api/host/:id/export.csv', hostAuth, (req, res) => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Name', 'Role', 'Organisation', 'Status', 'Checked in', 'Left', 'Interests', 'Looking for', 'Can offer']];
    for (const a of db.all(req.event.id)) {
      rows.push([a.name, a.role, a.org, a.status, new Date(a.checkedInAt).toISOString(), a.leftAt ? new Date(a.leftAt).toISOString() : '', a.interests.join('; '), a.lookingFor.join('; '), a.canOffer.join('; ')]);
    }
    res.type('text/csv').attachment(`attendance-${req.event.id}.csv`).send(rows.map((r) => r.map(esc).join(',')).join('\n'));
  });

  // Page routes (static HTML, data loaded client-side).
  app.get('/e/:id', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'event.html')));
  app.get('/e/:id/screen', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'screen.html')));
  app.get('/host/:id', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'host.html')));

  // ---------- real time ----------
  io.on('connection', (socket) => {
    const { token, eventId, hostKey } = socket.handshake.auth || {};
    if (token) {
      const me = db.byToken(token);
      if (!me) return socket.disconnect(true);
      socket.join([`event:${me.eventId}`, `att:${me.id}`]);
      db.touch(me.id);
      socket.on('heartbeat', () => db.touch(me.id));
    } else if (eventId && db.checkHostKey(eventId, hostKey)) {
      socket.join(`host:${String(eventId).toUpperCase()}`);
    } else if (eventId && db.getEvent(eventId)) {
      socket.join(`event:${String(eventId).toUpperCase()}`); // public entrance screen
    } else {
      socket.disconnect(true);
    }
  });

  // Anyone whose phone hasn't checked in for PRESENCE_TIMEOUT is treated as gone,
  // so the "who's here" list stays honest even if people forget to tap "I'm leaving".
  const sweeper = setInterval(() => {
    const changed = new Set();
    for (const a of db.staleAttendees(Date.now() - PRESENCE_TIMEOUT)) {
      db.setPresence(a, 'left');
      changed.add(a.eventId);
    }
    changed.forEach(broadcastRoom);
  }, SWEEP_EVERY);
  sweeper.unref();

  return { app, server, io, db, stop: () => { clearInterval(sweeper); io.close(); server.close(); db.raw.close(); } };
}

// Start when run directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createApp();
  server.listen(port, () => console.log(`RoomRadar running at http://localhost:${port}`));
}
