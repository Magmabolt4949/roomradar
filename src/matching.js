/**
 * Matching engine.
 *
 * Scores how useful a conversation between two attendees is likely to be and
 * explains why in plain language. Pure functions only: no I/O, easy to test.
 *
 * Score components (weights in WEIGHTS):
 *   1. Complementary needs  – what A is looking for that B can offer, and vice versa.
 *      Two-way matches get a bonus because both people gain from the conversation.
 *   2. Shared interests     – weighted by rarity (IDF across the room), so two people
 *      who both love "quantum computing" score higher than two who both like "AI".
 *   3. Bio similarity       – TF-IDF cosine similarity over short bios.
 *   4. Small nudges         – different organisation (new connection, not a colleague),
 *      same zone of the room (easy to walk over right now).
 *
 * Complexity: scoring one person against n others is O(n · k), k = tags per profile,
 * after an O(n · k) IDF pass that is shared across all requests for the same snapshot.
 */

export const WEIGHTS = {
  needOneWay: 3.0,
  needTwoWayBonus: 2.0,
  sharedInterest: 1.6,
  bio: 2.0,
  differentOrg: 0.4,
  sameZone: 0.5,
};

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have i im in into is it its me my of on or our so that the their them they this to was we were with you your about also am can do just like love more most not now over really very will would work working'.split(' ')
);

/** Lower-case, trim and de-duplicate a list of tags. */
export function normaliseTags(tags = []) {
  const out = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (v) out.add(v);
  }
  return [...out];
}

/** Split free text into meaningful lower-case tokens. */
export function tokenize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Build the statistics the scorer needs for one snapshot of the room:
 * inverse document frequency for interest tags and for bio words.
 */
export function buildRoomStats(people) {
  const n = Math.max(people.length, 1);
  const tagDf = new Map();
  const wordDf = new Map();
  for (const p of people) {
    for (const t of new Set(normaliseTags(p.interests))) tagDf.set(t, (tagDf.get(t) || 0) + 1);
    for (const w of new Set(tokenize(p.bio))) wordDf.set(w, (wordDf.get(w) || 0) + 1);
  }
  const idf = (df) => Math.log(1 + n / df);
  return {
    size: n,
    tagIdf: (t) => idf(tagDf.get(t) || 1),
    tagCount: (t) => tagDf.get(t) || 0,
    wordIdf: (w) => idf(wordDf.get(w) || 1),
  };
}

function tfidfVector(text, stats) {
  const counts = new Map();
  for (const w of tokenize(text)) counts.set(w, (counts.get(w) || 0) + 1);
  const vec = new Map();
  for (const [w, c] of counts) vec.set(w, c * stats.wordIdf(w));
  return vec;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  for (const [k, v] of a) if (b.has(k)) dot += v * b.get(k);
  const norm = (m) => Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0));
  const d = norm(a) * norm(b);
  return d ? dot / d : 0;
}

function intersect(a, b) {
  const setB = new Set(normaliseTags(b));
  return normaliseTags(a).filter((x) => setB.has(x));
}

const NEED_PHRASES = {
  cofounder: 'a co-founder',
  hiring: 'people to hire',
  'job opportunities': 'job opportunities',
  mentorship: 'mentorship',
  investment: 'investment',
  feedback: 'feedback on an idea',
  collaborators: 'collaborators',
  'design help': 'design help',
  'tech help': 'tech help',
  customers: 'early customers',
};
const phrase = (need) => NEED_PHRASES[need] || need;

/**
 * Score how valuable it is for `me` to meet `other`.
 * Returns { score, reasons[], sharedInterests[], theyNeed[], youNeed[] }.
 */
export function scorePair(me, other, stats) {
  let score = 0;
  const reasons = [];

  // 1. Complementary needs.
  const youNeed = intersect(me.lookingFor, other.canOffer); // they can help me
  const theyNeed = intersect(other.lookingFor, me.canOffer); // I can help them
  score += WEIGHTS.needOneWay * (youNeed.length + theyNeed.length);
  if (youNeed.length && theyNeed.length) {
    score += WEIGHTS.needTwoWayBonus;
    reasons.push(`You can help each other: they offer ${phrase(youNeed[0])}, you offer ${phrase(theyNeed[0])}`);
  } else if (youNeed.length) {
    reasons.push(`They can offer ${phrase(youNeed[0])}, which you're looking for`);
  } else if (theyNeed.length) {
    reasons.push(`They're looking for ${phrase(theyNeed[0])}, which you can offer`);
  }

  // 2. Shared interests, weighted by rarity in this room.
  const shared = intersect(me.interests, other.interests).sort(
    (a, b) => stats.tagIdf(b) - stats.tagIdf(a)
  );
  const interestScore = shared.reduce((s, t) => s + stats.tagIdf(t), 0);
  score += WEIGHTS.sharedInterest * interestScore;
  if (shared.length) {
    const rare = shared[0];
    const fewOthers = stats.tagCount(rare) <= Math.max(2, Math.ceil(stats.size * 0.1));
    reasons.push(
      shared.length === 1
        ? fewOthers
          ? `You're two of only a few people here into ${rare}`
          : `You both care about ${rare}`
        : `You share ${shared.length} interests, including ${shared.slice(0, 2).join(' and ')}`
    );
  }

  // 3. Bio similarity.
  const bioSim = cosine(tfidfVector(me.bio, stats), tfidfVector(other.bio, stats));
  score += WEIGHTS.bio * bioSim;
  if (bioSim > 0.25 && reasons.length < 2) reasons.push('Your bios describe similar work');

  // Only real overlap makes someone a match; the nudges below just reorder matches.
  const substantive = score;

  // 4. Nudges.
  if (me.org && other.org && me.org.trim().toLowerCase() !== other.org.trim().toLowerCase()) {
    score += WEIGHTS.differentOrg;
  }
  if (me.zone && other.zone && me.zone === other.zone) {
    score += WEIGHTS.sameZone;
    reasons.push(`They're near you right now (${other.zone})`);
  }

  return {
    score: substantive > 0 ? Math.round(score * 100) / 100 : 0,
    reasons: reasons.slice(0, 3),
    sharedInterests: shared,
    youNeed,
    theyNeed,
  };
}

/**
 * Rank everyone present for `me`.
 * @param {object} me
 * @param {object[]} people  everyone currently in the room (may include `me`)
 * @param {object} [opts]    { limit, exclude: Set of ids already connected }
 */
export function rankMatches(me, people, opts = {}) {
  const { limit = 10, exclude = new Set() } = opts;
  const stats = opts.stats || buildRoomStats(people);
  const ranked = [];
  for (const other of people) {
    if (other.id === me.id || exclude.has(other.id)) continue;
    const result = scorePair(me, other, stats);
    if (result.score > 0) ranked.push({ person: other, ...result });
  }
  ranked.sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name));
  return ranked.slice(0, limit);
}

/**
 * A "wildcard" suggestion: the person with the rarest shared interest who is NOT
 * already in the top matches. Encourages serendipity instead of an echo chamber.
 */
export function wildcard(me, people, topIds, stats = buildRoomStats(people)) {
  let best = null;
  for (const other of people) {
    if (other.id === me.id || topIds.has(other.id)) continue;
    const shared = intersect(me.interests, other.interests);
    if (!shared.length) continue;
    const rarest = shared.sort((a, b) => stats.tagIdf(b) - stats.tagIdf(a))[0];
    const rarity = stats.tagIdf(rarest);
    if (!best || rarity > best.rarity) best = { person: other, rarity, topic: rarest };
  }
  return best && { person: best.person, reason: `A wildcard: you both mentioned ${best.topic}` };
}
