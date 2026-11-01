// DUNE RAIL 멀티 — "열차 강도" 규칙. 서버(Node)와 브라우저(오프라인 연습) 양쪽에서 그대로 돈다. three.js 의존 없음.
// 산적 팀: 바이크로 열차를 쫓아와 뛰어올라 금고의 금괴 자루를 털어 후미 발코니의 도주 마차로 넘긴다.
// 경비 팀: 기관차 운전실에서 출발해 막는다. 라운드마다 공수 교대, 먼저 2라운드 이기면 승리.

export const CFG = {
  maxPlayers: 4, teamSize: 2,
  roundTime: 150, overtime: 20, toWin: 2, bagsToWin: 2,
  respawnR: 3.5, respawnG: 4.5, lootTime: 2.4, regenDelay: 5, regenRate: 14,
  roundEndPause: 6, matchEndPause: 9,
};
export const FLOOR = 1.2;
export const BAG_HOME = { x: 0.15, y: FLOOR, z: -1.9 };        // 금고 옆 통로
export const EXTRACT = { z0: 33.9, z1: 39.0, x: 1.5 };          // 후미 발코니
export const GUARD_SPAWNS = [{ x: -0.5, z: -31.4 }, { x: 0.5, z: -29.6 }, { x: 0, z: -30.5 }, { x: 0.4, z: -31.8 }];
const BOT_NAMES = ['사막여우', '방울뱀', '모래바람', '선인장', '독수리', '전갈'];
export const WEAPON_IDS = ['rifle', 'shotgun', 'revolver'];
// 플래그 비트 — 스냅샷에 실리는 몸 상태
export const FL = { CROUCH: 1, BIKE: 2, CARRY: 4, ADS: 8, SPRINT: 16, LEAP: 32, SLIDE: 64, CLIMB: 128 };

const roleOf = (side, round) => ((round % 2 === 1) === (side === 'A') ? 'R' : 'G');
const r2 = (v) => Math.round(v * 100) / 100;

export class Room {
  constructor(code, { send, broadcast, priv = false, onEmpty }) {
    this.code = code; this.send = send; this.bcast = broadcast; this.priv = priv; this.onEmpty = onEmpty;
    this.players = new Map();      // id → 플레이어
    this.order = 0; this.host = null; this.fill = true;
    this.phase = 'lobby'; this.round = 0; this.score = { A: 0, B: 0 };
    this.timer = 0; this.pauseT = 0; this.bags = 0; this.bag = { st: 'home', by: null, x: BAG_HOME.x, y: BAG_HOME.y, z: BAG_HOME.z, t: 0 };
    this.time = 0; this.botSeq = 0; this.lastWinner = null; this.metaDirty = true;
  }
  // ── 인원 ─────────────────────────────────────────────
  humans() { return [...this.players.values()].filter((p) => !p.bot); }
  count(side, onlyHumans = false) { let n = 0; for (const p of this.players.values()) if (p.side === side && (!onlyHumans || !p.bot)) n++; return n; }
  hasSpace() { return this.humans().length < CFG.maxPlayers; }
  join(id, name) {
    if (!this.hasSpace()) return false;
    const hA = this.count('A', true), hB = this.count('B', true);
    const side = hA <= hB ? 'A' : 'B';
    // 그 편의 봇 하나를 빼고 들어간다
    for (const p of this.players.values()) if (p.bot && p.side === side) { this.players.delete(p.id); this.bcast({ t: 'ev', k: 'left', id: p.id }); break; }
    const p = this.mkPlayer(id, clean(name) || `무법자${(Math.random() * 90 + 10) | 0}`, side, false);
    this.players.set(id, p);
    if (!this.host || !this.players.has(this.host)) this.host = id;
    if (this.phase !== 'lobby') { this.fillBots(); this.scheduleSpawn(p, 1.5); }
    this.metaDirty = true;
    return true;
  }
  mkPlayer(id, name, side, bot) {
    return { id, name, side, bot, hp: 100, alive: false, respawnAt: 0, kills: 0, deaths: 0, bags: 0, w: 'rifle',
      st: null, lastHurt: -9, lastBy: null, lastByT: -9, loot: 0, away: false, join: this.order++ };
  }
  leave(id) {
    const p = this.players.get(id); if (!p) return;
    if (this.bag.by === id) this.dropBag(p);
    this.players.delete(id);
    this.bcast({ t: 'ev', k: 'left', id });
    const hs = this.humans();
    if (!hs.length) { this.onEmpty?.(); return; }
    if (this.host === id) this.host = hs.sort((a, b) => a.join - b.join)[0].id;
    if (this.phase !== 'lobby') this.fillBots();
    this.metaDirty = true;
  }
  fillBots() {
    for (const p of [...this.players.values()]) if (p.bot && !this.fill) { this.players.delete(p.id); this.bcast({ t: 'ev', k: 'left', id: p.id }); }
    if (!this.fill) return;
    for (const side of ['A', 'B']) {
      while (this.count(side) < CFG.teamSize) {
        const id = `b${++this.botSeq}`;
        const used = new Set([...this.players.values()].map((p) => p.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || `봇${this.botSeq}`;
        const b = this.mkPlayer(id, name, side, true);
        b.w = WEAPON_IDS[this.botSeq % 3];
        this.players.set(id, b);
        if (this.phase === 'live') this.scheduleSpawn(b, 1);
      }
      // 사람이 들어와 넘친 봇 정리
      while (this.count(side) > CFG.teamSize) {
        const b = [...this.players.values()].find((p) => p.bot && p.side === side); if (!b) break;
        this.players.delete(b.id); this.bcast({ t: 'ev', k: 'left', id: b.id });
      }
    }
    this.metaDirty = true;
  }
  role(p) { return roleOf(p.side, Math.max(1, this.round)); }

  // ── 메시지 ───────────────────────────────────────────
  msg(id, m) {
    const p = this.players.get(id); if (!p) return;
    switch (m.t) {
      case 'st': {   // 몸 상태 (호스트는 봇 것도 보낸다)
        const who = m.id && m.id !== id ? this.players.get(m.id) : p;
        if (!who || (who !== p && (!who.bot || this.host !== id))) return;
        if (!who.alive) return;
        who.st = m.s; break;
      }
      case 'start': if (id === this.host && this.phase === 'lobby') this.startMatch(); break;
      case 'fill': if (id === this.host) { this.fill = !!m.on; if (this.phase !== 'lobby') this.fillBots(); this.metaDirty = true; } break;
      case 'side': if (this.phase === 'lobby') { const s = m.side === 'B' ? 'B' : 'A'; if (this.count(s, true) < CFG.teamSize) { p.side = s; this.metaDirty = true; } } break;
      case 'w': if (WEAPON_IDS.includes(m.w)) { const who = m.id && this.host === id ? this.players.get(m.id) : p; if (who) { who.w = m.w; this.metaDirty = true; } } break;
      case 'hit': this.onHit(id, m); break;
      case 'fall': { const who = m.id && this.host === id ? this.players.get(m.id) : p; if (who?.alive) this.kill(who, this.recentAttacker(who), 'fall'); break; }
      case 'shot': case 'dyn': {   // 연출만 — 다른 사람에게 전달
        const who = m.id && this.host === id ? m.id : id;
        this.bcast({ ...m, id: who }, id); break;
      }
      case 'back': if (id === this.host && this.phase === 'matchEnd') this.toLobby(); break;
      case 'ping': this.send(id, { t: 'pong', c: m.c }); break;
    }
  }
  recentAttacker(v) { return this.time - v.lastByT < 6 ? this.players.get(v.lastBy) || null : null; }
  onHit(senderId, m) {
    if (this.phase !== 'live') return;
    const by = this.players.get(m.by && this.host === senderId ? m.by : senderId);
    const v = this.players.get(m.tgt);
    if (!by || !v || !by.alive || !v.alive || by.side === v.side) return;
    const dmg = Math.max(0, Math.min(160, +m.dmg || 0));
    v.hp -= dmg; v.lastHurt = this.time; v.lastBy = by.id; v.lastByT = this.time;
    if (m.kx || m.kz) this.send(v.bot ? this.host : v.id, { t: 'ev', k: 'knock', tgt: v.id, kx: +m.kx || 0, kz: +m.kz || 0, up: +m.up || 0 });
    if (v.hp <= 0) this.kill(v, by, m.how || 'gun', !!m.head);
    else this.bcast({ t: 'ev', k: 'hit', tgt: v.id, by: by.id, hp: Math.round(v.hp), dmg: Math.round(dmg), head: !!m.head });
  }
  kill(v, by, how, head = false) {
    if (!v.alive) return;
    v.alive = false; v.hp = 0; v.deaths++; v.loot = 0;
    if (by && by !== v) by.kills++;
    if (this.bag.by === v.id) this.dropBag(v);
    this.bcast({ t: 'ev', k: 'kill', tgt: v.id, by: by ? by.id : null, how, head });
    this.scheduleSpawn(v, this.role(v) === 'R' ? CFG.respawnR : CFG.respawnG);
    this.metaDirty = true;
  }
  scheduleSpawn(p, delay) { p.respawnAt = this.time + delay; p.alive = false; p.st = null; }
  spawn(p) {
    p.alive = true; p.hp = 100; p.loot = 0; p.lastHurt = -9; p.respawnAt = 0; p.st = null;
    const role = this.role(p);
    let at;
    if (role === 'R') {
      const side = Math.random() < 0.5 ? -1 : 1;
      at = { bike: true, x: side * 4.2, y: 0, z: 44 + Math.random() * 8, side };
    } else {
      const used = [...this.players.values()].filter((q) => q.alive && q !== p && q.st).map((q) => q.st.p);
      const s = GUARD_SPAWNS.find((g) => !used.some((u) => Math.hypot(u[0] - g.x, u[2] - g.z) < 0.8)) || GUARD_SPAWNS[0];
      at = { bike: false, x: s.x, y: FLOOR, z: s.z, side: 0 };
    }
    p.st = { p: [at.x, at.y, at.z], yaw: 0, pitch: 0, fl: at.bike ? FL.BIKE : 0, w: p.w };
    this.bcast({ t: 'ev', k: 'spawn', id: p.id, role, at, w: p.w });
  }

  // ── 금괴 자루 ─────────────────────────────────────────
  dropBag(p) {
    const s = p.st?.p || [this.bag.x, FLOOR, this.bag.z];
    const onTrain = Math.abs(s[0]) < 1.5 && s[2] > -40 && s[2] < 39;
    if (!onTrain) { this.returnBag(null); return; }
    this.bag = { st: 'drop', by: null, x: s[0], y: Math.max(FLOOR, s[1]), z: s[2], t: this.time };
    this.bcast({ t: 'ev', k: 'bag', st: 'drop', by: p.id });
  }
  returnBag(by) {
    this.bag = { st: 'home', by: null, x: BAG_HOME.x, y: BAG_HOME.y, z: BAG_HOME.z, t: this.time };
    this.bcast({ t: 'ev', k: 'bag', st: 'home', by: by ? by.id : null });
  }
  bagLogic(dt) {
    const b = this.bag;
    for (const p of this.players.values()) {
      if (!p.alive || !p.st) continue;
      const [x, y, z] = p.st.p; const onBike = p.st.fl & FL.BIKE;
      const role = this.role(p);
      if (b.st === 'home' && role === 'R' && !onBike) {
        const d = Math.hypot(x - BAG_HOME.x, z - BAG_HOME.z);
        if (d < 1.5 && Math.abs(y - FLOOR) < 0.6) {
          p.loot += dt / CFG.lootTime;
          if (p.loot >= 1) { b.st = 'carry'; b.by = p.id; p.loot = 0; this.bcast({ t: 'ev', k: 'bag', st: 'carry', by: p.id }); }
        } else p.loot = Math.max(0, p.loot - dt * 1.5);
      } else p.loot = 0;
      if (b.st === 'drop' && !onBike && Math.hypot(x - b.x, z - b.z) < 1.2 && Math.abs(y - b.y) < 1.2) {
        if (role === 'R') { b.st = 'carry'; b.by = p.id; this.bcast({ t: 'ev', k: 'bag', st: 'carry', by: p.id }); }
        else { this.returnBag(p); }
      }
    }
    if (b.st === 'drop' && this.time - b.t > 18) this.returnBag(null);
    if (b.st === 'carry') {
      const c = this.players.get(b.by);
      if (!c || !c.alive) { if (c) this.dropBag(c); else this.returnBag(null); }
      else if (c.st) {
        const [x, y, z] = c.st.p; b.x = x; b.y = y; b.z = z;
        if (z > EXTRACT.z0 && z < EXTRACT.z1 && Math.abs(x) < EXTRACT.x && y > FLOOR - 0.3) {
          this.bags++; c.bags++;
          this.bcast({ t: 'ev', k: 'score', by: c.id, bags: this.bags });
          this.returnBag(null);
          if (this.bags >= CFG.bagsToWin) this.endRound('R', 'bags');
        }
      }
    }
  }

  // ── 흐름 ─────────────────────────────────────────────
  startMatch() {
    this.score = { A: 0, B: 0 }; this.round = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.bags = 0; }
    this.fillBots();
    this.startRound();
  }
  startRound() {
    this.round++; this.phase = 'live'; this.timer = CFG.roundTime; this.bags = 0; this.ot = false;
    this.bag = { st: 'home', by: null, x: BAG_HOME.x, y: BAG_HOME.y, z: BAG_HOME.z, t: this.time };
    this.metaDirty = false; this.bcast(this.meta());   // 역할이 바뀐 걸 먼저 알린 뒤 다시 태어나게
    for (const p of this.players.values()) { p.alive = false; p.loot = 0; this.spawn(p); }
    this.bcast({ t: 'ev', k: 'round', round: this.round, roles: { A: roleOf('A', this.round), B: roleOf('B', this.round) } });
    this.metaDirty = true;
  }
  endRound(winRole, reason) {
    if (this.phase !== 'live') return;
    const side = roleOf('A', this.round) === winRole ? 'A' : 'B';
    this.score[side]++;
    this.lastWinner = side;
    const done = this.score[side] >= CFG.toWin;
    this.phase = done ? 'matchEnd' : 'roundEnd';
    this.pauseT = done ? CFG.matchEndPause : CFG.roundEndPause;
    this.bcast({ t: 'ev', k: done ? 'matchEnd' : 'roundEnd', side, role: winRole, reason, score: this.score });
    this.metaDirty = true;
  }
  toLobby() { this.phase = 'lobby'; this.round = 0; for (const p of this.players.values()) { p.alive = false; } this.metaDirty = true; }

  tick(dt) {
    this.time += dt;
    if (this.phase === 'live') {
      this.timer -= dt;
      for (const p of this.players.values()) {
        if (!p.alive && p.respawnAt && this.time >= p.respawnAt) this.spawn(p);
        if (p.alive && p.hp < 100 && this.time - p.lastHurt > CFG.regenDelay) p.hp = Math.min(100, p.hp + CFG.regenRate * dt);
      }
      this.bagLogic(dt);
      if (this.timer <= 0) {
        if (this.bag.st === 'carry' && this.timer > -CFG.overtime) { if (!this.ot) { this.ot = true; this.bcast({ t: 'ev', k: 'ot' }); } }
        else this.endRound('G', 'time');
      }
    } else if (this.phase === 'roundEnd' || this.phase === 'matchEnd') {
      this.pauseT -= dt;
      if (this.pauseT <= 0) { if (this.phase === 'roundEnd') this.startRound(); else this.toLobby(); }
    }
    if (this.metaDirty) { this.metaDirty = false; this.bcast(this.meta()); }
    this.bcast(this.snap());
  }
  meta() {
    return {
      t: 'room', code: this.code, host: this.host, phase: this.phase, round: this.round, score: this.score, fill: this.fill,
      roles: { A: roleOf('A', Math.max(1, this.round)), B: roleOf('B', Math.max(1, this.round)) }, cfg: CFG,
      players: [...this.players.values()].sort((a, b) => a.join - b.join).map((p) => ({ id: p.id, name: p.name, side: p.side, bot: p.bot, kills: p.kills, deaths: p.deaths, bags: p.bags, w: p.w })),
    };
  }
  snap() {
    const e = [];
    for (const p of this.players.values()) {
      if (!p.alive || !p.st) { e.push([p.id, 0]); continue; }
      const s = p.st;
      e.push([p.id, 1, r2(s.p[0]), r2(s.p[1]), r2(s.p[2]), r2(s.yaw), r2(s.pitch), s.fl | 0, s.w || p.w, Math.round(p.hp), r2(p.loot)]);
    }
    const b = this.bag;
    return { t: 's', tm: r2(this.time), timer: Math.max(0, Math.round(this.timer)), ot: !!this.ot, bags: this.bags, bag: [b.st, b.by, r2(b.x), r2(b.y), r2(b.z)], e,
      resp: Object.fromEntries([...this.players.values()].filter((p) => !p.alive && p.respawnAt).map((p) => [p.id, r2(Math.max(0, p.respawnAt - this.time))])) };
  }
}
function clean(s) { return String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10); }
export function roomCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0]; return s; }
