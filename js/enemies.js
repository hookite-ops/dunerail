// 적 — 산적 바이크·탑승 산적·폭탄 드론·보행 전차(보스)
import * as THREE from 'three';
import { G, TRAIN, clamp, rand, pick, damp } from './state.js';
import { moveBody, rayBoxes, lineOfSight, groundAt, blocked, VAULT } from './world.js';
import { P, hurtPlayer } from './player.js';
import * as UI from './ui.js';
import { sfxAt, sfx, gunshot, hitSound } from './audio.js';
import { dust, smoke, explosion, sparks, blood, tracer, puff, muzzleWorld } from './fx.js';

export const enemies = [];
const shells = [];
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();

function cloneModel(name) {
  const m = G.models[name].clone(true);
  const mats = [];
  m.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); mats.push(o.material); } });
  return { m, mats };
}
const stageHp = () => 1 + (G.stage - 1) * 0.3;

class Enemy {
  constructor(hp) { this.hp = this.maxHp = hp * stageHp(); this.alive = true; this.flash = 0; this.hitboxes = []; this.remove = false; this.mats = []; }
  damage(amount, point, crit, dir) {
    if (!this.alive) return;
    this.hp -= amount; this.flash = 0.08;
    UI.floater(point, Math.round(amount), crit ? 'crit' : '');
    blood(point);
    G.controls?.haptic(this.hp - amount <= 0 ? 'kill' : 'hit');
    hitSound(this.hp <= 0 ? 'kill' : crit ? 'head' : 'hit');
    if (this.hp <= 0) {
      this.alive = false; UI.hitmarker(true); G.kills++; G.hitstop = 0.05;
      if (crit) UI.floater(point.clone().add(V3.set(0, 0.35, 0)), '헤드샷!', 'crit');
      this.lastDir = dir ? dir.clone() : null;
      this.die(); onKill(point);
    } else { UI.hitmarker(false); this.onHurt?.(dir); }
  }
  tickFlash(dt) {
    if (this.flash > 0 || this._f) {
      this.flash -= dt; const on = this.flash > 0;
      if (on !== this._f) { for (const m of this.mats) { m.emissive?.setRGB(on ? 0.9 : 0, on ? 0.35 : 0, on ? 0.15 : 0); } this._f = on; }
    }
  }
  reward(n, at) { G.scrap += n; G.totalScrap += n; UI.floater(at, `+${n} ⚙`, 'scrap'); sfxAt('coin', at, { vol: 0.5 }); }
}
// 연속 처치: 4.5초 안에 이어서 잡으면 보너스
function onKill(at) {
  G.streak = G.time - (G.streakT || -9) < 4.5 ? (G.streak || 1) + 1 : 1;
  G.streakT = G.time;
  if (G.streak >= 2) {
    const bonus = (G.streak - 1) * 3; G.scrap += bonus; G.totalScrap += bonus;
    UI.streak(G.streak, bonus);
    sfx('coin', { vol: 0.5, rate: 1 + G.streak * 0.12, jitter: 0 });
  }
  sfx('enemy_destroy', { vol: 0.25, rate: 1.6 });
}

// 적의 총격 — 엄폐·앉기·거리로 명중 판정
function enemyShot(from, acc, dmg) {
  const head = V1.set(P.pos.x, P.pos.y + P.eye - 0.15, P.pos.z);
  if (!lineOfSight(from, head)) return false;
  const d = from.distanceTo(head);
  let chance = acc - d * 0.008 - (P.crouch ? 0.14 : 0) - (Math.hypot(P.vel.x, P.vel.z) > 2 ? 0.1 : 0);
  if (G.storm > 0.3) chance -= 0.1;
  const hit = Math.random() < clamp(chance, 0.05, 0.85);
  const end = V2.copy(head);
  if (!hit) end.add(V3.set(rand(-1.2, 1.2), rand(-0.6, 1.0), rand(-1.2, 1.2)));
  tracer(from, end, [1, 0.45, 0.3]);
  muzzleWorld(from, V3.subVectors(end, from).normalize());
  gunshot(from, 0.7);
  if (hit) hurtPlayer(dmg, from);
  else if (from.distanceTo(head) < 20) sfx('impact', { vol: 0.25, rate: 2.4 });   // 귓가를 스치는 소리
  return true;
}

// ── 산적 몸 (bandit.glb) ───────────────────────────────
export function makeBandit() {
  const { m, mats } = cloneModel('bandit');
  const j = {}; for (const n of ['Hips', 'Spine', 'Head', 'ArmL', 'ArmR', 'LegL', 'LegR', 'KneeL', 'KneeR']) j[n] = m.getObjectByName(n);
  j.muzzle = m.getObjectByName('muzzle_ref');
  // 옷 색을 조금씩 다르게
  const tint = pick([0x8c2f22, 0x2f5a8c, 0x6b6b2a, 0x7a3f6a, 0x8c6a22]);
  for (const mt of mats) if (mt.name === 'ShirtRed') mt.color.setHex(tint);
  return { m, mats, j };
}
export function poseSeated(j) {
  j.LegL.rotation.x = j.LegR.rotation.x = 1.3; j.KneeL.rotation.x = j.KneeR.rotation.x = -1.35;
  j.Spine.rotation.x = -0.18; j.ArmL.rotation.set(1.05, 0, -0.2);
}
export function aimArm(j, ownerYaw, target, base) {
  // 오른팔을 목표 쪽으로 (몸 기준 좌우 + 높낮이)
  const wp = j.ArmR.getWorldPosition(V3);
  const dx = target.x - wp.x, dy = target.y - wp.y, dz = target.z - wp.z;
  let yaw = Math.atan2(-dx, -dz) - ownerYaw; yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  j.ArmR.rotation.set(Math.PI / 2 + pitch, clamp(yaw, -1.4, 1.4), 0, 'YXZ');
}

// ── 산적 바이크 ────────────────────────────────────────
const SLOTS = [-23.6, -7.2, 9.2];
class Bike extends Enemy {
  constructor(side) {
    super(45);
    const { m, mats } = cloneModel('bike2'); this.m = m;
    const b = makeBandit(); this.b = b; this.mats = [...mats, ...b.mats];
    b.m.position.set(0, 0.07, 0.42); poseSeated(b.j); m.add(b.m);
    this.side = side; this.x = side * rand(6, 10); this.z = rand(40, 58); this.ry = 0;
    this.slot = pick(SLOTS); this.state = 'approach'; this.t = 0; this.shotT = rand(1.2, 2.4);
    this.wheels = ['wf', 'wb'].map((n) => m.getObjectByName(n));
    this.vz = -8; this.wob = rand(0, 6); this.vy = 0; this.y = 0.02; this.spin = 0;
    G.scene.add(m);
    this.hitboxes = [{ c: new THREE.Vector3(), r: 0.62, mult: 1, j: 'Spine' }, { c: new THREE.Vector3(), r: 0.17, mult: 2.2, j: 'Head' }, { c: new THREE.Vector3(), r: 0.6, mult: 0.8, off: [0, 0.6, 0] }];
  }
  update(dt) {
    this.t += dt; this.tickFlash(dt);
    const m = this.m;
    if (this.state === 'approach' || this.state === 'board') {
      const tx = this.state === 'board' ? this.side * 2.3 : this.side * 4.6;
      const dz = this.slot - this.z;
      this.vz = damp(this.vz, clamp(dz * 0.9, -11, 11), 1.6, dt);
      this.z += this.vz * dt;
      this.x = damp(this.x, tx + Math.sin(this.t * 1.3 + this.wob) * 0.35, 1.3, dt);
      if (Math.abs(dz) < 3 && this.state === 'approach') this.state = 'board';
      if (this.state === 'board' && Math.abs(dz) < 0.9 && Math.abs(this.x - this.side * 2.3) < 0.35) {
        this.boardT = (this.boardT || 0) + dt;
        if (this.boardT > 0.9 && (boardersOnTrain() >= 2 + Math.min(2, G.stage - 1) || this.harass)) {
          this.harass = true; this.state = 'approach'; this.slot = pick(SLOTS) + rand(-4, 4); this.boardT = 0;
        } else if (this.boardT > 0.9) this.leap();
      }
      this.shotT -= dt;
      const aimAt = V2.set(P.pos.x, P.pos.y + 1.3, P.pos.z);
      aimArm(this.b.j, this.ry, aimAt);
      if (this.shotT <= 0) {
        this.shotT = rand(1.6, 2.8) / Math.min(1.6, stageHp());
        const from = this.b.j.muzzle.getWorldPosition(new THREE.Vector3());
        if (from.distanceTo(P.pos) < 38) enemyShot(from, 0.42, 7);
      }
      m.rotation.set(0, this.ry, Math.sin(this.t * 3 + this.wob) * 0.04 + (this.x - tx) * -0.05);
      m.position.set(this.x, 0.02, this.z);
    } else if (this.state === 'empty') {
      // 빈 바이크 — 비틀거리다 넘어져 뒤로 흘러감
      this.z += G.speed * 0.35 * dt; this.x += this.side * 1.8 * dt;
      this.tilt = Math.min(1.45, (this.tilt || 0) + dt * 1.2);
      m.rotation.set(0, this.ry + this.tilt * 0.4, this.side * this.tilt);
      m.position.set(this.x, 0.02, this.z);
      if (this.z > 140) this.remove = true;
    } else {
      // 격파 — 공중제비
      this.vy -= 18 * dt; this.y += this.vy * dt;
      if (this.y < 0) { this.y = 0; this.vy = Math.abs(this.vy) * 0.3; if (this.vy < 1) this.vy = 0; }
      this.spin += dt * (this.vy > 0 ? 7 : 2);
      this.z += G.speed * 0.8 * dt; this.x += this.side * 3 * dt;
      m.rotation.set(-this.spin, this.ry + this.spin * 0.3, this.side * Math.min(1.4, this.spin * 0.5));
      m.position.set(this.x, this.y, this.z);
      if (Math.random() < dt * 25) smoke(V1.set(this.x, this.y + 0.5, this.z), 0.7);
      if (this.z > 140) this.remove = true;
    }
    for (const w of this.wheels) if (w) w.rotation.x -= dt * 24;
    if (this.y < 0.2 && Math.random() < dt * 26) dust(V1.set(this.x, 0.2, this.z + 0.9), 0.85);
    m.updateMatrixWorld();
    for (const h of this.hitboxes) { if (h.j) this.b.j[h.j].getWorldPosition(h.c); else h.c.set(this.x + h.off[0], h.off[1], this.z + h.off[2]); }
    if (this.hitboxes[0]?.j === 'Spine') this.hitboxes[0].c.y += 0.25;
  }
  leap() {
    // 산적이 바이크에서 열차로 뛰어오른다 → 탑승 산적이 됨
    const wp = this.b.m.getWorldPosition(new THREE.Vector3());
    this.m.remove(this.b.m);
    const bd = new Boarder(this.side, this.slot, this.b, wp);
    enemies.push(bd);
    this.state = 'empty'; this.alive = false; this.hitboxes = [];
    sfxAt('jump_a', wp, { vol: 0.8, rate: 0.8 });
  }
  die() {
    this.state = 'crash'; this.hitboxes = []; this.vy = 7.5;
    explosion(V1.set(this.x, 0.8, this.z), 0.8); sfxAt('enemy_destroy', V1, { vol: 1 });
    this.reward(12, V1.set(this.x, 1.8, this.z));
  }
}

// ── 금고까지 흐름장(flow field) — 열차 바닥 격자를 한 번 BFS ─────
export const NAV = { c: 0.25, x0: -1.5, z0: -41, nx: 12, nz: 324, dist: null };
function buildNav() {
  const { c, x0, z0, nx, nz } = NAV;
  const walk = new Uint8Array(nx * nz), dist = new Float32Array(nx * nz).fill(1e9);
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const x = x0 + (i + 0.5) * c, z = z0 + (k + 0.5) * c;
    const g = groundAt(x, z, TRAIN.FLOOR + 0.05, 0.28, 0.45);
    walk[k * nx + i] = Math.abs(g - TRAIN.FLOOR) < 0.06 && !blocked(x, z, TRAIN.FLOOR, 0.26, 1.5, 0.45) ? 1 : 0;
  }
  const ti = Math.floor((0.02 - x0) / c), tk = Math.floor((VAULT.z - z0) / c);
  const q = [tk * nx + ti]; dist[q[0]] = 0; let h = 0;
  while (h < q.length) {
    const id = q[h++], i = id % nx, k = (id / nx) | 0;
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      if (!di && !dk) continue;
      const a = i + di, b = k + dk; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = b * nx + a; if (!walk[n]) continue;
      if (di && dk && (!walk[k * nx + a] || !walk[b * nx + i])) continue;   // 모서리 끼임 방지
      const nd = dist[id] + (di && dk ? 1.414 : 1);
      if (nd < dist[n]) { dist[n] = nd; q.push(n); }
    }
  }
  NAV.dist = dist; NAV.walk = walk;
}
export function navGrid() { if (!NAV.dist) buildNav(); return NAV; }
function navDir(x, z, out) {
  if (!NAV.dist) buildNav();
  const { c, x0, z0, nx, nz, dist } = NAV;
  const i = clamp(Math.floor((x - x0) / c), 0, nx - 1), k = clamp(Math.floor((z - z0) / c), 0, nz - 1);
  let best = dist[k * nx + i], bi = i, bk = k;
  for (let r = 1; r <= 3 && best >= 1e9; r++)   // 격자 밖이면 가까운 칸 찾기
    for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++) {
      const a = i + di, b = k + dk; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      if (dist[b * nx + a] < best) { best = dist[b * nx + a]; bi = a; bk = b; }
    }
  if (bi === i && bk === k) for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
    const a = i + di, b = k + dk; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
    if (dist[b * nx + a] < best) { best = dist[b * nx + a]; bi = a; bk = b; }
  }
  out.set(x0 + (bi + 0.5) * c - x, 0, z0 + (bk + 0.5) * c - z);
  return best;
}

// ── 탑승 산적 ──────────────────────────────────────────
function carIndex(z) { for (let i = 0; i < 6; i++) { const [a, b] = TRAIN.carZ(i); if (z >= a - 0.7 && z < b + 0.7) return i; } return z < -40 ? 0 : 5; }
class Boarder extends Enemy {
  constructor(side, z, bandit, fromPos) {
    super(38);
    const b = bandit || makeBandit(); this.b = b; this.mats = b.mats; this.j = b.j;
    this.m = b.m; G.scene.add(this.m);
    for (const k of ['LegL', 'LegR', 'KneeL', 'KneeR', 'Spine', 'ArmL']) b.j[k].rotation.set(0, 0, 0);
    this.target = new THREE.Vector3(side * 1.05, TRAIN.FLOOR, z);
    this.pos = new THREE.Vector3(side * 1.05, TRAIN.FLOOR, z); this.vel = new THREE.Vector3();
    this.ry = side > 0 ? Math.PI / 2 : -Math.PI / 2; this.shotT = rand(1.0, 1.8); this.stuck = 0; this.walk = 0; this.looting = false;
    this.stun = 0;
    // 뛰어오르는 연출
    this.leapT = fromPos ? 0 : 1; this.from = fromPos ? fromPos.clone() : null;
    this.hitboxes = [{ c: new THREE.Vector3(), r: 0.34, mult: 1, j: 'Spine', dy: 0.25 }, { c: new THREE.Vector3(), r: 0.17, mult: 2.2, j: 'Head', dy: 0.08 }, { c: new THREE.Vector3(), r: 0.26, mult: 0.8, j: 'Hips', dy: -0.2 }];
    UI.toast(z < -15 ? '산적이 무기칸에 뛰어올랐다!' : z < 0 ? '산적이 화물칸에 침입!' : '산적이 정비칸에 뛰어올랐다!');
  }
  knock(vx, vz, up) { this.vel.set(vx, up, vz); this.stun = 0.9; this.flinch = 1.5; this.knocked = true; }
  update(dt) {
    this.tickFlash(dt);
    const p = this.pos, j = this.j;
    if (this.leapT < 1) {
      this.leapT = Math.min(1, this.leapT + dt / 0.55);
      const t = this.leapT;
      p.lerpVectors(this.from, this.target, t); p.y += Math.sin(t * Math.PI) * 1.6;
      j.LegL.rotation.x = j.LegR.rotation.x = 1.0 * Math.sin(t * Math.PI); j.KneeL.rotation.x = j.KneeR.rotation.x = -1.2 * Math.sin(t * Math.PI);
      this.m.position.copy(p); this.m.rotation.set(0, this.ry, 0);
      if (t >= 1) { p.copy(this.target); this.vel.set(-Math.sign(p.x) * 1.5, 0, 0); sfxAt('land', p, { vol: 0.9 }); }
      this.syncHit(); return;
    }
    const toP = V1.set(P.pos.x - p.x, 0, P.pos.z - p.z); const dP = toP.length();
    const eye = V2.set(p.x, p.y + 1.6, p.z);
    const sees = dP < 18 && lineOfSight(eye, V3.set(P.pos.x, P.pos.y + P.eye - 0.1, P.pos.z));
    let tx, tz, wantMove = this.stun <= 0;
    const goVault = G.loot < 1;
    if (sees && !this.looting) { wantMove = wantMove && dP > 6; tx = P.pos.x; tz = P.pos.z; }
    else if (goVault) { tx = 0.02; tz = VAULT.z; }
    else { tx = P.pos.x; tz = P.pos.z; }
    this.flinch = Math.max(0, (this.flinch || 0) - dt);
    this.stun = Math.max(0, this.stun - dt);
    const atVault = Math.hypot(p.x - 0.02, p.z - VAULT.z) < 0.7 && goVault && this.flinch <= 0;
    this.looting = atVault;
    if (atVault) { wantMove = false; lootingNow++; }
    const dir = V3.set(0, 0, 0);
    if (wantMove) {
      if (sees || !goVault) dir.set(tx - p.x, 0, tz - p.z);
      else navDir(p.x, p.z, dir);
      const dl = dir.length(); if (dl > 0.01) dir.multiplyScalar(2.7 / dl);
    }
    for (const o of enemies) if (o !== this && o instanceof Boarder && o.alive) {
      const ox = p.x - o.pos.x, oz = p.z - o.pos.z, d = Math.hypot(ox, oz);
      if (d < 0.6 && d > 0.001) { dir.x += ox / d * 1.5; dir.z += oz / d * 1.5; }
    }
    if (this.stun <= 0) { this.vel.x = damp(this.vel.x, dir.x, 8, dt); this.vel.z = damp(this.vel.z, dir.z, 8, dt); }
    else { this.vel.x *= Math.exp(-1.2 * dt); this.vel.z *= Math.exp(-1.2 * dt); }
    this.vel.y -= 22 * dt;
    const bx = p.x, bz = p.z;
    // 밀려날 때는 난간을 넘을 수 있게 (발 높이 기준 계단을 높여 판정)
    moveBody(p, this.vel, dt, 0.3, 1.6, this.stun > 0 ? 0.45 + Math.max(0, p.y - TRAIN.FLOOR) : 0.45);
    if (Math.abs(p.x) > 1.55 && this.stun > 0) p.z += G.speed * 0.2 * dt;
    const moved = Math.hypot(p.x - bx, p.z - bz) / dt;
    if (wantMove && moved < 0.4) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt * 2);
    // 열차 밖으로 떨어짐 → 처치
    if (p.y < 0.9 && Math.abs(p.x) > 1.4) { this.fallOff(); return; }
    // 몸짓
    const face = sees ? Math.atan2(-(P.pos.x - p.x), -(P.pos.z - p.z)) : (moved > 0.3 ? Math.atan2(-this.vel.x, -this.vel.z) : this.ry);
    let d = face - this.ry; d = Math.atan2(Math.sin(d), Math.cos(d)); this.ry += d * Math.min(1, dt * 8);
    this.walk += moved * dt * 3.2;
    const sw = moved > 0.3 ? Math.sin(this.walk) : 0;
    j.LegL.rotation.x = sw * 0.55; j.LegR.rotation.x = -sw * 0.55;
    j.KneeL.rotation.x = -Math.max(0, -sw) * 0.8; j.KneeR.rotation.x = -Math.max(0, sw) * 0.8;
    j.Spine.rotation.x = this.stun > 0 ? 0.35 : this.looting ? -0.4 : 0;
    j.ArmL.rotation.set(this.looting ? 1.2 + Math.sin(G.time * 12) * 0.35 : -sw * 0.4, 0, -0.1);
    if (sees && this.stun <= 0) aimArm(j, this.ry, V2.set(P.pos.x, P.pos.y + 1.3, P.pos.z));
    else j.ArmR.rotation.set(this.looting ? 1.0 + Math.sin(G.time * 12 + 1) * 0.3 : sw * 0.4, 0, 0.1);
    this.m.position.set(p.x, p.y, p.z); this.m.rotation.set(this.stun > 0 ? 0.25 : 0, this.ry, 0);
    if (sees && this.stun <= 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT = rand(1.1, 1.8) / Math.min(1.5, stageHp());
        enemyShot(j.muzzle.getWorldPosition(new THREE.Vector3()), 0.5, 8);
      }
    } else this.shotT = Math.max(this.shotT, 0.6);
    this.syncHit();
  }
  syncHit() { this.m.updateMatrixWorld(); for (const h of this.hitboxes) { this.j[h.j].getWorldPosition(h.c); h.c.y += h.dy; } }
  fallOff() {
    if (!this.alive) return;
    this.alive = false; G.kills++;
    const at = this.pos.clone().add(V1.set(0, 1.4, 0));
    UI.floater(at, '열차 밖으로!', 'crit'); this.reward(16, at); onKill(at);
    sfxAt('skid', at, { vol: 0.7, rate: 1.3 });
    this.hitboxes = []; this.dying = 0; this.dvel = new THREE.Vector3(Math.sign(this.pos.x) * 2, 2, 0); this.spin = 2;
  }
  die() {
    const at = this.pos.clone().add(V1.set(0, 1.2, 0));
    this.reward(10, at); puff(at, 8, [0.7, 0.5, 0.35, 0.6]);
    this.hitboxes = []; this.dying = 0;
    const d = this.lastDir || V2.set(this.pos.x - P.pos.x, 0, this.pos.z - P.pos.z).normalize();
    this.dvel = new THREE.Vector3(d.x * 3, 2.5, d.z * 3); this.spin = 0;
  }
  onHurt(dir) { this.flinch = 1.5; if (dir) { this.vel.x += dir.x * 1.5; this.vel.z += dir.z * 1.5; } }
  dieUpdate(dt) {
    // 간단한 래그돌: 뒤로 넘어지며 날아감, 열차 밖이면 모래 위로 떨어져 뒤로 흘러감
    this.dying += dt;
    const p = this.pos, v = this.dvel;
    v.y -= 20 * dt; p.addScaledVector(v, dt);
    const g = Math.abs(p.x) < 1.5 && p.z > TRAIN.front && p.z < TRAIN.back ? groundAt(p.x, p.z, p.y + 0.3, 0.2, 0.5) : 0.05;
    if (p.y < g) { p.y = g; v.y = 0; v.x *= 0.6; v.z *= 0.6; }
    if (g < 0.5 && p.y < 0.6) p.z += G.speed * dt;
    this.spin += dt * 4;
    const fall = Math.min(1.5, this.dying * 4.5);
    this.m.position.copy(p); this.m.rotation.set(-fall, this.ry + this.spin * 0.5, 0);
    const j = this.j; j.ArmL.rotation.x = j.ArmR.rotation.x = -2.2 * Math.min(1, this.dying * 3); j.LegL.rotation.x = 0.6; j.KneeL.rotation.x = -0.8;
    if (this.dying > 2.4 || p.z > 150) { if (this.dying > 2.4) this.m.scale.multiplyScalar(Math.pow(0.001, dt)); }
    if (this.dying > 3.2 || p.z > 150) this.remove = true;
  }
}

// ── 폭탄 드론 ──────────────────────────────────────────
class Drone extends Enemy {
  constructor(i, n) {
    super(12);
    const { m, mats } = cloneModel('drone'); this.m = m; this.mats = mats; m.scale.setScalar(1.25);
    const a = (i / n) * Math.PI * 2;
    this.p = new THREE.Vector3(Math.cos(a) * 10 + rand(-3, 3), rand(10, 15), -75 + Math.sin(a) * 8);
    this.v = new THREE.Vector3(0, 0, 8);
    this.rotors = [0, 1, 2, 3].map((k) => m.getObjectByName('Rotor' + k));
    this.ph = rand(0, 6); this.armed = 0;
    this.hitboxes = [{ c: this.p, r: 0.55, mult: 1 }];
    G.scene.add(m);
  }
  update(dt) {
    this.tickFlash(dt);
    const target = V1.set(P.pos.x, P.pos.y + 1.4, P.pos.z);
    const to = V2.subVectors(target, this.p); const d = to.length();
    const sp = d > 14 ? 11 : 8.5;
    to.normalize().multiplyScalar(sp);
    to.x += Math.sin(G.time * 2.5 + this.ph) * 3; to.y += Math.cos(G.time * 3 + this.ph) * 1.5;
    this.v.lerp(to, Math.min(1, dt * 1.8));
    this.p.addScaledVector(this.v, dt);
    if (this.p.y < 0.8) this.p.y = 0.8;
    this.m.position.copy(this.p);
    this.m.rotation.set(-this.v.z * 0.03, Math.atan2(-this.v.x, -this.v.z), this.v.x * 0.03);
    for (const r of this.rotors) if (r) r.rotation.y += dt * 40;
    if (d < 6 && !this.armed) { this.armed = 1; sfxAt('enemy_attack', this.p, { vol: 0.7, rate: 1.4 }); }
    if (d < 1.7) { this.blow(true); }
  }
  blow(onPlayer) {
    if (this.remove) return;
    this.alive = false; this.remove = true; this.hitboxes = [];
    G.scene.remove(this.m);
    explodeAt(this.p.clone(), 3.5, 25, { playerDmg: onPlayer ? 22 : 14, scale: 0.65, from: this });
  }
  die() { this.reward(6, this.p.clone()); this.blow(false); }
}

// ── 보행 전차 / 보스 ───────────────────────────────────
class Walker extends Enemy {
  constructor(side, boss) {
    super(boss ? 1100 : 280);
    const { m, mats } = cloneModel('walker'); this.m = m; this.mats = mats;
    this.boss = boss; const s = boss ? 1.75 : 1; m.scale.setScalar(s); this.s = s;
    if (boss) for (const mt of mats) if (mt.name === 'Rust') mt.color.setHex(0x5a2a1c);
    this.side = side; this.x = side * 45; this.tx = side * (boss ? 22 : 17); this.z = rand(-18, 12); this.t = 0;
    this.fireT = 3; this.droneT = 8;
    this.body = m.getObjectByName('Body'); this.hips = [m.getObjectByName('HipL'), m.getObjectByName('HipR')];
    this.cannon = m.getObjectByName('Cannon'); this.rack = m.getObjectByName('Cannon2'); this.eye = m.getObjectByName('eye');
    this.hitboxes = [{ c: new THREE.Vector3(), r: 1.25 * s, mult: 1 }, { c: new THREE.Vector3(), r: 0.32 * s, mult: 2.5 }];
    G.scene.add(m);
    UI.toast(boss ? '⚠ 철갑 거상 출현! 눈을 노려라' : '보행 전차 접근 — 빨간 눈이 약점');
    sfx('skid', { vol: 0.7, rate: 0.5 });
    if (boss) G.bossAlive = true;
  }
  update(dt) {
    this.t += dt; this.tickFlash(dt);
    // 일반 전차는 50초 뒤 물러난다 (쌓이지 않게)
    if (!this.boss && this.t > 50 && !this.leaving) { this.leaving = true; this.tx = this.side * 70; }
    if (this.leaving && Math.abs(this.x) > 60) { this.alive = false; this.remove = true; return; }
    this.x = damp(this.x, this.tx + Math.sin(this.t * 0.3) * 2, this.leaving ? 0.25 : 0.6, dt);
    this.z += Math.sin(this.t * 0.21) * 1.2 * dt;
    const step = this.t * 3.4;
    this.hips[0].rotation.x = Math.sin(step) * 0.45; this.hips[1].rotation.x = -Math.sin(step) * 0.45;
    this.m.position.set(this.x, Math.abs(Math.cos(step)) * 0.15 * this.s, this.z);
    const ry = Math.atan2(-(P.pos.x - this.x), -(P.pos.z - this.z));
    this.m.rotation.y = ry;
    this.body.rotation.x = Math.sin(step * 2) * 0.03;
    if (Math.random() < dt * 8) dust(V1.set(this.x + rand(-1, 1), 0.2, this.z + rand(-1, 1)), 0.3);
    if (Math.random() < dt * 5) smoke(this.body.localToWorld(V1.set(0.55, 1.5, 1.0)).clone(), 0.2);
    // 포격
    this.fireT -= dt;
    if (this.fireT <= 0 && !this.leaving && Math.abs(this.x) < Math.abs(this.tx) + 6 && G.time - lastShell > 1.4) {
      lastShell = G.time;
      const n = this.boss ? 3 : 1;
      this.fireT = (this.boss ? 3.2 : 4.2) / Math.min(1.5, stageHp());
      for (let k = 0; k < n; k++) setTimeout(() => this.alive && fireShell(this, k), k * 280);
    }
    if (this.boss) {
      this.droneT -= dt;
      if (this.droneT <= 0) { this.droneT = 13; spawnDrones(3); UI.toast('거상이 드론을 풀었다!'); }
    }
    this.m.updateMatrixWorld();
    this.body.getWorldPosition(this.hitboxes[0].c);
    this.eye.getWorldPosition(this.hitboxes[1].c);
    if (this.boss) UI.setWave(`철갑 거상 · ${Math.max(0, Math.ceil(this.hp / this.maxHp * 100))}%`);
  }
  die() {
    const at = this.hitboxes[0].c.clone();
    explosion(at, this.boss ? 2 : 1.3); sfxAt('enemy_destroy', at, { vol: 1.2, rate: 0.6 });
    setTimeout(() => { explosion(at.clone().add(V1.set(0, -1.5, 0)), 1); }, 300);
    this.reward(this.boss ? 150 : 55, at);
    this.hitboxes = []; this.dying = 0;
    if (this.boss) { G.bossAlive = false; G.bossDone = true; }
  }
  dieUpdate(dt) {
    this.dying += dt;
    this.z += G.speed * Math.min(1, this.dying * 0.5) * dt;
    this.m.position.set(this.x, Math.max(-3, -this.dying * this.dying * 1.5), this.z);
    this.m.rotation.z = Math.min(1.4, this.dying * 0.9) * -this.side;
    if (Math.random() < dt * 20) smoke(V1.set(this.x, 2, this.z).clone(), 0.8);
    if (this.z > 150) this.remove = true;
  }
}
let lastShell = -9;
function fireShell(w, k) {
  const from = w.cannon.localToWorld(V1.set(0.15, 0, -1.5)).clone();
  const target = V2.set(P.pos.x + rand(-1.4, 1.4) + P.vel.x * 0.6, P.pos.y + 0.4, P.pos.z + rand(-1.4, 1.4) + P.vel.z * 0.6);
  if (k > 0) target.z += (k - 1) * 3;
  const d = from.distanceTo(target); const T = Math.max(0.9, d / 20); const g = 14;
  const v = new THREE.Vector3().subVectors(target, from).divideScalar(T); v.y += 0.5 * g * T;
  const mesh = new THREE.Mesh(G.shellGeo ||= new THREE.SphereGeometry(0.18, 10, 8), G.shellMat ||= new THREE.MeshBasicMaterial({ color: 0xffb050 }));
  mesh.position.copy(from); G.scene.add(mesh);
  shells.push({ p: from, v, g, mesh, t: 0, T, w });
  muzzleWorld(from, v.clone().normalize()); explosion(from, 0.2);
  gunshot(from, 1.6);
}
function updateShells(dt) {
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i]; s.t += dt;
    s.v.y -= s.g * dt; s.p.addScaledVector(s.v, dt); s.mesh.position.copy(s.p);
    if (Math.random() < dt * 40) smoke(s.p.clone(), 0.15);
    const g = groundAt(s.p.x, s.p.z, s.p.y, 0.1, 0);
    const inBox = G.boxes.some((b) => s.p.x > b.min[0] && s.p.x < b.max[0] && s.p.y > b.min[1] && s.p.y < b.max[1] && s.p.z > b.min[2] && s.p.z < b.max[2]);
    if (s.p.y <= g || inBox || s.t > s.T + 1.5) {
      G.scene.remove(s.mesh); shells.splice(i, 1);
      explodeAt(s.p.clone(), 3.2, 30, { playerDmg: 32 * (s.w.boss ? 1.1 : 1), scale: 0.9 });
    }
  }
}

// ── 생성·갱신·조회 ─────────────────────────────────────
export function spawnBike(side) { if (enemies.filter((e) => e instanceof Bike && e.alive).length < 6) enemies.push(new Bike(side ?? (Math.random() < 0.5 ? -1 : 1))); }
export function spawnBoarder(side, z) { enemies.push(new Boarder(side, z)); }
export function spawnDrones(n) { for (let i = 0; i < n; i++) enemies.push(new Drone(i, n)); sfx('enemy_attack', { vol: 0.5, rate: 0.7 }); }
export function spawnWalker(side, boss = false) { enemies.push(new Walker(side ?? (Math.random() < 0.5 ? -1 : 1), boss)); }
export function liveCount() { return enemies.filter((e) => e.alive).length; }
export function boardersOnTrain() { return enemies.filter((e) => e instanceof Boarder && e.alive).length; }

let lootingNow = 0;
export function updateEnemies(dt) {
  lootingNow = 0;
  for (const e of enemies) {
    if (e.alive) e.update(dt);
    else if (e.dieUpdate) e.dieUpdate(dt);
    else if (e instanceof Bike) e.update(dt);
  }
  // 금고 약탈: 한 명이면 약 45초, 여럿이면 빨라지지만 3명에서 멈춤
  if (lootingNow) {
    G.loot = Math.min(1, G.loot + dt * 0.017 * (1 + 0.6 * (Math.min(3, lootingNow) - 1)) * (1 - G.upgrades.vault * 0.2));
    if (!G._lootWarn || G.time - G._lootWarn > 8) { G._lootWarn = G.time; UI.toast('⚠ 산적이 금고를 털고 있다! 화물칸으로'); }
  }
  for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].remove) { G.scene.remove(enemies[i].m); enemies.splice(i, 1); }
  updateShells(dt);
}
export function clearEnemies() {
  for (const e of enemies) G.scene.remove(e.m);
  enemies.length = 0;
  for (const s of shells) G.scene.remove(s.mesh);
  shells.length = 0;
  G.bossAlive = false;
}

// 폭발: 플레이어·적 모두에게 피해, 탑승 산적은 날려 보냄
export function explodeAt(p, radius, dmg, { playerDmg = 0, scale = 1, from = null, knock = 0 } = {}) {
  explosion(p, scale); sfxAt('enemy_destroy', p, { vol: 1.1, rate: 0.9 - scale * 0.15 });
  if (playerDmg) {
    const d = p.distanceTo(V1.set(P.pos.x, P.pos.y + 0.9, P.pos.z));
    if (d < radius) hurtPlayer(playerDmg * (1 - d / (radius * 1.2)), p);
  }
  for (const e of enemies) {
    if (e === from || !e.alive || !e.hitboxes[0]) continue;
    const c = e.hitboxes[0].c; const d = c.distanceTo(p);
    if (d > radius) continue;
    if (knock && e instanceof Boarder) { const dx = c.x - p.x, dz = c.z - p.z, L = Math.hypot(dx, dz) || 1; e.knock(dx / L * knock, dz / L * knock, 6.8); }
    e.damage(dmg * (1 - d / (radius * 1.3)), c.clone(), false, V2.subVectors(c, p).normalize());
  }
}
// 개머리판 치기: 앞 1.9m 안의 산적을 밀쳐낸다
export function meleeHit(o, d) {
  let best = null, bd = 1.9;
  for (const e of enemies) {
    if (!(e instanceof Boarder) || !e.alive || e.leapT < 1) continue;
    const to = V1.set(e.pos.x - o.x, 0, e.pos.z - o.z); const L = to.length();
    if (L < bd && to.normalize().dot(V2.set(d.x, 0, d.z).normalize()) > 0.55) { bd = L; best = e; }
  }
  if (!best) return false;
  const dx = best.pos.x - o.x, dz = best.pos.z - o.z, L = Math.hypot(dx, dz) || 1;
  best.knock(dx / L * 7.5, dz / L * 7.5, 6.8);
  best.damage(18, best.hitboxes[0].c.clone(), false, V1.set(dx / L, 0, dz / L));
  sfxAt('impact', best.pos, { vol: 1, rate: 0.8 }); sparks(best.hitboxes[0]?.c || best.pos, 6);
  return true;
}
export function nearestBoarder(o, maxD) {
  let best = null, bd = maxD;
  for (const e of enemies) if (e instanceof Boarder && e.alive && e.leapT >= 1) { const d = Math.hypot(e.pos.x - o.x, e.pos.z - o.z); if (d < bd) { bd = d; best = e; } }
  return best;
}
// 조준 보조 대상: 살아 있고 시야가 트인 적의 몸통 (객체 재사용)
const AT = [];
export function assistTargets(cam) {
  let n = 0;
  for (const en of enemies) {
    if (!en.alive || !en.hitboxes[0] || en.leapT < 1) continue;
    const h = en.hitboxes[0], d = h.c.distanceTo(cam);
    if (d > 70) continue;
    V2.subVectors(h.c, cam).divideScalar(d);
    if (rayBoxes(cam, V2, d) < d - h.r) continue;
    const t = AT[n] || (AT[n] = { x: 0, y: 0, z: 0, r: 0, ref: null });
    t.x = h.c.x; t.y = h.c.y; t.z = h.c.z; t.r = h.r; t.ref = en; n++;
  }
  AT.length = n;
  return AT;
}
// 화면 밖 위협 표시용
export function threats(out) {
  out.length = 0;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e instanceof Boarder) out.push({ p: e.hitboxes[0]?.c || e.pos, kind: e.looting ? 'loot' : 'boarder' });
    else if (e instanceof Walker) out.push({ p: e.hitboxes[0].c, kind: 'walker' });
  }
  for (const s of shells) out.push({ p: s.p, kind: 'shell' });
  return out;
}

export function raycastEnemies(o, d, maxT) {
  let best = null;
  for (const e of enemies) {
    if (!e.alive) continue;
    for (const h of e.hitboxes) {
      const oc = V1.subVectors(o, h.c);
      const b = oc.dot(d), c = oc.lengthSq() - h.r * h.r;
      const disc = b * b - c; if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > 0 && t < maxT && (!best || t < best.t || (Math.abs(t - best.t) < 0.3 && h.mult > best.mult))) best = { enemy: e, t, mult: h.mult };
    }
  }
  return best;
}
export function aimAssistTarget(o, d, cone) {
  let best = null, bestA = cone;
  for (const e of enemies) {
    if (!e.alive) continue;
    const h = e.hitboxes[e.hitboxes.length > 1 && !(e instanceof Walker) ? 0 : 0];
    if (!h) continue;
    const to = V2.subVectors(h.c, o); const L = to.length(); if (L > 70) continue;
    const a = Math.acos(clamp(to.dot(d) / L, -1, 1)) - h.r / L;
    if (a < bestA && rayBoxes(o, to.divideScalar(L), L) >= L - h.r) { bestA = a; best = h.c; }
  }
  return best;
}
