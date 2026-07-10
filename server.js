"use strict";
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
const clients = new Map();           // ws -> {id, name, seat}  seat: 0-3 or -1 (waiting/spectator)
const seats = [null, null, null, null]; // client id or null

const wss = new WebSocketServer({ server });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const ws of clients.keys()) send(ws, msg); }

function hostSeat() {
  for (let s = 0; s < 4; s++) if (seats[s] !== null) return s;
  return -1;
}
function lobbySnapshot() {
  return {
    t: 'lobby',
    phase,
    hostSeat: hostSeat(),
    seats: seats.map(id => {
      if (id === null) return null;
      for (const c of clients.values()) if (c.id === id) return { name: c.name };
      return null;
    }),
    waiting: [...clients.values()].filter(c => c.seat === -1).map(c => c.name),
  };
}
// give free seats to already-joined-but-waiting clients (in join order).
// only kicks in when a seat frees up mid-lobby.
function seatWaiting() {
  for (const [ws, c] of clients) {
    if (!c.joined || c.seat !== -1) continue;
    const free = seats.indexOf(null);
    if (free === -1) break;
    seats[free] = c.id;
    c.seat = free;
    send(ws, { t: 'seated', seat: free });
  }
}
// pick a seat for a client trying to join; prefers `preferred` if it's a free 0-3.
// returns final seat (0-3) or -1 if the room is full.
function assignSeat(preferred) {
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < 4 && seats[preferred] === null) {
    return preferred;
  }
  return seats.indexOf(null); // -1 if all taken
}

wss.on('connection', ws => {
  const c = { id: nextId++, name: '玩家' + nextId, seat: -1, joined: false };
  clients.set(ws, c);
  send(ws, { t: 'welcome', id: c.id, phase, url: `http://${lanIP()}:${PORT}` });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      c.name = String(m.name || '').slice(0, 12) || c.name;
      c.joined = true;
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
    // change color mid-lobby (host may want a specific color, or someone wants to swap)
    if (m.t === 'pickSeat' && phase === 'lobby' && c.joined) {
      const want = m.seat;
      if (!Number.isInteger(want) || want < 0 || want >= 4) return;
      if (seats[want] !== null) return;               // taken, silently ignore
      if (c.seat >= 0) seats[c.seat] = null;          // free current
      seats[want] = c.id;
      c.seat = want;
      send(ws, { t: 'seated', seat: want });
      seatWaiting();
      broadcast(lobbySnapshot());
      return;
    }
    if (m.t === 'start' || m.t === 'restart') {
      if (c.seat !== hostSeat()) return;      // host only
      if (m.t === 'restart') { phase = 'lobby'; seatWaiting(); broadcast(lobbySnapshot()); return; }
      if (phase !== 'lobby') return;
      phase = 'playing';
      broadcast({ t: 'start', seats: lobbySnapshot().seats, hostSeat: hostSeat() });
      return;
    }
    // in-game relays: roll / move — only from a seated player
    if ((m.t === 'roll' || m.t === 'move') && c.seat >= 0 && phase === 'playing') {
      broadcast({ ...m, from: c.seat });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (c.seat >= 0) {
      seats[c.seat] = null;
      if (phase === 'lobby') seatWaiting();
      broadcast({ t: 'left', seat: c.seat, hostSeat: hostSeat() });
      broadcast(lobbySnapshot());
    } else {
      broadcast(lobbySnapshot());
    }
    if (clients.size === 0) { phase = 'lobby'; seats.fill(null); }
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🦑 SPLAT LUDO 服务器已启动!');
  console.log(`  本机游玩:   http://localhost:${PORT}`);
  console.log(`  局域网加入: http://${lanIP()}:${PORT}`);
  console.log('');
});
