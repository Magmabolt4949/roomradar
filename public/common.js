// Shared browser helpers.

export const NEEDS = ['cofounder', 'hiring', 'job opportunities', 'mentorship', 'investment', 'feedback', 'collaborators', 'design help', 'tech help', 'customers'];
export const SUGGESTED_INTERESTS = ['ai', 'fintech', 'edtech', 'healthtech', 'climate', 'web3', 'product design', 'marketing', 'music', 'gaming', 'deep tech', 'd2c brands', 'open source', 'robotics', 'saas', 'content creation'];
export const EMOJIS = ['👋', '🚀', '🎸', '📚', '🌱', '🧠', '🎨', '⚡', '🏀', '☕', '🎧', '🛠️'];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, { method = 'GET', body, token, hostKey } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-token'] = token;
  if (hostKey) headers['x-host-key'] = hostKey;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/** A tappable chip group bound to a Set. */
export function chipGroup(el, options, selected, { max = 99, onChange } = {}) {
  el.innerHTML = options.map((o) => `<button type="button" class="chip" aria-pressed="${selected.has(o)}" data-v="${esc(o)}">${esc(o)}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const v = b.dataset.v;
    if (selected.has(v)) selected.delete(v);
    else if (selected.size < max) selected.add(v);
    b.setAttribute('aria-pressed', selected.has(v));
    onChange?.(selected);
  };
}

let toastTimer;
export function toast(html, { ms = 5000 } = {}) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.innerHTML = html;
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
  return t;
}
