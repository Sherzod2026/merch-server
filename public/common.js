// Общие функции для всех страниц
const Auth = {
  get token() { try { return localStorage.getItem('mt_token'); } catch { return null; } },
  set(t) { try { localStorage.setItem('mt_token', t); } catch {} },
  clear() { try { localStorage.removeItem('mt_token'); } catch {} },
};

async function api(url, body) {
  const opt = { headers: { 'Content-Type': 'application/json' } };
  if (Auth.token) opt.headers.Authorization = 'Bearer ' + Auth.token;
  if (body !== undefined) { opt.method = 'POST'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.endsWith('/login')) { Auth.clear(); location.href = '/'; throw new Error('auth'); }
  if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
  return data;
}

async function logout() {
  try { await api('/api/logout', {}); } catch {}
  Auth.clear();
  location.href = '/';
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function fmtAgo(t, now = Date.now()) {
  if (!t) return 'нет данных';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' ч ' + (m % 60) + ' мин назад';
  return new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
