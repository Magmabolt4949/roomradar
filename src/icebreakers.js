/**
 * Conversation openers for a pair of attendees.
 *
 * Works with no setup: openers are built from what the two people actually share.
 * If ANTHROPIC_API_KEY is set, a model writes a more natural opener instead, with a
 * short timeout so a slow API never blocks the live event (we fall back silently).
 */

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

function seedOf(a, b) {
  let h = 0;
  for (const ch of a.id + b.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

export function templateIcebreakers(me, other, match) {
  const seed = seedOf(me, other);
  const lines = [];
  const first = other.name.split(' ')[0];

  if (match.theyNeed?.length) {
    lines.push(`"Hi ${first}, I saw you're looking for ${match.theyNeed[0]}. That's something I work on, happy to help."`);
  }
  if (match.youNeed?.length) {
    lines.push(`"Hi ${first}, I'm looking for ${match.youNeed[0]} and your profile says you can help. Got five minutes?"`);
  }
  if (match.sharedInterests?.length) {
    const topic = match.sharedInterests[0];
    lines.push(
      pick(
        [
          `"We're both into ${topic}. What got you started?"`,
          `"What's the most interesting thing you've seen in ${topic} lately?"`,
          `"I'm curious how you use ${topic} in your work at ${other.org || 'your place'}."`,
        ],
        seed
      )
    );
  }
  if (other.role) {
    lines.push(`"What does a typical week look like as ${/^[aeiou]/i.test(other.role) ? 'an' : 'a'} ${other.role}?"`);
  }
  return lines.slice(0, 3);
}

export async function aiIcebreaker(me, other, match, { apiKey = process.env.ANTHROPIC_API_KEY, timeoutMs = 4000 } = {}) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const prompt = `Two people are at a networking mixer. Write ONE friendly, specific opening line (max 25 words) that person A could say to person B. No emojis, no quotes.
A: ${me.name}, ${me.role || ''} at ${me.org || ''}. Interests: ${me.interests.join(', ')}. Looking for: ${me.lookingFor.join(', ')}. Offers: ${me.canOffer.join(', ')}.
B: ${other.name}, ${other.role || ''} at ${other.org || ''}. Interests: ${other.interests.join(', ')}. Looking for: ${other.lookingFor.join(', ')}. Offers: ${other.canOffer.join(', ')}. Bio: ${other.bio || ''}
Why they matched: ${match.reasons.join('; ')}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim();
    return text ? `"${text.replace(/^"|"$/g, '')}"` : null;
  } catch {
    return null; // timeout or network issue: templates are good enough
  } finally {
    clearTimeout(timer);
  }
}
