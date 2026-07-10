"use strict";
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

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

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
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

wss.on('connection', ws => {
  const c = { id: nextId++, clientId: null, name: '玩家' + nextId, seat: -1, joined: false };
  clients.set(ws, c);
  send(ws, { t: 'welcome', id: c.id, phase, url: `http://${lanIP()}:${PORT}`, reconnectWindowMs: RECONNECT_WINDOW_MS });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      c.clientId = String(m.clientId || '').slice(0, 64) || null;
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
    if (clients.size === 0) {
      for (const [s, p] of pending) clearTimeout(p.timer);
      pending.clear();
      phase = 'lobby';
      seats.fill(null);
      seq = 0;
    }
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🦑 SPLAT LUDO 服务器已启动!');
  console.log(`  本机游玩:   http://localhost:${PORT}`);
  console.log(`  局域网加入: http://${lanIP()}:${PORT}`);
  console.log('');
});
