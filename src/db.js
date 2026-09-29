/**
 * Storage layer (SQLite via better-sqlite3).
 *
 * Every query the app uses lives here, so swapping to Postgres for a large
 * deployment means rewriting one file. WAL mode lets reads continue while a
 * write is in progress, which matters at the check-in rush.
 */
import Database from 'better-sqlite3';
import { customAlphabet } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';

const eventCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6); // no 0/O/1/I confusion
const secret = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 24);

export const BADGE_COLORS = ['#E63946', '#2A9D8F', '#F4A261', '#6A4C93', '#1D70A2', '#E76F9E', '#3D8B37', '#C9832E'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,            -- short join code, e.g. K7PQ2M
  name TEXT NOT NULL,
  venue TEXT,
  zones TEXT NOT NULL DEFAULT '[]',   -- JSON array of areas in the room
  host_key TEXT NOT NULL,
  announcement TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,         -- private key stored on the attendee's phone
  name TEXT NOT NULL,
  role TEXT, org TEXT, bio TEXT,
  interests TEXT NOT NULL DEFAULT '[]',
  looking_for TEXT NOT NULL DEFAULT '[]',
  can_offer TEXT NOT NULL DEFAULT '[]',
  wearing TEXT,                       -- "Blue denim jacket" – helps people find you
  emoji TEXT NOT NULL DEFAULT '👋',
  color TEXT NOT NULL,
  zone TEXT,
  contact TEXT,                       -- shared only after a mutual connection
  status TEXT NOT NULL DEFAULT 'present',   -- present | left
  checked_in_at INTEGER NOT NULL,
  left_at INTEGER,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_event_status ON attendees(event_id, status);
CREATE TABLE IF NOT EXISTS waves (
  event_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS connections (
  event_id TEXT NOT NULL,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
CREATE TABLE IF NOT EXISTS checkins (   -- append-only log for the attendance timeline
  event_id TEXT NOT NULL,
  attendee_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- in | out
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkins_event ON checkins(event_id, at);
`;

const JSON_FIELDS = ['interests', 'looking_for', 'can_offer'];

function rowToAttendee(row) {
  if (!row) return null;
  const a = { ...row };
  for (const f of JSON_FIELDS) a[f] = JSON.parse(a[f] || '[]');
  return {
    id: a.id, eventId: a.event_id, name: a.name, role: a.role, org: a.org, bio: a.bio,
    interests: a.interests, lookingFor: a.looking_for, canOffer: a.can_offer,
    wearing: a.wearing, emoji: a.emoji, color: a.color, zone: a.zone, contact: a.contact,
    status: a.status, checkedInAt: a.checked_in_at, leftAt: a.left_at, lastSeen: a.last_seen,
  };
}

/** Fields safe to show other attendees (no token, no contact). */
export function publicProfile(a) {
  if (!a) return null;
  const { contact, ...rest } = a;
  return rest;
}

export function openDb(file = process.env.DB_FILE || 'data/roomradar.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const q = {
    insertEvent: db.prepare(`INSERT INTO events (id,name,venue,zones,host_key,created_at) VALUES (@id,@name,@venue,@zones,@host_key,@created_at)`),
    getEvent: db.prepare(`SELECT * FROM events WHERE id = ?`),
    setAnnouncement: db.prepare(`UPDATE events SET announcement = ? WHERE id = ?`),
    insertAttendee: db.prepare(`INSERT INTO attendees
      (id,event_id,token,name,role,org,bio,interests,looking_for,can_offer,wearing,emoji,color,zone,contact,status,checked_in_at,last_seen)
      VALUES (@id,@event_id,@token,@name,@role,@org,@bio,@interests,@looking_for,@can_offer,@wearing,@emoji,@color,@zone,@contact,'present',@now,@now)`),
    byToken: db.prepare(`SELECT * FROM attendees WHERE token = ?`),
    byId: db.prepare(`SELECT * FROM attendees WHERE id = ?`),
    present: db.prepare(`SELECT * FROM attendees WHERE event_id = ? AND status = 'present' ORDER BY checked_in_at DESC`),
    all: db.prepare(`SELECT * FROM attendees WHERE event_id = ? ORDER BY checked_in_at`),
    countByColor: db.prepare(`SELECT COUNT(*) AS n FROM attendees WHERE event_id = ?`),
    touch: db.prepare(`UPDATE attendees SET last_seen = ? WHERE id = ?`),
    setStatus: db.prepare(`UPDATE attendees SET status = @status, left_at = @left_at, last_seen = @now WHERE id = @id`),
    update: db.prepare(`UPDATE attendees SET zone = COALESCE(@zone, zone), wearing = COALESCE(@wearing, wearing) WHERE id = @id`),
    stale: db.prepare(`SELECT * FROM attendees WHERE status = 'present' AND last_seen < ?`),
    logCheckin: db.prepare(`INSERT INTO checkins (event_id, attendee_id, kind, at) VALUES (?,?,?,?)`),
    timeline: db.prepare(`SELECT kind, at FROM checkins WHERE event_id = ? ORDER BY at`),
    insertWave: db.prepare(`INSERT OR IGNORE INTO waves (event_id, from_id, to_id, created_at) VALUES (?,?,?,?)`),
    hasWave: db.prepare(`SELECT 1 FROM waves WHERE from_id = ? AND to_id = ?`),
    wavesTo: db.prepare(`SELECT from_id, created_at FROM waves WHERE to_id = ? ORDER BY created_at DESC`),
    wavesFrom: db.prepare(`SELECT to_id FROM waves WHERE from_id = ?`),
    insertConn: db.prepare(`INSERT OR IGNORE INTO connections (event_id, a_id, b_id, created_at) VALUES (?,?,?,?)`),
    connsOf: db.prepare(`SELECT a_id, b_id, created_at FROM connections WHERE a_id = ? OR b_id = ?`),
    countWaves: db.prepare(`SELECT COUNT(*) AS n FROM waves WHERE event_id = ?`),
    countConns: db.prepare(`SELECT COUNT(*) AS n FROM connections WHERE event_id = ?`),
  };

  return {
    raw: db,

    createEvent({ name, venue, zones }) {
      let id;
      do { id = eventCode(); } while (q.getEvent.get(id));
      const ev = { id, name, venue: venue || '', zones: JSON.stringify(zones || []), host_key: secret(), created_at: Date.now() };
      q.insertEvent.run(ev);
      return this.getEvent(id, true);
    },

    getEvent(id, includeKey = false) {
      const e = q.getEvent.get(String(id || '').toUpperCase());
      if (!e) return null;
      const ev = { id: e.id, name: e.name, venue: e.venue, zones: JSON.parse(e.zones), announcement: e.announcement, createdAt: e.created_at };
      if (includeKey) ev.hostKey = e.host_key;
      return ev;
    },

    checkHostKey(eventId, key) {
      const e = q.getEvent.get(String(eventId || '').toUpperCase());
      return !!e && typeof key === 'string' && e.host_key === key;
    },

    setAnnouncement(eventId, text) { q.setAnnouncement.run(text || null, eventId); },

    checkIn(eventId, p) {
      const now = Date.now();
      const n = q.countByColor.get(eventId).n;
      const row = {
        id: secret().slice(0, 12),
        event_id: eventId,
        token: secret(),
        name: p.name, role: p.role || '', org: p.org || '', bio: p.bio || '',
        interests: JSON.stringify(p.interests || []),
        looking_for: JSON.stringify(p.lookingFor || []),
        can_offer: JSON.stringify(p.canOffer || []),
        wearing: p.wearing || '', emoji: p.emoji || '👋',
        color: BADGE_COLORS[n % BADGE_COLORS.length], // spread colours evenly across the room
        zone: p.zone || null, contact: p.contact || '', now,
      };
      q.insertAttendee.run(row);
      q.logCheckin.run(eventId, row.id, 'in', now);
      return { attendee: rowToAttendee(q.byId.get(row.id)), token: row.token };
    },

    byToken: (token) => rowToAttendee(q.byToken.get(token)),
    byId: (id) => rowToAttendee(q.byId.get(id)),
    present: (eventId) => q.present.all(eventId).map(rowToAttendee),
    all: (eventId) => q.all.all(eventId).map(rowToAttendee),
    touch: (id) => q.touch.run(Date.now(), id),

    setPresence(a, status) {
      const now = Date.now();
      q.setStatus.run({ id: a.id, status, left_at: status === 'left' ? now : null, now });
      q.logCheckin.run(a.eventId, a.id, status === 'left' ? 'out' : 'in', now);
      return rowToAttendee(q.byId.get(a.id));
    },

    updateAttendee(id, { zone, wearing }) {
      q.update.run({ id, zone: zone ?? null, wearing: wearing ?? null });
      return rowToAttendee(q.byId.get(id));
    },

    staleAttendees: (cutoff) => q.stale.all(cutoff).map(rowToAttendee),
    timeline: (eventId) => q.timeline.all(eventId),

    /** Record a wave. Returns { mutual } – true if the other person had already waved back. */
    wave(eventId, fromId, toId) {
      const now = Date.now();
      q.insertWave.run(eventId, fromId, toId, now);
      const mutual = !!q.hasWave.get(toId, fromId);
      if (mutual) {
        const [a, b] = [fromId, toId].sort();
        q.insertConn.run(eventId, a, b, now);
      }
      return { mutual };
    },

    wavesTo: (id) => q.wavesTo.all(id),
    wavedAt: (id) => new Set(q.wavesFrom.all(id).map((r) => r.to_id)),
    connectionsOf(id) {
      return q.connsOf.all(id, id).map((c) => ({ otherId: c.a_id === id ? c.b_id : c.a_id, at: c.created_at }));
    },
    counts: (eventId) => ({ waves: q.countWaves.get(eventId).n, connections: q.countConns.get(eventId).n }),
  };
}
