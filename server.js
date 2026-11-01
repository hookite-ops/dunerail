// DUNE RAIL 서버 — 정적 파일 + 웹소켓 멀티플레이 (Cloud Run 8080)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, roomCode } from './js/net/rules.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const BLOCK = new Set(['server.js', 'package.json', 'package-lock.json', 'Dockerfile', 'node_modules']);

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || BLOCK.has(p.split('/')[1])) { res.writeHead(404); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': ext === '.glb' || ext === '.ogg' ? 'public, max-age=86400' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
});

// ── 방 관리 ────────────────────────────────────────────
const rooms = new Map();        // code → Room
const conns = new Map();        // id → { ws, room, name, token }
const tokens = new Map();       // token → { id, room, until }
let seq = 0;

function send(id, m) { const c = conns.get(id); if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
function makeRoom(priv) {
  let code; do code = roomCode(); while (rooms.has(code));
  const room = new Room(code, {
    priv,
    send,
    broadcast: (m, except) => { const s = JSON.stringify(m); for (const p of room.players.values()) if (!p.bot && p.id !== except) { const c = conns.get(p.id); if (c && c.ws.readyState === 1) c.ws.send(s); } },
    onEmpty: () => rooms.delete(code),
  });
  rooms.set(code, room);
  return room;
}
function list() {
  return [...rooms.values()].filter((r) => !r.priv).map((r) => ({ code: r.code, n: r.humans().length, max: 4, phase: r.phase,
    host: r.players.get(r.host)?.name || '' })).slice(0, 30);
}
function enter(c, room) {
  if (!room.join(c.id, c.name)) { send(c.id, { t: 'err', msg: '방이 가득 찼어요' }); return; }
  c.room = room.code;
  tokens.set(c.token, { id: c.id, room: room.code, until: 0 });
  send(c.id, { t: 'joined', id: c.id, code: room.code, token: c.token });
  room.metaDirty = true;
}
function leaveRoom(c) {
  const room = rooms.get(c.room); c.room = null;
  if (room) room.leave(c.id);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  const id = `p${++seq}`;
  const c = { id, ws, room: null, name: '', token: Math.random().toString(36).slice(2) + Date.now().toString(36) };
  conns.set(id, c);
  send(id, { t: 'hello', id });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.name) c.name = String(m.name).slice(0, 10);
    switch (m.t) {
      case 'list': send(id, { t: 'list', rooms: list() }); return;
      case 'create': if (c.room) leaveRoom(c); enter(c, makeRoom(!!m.priv)); return;
      case 'join': {
        const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) { send(id, { t: 'err', msg: '그런 방이 없어요' }); return; }
        if (c.room) leaveRoom(c); enter(c, room); return;
      }
      case 'quick': {
        if (c.room) leaveRoom(c);
        const open = [...rooms.values()].filter((r) => !r.priv && r.hasSpace()).sort((a, b) => b.humans().length - a.humans().length)[0];
        enter(c, open || makeRoom(false)); return;
      }
      case 'rejoin': {   // 끊겼다 다시 붙음 — 같은 자리로
        const tk = tokens.get(m.token); const room = tk && rooms.get(tk.room);
        const old = room && room.players.get(tk.id);
        if (!old) { send(id, { t: 'err', msg: '방이 사라졌어요', gone: true }); return; }
        conns.delete(id); const prev = conns.get(tk.id); if (prev && prev.ws !== ws) try { prev.ws.close(); } catch {}
        c.id = tk.id; c.room = room.code; c.token = m.token; tk.until = 0; old.away = false;
        conns.set(c.id, c);
        send(c.id, { t: 'joined', id: c.id, code: room.code, token: c.token, re: true });
        room.metaDirty = true; return;
      }
      case 'leave': if (c.room) leaveRoom(c); tokens.delete(c.token); return;
    }
    const room = rooms.get(c.room);
    if (room) room.msg(c.id, m);
  });
  ws.on('close', () => {
    if (conns.get(c.id) !== c) return;
    conns.delete(c.id);
    const room = rooms.get(c.room);
    if (!room) return;
    // 30초 안에 다시 붙으면 자리 유지
    const p = room.players.get(c.id); if (p) p.away = true;
    const tk = tokens.get(c.token); if (tk) tk.until = Date.now() + 30000;
    setTimeout(() => {
      const t = tokens.get(c.token);
      if (t && t.until && Date.now() >= t.until) { tokens.delete(c.token); const r = rooms.get(t.room); if (r && !conns.has(t.id)) r.leave(t.id); }
    }, 31000);
  });
});

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.2, (now - last) / 1000); last = now;
  for (const r of rooms.values()) r.tick(dt);
}, 50);

server.listen(PORT, () => console.log(`DUNE RAIL :${PORT}`));
