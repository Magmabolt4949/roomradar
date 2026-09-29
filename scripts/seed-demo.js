/**
 * Fill a running RoomRadar server with a realistic demo event.
 *
 *   npm start                       # in one terminal
 *   npm run seed                    # in another: creates the event and prints links
 *   npm run seed -- --live          # checks people in one by one (great for a demo video)
 *   npm run seed -- --url http://192.168.1.5:3000
 *
 * Uses the public API, so everything shows up in real time on open screens.
 */
const args = process.argv.slice(2);
const base = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:3000';
const live = args.includes('--live');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PEOPLE = [
  ['Aisha Khan', 'Founder', 'PaySetu', '🚀', 'Mustard kurta', ['fintech', 'upi', 'd2c brands'], ['design help', 'investment'], ['feedback'], 'Building UPI payments for college canteens.'],
  ['Rohan Mehta', 'ML engineer', 'VaaniAI', '🎸', 'Black band tee', ['ai', 'music', 'open source'], ['collaborators'], ['tech help', 'mentorship'], 'Training speech models for Indian languages; weekend guitarist.'],
  ['Priya Nair', 'Product designer', 'Freelance', '🎨', 'Green blazer', ['product design', 'edtech', 'fintech'], ['job opportunities'], ['design help'], 'Designing onboarding flows for first-time smartphone users.'],
  ['Kabir Singh', 'Angel investor', '', '☕', 'Grey hoodie', ['saas', 'fintech', 'climate'], ['customers'], ['investment', 'mentorship'], 'Backed 12 pre-seed startups; ex-founder of a logistics SaaS.'],
  ['Meera Iyer', 'Growth lead', 'Hoppr', '⚡', 'Red sneakers', ['marketing', 'content creation', 'd2c brands'], ['collaborators'], ['feedback', 'customers'], 'Grew a D2C snack brand from 0 to 40k customers on Instagram.'],
  ['Arjun Rao', 'Student, CS', 'BITS Pilani', '📚', 'Navy college jacket', ['ai', 'robotics', 'gaming'], ['mentorship', 'job opportunities'], ['tech help'], 'Building a line-following robot and a Discord bot for my hostel.'],
  ['Sana Qureshi', 'Climate researcher', 'IISc', '🌱', 'White linen shirt', ['climate', 'deep tech', 'ai'], ['cofounder'], ['feedback'], 'Working on low-cost soil sensors for smallholder farmers.'],
  ['Dev Patel', 'Full-stack developer', 'Zeta Labs', '🛠️', 'Blue denim jacket', ['saas', 'open source', 'web3'], ['cofounder'], ['tech help'], 'Looking for a business co-founder for a B2B SaaS idea.'],
  ['Ishita Bose', 'Community manager', 'Founder Circle', '👋', 'Yellow dress', ['content creation', 'edtech', 'marketing'], ['collaborators'], ['customers', 'feedback'], 'I run founder meetups in three cities.'],
  ['Vikram Shah', 'Head of talent', 'PayGrid', '🏀', 'Striped polo', ['fintech', 'hiring', 'saas'], ['hiring'], ['job opportunities', 'mentorship'], 'Hiring designers and backend engineers this quarter.'],
  ['Nisha Verma', 'Founder', 'TaalBox', '🎧', 'Purple scarf', ['music', 'edtech', 'ai'], ['investment', 'tech help'], ['feedback'], 'An AI practice partner for guitar and vocals, built for India.'],
  ['Farhan Ali', 'Data analyst', 'QuickBite', '🧠', 'Round glasses', ['ai', 'd2c brands', 'gaming'], ['job opportunities'], ['tech help'], 'SQL, dashboards and a lot of chai.'],
  ['Tanvi Joshi', 'VC associate', 'Seed fund', '🚀', 'Beige trench coat', ['deep tech', 'climate', 'healthtech'], ['customers'], ['investment', 'feedback'], 'Looking at climate and health startups at pre-seed.'],
  ['Karan Malhotra', 'Founder', 'MedLoop', '⚡', 'Black turtleneck', ['healthtech', 'ai', 'saas'], ['investment', 'hiring'], ['mentorship'], 'Clinic software used by 300 doctors in Tier-2 cities.'],
  ['Ananya Das', 'UX researcher', 'ShopKart', '🎨', 'Orange headband', ['product design', 'healthtech', 'music'], ['collaborators'], ['design help', 'feedback'], 'I talk to users for a living.'],
  ['Rahul Gupta', 'Blockchain developer', 'Independent', '🛠️', 'Green cap', ['web3', 'open source', 'fintech'], ['customers'], ['tech help'], 'Building open-source tools for on-chain payments.'],
  ['Zoya Mirza', 'Student, design', 'NID', '🎨', 'Tote bag with patches', ['product design', 'content creation', 'gaming'], ['job opportunities', 'mentorship'], ['design help'], 'Looking for a summer internship in product design.'],
  ['Siddharth Kulkarni', 'CTO', 'Kheti AI', '🌱', 'Khaki jacket', ['climate', 'ai', 'robotics'], ['hiring'], ['tech help', 'mentorship'], 'Drones and computer vision for crop health.'],
  ['Pooja Reddy', 'Marketing lead', 'EdStart', '📚', 'Pink kurta', ['edtech', 'marketing', 'content creation'], ['design help'], ['customers'], 'Marketing test-prep courses to 2M students.'],
  ['Neel Chatterjee', 'Quant researcher', 'Trading firm', '🧠', 'White shirt, no tie', ['fintech', 'deep tech', 'music'], ['collaborators'], ['mentorship'], 'Maths, markets and a little bit of piano.'],
];

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const zones = ['Entrance', 'Stage', 'Food counter', 'Terrace'];
const ev = await post('/api/events', { name: "Founders' Friday Mixer", venue: 'Rooftop, Innovation Hub', zones });
console.log(`\nEvent created: ${ev.event.name} (code ${ev.event.id})\n`);
console.log(`  Check in (open on your phone):  ${ev.joinUrl}`);
console.log(`  Organiser dashboard:            ${ev.hostUrl}`);
console.log(`  Entrance screen:                ${base}/e/${ev.event.id}/screen\n`);

const tokens = [];
for (const [i, [name, role, org, emoji, wearing, interests, lookingFor, canOffer, bio]] of PEOPLE.entries()) {
  const r = await post(`/api/events/${ev.event.id}/checkin`, {
    name, role, org, emoji, wearing, interests, lookingFor, canOffer, bio,
    zone: ev.event.zones[i % ev.event.zones.length], contact: `linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}`,
  });
  tokens.push(r);
  process.stdout.write(`  ✓ ${name}\n`);
  if (live) await sleep(2500);
}

// A few waves and connections so the dashboard and inboxes aren't empty.
const wave = (a, b) => post(`/api/wave/${tokens[b].attendee.id}`, {}, { 'x-token': tokens[a].token });
await wave(0, 2); await wave(2, 0);   // Aisha ↔ Priya connected
await wave(7, 3);                      // Dev waved at Kabir
await wave(10, 3); await wave(3, 10); // Nisha ↔ Kabir connected
await wave(5, 9);                      // Arjun waved at Vikram
console.log('\nDone. Open the check-in link on your phone and check in as yourself to see your matches.\n');
