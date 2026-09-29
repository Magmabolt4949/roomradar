import { api, esc, ago, chipGroup, toast, NEEDS, SUGGESTED_INTERESTS, EMOJIS } from '/common.js';

const code = location.pathname.split('/')[2].toUpperCase();
const TOKEN_KEY = `rr-token-${code}`;
const view = document.getElementById('view');
const tabs = document.getElementById('tabs');

const state = { token: localStorage.getItem(TOKEN_KEY), me: null, event: null, tab: 'meet', room: [], filter: { q: '', zone: '' } };
const call = (path, opts = {}) => api(path, { ...opts, token: state.token });

// ---------------- boot ----------------
async function boot() {
  let ev;
  try { ev = (await api(`/api/events/${code}`)).event; }
  catch (e) { view.innerHTML = `<div class="error">${esc(e.message)}</div><a class="btn" href="/">Enter a different code</a>`; return; }
  state.event = ev;
  document.title = `${ev.name} · RoomRadar`;
  if (state.token) {
    try { const r = await call('/api/me'); state.me = r.me; return startApp(); }
    catch { localStorage.removeItem(TOKEN_KEY); state.token = null; }
  }
  renderCheckIn();
}

// ---------------- check-in ----------------
function renderCheckIn() {
  const ev = state.event;
  const interests = new Set(), lookingFor = new Set(), canOffer = new Set();
  let emoji = EMOJIS[0];
  view.innerHTML = `
    <h1>${esc(ev.name)}</h1>
    <p class="muted">${esc(ev.venue || '')}</p>
    <p>Tell people a little about yourself. It takes a minute, and it's how we work out who you should meet.</p>
    <form id="ci" novalidate>
      <label for="name">Your name</label><input id="name" type="text" maxlength="60" autocomplete="name" required>
      <div class="grid2">
        <div><label for="role">What you do</label><input id="role" type="text" maxlength="60" placeholder="Product designer"></div>
        <div><label for="org">Where <span class="hint">company, college or club</span></label><input id="org" type="text" maxlength="60" placeholder="BITS Pilani"></div>
      </div>
      <label>Pick a badge emoji</label><div class="chips" id="emoji"></div>
      <label for="wearing">What are you wearing? <span class="hint">so people can find you</span></label>
      <input id="wearing" type="text" maxlength="80" placeholder="Olive jacket, white sneakers">
      ${ev.zones.length ? `<label for="zone">Where are you now?</label><select id="zone"><option value="">Just arrived</option>${ev.zones.map((z) => `<option>${esc(z)}</option>`).join('')}</select>` : ''}
      <label>Interests <span class="hint">tap any, or add your own</span></label>
      <div class="chips" id="interests"></div>
      <div style="display:flex;gap:8px;margin-top:8px"><input id="custom" type="text" maxlength="40" placeholder="Add an interest"><button type="button" class="btn ghost small" id="add">Add</button></div>
      <label>Looking for <span class="hint">up to 3</span></label><div class="chips" id="looking"></div>
      <label>Can help with <span class="hint">up to 3</span></label><div class="chips" id="offer"></div>
      <label for="bio">One line about you <span class="hint">optional</span></label>
      <textarea id="bio" maxlength="280" placeholder="Building a UPI app for college canteens; ex-intern at a fintech startup."></textarea>
      <label for="contact">LinkedIn or email <span class="hint">only shown to people you both wave at</span></label>
      <input id="contact" type="text" maxlength="120" placeholder="linkedin.com/in/yourname">
      <div id="err"></div>
      <button class="btn full" style="margin-top:18px">Check in</button>
    </form>`;
  const emojiEl = document.getElementById('emoji');
  const drawEmoji = () => {
    emojiEl.innerHTML = EMOJIS.map((e) => `<button type="button" class="chip" aria-pressed="${e === emoji}" data-v="${e}" aria-label="${e}">${e}</button>`).join('');
  };
  drawEmoji();
  emojiEl.onclick = (e) => { const b = e.target.closest('.chip'); if (b) { emoji = b.dataset.v; drawEmoji(); } };
  const interestOpts = [...SUGGESTED_INTERESTS];
  const drawInterests = () => chipGroup(document.getElementById('interests'), interestOpts, interests, { max: 10 });
  drawInterests();
  document.getElementById('add').onclick = () => {
    const input = document.getElementById('custom');
    const v = input.value.trim().toLowerCase();
    if (v && !interestOpts.includes(v)) interestOpts.unshift(v);
    if (v) interests.add(v);
    input.value = '';
    drawInterests();
  };
  chipGroup(document.getElementById('looking'), NEEDS, lookingFor, { max: 3 });
  chipGroup(document.getElementById('offer'), NEEDS, canOffer, { max: 3 });

  document.getElementById('ci').onsubmit = async (e) => {
    e.preventDefault();
    const val = (id) => document.getElementById(id)?.value || '';
    const err = document.getElementById('err');
    if (!val('name').trim()) { err.innerHTML = '<div class="error">Add your name so people know who you are.</div>'; return; }
    if (!interests.size && !lookingFor.size) { err.innerHTML = '<div class="error">Pick at least one interest or something you\'re looking for, so we can suggest people.</div>'; return; }
    try {
      const r = await api(`/api/events/${code}/checkin`, { method: 'POST', body: {
        name: val('name'), role: val('role'), org: val('org'), wearing: val('wearing'), zone: val('zone'),
        bio: val('bio'), contact: val('contact'), emoji,
        interests: [...interests], lookingFor: [...lookingFor], canOffer: [...canOffer],
      }});
      state.token = r.token; state.me = r.attendee;
      localStorage.setItem(TOKEN_KEY, r.token);
      startApp();
    } catch (x) { err.innerHTML = `<div class="error">${esc(x.message)}</div>`; }
  };
}

// ---------------- app ----------------
let socket;
function startApp() {
  tabs.hidden = false;
  tabs.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); };
  socket = io({ auth: { token: state.token } });
  let refreshTimer;
  socket.on('room:changed', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (state.tab !== 'me') show(state.tab, { quiet: true }); refreshInboxCount(); }, 300); });
  socket.on('wave', ({ from }) => {
    const t = toast(`<strong>${esc(from.emoji)} ${esc(from.name)}</strong> waved at you. <button class="btn small" id="wb">Wave back</button>`, { ms: 9000 });
    t.querySelector('#wb').onclick = () => wave(from.id).then(() => t.remove());
    navigator.vibrate?.(120);
    refreshInboxCount();
  });
  socket.on('connection', ({ person }) => {
    toast(`🎉 You and <strong>${esc(person.name)}</strong> are connected. Their contact is in Waves.`);
    navigator.vibrate?.([80, 60, 80]);
    refreshInboxCount();
    if (state.tab === 'inbox') show('inbox', { quiet: true });
  });
  socket.on('announcement', ({ text }) => { state.event.announcement = text; if (text) toast(`📣 ${esc(text)}`, { ms: 9000 }); });
  // Presence heartbeat: keeps you listed as "here"; after 15 quiet minutes you're treated as gone.
  setInterval(() => socket.emit('heartbeat'), 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { socket.emit('heartbeat'); show(state.tab, { quiet: true }); } });
  show('meet');
  refreshInboxCount();
}

function selectTab(tab) {
  state.tab = tab;
  tabs.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
}

async function show(tab, { quiet } = {}) {
  selectTab(tab);
  if (!quiet) view.innerHTML = '<p class="empty">Loading…</p>';
  try {
    if (tab === 'meet') await renderMeet();
    if (tab === 'room') await renderRoom();
    if (tab === 'inbox') await renderInbox();
    if (tab === 'me') renderMe();
  } catch (e) {
    if (e.status === 401) { localStorage.removeItem(TOKEN_KEY); location.reload(); return; }
    view.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function header(title) {
  const a = state.event.announcement ? `<div class="notice">📣 ${esc(state.event.announcement)}</div>` : '';
  const away = state.me.status === 'left' ? `<div class="notice">You're marked as gone. <button class="btn small" id="back">I'm back</button></div>` : '';
  return `${a}${away}<div class="topbar"><h2 style="margin:0">${title}</h2><span class="live small">${esc(state.event.name)}</span></div>`;
}
function bindBack() { document.getElementById('back')?.addEventListener('click', async () => { state.me = (await call('/api/me/return', { method: 'POST' })).me; show(state.tab); }); }

function badge(p, { reasons = [], opener, actions = '' } = {}) {
  const meta = [p.zone && `📍 ${esc(p.zone)}`, p.wearing && `👕 ${esc(p.wearing)}`].filter(Boolean).join('</span><span>');
  return `<article class="badge" style="--c:${esc(p.color)}">
    <div class="avatar" aria-hidden="true">${esc(p.emoji)}</div>
    <div class="badge-top"><span class="hello">Hello, I'm</span></div>
    <div class="badge-body">
      <p class="name">${esc(p.name)}</p>
      <p class="role">${esc([p.role, p.org].filter(Boolean).join(' at '))}</p>
      ${meta ? `<div class="meta"><span>${meta}</span></div>` : ''}
      ${reasons.length ? `<ul class="why">${reasons.map((r) => `<li><mark>${esc(r)}</mark></li>`).join('')}</ul>` : ''}
      ${opener ? `<p class="opener" data-opener="${esc(p.id)}">${esc(opener)}</p>` : ''}
      <div class="actions">${actions}</div>
    </div></article>`;
}

function waveButton(id, waved) {
  return waved
    ? `<button class="btn small done" disabled>Waved 👋</button>`
    : `<button class="btn small" data-wave="${esc(id)}">Wave 👋</button>`;
}

async function renderMeet() {
  const r = await call('/api/matches');
  const cards = r.matches.map((m) => badge(m.person, {
    reasons: m.reasons, opener: m.icebreakers[0],
    actions: `${waveButton(m.person.id, m.youWaved)}<button class="btn small ghost" data-spot="${esc(m.person.id)}">Find them</button>${r.aiAvailable ? `<button class="btn small ghost" data-ai="${esc(m.person.id)}">New opener</button>` : ''}`,
  })).join('');
  const wc = r.wildcard ? `<h3 style="margin-top:22px">Someone different</h3>${badge(r.wildcard.person, { reasons: [r.wildcard.reason], actions: `${waveButton(r.wildcard.person.id, r.wildcard.youWaved)}<button class="btn small ghost" data-spot="${esc(r.wildcard.person.id)}">Find them</button>` })}` : '';
  view.innerHTML = header('People to meet') +
    (r.matches.length
      ? `<p class="muted">Ranked by how much you can help each other. Only people in the room right now.</p>${cards}${wc}`
      : `<div class="empty"><p>No strong matches yet. As more people check in, suggestions appear here.</p><button class="btn ghost" data-go="room">See who's here</button></div>`);
  bindBack();
  bindCardActions(r.matches.map((m) => m.person).concat(r.wildcard ? [r.wildcard.person] : []));
}

function bindCardActions(people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  view.querySelectorAll('[data-wave]').forEach((b) => (b.onclick = async () => { b.disabled = true; await wave(b.dataset.wave); b.textContent = 'Waved 👋'; b.classList.add('done'); }));
  view.querySelectorAll('[data-spot]').forEach((b) => (b.onclick = () => spotMe(byId.get(b.dataset.spot))));
  view.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go)));
  view.querySelectorAll('[data-ai]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Thinking…';
    const { line } = await call(`/api/icebreaker/${b.dataset.ai}`);
    const el = view.querySelector(`[data-opener="${CSS.escape(b.dataset.ai)}"]`);
    if (el) el.textContent = line;
    b.textContent = 'New opener'; b.disabled = false;
  }));
}

async function wave(id) {
  const r = await call(`/api/wave/${id}`, { method: 'POST' });
  if (!r.mutual) toast('Wave sent. If they wave back, you\'ll both see each other\'s contact.');
  refreshInboxCount();
  return r;
}

async function renderRoom() {
  const r = await call('/api/room');
  state.room = r.people;
  const zones = state.event.zones;
  view.innerHTML = header(`${r.presentCount} here now`) + `
    <input type="search" id="q" placeholder="Search by name, role, company or interest" value="${esc(state.filter.q)}" aria-label="Search people">
    ${zones.length ? `<div class="chips" id="zf" style="margin:10px 0"><button class="chip" aria-pressed="${!state.filter.zone}" data-z="">Everywhere</button>${zones.map((z) => `<button class="chip" aria-pressed="${state.filter.zone === z}" data-z="${esc(z)}">${esc(z)}</button>`).join('')}</div>` : ''}
    <div id="list" style="margin-top:12px"></div>`;
  bindBack();
  const q = document.getElementById('q');
  q.oninput = () => { state.filter.q = q.value; drawList(); };
  document.getElementById('zf')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    state.filter.zone = b.dataset.z;
    document.querySelectorAll('#zf .chip').forEach((c) => c.setAttribute('aria-pressed', c.dataset.z === state.filter.zone));
    drawList();
  });
  drawList();
}

function drawList() {
  const term = state.filter.q.trim().toLowerCase();
  const people = state.room
    .filter((p) => !state.filter.zone || p.zone === state.filter.zone)
    .filter((p) => !term || [p.name, p.role, p.org, ...p.interests].join(' ').toLowerCase().includes(term))
    .sort((a, b) => b.matchScore - a.matchScore);
  const rel = { connected: '<span class="pill hot">Connected</span>', 'waved-at-you': '<span class="pill hot">Waved at you</span>', 'you-waved': '<span class="pill">You waved</span>' };
  const list = document.getElementById('list');
  list.innerHTML = people.length ? people.map((p) => `
    <button class="row" style="--c:${esc(p.color)};width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer" data-open="${esc(p.id)}">
      <span class="dot" aria-hidden="true">${esc(p.emoji)}</span>
      <span class="who"><strong>${esc(p.name)}</strong><span>${esc(p.topReason || [p.role, p.org].filter(Boolean).join(' at '))}</span></span>
      ${rel[p.relation] || (p.matchScore >= 6 ? '<span class="pill hot">Good match</span>' : p.zone ? `<span class="pill">${esc(p.zone)}</span>` : '')}
    </button>`).join('') : `<p class="empty">Nobody matches that yet.</p>`;
  list.onclick = (e) => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    const p = state.room.find((x) => x.id === b.dataset.open);
    view.insertAdjacentHTML('afterbegin', `<div id="detail">${badge(p, {
      reasons: p.topReason ? [p.topReason] : [],
      actions: `${p.relation === 'connected' ? '<span class="pill hot">Connected</span>' : waveButton(p.id, p.relation === 'you-waved')}<button class="btn small ghost" data-spot="${esc(p.id)}">Find them</button><button class="btn small ghost" id="close-detail">Close</button>`,
    })}</div>`);
    document.getElementById('close-detail').onclick = () => document.getElementById('detail').remove();
    bindCardActions([p]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

async function renderInbox() {
  const r = await call('/api/inbox');
  const waves = r.waves.map((w) => badge(w.person, { reasons: [`Waved at you ${ago(w.at)}`], actions: `${waveButton(w.person.id, false)}<button class="btn small ghost" data-spot="${esc(w.person.id)}">Find them</button>` })).join('');
  const conns = r.connections.map((c) => badge(c.person, {
    reasons: [`Connected ${ago(c.at)}`],
    actions: c.contact ? `<span class="pill hot">${contactHtml(c.contact)}</span>` : '<span class="muted small">No contact shared</span>',
  })).join('');
  view.innerHTML = header('Waves') +
    `<h3>Waiting for your wave back</h3>${waves || '<p class="muted">No one yet. People who wave at you show up here.</p>'}
     <h3 style="margin-top:22px">Connected</h3>${conns || '<p class="muted">When you both wave, you\'re connected and can see each other\'s contact.</p>'}`;
  bindBack();
  bindCardActions([...r.waves, ...r.connections].map((x) => x.person));
}

function contactHtml(c) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return `<a href="mailto:${esc(c)}">${esc(c)}</a>`;
  if (/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(c)) return `<a href="${esc(c.startsWith('http') ? c : 'https://' + c)}" target="_blank" rel="noopener">${esc(c)}</a>`;
  return esc(c);
}

async function refreshInboxCount() {
  try {
    const r = await call('/api/inbox');
    const el = document.getElementById('wave-count');
    el.hidden = !r.waves.length; el.textContent = r.waves.length;
  } catch { /* offline for a moment: keep the old count */ }
}

function renderMe() {
  const me = state.me, ev = state.event;
  view.innerHTML = header('My badge') + badge(me, { actions: `<button class="btn" id="spot">Show my badge full screen</button>` }) + `
    <p class="muted small">Hold your phone up so the person you waved at can find you across the room.</p>
    ${ev.zones.length ? `<label for="zone">Where are you now?</label><select id="zone"><option value="">Not set</option>${ev.zones.map((z) => `<option ${z === me.zone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>` : ''}
    <label for="wearing">What are you wearing?</label><input id="wearing" type="text" maxlength="80" value="${esc(me.wearing || '')}">
    <div class="actions"><button class="btn ghost" id="save">Save</button>
    ${me.status === 'present' ? '<button class="btn ghost" id="leave">I\'m leaving</button>' : ''}</div>`;
  bindBack();
  document.getElementById('spot').onclick = () => spotMe(me);
  document.getElementById('save').onclick = async () => {
    state.me = (await call('/api/me', { method: 'PATCH', body: { zone: document.getElementById('zone')?.value ?? undefined, wearing: document.getElementById('wearing').value } })).me;
    toast('Saved.');
  };
  document.getElementById('leave')?.addEventListener('click', async () => {
    state.me = (await call('/api/me/leave', { method: 'POST' })).me;
    toast('You\'re marked as gone. Your connections stay saved.');
    renderMe();
  });
}

function spotMe(p) {
  if (!p) return;
  const el = document.createElement('div');
  el.className = 'spotme'; el.style.setProperty('--c', p.color);
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', `${p.name}'s badge`);
  const isMe = p.id === state.me.id;
  el.innerHTML = `<button class="btn close">Close</button>
    <div class="big-emoji" aria-hidden="true">${esc(p.emoji)}</div>
    <div class="big-name">${esc(p.name)}</div>
    ${p.wearing ? `<p class="wearing">${isMe ? 'Wearing' : 'Look for'}: ${esc(p.wearing)}</p>` : ''}
    ${p.zone ? `<p class="wearing">📍 ${esc(p.zone)}</p>` : ''}
    <p class="wearing" style="opacity:.85">${isMe ? 'Hold this up so people can find you.' : `Their badge colour is this one. Look for it on their screen.`}</p>`;
  el.querySelector('.close').onclick = () => el.remove();
  document.body.append(el);
  el.querySelector('.close').focus();
}

boot();
