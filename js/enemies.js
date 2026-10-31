// 적 — 산적 바이크·탑승 산적·폭탄 드론·보행 전차(보스)
import * as THREE from 'three';
import { G, TRAIN, clamp, rand, pick, damp } from './state.js';
import { moveBody, rayBoxes, lineOfSight, groundAt, blocked, VAULT } from './world.js';
import { P, hurtPlayer } from './player.js';
import * as UI from './ui.js';
import { sfxAt, sfx } from './audio.js';
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
  damage(amount, point, crit) {
    if (!this.alive) return;
    this.hp -= amount; this.flash = 0.08;
    UI.floater(point, Math.round(amount), crit ? 'crit' : '');
    blood(point);
    if (this.hp <= 0) { this.alive = false; UI.hitmarker(true); G.kills++; this.die(); }
    else { UI.hitmarker(false); sfxAt('enemy_hurt', point, { vol: 0.5 }); this.onHurt?.(); }
  }
  tickFlash(dt) {
    if (this.flash > 0 || this._f) {
      this.flash -= dt; const on = this.flash > 0;
      if (on !== this._f) { for (const m of this.mats) { m.emissive?.setRGB(on ? 0.9 : 0, on ? 0.35 : 0, on ? 0.15 : 0); } this._f = on; }
    }
  }
  reward(n, at) { G.scrap += n; G.totalScrap += n; UI.floater(at, `+${n} ⚙`, 'scrap'); sfxAt('coin', at, { vol: 0.5 }); }
}

// 적의 총격 — 엄폐·앉기·거리로 명중 판정
function enemyShot(from, acc, dmg) {
  const head = V1.set(P.pos.x, P.pos.y + P.eye - 0.15, P.pos.z);
  if (!lineOfSight(from, head)) return false;
  const d = from.distanceTo(head);
  let chance = acc - d * 0.008 - (P.crouch ? 0.14 : 0) - (Math.hypot(P.vel.x, P.vel.z) > 2 ? 0.08 : 0);
  if (G.storm > 0.3) chance -= 0.1;
  const hit = Math.random() < clamp(chance, 0.05, 0.85);
  const end = V2.copy(head);
  if (!hit) end.add(V3.set(rand(-1.2, 1.2), rand(-0.6, 1.0), rand(-1.2, 1.2)));
  tracer(from, end, [1, 0.45, 0.3]);
  muzzleWorld(from, V3.subVectors(end, from).normalize());
  sfxAt('blaster', from, { vol: 0.55, rate: 0.9 });
  if (hit) hurtPlayer(dmg, from);
  return true;
}

// ── 산적 바이크 ────────────────────────────────────────
const SLOTS = [-23.6, -7.2, 9.2];
class Bike extends Enemy {
  constructor(side) {
    super(45);
    const { m, mats } = cloneModel('bike'); this.m = m; this.mats = mats;
    this.side = side; this.x = side * rand(6, 10); this.z = rand(55, 75); this.ry = 0;
    this.slot = pick(SLOTS); this.state = 'approach'; this.t = 0; this.shotT = rand(1.5, 3);
    this.rider = m.getObjectByName('Rider'); this.arm = m.getObjectByName('ArmR');
    this.wheels = ['wf', 'wb'].map((n) => m.getObjectByName(n));
    this.vz = -6; this.wob = rand(0, 6);
    G.scene.add(m);
    this.hitboxes = [{ c: new THREE.Vector3(), r: 0.75, mult: 1, off: [0, 0.75, 0] }, { c: new THREE.Vector3(), r: 0.22, mult: 2, off: [0, 1.75, 0.35] }];
    this.engine = 0;
  }
  update(dt) {
    this.t += dt; this.tickFlash(dt);
    const m = this.m;
    if (this.state === 'approach' || this.state === 'board') {
      const tx = this.state === 'board' ? this.side * 2.25 : this.side * 4.5;
      const tz = this.slot;
      const dz = tz - this.z;
      this.vz = damp(this.vz, clamp(dz * 0.8, -9, 9), 1.5, dt);
      this.z += this.vz * dt;
      this.x = damp(this.x, tx + Math.sin(this.t * 1.3 + this.wob) * 0.3, 1.2, dt);
      if (Math.abs(dz) < 3 && this.state === 'approach') this.state = 'board';
      if (this.state === 'board' && Math.abs(dz) < 0.8 && Math.abs(this.x - this.side * 2.25) < 0.3) {
        this.boardT = (this.boardT || 0) + dt;
        if (this.boardT > 1.1 && (boardersOnTrain() >= 2 + Math.min(2, G.stage - 1) || this.harass)) {
          // 열차가 꽉 찼으면 옆에 붙어 견제 사격만
          this.harass = true; this.state = 'approach'; this.slot = pick(SLOTS) + rand(-4, 4); this.boardT = 0;
        } else if (this.boardT > 1.1) {
          spawnBoarder(this.side, this.slot);
          this.rider.visible = false; this.state = 'empty'; this.alive = false; this.hitboxes = [];
          sfxAt('land', V1.set(this.x, 1.5, this.z), { vol: 0.8 });
        }
      }
      // 사격
      this.shotT -= dt;
      if (this.shotT <= 0 && this.rider.visible) {
        this.shotT = rand(1.8, 3.2) / Math.min(1.6, stageHp());
        const from = this.arm.localToWorld(V3.set(0, 0.04, -0.7)).clone();
        if (from.distanceTo(P.pos) < 38) enemyShot(from, 0.42, 7);
      }
      // 팔을 플레이어 쪽으로
      const ax = P.pos.x - this.x, az = P.pos.z - this.z;
      this.arm.rotation.x = 0.1;
      this.arm.rotation.y = Math.atan2(-ax, -az) - this.ry;
      m.rotation.set(0, this.ry, Math.sin(this.t * 3 + this.wob) * 0.04 + (this.x - this.side * 4.5) * -0.02);
    } else {
      // 빈 바이크/추락 — 뒤로 흘러가며 넘어짐
      this.z += G.speed * 0.6 * dt; this.x += this.side * 2.5 * dt;
      this.tilt = Math.min(1.5, (this.tilt || 0) + dt * 1.6);
      m.rotation.set(this.dead ? this.tilt * 0.6 : 0, this.ry + this.tilt * 0.5, this.side * this.tilt);
      if (this.z > 140) this.remove = true;
    }
    m.position.set(this.x, 0.12, this.z);
    for (const w of this.wheels) if (w) w.rotation.x -= dt * 22;
    if (Math.random() < dt * 22) dust(V1.set(this.x, 0.2, this.z + 0.9), 0.85);
    for (const h of this.hitboxes) h.c.set(this.x + h.off[0], h.off[1], this.z + h.off[2]);
  }
  die() {
    this.dead = true; this.state = 'crash'; this.hitboxes = [];
    explosion(V1.set(this.x, 0.8, this.z), 0.7); sfxAt('enemy_destroy', V1, { vol: 1 });
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
  constructor(side, z) {
    super(38);
    const { m, mats } = cloneModel('bike'); this.mats = mats;
    const rider = m.getObjectByName('Rider');
    rider.position.set(0, 0, 0); rider.rotation.set(0, 0, 0);
    const holder = new THREE.Group(); holder.add(rider); holder.scale.setScalar(1.35);
    this.m = holder; this.rider = rider;
    this.legs = [rider.getObjectByName('leg-1'), rider.getObjectByName('leg1')].filter(Boolean);
    for (const l of this.legs) l.rotation.x = 0;
    this.arm = rider.getObjectByName('ArmR'); this.armL = rider.getObjectByName('ArmL');
    this.pos = new THREE.Vector3(side * 1.25, TRAIN.FLOOR, z); this.vel = new THREE.Vector3();
    this.ry = side > 0 ? Math.PI / 2 : -Math.PI / 2; this.shotT = rand(0.8, 1.6); this.stuck = 0; this.walk = 0; this.looting = false;
    this.hitboxes = [{ c: new THREE.Vector3(), r: 0.36, mult: 1, y: 0.6 }, { c: new THREE.Vector3(), r: 0.2, mult: 2, y: 1.2 }];
    G.scene.add(holder);
    UI.toast(z < -15 ? '산적이 무기칸에 올라탔다!' : z < 0 ? '산적이 화물칸에 침입!' : '산적이 정비칸에 올라탔다!');
  }
  update(dt) {
    this.tickFlash(dt);
    const p = this.pos;
    const toP = V1.set(P.pos.x - p.x, 0, P.pos.z - p.z); const dP = toP.length();
    const eye = V2.set(p.x, p.y + 1.45, p.z);
    const sees = dP < 17 && lineOfSight(eye, V3.set(P.pos.x, P.pos.y + P.eye - 0.1, P.pos.z));
    let tx, tz, wantMove = true;
    const goVault = G.loot < 1;
    if (sees && !this.looting) { wantMove = dP > 7; tx = P.pos.x; tz = P.pos.z; }
    else if (goVault) { tx = 0.02; tz = VAULT.z; }
    else { tx = P.pos.x; tz = P.pos.z; }
    // 금고 도착 → 약탈
    this.flinch = Math.max(0, (this.flinch || 0) - dt);
    const atVault = Math.hypot(p.x - 0.02, p.z - VAULT.z) < 0.7 && goVault && this.flinch <= 0;
    this.looting = atVault;
    if (atVault) { wantMove = false; lootingNow++; }
    const dir = V3.set(0, 0, 0);
    if (wantMove) {
      if (sees || !goVault) dir.set(tx - p.x, 0, tz - p.z);
      else navDir(p.x, p.z, dir);
      const dl = dir.length(); if (dl > 0.01) dir.multiplyScalar(2.6 / dl);
    }
    // 서로 겹치지 않게
    for (const o of enemies) if (o !== this && o instanceof Boarder && o.alive) {
      const ox = p.x - o.pos.x, oz = p.z - o.pos.z, d = Math.hypot(ox, oz);
      if (d < 0.6 && d > 0.001) { dir.x += ox / d * 1.5; dir.z += oz / d * 1.5; }
    }
    this.vel.x = damp(this.vel.x, dir.x, 8, dt); this.vel.z = damp(this.vel.z, dir.z, 8, dt);
    this.vel.y -= 22 * dt;
    const bx = p.x, bz = p.z;
    moveBody(p, this.vel, dt, 0.3, 1.5, 0.45);
    const moved = Math.hypot(p.x - bx, p.z - bz) / dt;
    if (wantMove && moved < 0.4) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 1.6) this.stuck = 0;
    if (p.y < 0.5) { this.alive = false; this.remove = true; G.scene.remove(this.m); return; }  // 떨어짐
    // 방향·걷기
    const face = sees ? Math.atan2(-(P.pos.x - p.x), -(P.pos.z - p.z)) : (moved > 0.3 ? Math.atan2(-this.vel.x, -this.vel.z) : this.ry);
    let d = face - this.ry; d = Math.atan2(Math.sin(d), Math.cos(d)); this.ry += d * Math.min(1, dt * 8);
    this.walk += moved * dt * 3.5;
    const sw = moved > 0.3 ? Math.sin(this.walk) * 0.6 : 0;
    if (this.legs[0]) this.legs[0].rotation.x = sw; if (this.legs[1]) this.legs[1].rotation.x = -sw;
    if (this.armL) this.armL.rotation.x = this.looting ? -1.0 + Math.sin(G.time * 12) * 0.4 : -sw * 0.5;
    if (this.arm) this.arm.rotation.x = sees ? 0.05 : this.looting ? -0.5 + Math.sin(G.time * 12 + 1) * 0.3 : -0.9;
    this.m.position.set(p.x, p.y + 0.16, p.z); this.m.rotation.y = this.ry;
    // 사격
    if (sees) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT = rand(1.1, 1.8) / Math.min(1.5, stageHp());
        const from = this.arm.localToWorld(V1.set(0, 0.04, -0.7)).clone();
        enemyShot(from, 0.5, 8);
      }
    } else this.shotT = Math.max(this.shotT, 0.5);
    for (const h of this.hitboxes) h.c.set(p.x, p.y + h.y, p.z);
  }
  die() {
    const at = V1.set(this.pos.x, this.pos.y + 1.2, this.pos.z).clone();
    this.reward(10, at); puff(at, 8, [0.7, 0.5, 0.35, 0.6]);
    sfxAt('enemy_destroy', at, { vol: 0.6, rate: 1.3 });
    this.dying = 0; this.hitboxes = [];
  }
  onHurt() { this.flinch = 1.5; }
  dieUpdate(dt) {
    this.dying += dt;
    this.m.rotation.x = Math.min(1.5, this.dying * 5) * -1;
    this.m.position.y = this.pos.y + 0.16 - Math.min(0.3, this.dying);
    if (this.dying > 1.0) { this.m.scale.multiplyScalar(Math.pow(0.02, dt)); }
    if (this.dying > 1.6) this.remove = true;
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
    explosion(this.p.clone(), 0.65); sfxAt('enemy_destroy', this.p, { vol: 0.9, rate: 1.2 });
    const d = this.p.distanceTo(V1.set(P.pos.x, P.pos.y + 1, P.pos.z));
    if (d < 3.6) hurtPlayer((onPlayer ? 22 : 14) * (1 - d / 5), this.p);
    // 주변 적에게도 피해
    for (const e of enemies) if (e !== this && e.alive && e.hitboxes[0] && e.hitboxes[0].c.distanceTo(this.p) < 3.5) e.damage(25, e.hitboxes[0].c.clone(), false);
    G.scene.remove(this.m);
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
  sfxAt('impact', from, { vol: 1, rate: 0.5 }); sfxAt('blaster', from, { vol: 0.8, rate: 0.35 });
}
function updateShells(dt) {
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i]; s.t += dt;
    s.v.y -= s.g * dt; s.p.addScaledVector(s.v, dt); s.mesh.position.copy(s.p);
    if (Math.random() < dt * 40) smoke(s.p.clone(), 0.15);
    const g = groundAt(s.p.x, s.p.z, s.p.y, 0.1, 0);
    const inBox = G.boxes.some((b) => s.p.x > b.min[0] && s.p.x < b.max[0] && s.p.y > b.min[1] && s.p.y < b.max[1] && s.p.z > b.min[2] && s.p.z < b.max[2]);
    if (s.p.y <= g || inBox || s.t > s.T + 1.5) {
      explosion(s.p, 0.9); sfxAt('enemy_destroy', s.p, { vol: 1, rate: 0.8 });
      const d = s.p.distanceTo(V1.set(P.pos.x, P.pos.y + 0.9, P.pos.z));
      if (d < 3.2) hurtPlayer(32 * (1 - d / 3.8) * (s.w.boss ? 1.1 : 1), s.p);
      G.scene.remove(s.mesh); shells.splice(i, 1);
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
