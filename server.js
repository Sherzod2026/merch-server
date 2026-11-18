// Сервер для отслеживания мерчендайзеров. Работает без внешних пакетов (только Node.js 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TZ_OFFSET_H = Number(process.env.TZ_OFFSET || 5); // Ташкент UTC+5
const DATA = path.join(__dirname, 'data');
const PTS = path.join(DATA, 'points');
const PUB = path.join(__dirname, 'public');
const USERS_F = path.join(DATA, 'users.json');
const SESS_F = path.join(DATA, 'sessions.json');
const SESSION_DAYS = 30;

fs.mkdirSync(PTS, { recursive: true });

const hash = (p, salt) => crypto.scryptSync(String(p), salt, 32).toString('hex');
function genPass() {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += c[crypto.randomInt(c.length)];
  return s;
}
const dateKey = (t) => new Date(t + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);

// ---------- Пользователи ----------
let users;
let usersDirty = false;
function saveUsers() { fs.writeFileSync(USERS_F, JSON.stringify(users, null, 1)); usersDirty = false; }

if (!fs.existsSync(USERS_F)) {
  users = [];
  const rows = [['Логин', 'Пароль', 'Роль', 'Имя']];
  const add = (login, role, name) => {
    const p = genPass();
    const salt = crypto.randomBytes(8).toString('hex');
    users.push({ id: login, login, role, name, salt, hash: hash(p, salt), active: false, last: null });
    rows.push([login, p, role === 'admin' ? 'Администратор' : 'Мерчендайзер', name]);
  };
  add('admin1', 'admin', 'Администратор 1');
  add('admin2', 'admin', 'Администратор 2');
  for (let i = 1; i <= 27; i++) {
    const n = String(i).padStart(2, '0');
    add('merch' + n, 'merch', 'Мерч ' + i);
  }
  saveUsers();
  fs.writeFileSync(path.join(DATA, 'credentials.csv'), '﻿' + rows.map((r) => r.join(';')).join('\r\n'));
  console.log('Созданы 29 учётных записей. Логины и пароли: data/credentials.csv');
} else {
  users = JSON.parse(fs.readFileSync(USERS_F, 'utf8'));
}
setInterval(() => usersDirty && saveUsers(), 10000);

// ---------- Сессии ----------
let sessions = fs.existsSync(SESS_F) ? JSON.parse(fs.readFileSync(SESS_F, 'utf8')) : {};
const saveSessions = () => fs.writeFileSync(SESS_F, JSON.stringify(sessions));
function getUser(req) {
  const m = /Bearer (\w+)/.exec(req.headers.authorization || '');
  const s = m && sessions[m[1]];
  if (!s || s.exp < Date.now()) return null;
  return users.find((u) => u.id === s.uid) || null;
}

// ---------- Вспомогательное ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}
const pub = (u) => ({ id: u.id, login: u.login, name: u.name, role: u.role, active: u.active, last: u.last });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const f = path.normalize(path.join(PUB, pathname));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Не найдено'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}

// ---------- API ----------
async function api(req, res, p, q) {
  if (p === '/api/login' && req.method === 'POST') {
    const { login, password } = await readBody(req);
    const u = users.find((x) => x.login === String(login || '').trim().toLowerCase());
    if (!u || hash(password || '', u.salt) !== u.hash) return send(res, 401, { error: 'Неверный логин или пароль' });
    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
    saveSessions();
    return send(res, 200, { token, user: pub(u) });
  }

  const me = getUser(req);
  if (!me) return send(res, 401, { error: 'Требуется вход' });

  if (p === '/api/logout' && req.method === 'POST') {
    const m = /Bearer (\w+)/.exec(req.headers.authorization || '');
    if (m) { delete sessions[m[1]]; saveSessions(); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/me') return send(res, 200, { user: pub(me) });

  // --- мерчендайзер ---
  if (p === '/api/active' && req.method === 'POST') {
    const { active } = await readBody(req);
    me.active = !!active;
    usersDirty = true;
    fs.appendFileSync(path.join(PTS, dateKey(Date.now()) + '.ndjson'),
      JSON.stringify({ u: me.id, ev: me.active ? 'start' : 'stop', t: Date.now() }) + '\n');
    return send(res, 200, { active: me.active });
  }
  if (p === '/api/location' && req.method === 'POST') {
    const { points } = await readBody(req);
    if (!Array.isArray(points)) return send(res, 400, { error: 'Нет точек' });
    const now = Date.now();
    const byDay = {};
    let saved = 0;
    for (const pt of points.slice(0, 500)) {
      const lat = Number(pt.lat), lng = Number(pt.lng), t = Number(pt.t) || now;
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (t > now + 5 * 60e3 || t < now - 3 * 864e5) continue;
      const rec = { u: me.id, lat: +lat.toFixed(6), lng: +lng.toFixed(6), acc: Math.round(pt.acc || 0), t };
      if (pt.bat != null) rec.bat = Math.round(pt.bat);
      (byDay[dateKey(t)] ||= []).push(JSON.stringify(rec));
      if (!me.last || t >= me.last.t) me.last = rec;
      saved++;
    }
    for (const d in byDay) fs.appendFileSync(path.join(PTS, d + '.ndjson'), byDay[d].join('\n') + '\n');
    usersDirty = true;
    return send(res, 200, { saved });
  }

  // --- администратор ---
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'Не найдено' });
  if (me.role !== 'admin') return send(res, 403, { error: 'Только для администратора' });

  if (p === '/api/admin/live') {
    return send(res, 200, { now: Date.now(), users: users.filter((u) => u.role === 'merch').map(pub) });
  }
  if (p === '/api/admin/track') {
    const uid = q.get('user');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : dateKey(Date.now());
    const f = path.join(PTS, date + '.ndjson');
    const points = [], events = [];
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r.u !== uid) continue;
          (r.ev ? events : points).push(r);
        } catch {}
      }
    }
    points.sort((a, b) => a.t - b.t);
    events.sort((a, b) => a.t - b.t);
    return send(res, 200, { date, points, events });
  }
  if (p === '/api/admin/user' && req.method === 'POST') {
    const { id, name, password } = await readBody(req);
    const u = users.find((x) => x.id === id);
    if (!u) return send(res, 404, { error: 'Пользователь не найден' });
    if (name && String(name).trim()) u.name = String(name).trim().slice(0, 60);
    if (password) {
      if (String(password).length < 4) return send(res, 400, { error: 'Пароль слишком короткий (мин. 4 символа)' });
      u.salt = crypto.randomBytes(8).toString('hex');
      u.hash = hash(password, u.salt);
      for (const k in sessions) if (sessions[k].uid === u.id) delete sessions[k];
      saveSessions();
    }
    saveUsers();
    return send(res, 200, { user: pub(u) });
  }
  return send(res, 404, { error: 'Не найдено' });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) await api(req, res, u.pathname, u.searchParams);
    else serveStatic(req, res, decodeURIComponent(u.pathname));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера' });
  }
}).listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));

process.on('SIGINT', () => { saveUsers(); process.exit(0); });
process.on('SIGTERM', () => { saveUsers(); process.exit(0); });
