"use strict";
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;   // seat + snapshot reserved for 5min after disconnect

function lanIP() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

/* ---- http helpers ---- */
function readJson(req, cb) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on('end', () => {
    try { cb(null, JSON.parse(raw || '{}')); }
    catch (e) { cb(e); }
  });
}
function sendJson(res, status, obj, extraHeaders) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {});
  res.writeHead(status, h);
  res.end(JSON.stringify(obj));
}
function sessionCookie(token) {
  const days = auth.SESSION_DAYS;
  return `splat_session=${token}; Path=/; Max-Age=${days * 24 * 3600}; HttpOnly; SameSite=Lax`;
}
function clearCookie() {
  return 'splat_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';
}
async function currentUser(req) {
  const token = auth.tokenFromCookieHeader(req.headers.cookie);
  return await auth.sessionUser(token);
}
function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const p = url.pathname;

  try {
    // ---- auth API ----
    if (p === '/api/register' && req.method === 'POST') {
      return readJson(req, async (err, body) => {
        if (err) return sendJson(res, 400, { error: 'bad_json' });
        const { email, password, displayName } = body || {};
        if (!email || !password || !displayName) return sendJson(res, 400, { error: '缺少字段' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: '邮箱格式不对' });
        if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
        if (displayName.length < 1 || displayName.length > 12) return sendJson(res, 400, { error: '昵称 1-12 字' });
        try {
          const user = await auth.createUser(email, password, displayName);
          const { token } = await auth.createSession(user.id);
          return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': sessionCookie(token) });
        } catch (e) {
          if (e.code === '23505') return sendJson(res, 409, { error: '该邮箱已注册' });
          console.error('register error', e);
          return sendJson(res, 500, { error: 'server_error' });
        }
      });
    }
    if (p === '/api/login' && req.method === 'POST') {
      return readJson(req, async (err, body) => {
        if (err) return sendJson(res, 400, { error: 'bad_json' });
        const { email, password } = body || {};
        if (!email || !password) return sendJson(res, 400, { error: '缺少字段' });
        const u = await auth.findUserByEmail(email);
        if (!u || !auth.verifyPassword(password, u.password_hash)) {
          return sendJson(res, 401, { error: '邮箱或密码错误' });
        }
        const { token } = await auth.createSession(u.id);
        return sendJson(res, 200, {
          ok: true,
          user: { id: u.id, email: u.email, display_name: u.display_name }
        }, { 'Set-Cookie': sessionCookie(token) });
      });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const token = auth.tokenFromCookieHeader(req.headers.cookie);
      await auth.deleteSession(token);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }
    if (p === '/api/me' && req.method === 'GET') {
      const u = await currentUser(req);
      if (!u) return sendJson(res, 401, { error: 'not_logged_in' });
      return sendJson(res, 200, { user: u });
    }

    // ---- pages ----
    if (p === '/login' || p === '/register') {
      // if already logged in, bounce to /
      if (await currentUser(req)) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      return serveStatic(res, path.join(PUB, p.slice(1) + '.html'));
    }

    // root and game assets need auth
    const gameOrRoot = (p === '/' || p === '/index.html');
    if (gameOrRoot) {
      if (!await currentUser(req)) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return serveStatic(res, path.join(PUB, 'index.html'));
    }

    // ---- static ----
    let sp = p;
    if (sp === '/') sp = '/index.html';
    const file = path.join(PUB, path.normalize(sp));
    if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    return serveStatic(res, file);
  } catch (e) {
    console.error('req error', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
  }
});

/* ---- room state (single room) ---- */
let phase = 'lobby';                 // 'lobby' | 'playing'
let nextId = 1;
let seq = 0;                          // monotonic sequence for relayed roll/move
const clients = new Map();            // ws -> {id, clientId, name, seat, joined}   seat: 0-3 or -1
const seats = [null, null, null, null]; // client.id or null
// disconnected seats holding place: seat -> {clientId, name, expiresAt, timer}
const pending = new Map();

const wss = new WebSocketServer({ server });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const ws of clients.keys()) send(ws, msg); }
function findWsById(id) { for (const [ws, c] of clients) if (c.id === id) return ws; return null; }

function hostSeat() {
  for (let s = 0; s < 4; s++) if (seats[s] !== null) return s;
  return -1;
}
function hostWs() {
  const s = hostSeat();
  return s < 0 ? null : findWsById(seats[s]);
}
// snapshot source: prefer a non-target client with a game running (so a reconnecting host still gets state from another peer)
function snapshotSourceFor(targetWs) {
  // first try any seated client that isn't the target
  for (const [ws, c] of clients) {
    if (ws === targetWs) continue;
    if (c.seat >= 0) return ws;
  }
  return null;
}
function seatIsPending(s) { return pending.has(s); }
function lobbySnapshot() {
  return {
    t: 'lobby',
    phase,
    hostSeat: hostSeat(),
    seats: seats.map((id, s) => {
      if (id !== null) {
        for (const c of clients.values()) if (c.id === id) return { name: c.name };
      }
      if (pending.has(s)) return { name: pending.get(s).name, pending: true };
      return null;
    }),
    waiting: [...clients.values()].filter(c => c.seat === -1 && c.joined).map(c => c.name),
  };
}
function seatWaiting() {
  for (const [ws, c] of clients) {
    if (!c.joined || c.seat !== -1) continue;
    // skip seats that are pending-reserved for a returning player
    let free = -1;
    for (let s = 0; s < 4; s++) if (seats[s] === null && !pending.has(s)) { free = s; break; }
    if (free === -1) break;
    seats[free] = c.id;
    c.seat = free;
    send(ws, { t: 'seated', seat: free });
  }
}
function assignSeat(preferred) {
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < 4 && seats[preferred] === null && !pending.has(preferred)) {
    return preferred;
  }
  for (let s = 0; s < 4; s++) if (seats[s] === null && !pending.has(s)) return s;
  return -1;
}
function releasePending(seat, why) {
  const p = pending.get(seat);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(seat);
  broadcast({ t: 'reconnectExpired', seat, reason: why || 'timeout' });
  if (phase === 'lobby') seatWaiting();
  // if the room was fully abandoned (no live clients + no more pending), reset it fresh
  if (clients.size === 0 && pending.size === 0) {
    phase = 'lobby';
    seats.fill(null);
    seq = 0;
  }
  broadcast(lobbySnapshot());
}
function reservePending(seat, clientId, name) {
  // clear any prior pending for this seat
  const prev = pending.get(seat);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => releasePending(seat, 'timeout'), RECONNECT_WINDOW_MS);
  pending.set(seat, { clientId, name, expiresAt: Date.now() + RECONNECT_WINDOW_MS, timer });
}
// try to restore returning client to their old seat via clientId
function tryRestore(c, clientId) {
  if (!clientId) return -1;
  for (const [seat, p] of pending) {
    if (p.clientId === clientId) {
      clearTimeout(p.timer);
      pending.delete(seat);
      seats[seat] = c.id;
      c.seat = seat;
      c.name = p.name;         // restore their old name
      return seat;
    }
  }
  return -1;
}

wss.on('connection', async (ws, req) => {
  // authenticate: reject sockets without a valid session cookie
  const token = auth.tokenFromCookieHeader(req.headers.cookie);
  let user = null;
  try { user = await auth.sessionUser(token); } catch (e) { console.error('ws auth error', e); }
  if (!user) {
    send(ws, { t: 'authRequired' });
    try { ws.close(4401, 'not authenticated'); } catch {}
    return;
  }
  const c = {
    id: nextId++,
    userId: user.id,
    clientId: 'user-' + user.id,           // stable per-account; ignored client-supplied id
    name: user.display_name,
    seat: -1,
    joined: false,
  };
  clients.set(ws, c);
  send(ws, {
    t: 'welcome',
    id: c.id,
    phase,
    url: `http://${lanIP()}:${PORT}`,
    reconnectWindowMs: RECONNECT_WINDOW_MS,
    user: { id: user.id, email: user.email, display_name: user.display_name },
  });
  send(ws, lobbySnapshot());

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      // clientId is enforced by the server (user id), not trusted from client
      const wantName = String(m.name || '').slice(0, 12);
      c.name = wantName || c.name;
      c.joined = true;

      // try reconnect first (regardless of phase)
      let restored = -1;
      if (c.seat === -1 && c.clientId) {
        restored = tryRestore(c, c.clientId);
      }
      if (restored >= 0) {
        if (wantName) c.name = wantName;   // let them rename on rejoin
        send(ws, { t: 'seated', seat: restored, reconnected: true });
        if (phase === 'playing') {
          const src = snapshotSourceFor(ws);
          if (src) send(src, { t: 'snapshotReq', forId: c.id, seat: restored, lastSeq: seq });
        }
        broadcast({ t: 'reconnected', seat: restored, name: c.name, hostSeat: hostSeat() });
        broadcast(lobbySnapshot());
        return;
      }

      // fresh join — only assign a seat if we're still in lobby
      if (phase === 'lobby' && c.seat === -1) {
        const s = assignSeat(m.seat);
        if (s >= 0) {
          seats[s] = c.id;
          c.seat = s;
          send(ws, { t: 'seated', seat: s, preferred: m.seat });
        }
      }
      broadcast(lobbySnapshot());
      return;
    }
    if (m.t === 'pickSeat' && phase === 'lobby' && c.joined) {
      const want = m.seat;
      if (!Number.isInteger(want) || want < 0 || want >= 4) return;
      if (seats[want] !== null || pending.has(want)) return;
      if (c.seat >= 0) seats[c.seat] = null;
      seats[want] = c.id;
      c.seat = want;
      send(ws, { t: 'seated', seat: want });
      seatWaiting();
      broadcast(lobbySnapshot());
      return;
    }
    if (m.t === 'start' || m.t === 'restart') {
      if (c.seat !== hostSeat()) return;
      if (m.t === 'restart') {
        // clear any pending reservations when starting fresh
        for (const [s, p] of pending) clearTimeout(p.timer);
        pending.clear();
        seq = 0;
        phase = 'lobby';
        seatWaiting();
        broadcast(lobbySnapshot());
        return;
      }
      if (phase !== 'lobby') return;
      seq = 0;
      phase = 'playing';
      broadcast({ t: 'start', seats: lobbySnapshot().seats, hostSeat: hostSeat() });
      return;
    }
    // relayed game messages
    if ((m.t === 'roll' || m.t === 'move') && c.seat >= 0 && phase === 'playing') {
      seq++;
      broadcast({ ...m, from: c.seat, seq });
      return;
    }
    // host uploads a snapshot for a reconnecting client
    if (m.t === 'snapshot' && phase === 'playing') {
      const targetWs = findWsById(m.forId);
      if (!targetWs) return;
      // trust host's payload verbatim
      send(targetWs, { t: 'snapshot', state: m.state, appliedSeq: m.appliedSeq, seat: m.seat });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (c.seat >= 0) {
      const seatWas = c.seat;
      if (phase === 'playing' && c.clientId) {
        // reserve seat for reconnection
        reservePending(seatWas, c.clientId, c.name);
        seats[seatWas] = null;
        broadcast({ t: 'left', seat: seatWas, hostSeat: hostSeat(), pending: true, name: c.name });
        broadcast(lobbySnapshot());
      } else {
        seats[seatWas] = null;
        if (phase === 'lobby') seatWaiting();
        broadcast({ t: 'left', seat: seatWas, hostSeat: hostSeat() });
        broadcast(lobbySnapshot());
      }
    } else {
      broadcast(lobbySnapshot());
    }
    // Do NOT clear state when clients.size === 0 during 'playing' — pending seats need
    // their 5-minute window even if everyone happens to drop simultaneously (WAN blip,
    // wifi hiccup on both sides). The pending timers themselves will release seats,
    // and the room resets when they all expire.
    if (clients.size === 0 && phase === 'lobby') {
      seats.fill(null);
      seq = 0;
    }
  });
});

async function main() {
  try {
    await db.migrate();
    console.log('  db migrations applied.');
  } catch (e) {
    console.error('db migrate failed', e);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log('');
    console.log('  🦑 SPLAT LUDO 服务器已启动!');
    console.log(`  本机访问:   http://localhost:${PORT}`);
    const ip = lanIP();
    if (ip !== 'localhost') console.log(`  同网访问:   http://${ip}:${PORT}`);
    console.log('');
  });
}
main();
