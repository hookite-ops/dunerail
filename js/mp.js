// DUNE RAIL 멀티 "열차 강도" — 원격 플레이어, 봇(방장이 돌림), 금괴 자루, 도주 마차, 멀티 HUD
import * as THREE from 'three';
import { G, TRAIN, clamp, lerp, rand, damp, pick } from './state.js';
import { moveBody, rayBoxes, lineOfSight, groundAt, onTrain } from './world.js';
import { makeBandit, poseSeated, aimArm, navGrid } from './enemies.js';
import { P, WEAPONS, spawnAt, hurtPlayer, knockMe, addDyn, clearDyn, canLand, setWeapon } from './player.js';
import { Net } from './net/client.js';
import { FL, BAG_HOME, EXTRACT, FLOOR, WEAPON_IDS } from './net/rules.js';
import * as UI from './ui.js';
import { sfx, sfxAt, gunshot, hitSound, setLoop } from './audio.js';
import { tracer, muzzleWorld, explosion, hitPuff, dust, sparks, addShake, puff, flash } from './fx.js';

const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3(), V4 = new THREE.Vector3();
const $ = (id) => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const W_ICON = { rifle: '🔫', shotgun: '💥', revolver: '🤠', fall: '⬇', dyn: '🧨', melee: '👊' };

// ── 상태 ───────────────────────────────────────────────
const M = {
  net: null, me: null, code: '', meta: null, ents: new Map(), bots: new Map(),
  bag: { st: 'home', by: null, x: BAG_HOME.x, y: BAG_HOME.y, z: BAG_HOME.z }, timer: 0, ot: false, bags: 0, resp: {},
  sendT: 0, myLoot: 0, killer: null, deathPos: new THREE.Vector3(), fallSent: false, banner: null, active: false,
};
export const mp = M;

// ── 화면에 보이는 사람 (원격 플레이어·봇 공통) ─────────
const ROLE_TINT = { R: { shirt: 0x9e2a1b, poncho: 0xc79a5c, hat: 0x4a3020 }, G: { shirt: 0x24457a, poncho: 0x2c3446, hat: 0x17181c } };
class Avatar {
  constructor(ent) {
    const b = makeBandit(); this.m = b.m; this.j = b.j; this.mats = b.mats;
    this.m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    G.scene.add(this.m);
    this.bikeM = G.models.bike2.clone(true); this.bikeM.visible = false; G.scene.add(this.bikeM);
    this.wheels = ['wf', 'wb'].map((n) => this.bikeM.getObjectByName(n));
    this.sack = makeSack(0.75); this.sack.position.set(0, 0.25, -0.2); this.sack.visible = false; this.j.Spine.add(this.sack);
    this.tag = makeTag(); G.scene.add(this.tag);
    this.hit = [{ c: new THREE.Vector3(), r: 0.36, mult: 1, j: 'Spine', dy: 0.25 }, { c: new THREE.Vector3(), r: 0.2, mult: 2.2, j: 'Head', dy: 0.08 },
      { c: new THREE.Vector3(), r: 0.28, mult: 0.8, j: 'Hips', dy: -0.2 }];
    this.walk = 0; this.last = new THREE.Vector3(); this.speed = 0; this.dying = -1; this.recoil = 0; this.role = null; this.ent = ent;
    this.setRole('R');
  }
  setRole(role) {
    if (role === this.role) return; this.role = role;
    const t = ROLE_TINT[role];
    for (const mt of this.mats) { if (mt.name === 'ShirtRed') mt.color.setHex(t.shirt); if (mt.name === 'Poncho') mt.color.setHex(t.poncho); if (mt.name === 'HatFelt') mt.color.setHex(t.hat); }
  }
  setTag(name, ally) { drawTag(this.tag, name, ally); this.tag.material.depthTest = !ally; this.tag.renderOrder = ally ? 10 : 0; }
  pose(s, dt) {
    const j = this.j, m = this.m;
    if (this.dying >= 0) return this.dieUpdate(dt);
    const bike = s.fl & FL.BIKE, crouch = s.fl & FL.CROUCH, leap = s.fl & FL.LEAP;
    this.speed = damp(this.speed, Math.hypot(s.x - this.last.x, s.z - this.last.z) / Math.max(dt, 1e-3), 10, dt);
    this.last.set(s.x, s.y, s.z);
    for (const k of ['LegL', 'LegR', 'KneeL', 'KneeR', 'Spine', 'ArmL']) j[k].rotation.set(0, 0, 0);
    this.bikeM.visible = !!bike && !leap;
    let bodyYaw = s.yaw;
    if (bike && !leap) {
      this.bikeM.position.set(s.x, 0.02 + Math.sin(G.time * 17 + s.x) * 0.01, s.z);
      this.bikeM.rotation.set(0, 0, Math.sin(G.time * 3 + s.z) * 0.03);
      for (const w of this.wheels) if (w) w.rotation.x -= dt * 24;
      m.position.set(s.x, 0.09, s.z + 0.42); bodyYaw = 0;
      poseSeated(j);
      let d = s.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); j.Spine.rotation.y = clamp(d, -1.2, 1.2) * 0.6;
      if (Math.random() < dt * 20) dust(V1.set(s.x, 0.2, s.z + 1.3), 0.85);
    } else {
      m.position.set(s.x, s.y - (crouch ? 0.38 : 0), s.z);
      if (leap) { j.LegL.rotation.x = j.LegR.rotation.x = 1.0; j.KneeL.rotation.x = j.KneeR.rotation.x = -1.3; }
      else if (crouch) { j.LegL.rotation.x = j.LegR.rotation.x = 1.15; j.KneeL.rotation.x = j.KneeR.rotation.x = -1.7; j.Spine.rotation.x = -0.25; }
      else {
        this.walk += this.speed * dt * 3.0;
        const sw = this.speed > 0.4 ? Math.sin(this.walk) * Math.min(1, this.speed / 4) : 0;
        j.LegL.rotation.x = sw * 0.6; j.LegR.rotation.x = -sw * 0.6;
        j.KneeL.rotation.x = -Math.max(0, -sw) * 0.9; j.KneeR.rotation.x = -Math.max(0, sw) * 0.9;
        j.ArmL.rotation.set(-sw * 0.4, 0, -0.1);
        j.Spine.rotation.x = s.fl & FL.SPRINT ? -0.18 : 0;
      }
      if (s.fl & FL.CARRY) j.Spine.rotation.x -= 0.15;
    }
    m.rotation.set(0, bodyYaw, 0);
    this.sack.visible = !!(s.fl & FL.CARRY);
    // 오른팔: 보는 방향으로 총을 겨눔
    m.updateMatrixWorld();
    const eye = V1.set(s.x, (bike ? 0.09 : s.y) + (bike ? 1.45 : crouch ? 1.15 : 1.55), s.z);
    const dir = V2.set(-Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), -Math.cos(s.yaw) * Math.cos(s.pitch));
    aimArm(j, bodyYaw, eye.addScaledVector(dir, 10));
    this.recoil = damp(this.recoil, 0, 12, dt);
    j.ArmR.rotation.x += this.recoil * 0.35;
    m.updateMatrixWorld();
    for (const h of this.hit) { j[h.j].getWorldPosition(h.c); h.c.y += h.dy; }
    j.Head.getWorldPosition(this.tag.position); this.tag.position.y += 0.62;
  }
  die(dir) { this.dying = 0; this.dvel = new THREE.Vector3((dir?.x || 0) * 2.5, 2.2, (dir?.z || 0) * 2.5); this.bikeM.visible = false; this.tag.visible = false; this.sack.visible = false; }
  dieUpdate(dt) {
    this.dying += dt; const m = this.m, p = m.position, v = this.dvel;
    v.y -= 20 * dt; p.addScaledVector(v, dt);
    const g = onTrain(p.x, p.z) ? groundAt(p.x, p.z, p.y + 0.3, 0.2, 0.5) : 0.05;
    if (p.y < g) { p.y = g; v.set(v.x * 0.5, 0, v.z * 0.5); }
    if (g < 0.5 && p.y < 0.6) p.z += G.speed * dt;
    const fall = Math.min(1.5, this.dying * 4.5);
    m.rotation.x = -fall; this.j.ArmL.rotation.x = this.j.ArmR.rotation.x = -2.2 * Math.min(1, this.dying * 3);
    if (this.dying > 2.6) m.visible = false;
  }
  revive() { this.dying = -1; this.m.visible = true; this.m.rotation.x = 0; this.tag.visible = true; }
  hide() { this.m.visible = false; this.bikeM.visible = false; this.tag.visible = false; }
  dispose() { G.scene.remove(this.m); G.scene.remove(this.bikeM); G.scene.remove(this.tag); }
}
function makeTag() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(1.2, 0.3, 1); s.userData.c = c; return s;
}
function drawTag(s, name, ally) {
  const c = s.userData.c, g = c.getContext('2d'); g.clearRect(0, 0, 256, 64);
  g.font = '900 30px "Noto Sans KR", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (ally) {
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(name, 128, 24); g.fillStyle = '#8fd0ff'; g.fillText(name, 128, 24);
    g.fillStyle = '#8fd0ff'; g.beginPath(); g.moveTo(116, 46); g.lineTo(140, 46); g.lineTo(128, 60); g.fill();
  } else { g.fillStyle = '#ff4b36'; g.beginPath(); g.moveTo(128, 34); g.lineTo(142, 48); g.lineTo(128, 62); g.lineTo(114, 48); g.fill(); }
  s.material.map.needsUpdate = true;
}
function makeSack(s = 1) {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0xb08a55, roughness: 0.95 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22 * s, 12, 10), cloth); body.scale.set(1, 1.15, 0.85); g.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.1 * s, 0.12 * s, 8), cloth); neck.position.y = 0.26 * s; g.add(neck);
  const tie = new THREE.Mesh(new THREE.TorusGeometry(0.065 * s, 0.018 * s, 6, 12), new THREE.MeshStandardMaterial({ color: 0x5a3622 })); tie.rotation.x = Math.PI / 2; tie.position.y = 0.24 * s; g.add(tie);
  const gold = new THREE.Mesh(new THREE.BoxGeometry(0.16 * s, 0.05 * s, 0.07 * s), new THREE.MeshStandardMaterial({ color: 0xffc94a, metalness: 1, roughness: 0.25, emissive: 0x6a4200 }));
  gold.position.set(0.04 * s, 0.33 * s, 0); gold.rotation.z = 0.4; g.add(gold);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ── 엔티티 (사람 한 명의 네트워크 상태) ────────────────
function ent(id) {
  let e = M.ents.get(id);
  if (!e) { e = { id, name: '', side: 'A', bot: false, alive: false, hp: 100, buf: [], s: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fl: 0, w: 'rifle' }, av: null }; M.ents.set(id, e); }
  return e;
}
const roleOf = (side) => (M.meta ? M.meta.roles[side] : 'R');
const myEnt = () => M.ents.get(M.me);
const mySide = () => myEnt()?.side || 'A';
const myRole = () => roleOf(mySide());
const isEnemy = (e) => e && e.id !== M.me && e.side !== mySide();
const amHost = () => M.meta && M.meta.host === M.me;
const nameOf = (id) => M.ents.get(id)?.name || '?';
function sampleEnt(e, now) {
  // 120ms 뒤를 그려서 사이를 부드럽게 잇는다
  const b = e.buf; if (!b.length) return null;
  const t = now - 0.12;
  while (b.length > 2 && b[1].t <= t) b.shift();
  const a = b[0], c = b[1];
  if (!c || t <= a.t) return a;
  const k = clamp((t - a.t) / (c.t - a.t), 0, 1);
  let dy = c.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  const s = e.s;
  s.x = lerp(a.x, c.x, k); s.y = lerp(a.y, c.y, k); s.z = lerp(a.z, c.z, k); s.yaw = a.yaw + dy * k; s.pitch = lerp(a.pitch, c.pitch, k); s.fl = c.fl; s.w = c.w;
  if (Math.hypot(c.x - a.x, c.z - a.z) > 6) { s.x = c.x; s.y = c.y; s.z = c.z; }   // 순간이동(리스폰)
  return s;
}

// ── 봇 (방장 브라우저가 몸을 움직이고 총을 쏜다) ────────
const SLOTS = [-23.6, -21, -18, -16, -7.2, 1.5, 4.5, 9.2, 35, 37.5];
const POSTS_G = [[0.55, -4.2], [-0.3, -10.5], [0.5, 2.2], [-0.6, 5.5], [0.45, -12.6], [-0.5, 10.6], [0.6, -1.6], [0, 15.5]];
class Bot {
  constructor(id) { this.id = id; this.p = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.yaw = 0; this.pitch = 0; this.alive = false; this.fields = {}; this.reset(); }
  reset() { this.bike = null; this.target = null; this.seeT = 0; this.fireCd = 1; this.ammo = 8; this.reloadT = 0; this.knockT = 0; this.postT = 0; this.post = null; this.strafe = rand(-1, 1); this.crouch = false; this.onGround = true; this.fieldT = 0; this.goalLabel = ''; }
  spawn(at, w) {
    this.reset(); this.alive = true; this.w = w || 'rifle'; this.ammo = WEAPONS[this.w].mag;
    this.p.set(at.x, at.y, at.z); this.vel.set(0, 0, 0);
    if (at.bike) {
      const side = at.side;
      const opts = SLOTS.filter((z) => canLand(side, z));
      const pref = opts.filter((z) => Math.abs(z - BAG_HOME.z) < 14);
      this.bike = { side, x: at.x, z: at.z, slot: (Math.random() < 0.7 && pref.length ? pick(pref) : pick(opts.length ? opts : [-7.2])) + rand(-0.4, 0.4), leap: null };
      this.yaw = side > 0 ? 0.8 : -0.8;
    } else this.yaw = Math.PI;
  }
  get role() { return roleOf(ent(this.id).side); }
  enemies() { const side = ent(this.id).side; const out = []; for (const e of M.ents.values()) if (e.alive && e.side !== side) out.push(e); return out; }
  posOf(e) {   // 상대 위치: 나면 P, 봇이면 그 봇 시뮬, 아니면 보간된 상태
    if (e.id === M.me) return { x: P.pos.x, y: P.pos.y, z: P.pos.z, fl: P.bike ? FL.BIKE : P.crouch ? FL.CROUCH : 0, moving: Math.hypot(P.vel.x, P.vel.z) > 1 };
    const b = M.bots.get(e.id); if (b) return { x: b.p.x, y: b.p.y, z: b.p.z, fl: b.bike ? FL.BIKE : 0, moving: Math.hypot(b.vel.x, b.vel.z) > 1 };
    return { x: e.s.x, y: e.s.y, z: e.s.z, fl: e.s.fl, moving: true };
  }
  field(key, tx, tz) {
    const f = this.fields[key];
    if (f && f.tx === tx && f.tz === tz) return f;
    return (this.fields[key] = { tx, tz, d: bfs(tx, tz) });
  }
  update(dt) {
    if (!this.alive) return;
    const e = ent(this.id);
    // 시야 안의 적 고르기
    const eye = V1.set(this.p.x, this.p.y + (this.bike ? 1.45 : this.crouch ? 1.1 : 1.55), this.p.z);
    this.scanT = (this.scanT || 0) - dt;
    let best = this.target, bd = 30;
    if (best) { const o = M.ents.get(best.id); const q = o?.alive ? this.posOf(o) : null; if (q) { best.q = q; best.head.set(q.x, q.y + (q.fl & FL.BIKE ? 1.5 : q.fl & FL.CROUCH ? 1.1 : 1.5), q.z); best.d = eye.distanceTo(best.head); } else best = null; }
    if (this.scanT <= 0) { this.scanT = 0.12; best = null;
    for (const o of this.enemies()) {
      const q = this.posOf(o);
      const head = V2.set(q.x, q.y + (q.fl & FL.BIKE ? 1.5 : q.fl & FL.CROUCH ? 1.1 : 1.5), q.z);
      const d = eye.distanceTo(head);
      if (d > bd) continue;
      let ang = Math.atan2(-(head.x - eye.x), -(head.z - eye.z)) - this.yaw; ang = Math.atan2(Math.sin(ang), Math.cos(ang));
      if (Math.abs(ang) > 1.3 && d > 5 && !(this.target && this.target.id === o.id)) continue;
      if (!lineOfSight(eye, head)) continue;
      best = { id: o.id, q, d, head: head.clone() }; bd = d;
    } }
    if (best && (!this.target || this.target.id !== best.id)) this.seeT = 0;
    this.target = best;
    this.seeT = best ? this.seeT + dt : 0;
    if (this.bike) this.rideBike(dt);
    else this.walkTrain(dt);
    // 조준·사격
    if (best) {
      const want = Math.atan2(-(best.head.x - eye.x), -(best.head.z - eye.z));
      let dy = want - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += clamp(dy, -6 * dt, 6 * dt);
      this.pitch = damp(this.pitch, Math.atan2(best.head.y - eye.y, Math.hypot(best.head.x - eye.x, best.head.z - eye.z)), 8, dt);
      this.fireCd -= dt;
      if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) this.ammo = WEAPONS[this.w].mag; }
      else if (this.fireCd <= 0 && this.seeT > 0.5 && Math.abs(dy) < 0.25 && !(this.bike && this.bike.leap)) this.fire(best, eye);
    } else {
      this.pitch = damp(this.pitch, 0, 4, dt);
      if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) this.ammo = WEAPONS[this.w].mag; }
      else if (this.ammo < WEAPONS[this.w].mag * 0.5) this.reloadT = WEAPONS[this.w].reload;
    }
  }
  fire(t, eye) {
    const w = WEAPONS[this.w];
    this.fireCd = w.fire * rand(1.6, 2.3); this.ammo--;
    if (this.ammo <= 0) this.reloadT = w.reload;
    const d = t.d;
    let chance = (this.w === 'shotgun' ? 0.95 - d * 0.045 : this.w === 'rifle' ? 0.62 : 0.5) - d * 0.012 + Math.min(0.15, (this.seeT - 0.5) * 0.08);
    if (t.q.moving) chance -= 0.12; if (t.q.fl & FL.CROUCH) chance -= 0.1; if (this.bike) chance -= 0.1;
    const hit = Math.random() < clamp(chance, 0.06, 0.88);
    const av = ent(this.id).av;
    const from = av ? av.j.muzzle.getWorldPosition(new THREE.Vector3()) : eye.clone();
    const to = t.head.clone(); if (!hit) to.add(V3.set(rand(-1.2, 1.2), rand(-0.6, 0.9), rand(-1.2, 1.2)));
    remoteShotFx(from, to, this.w, av);
    M.net.send({ t: 'shot', id: this.id, a: arr(from), b: arr(to), w: this.w });
    if (hit) {
      let dmg = w.dmg; const head = this.w !== 'shotgun' && Math.random() < 0.14;
      if (this.w === 'shotgun') dmg = w.dmg * Math.round(9 * clamp(1 - (d - 3) / 14, 0.15, 1));
      if (head) dmg *= 2.2;
      M.net.send({ t: 'hit', by: this.id, tgt: t.id, dmg: Math.round(dmg), head, how: 'gun' });
    }
  }
  rideBike(dt) {
    const b = this.bike;
    if (b.leap) {
      const L = b.leap; L.t = Math.min(1, L.t + dt / 0.5);
      this.p.lerpVectors(L.from, L.to, L.t); this.p.y += Math.sin(L.t * Math.PI) * 1.5;
      if (L.t >= 1) { this.bike = null; this.p.copy(L.to); this.vel.set(0, 0, 0); sfxAt('land', this.p, { vol: 0.8 }); }
      return;
    }
    const tz = b.slot, tx = b.side * 2.5;
    const vz = clamp((tz - b.z) * 1.1, -10, 10), vx = clamp((tx - b.x) * 2, -4, 4);
    b.z += vz * dt; b.x += vx * dt;
    this.p.set(b.x, 0, b.z); this.vel.set(vx, 0, vz);
    if (Math.abs(b.z - tz) < 0.5 && Math.abs(b.x - tx) < 0.4) {
      if (canLand(b.side, b.z)) b.leap = { t: 0, from: new THREE.Vector3(b.x, 0.3, b.z), to: new THREE.Vector3(b.side * 1.0, FLOOR, b.z) };
      else b.slot = pick(SLOTS.filter((z) => canLand(b.side, z)));
    }
    if (!this.target) { let d = (b.side > 0 ? 0.9 : -0.9) - this.yaw; this.yaw += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, dt * 3); }
  }
  walkTrain(dt) {
    const role = this.role, bag = M.bag, me = this.id;
    let goal = null, key = 'g';
    if (role === 'R') {
      if (bag.st === 'carry' && bag.by === me) { goal = { x: 0, z: 36.4 }; key = 'ex'; }
      else if (bag.st === 'carry') { const q = this.posOf(ent(bag.by)); goal = { x: q.x + 0.6, z: q.z + 2.2 }; key = 'esc'; }
      else if (bag.st === 'drop') { goal = { x: bag.x, z: bag.z }; key = 'bag'; }
      else { goal = { x: BAG_HOME.x, z: BAG_HOME.z }; key = 'home'; }
    } else {
      if (bag.st === 'carry') { const q = this.posOf(ent(bag.by)); goal = { x: q.x, z: q.z }; key = 'thief'; }
      else if (bag.st === 'drop') { goal = { x: bag.x, z: bag.z }; key = 'bag'; }
      else {
        this.postT -= dt;
        if (!this.post || this.postT <= 0) { this.post = pick(POSTS_G); this.postT = rand(6, 11); }
        goal = { x: this.post[0], z: this.post[1] }; key = 'post';
      }
    }
    // 흐름장으로 길 찾기 (목표 칸이 바뀔 때만 다시 계산)
    const N = navGrid();
    const gi = clamp(Math.floor((goal.x - N.x0) / N.c), 0, N.nx - 1), gk = clamp(Math.floor((goal.z - N.z0) / N.c), 0, N.nz - 1);
    const f = this.field(key, gi, gk);
    const dir = V3.set(0, 0, 0);
    const dist = Math.hypot(goal.x - this.p.x, goal.z - this.p.z);
    let stop = dist < (key === 'post' ? 0.6 : key === 'esc' ? 2 : 0.35);
    if (this.target && role === 'G' && bag.st === 'home' && this.target.d > 7) stop = true;   // 경비는 보이면 멈춰 쏜다
    if (!stop && this.p.y < FLOOR + 0.6) {
      if (dist < 1.2) dir.set(goal.x - this.p.x, 0, goal.z - this.p.z);
      else fieldDir(f.d, this.p.x, this.p.z, dir);
    }
    let sp = (bag.st === 'carry' && bag.by === me) ? 3.8 : this.target ? 3.2 : 4.6;
    const L = dir.length(); if (L > 0.01) dir.multiplyScalar(sp / L);
    if (this.target && this.target.d < 14) {   // 좌우로 흔들며 쏜다
      this.strafe += dt * rand(0.5, 1.5); const s = Math.sin(this.strafe * 2.2) * 1.4;
      dir.x += Math.cos(this.yaw) * s; dir.z -= Math.sin(this.yaw) * s;
    }
    this.crouch = !!this.target && stop && Math.sin(G.time * 0.7 + this.p.z) > 0.3;
    // 서로 밀어내기
    for (const o of M.bots.values()) if (o !== this && o.alive && !o.bike) {
      const ox = this.p.x - o.p.x, oz = this.p.z - o.p.z, d = Math.hypot(ox, oz);
      if (d < 0.6 && d > 0.001) { dir.x += ox / d * 1.5; dir.z += oz / d * 1.5; }
    }
    if (this.knockT > 0) { this.knockT -= dt; this.vel.x *= Math.exp(-1.2 * dt); this.vel.z *= Math.exp(-1.2 * dt); }
    else { this.vel.x = damp(this.vel.x, dir.x, 9, dt); this.vel.z = damp(this.vel.z, dir.z, 9, dt); }
    this.vel.y -= 22 * dt;
    const step = this.knockT > 0 ? 0.45 + Math.max(0, this.p.y - FLOOR) : 0.45;
    this.onGround = moveBody(this.p, this.vel, dt, 0.3, this.crouch ? 1.1 : 1.6, step);
    if (Math.abs(this.p.x) > 1.55 && this.knockT > 0) this.p.z += G.speed * 0.2 * dt;
    if (!this.target && Math.hypot(this.vel.x, this.vel.z) > 0.5) {
      const want = Math.atan2(-this.vel.x, -this.vel.z); let d = want - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); this.yaw += d * Math.min(1, dt * 7);
    }
    if ((this.p.y < 0.6 && !onTrain(this.p.x, this.p.z)) || this.p.y < 0.3) { this.alive = false; M.net.send({ t: 'fall', id: this.id }); }
  }
  state() {
    let fl = 0;
    if (this.bike) fl |= FL.BIKE; if (this.bike?.leap) fl |= FL.LEAP; if (this.crouch) fl |= FL.CROUCH;
    if (M.bag.st === 'carry' && M.bag.by === this.id) fl |= FL.CARRY;
    if (!this.target && !this.bike && Math.hypot(this.vel.x, this.vel.z) > 4.2) fl |= FL.SPRINT;
    return { p: [r2(this.p.x), r2(this.p.y), r2(this.p.z)], yaw: r2(this.yaw), pitch: r2(this.pitch), fl, w: this.w };
  }
}
const r2 = (v) => Math.round(v * 100) / 100;
const arr = (v) => [r2(v.x), r2(v.y), r2(v.z)];
function bfs(ti, tk) {
  const N = navGrid(); const { nx, nz, walk } = N;
  const dist = new Float32Array(nx * nz).fill(1e9);
  // 목표 칸이 못 가는 칸이면 가까운 갈 수 있는 칸에서 시작
  let start = tk * nx + ti;
  if (!walk[start]) { let bd = 1e9; for (let r = 1; r < 8 && bd === 1e9; r++) for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++) { const a = ti + di, b = tk + dk; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const n = b * nx + a; if (walk[n] && Math.abs(di) + Math.abs(dk) < bd) { bd = Math.abs(di) + Math.abs(dk); start = n; } } }
  const q = [start]; let h = 0; dist[start] = 0;
  while (h < q.length) {
    const id = q[h++], i = id % nx, k = (id / nx) | 0;
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      if (!di && !dk) continue;
      const a = i + di, b = k + dk; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = b * nx + a; if (!walk[n]) continue;
      if (di && dk && (!walk[k * nx + a] || !walk[b * nx + i])) continue;
      const nd = dist[id] + (di && dk ? 1.414 : 1);
      if (nd < dist[n]) { dist[n] = nd; q.push(n); }
    }
  }
  return dist;
}
function fieldDir(dist, x, z, out) {
  const N = navGrid(); const { c, x0, z0, nx, nz } = N;
  const i = clamp(Math.floor((x - x0) / c), 0, nx - 1), k = clamp(Math.floor((z - z0) / c), 0, nz - 1);
  let best = dist[k * nx + i], bi = i, bk = k;
  for (let r = 1; r <= 3; r++) {
    for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++) {
      if (Math.max(Math.abs(di), Math.abs(dk)) !== r) continue;
      const a = i + di, b = k + dk; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      if (dist[b * nx + a] < best - 0.01) { best = dist[b * nx + a]; bi = a; bk = b; }
    }
    if (bi !== i || bk !== k) break;
  }
  out.set(x0 + (bi + 0.5) * c - x, 0, z0 + (bk + 0.5) * c - z);
}

// ── 월드 소품: 금괴 자루, 탈출 표시, 도주 마차 ──────────
let worldBag, bagBeam, exitRing, wagon, wagonSacks = [], tossFx = [];
function buildProps() {
  worldBag = makeSack(1.1); G.scene.add(worldBag);
  const beamM = new THREE.MeshBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  bagBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 9, 12, 1, true), beamM); G.scene.add(bagBeam);
  // 후미 발코니 탈출 지점
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 14; g.setLineDash([26, 16]); g.strokeRect(12, 12, 232, 232);
  g.setLineDash([]); g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(12, 12, 232, 232);
  g.fillStyle = '#fff'; g.font = '900 64px "Black Han Sans", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('탈출', 128, 132);
  const tx = new THREE.CanvasTexture(c);
  exitRing = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.6), new THREE.MeshBasicMaterial({ map: tx, transparent: true, color: 0xffc94a, depthWrite: false, blending: THREE.AdditiveBlending }));
  exitRing.rotation.x = -Math.PI / 2; exitRing.position.set(0, FLOOR + 0.03, 36.5); G.scene.add(exitRing);
  // 도주 마차: 열차 뒤를 따라오는 평판 화물차 + 말 없는 증기 마차
  wagon = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a4b2c, roughness: 0.85 }), iron = new THREE.MeshStandardMaterial({ color: 0x2d2a28, roughness: 0.5, metalness: 0.8 });
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 4.2), wood); bed.position.y = 1.0; wagon.add(bed);
  for (const sx of [-1, 1]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 4.2), wood); rail.position.set(sx * 1.15, 1.35, 0); wagon.add(rail); }
  for (const sx of [-1, 1]) for (const sz of [-1.4, 1.4]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 14), iron); w.rotation.z = Math.PI / 2; w.position.set(sx * 1.2, 0.55, sz); wagon.add(w); }
  const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 12), iron); boiler.rotation.x = Math.PI / 2; boiler.position.set(0, 1.6, 1.6); wagon.add(boiler);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.9, 8), iron); stack.position.set(0, 2.3, 2.0); wagon.add(stack);
  const flagM = new THREE.MeshStandardMaterial({ color: 0xa3301f, side: THREE.DoubleSide });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), wood); pole.position.set(-1.0, 2.2, -1.8); wagon.add(pole);
  const flg = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), flagM); flg.position.set(-0.6, 3.0, -1.8); wagon.add(flg); wagon.userData.flag = flg;
  for (let i = 0; i < 4; i++) { const s = makeSack(1.0); s.position.set((i % 2 - 0.5) * 0.9, 1.35, -1.0 + Math.floor(i / 2) * 0.9); s.visible = false; wagon.add(s); wagonSacks.push(s); }
  wagon.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  wagon.scale.setScalar(0.85);
  wagon.position.set(0, 0, 58); wagon.visible = false; G.scene.add(wagon);
}
function updateProps(dt) {
  const b = M.bag, role = myRole();
  const showWorld = b.st === 'home' || b.st === 'drop';
  worldBag.visible = showWorld; bagBeam.visible = showWorld;
  if (showWorld) {
    worldBag.position.set(b.x, b.y + 0.24 + Math.sin(G.time * 2.5) * 0.04, b.z); worldBag.rotation.y += dt * 0.8;
    bagBeam.position.set(b.x, b.y + 4.5, b.z);
    bagBeam.material.color.setHex(b.st === 'drop' ? 0xff7a3a : 0xffc94a);
    bagBeam.material.opacity = 0.18 + Math.sin(G.time * 4) * 0.06;
  }
  exitRing.material.color.setHex(role === 'R' ? 0xffc94a : 0xff5040);
  exitRing.material.opacity = 0.55 + Math.sin(G.time * 3) * 0.25;
  wagon.visible = true;
  wagon.position.set(Math.sin(G.time * 0.4) * 0.15, Math.abs(Math.sin(G.time * 9)) * 0.03, 58);
  wagon.userData.flag.rotation.y = Math.sin(G.time * 6) * 0.3;
  wagonSacks.forEach((s, i) => { s.visible = i < M.bags; });
  if (Math.random() < dt * 6) puff(V1.set(wagon.position.x, 2.8, wagon.position.z + 2), 1, [0.3, 0.27, 0.25, 0.5]);
  for (let i = tossFx.length - 1; i >= 0; i--) {
    const t = tossFx[i]; t.t += dt / 0.9;
    t.m.position.lerpVectors(t.a, t.b, Math.min(1, t.t)); t.m.position.y += Math.sin(Math.min(1, t.t) * Math.PI) * 3;
    t.m.rotation.x += dt * 6;
    if (t.t >= 1) { G.scene.remove(t.m); tossFx.splice(i, 1); }
  }
}

// ── HUD ────────────────────────────────────────────────
const markers = [];
function marker(i, pos, icon, label, cls) {
  let d = markers[i];
  if (!d) { d = document.createElement('div'); d.className = 'mk'; d.innerHTML = '<b></b><span></span>'; $('mpMarks').appendChild(d); markers[i] = d; }
  V4.copy(pos).project(G.camera);
  let x = V4.x, y = V4.y; const behind = V4.z > 1; if (behind) { x = -x; y = -y; }
  const w = innerWidth, h = innerHeight, mx = 0.9, my = 0.8;
  const out = behind || Math.abs(x) > mx || Math.abs(y) > my;
  if (out) { const k = Math.max(Math.abs(x) / mx, Math.abs(y) / my); x /= k; y /= k; }
  d.style.transform = `translate(${(x * 0.5 + 0.5) * w}px, ${(-y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
  d.className = 'mk ' + cls + (out ? ' edge' : '');
  if (d.firstChild.textContent !== icon) d.firstChild.textContent = icon;
  const dist = Math.round(pos.distanceTo(G.camera.position));
  const txt = label ? `${label} ${dist}m` : `${dist}m`;
  if (d.lastChild.textContent !== txt) d.lastChild.textContent = txt;
  d.style.display = '';
}
function updateMarkers() {
  let n = 0; const b = M.bag, role = myRole();
  if (P.dead) { for (const d of markers) d.style.display = 'none'; return; }
  const iCarry = b.st === 'carry' && b.by === M.me;
  if (b.st === 'home') marker(n++, V1.set(b.x, b.y + 1.0, b.z), '💰', role === 'R' ? '털기' : '지키기', role === 'R' ? 'gold' : 'blue');
  if (b.st === 'drop') marker(n++, V1.set(b.x, b.y + 1.0, b.z), '💰', role === 'R' ? '줍기' : '되찾기', 'orange');
  if (b.st === 'carry' && !iCarry) {
    const e = M.ents.get(b.by); const s = e && (M.bots.get(e.id)?.p || e.s);
    if (s) marker(n++, V1.set(s.x, s.y + 2.1, s.z), role === 'R' ? '🛡' : '⚠', role === 'R' ? '호위' : '도둑', role === 'R' ? 'blue' : 'red');
  }
  if (role === 'R' && (iCarry || b.st === 'carry')) marker(n++, V1.set(0, FLOOR + 1.2, 36.5), '🐎', '탈출', 'gold');
  for (let i = n; i < markers.length; i++) markers[i].style.display = 'none';
}
function killFeed(by, tgt, how, head) {
  const f = $('mpFeed'); const d = document.createElement('div'); d.className = 'kf';
  const cls = (id) => (id === M.me ? 'me' : M.ents.get(id)?.side === mySide() ? 'ally' : 'enemy');
  const icon = how === 'gun' ? W_ICON[M.ents.get(by)?.s?.w || 'rifle'] || '🔫' : W_ICON[how] || '💀';
  d.innerHTML = by && by !== tgt ? `<b class="${cls(by)}">${esc(nameOf(by))}</b><i>${icon}${head ? '🎯' : ''}</i><b class="${cls(tgt)}">${esc(nameOf(tgt))}</b>` : `<i>${icon}</i><b class="${cls(tgt)}">${esc(nameOf(tgt))}</b>`;
  f.prepend(d);
  d.animate([{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.23,1,0.32,1)' });
  setTimeout(() => d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => d.remove(), 4500);
  while (f.children.length > 5) f.lastChild.remove();
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function banner(big, small, cls = '', ms = 2600) {
  const el = $('mpBanner'); el.className = 'mp-banner ' + cls;
  el.innerHTML = `<b>${big}</b>${small ? `<span>${small}</span>` : ''}`;
  el.getAnimations().forEach((a) => a.cancel());
  el.animate([{ opacity: 0, transform: 'translate(-50%, 8px) scale(0.97)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.08 },
    { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.85 }, { opacity: 0, transform: 'translate(-50%, -4px) scale(1)' }], { duration: ms, easing: 'cubic-bezier(0.23,1,0.32,1)', fill: 'forwards' });
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
let lastTop = '';
function updateTop() {
  if (!M.meta) return;
  const me = mySide(), them = me === 'A' ? 'B' : 'A', sc = M.meta.score;
  const role = myRole();
  const top = `${sc[me]}|${sc[them]}|${M.timer}|${M.ot}|${M.bags}|${role}|${M.meta.round}`;
  if (top !== lastTop) {
    lastTop = top;
    $('mpScoreMe').textContent = sc[me]; $('mpScoreThem').textContent = sc[them];
    $('mpTimer').textContent = M.ot ? '연장' : fmt(M.timer);
    $('mpTimer').classList.toggle('low', M.timer <= 20);
    $('mpRole').textContent = role === 'R' ? '산적' : '경비';
    $('mpRole').className = 'mp-role ' + role;
    UI.setWave(role === 'R' ? `금괴 ${M.bags}/2 탈취 — 후미 발코니로` : `금괴 지키기 — ${M.bags}/2 털림`);
    UI.el.lootFill.style.transform = `scaleX(${M.bags / 2})`;
    UI.el.lootTxt.textContent = `금괴 ${M.bags}/2`;
  }
  // 털기 진행
  const lp = $('mpLoot');
  if (M.myLoot > 0.01 && !P.dead) { lp.style.display = ''; lp.style.setProperty('--p', M.myLoot); lp.lastChild.textContent = `금괴 터는 중 ${Math.round(M.myLoot * 100)}%`; }
  else lp.style.display = 'none';
  const carry = M.bag.st === 'carry' && M.bag.by === M.me;
  $('mpCarry').style.display = carry && !P.dead ? '' : 'none';
}
function showDeath(on, killerId, how) {
  const d = $('mpDeath'); d.classList.toggle('hidden', !on);
  if (on) {
    $('mpDeathBy').textContent = killerId && killerId !== M.me ? `${nameOf(killerId)}에게 당함` : how === 'fall' ? '열차에서 떨어졌다' : '쓰러졌다';
    renderWeaponPick($('mpDeathW'));
  }
}
function renderWeaponPick(box) {
  const cur = myEnt()?.w || P.weapon;
  box.innerHTML = '';
  for (const id of WEAPON_IDS) {
    const w = WEAPONS[id];
    const b = document.createElement('button'); b.className = 'wpick' + (id === cur ? ' on' : '');
    b.innerHTML = `<i>${W_ICON[id]}</i><b>${w.name}</b><span>${id === 'rifle' ? '중거리 · 헤드샷 한 방' : id === 'shotgun' ? '객차 안 근접 최강' : '빠른 연사 · 기동전'}</span>`;
    b.addEventListener('click', () => { M.net.send({ t: 'w', w: id }); const e = myEnt(); if (e) e.w = id; P.weapon = id; renderWeaponPick(box); sfx('toggle', { vol: 0.5 }); });
    box.appendChild(b);
  }
}

// ── 네트워크 메시지 ─────────────────────────────────────
function onMsg(m) {
  switch (m.t) {
    case 'hello': break;
    case 'list': renderList(m.rooms); break;
    case 'err': lobbyMsg(m.msg); if (m.gone) leave(); break;
    case 'joined': M.me = m.id; M.code = m.code; if (!m.re) { for (const e of M.ents.values()) e.av?.dispose(); M.ents.clear(); M.bots.clear(); showLobby(); } break;
    case 'room': onMeta(m); break;
    case 's': onSnap(m); break;
    case 'ev': onEv(m); break;
    case 'shot': {
      const e = M.ents.get(m.id); if (!e || M.bots.has(m.id)) return;
      remoteShotFx(V1.fromArray(m.a).clone(), V2.fromArray(m.b).clone(), m.w, e.av); break;
    }
    case 'dyn': if (!M.bots.has(m.id)) addDyn(V1.fromArray(m.p), V2.fromArray(m.v), false); break;
  }
}
function onMeta(m) {
  const prevPhase = M.meta?.phase;
  M.meta = m;
  const ids = new Set();
  for (const p of m.players) {
    const e = ent(p.id); ids.add(p.id);
    Object.assign(e, { name: p.name, side: p.side, bot: p.bot, kills: p.kills, deaths: p.deaths, bags: p.bags, w: p.w });
    if (p.id !== M.me && !e.av) e.av = new Avatar(e);
    if (e.av) { e.av.setRole(roleOf(p.side)); e.av.setTag(p.name, p.side === mySide()); }
  }
  for (const [id, e] of M.ents) if (!ids.has(id)) { e.av?.dispose(); M.ents.delete(id); M.bots.delete(id); }
  // 방장이면 봇을 맡는다
  if (amHost()) {
    for (const p of m.players) if (p.bot && !M.bots.has(p.id)) {
      const b = new Bot(p.id); M.bots.set(p.id, b);
      const e = ent(p.id);
      if (e.alive && e.buf.length) { const s = e.buf[e.buf.length - 1]; b.alive = true; b.w = p.w; b.p.set(s.x, s.y, s.z); b.yaw = s.yaw; if (s.fl & FL.BIKE) b.spawn({ bike: true, side: Math.sign(s.x) || 1, x: s.x, y: 0, z: s.z }, p.w); }
    }
  } else M.bots.clear();
  if (G.state === 'mplobby') renderLobby();
  if (m.phase === 'lobby' && prevPhase && prevPhase !== 'lobby') backToLobby();
  if (m.phase !== 'lobby' && G.state === 'mplobby') enterMatch();
}
function onSnap(m) {
  const now = performance.now() / 1000;
  M.timer = m.timer; M.ot = m.ot; M.bags = m.bags; M.resp = m.resp || {};
  const [st, by, x, y, z] = m.bag; const was = M.bag.st;
  Object.assign(M.bag, { st, by, x, y, z });
  P.carry = st === 'carry' && by === M.me;
  if (was !== st && st === 'carry' && by === M.me) { sfx('coin', { vol: 0.8, rate: 0.8 }); G.controls?.haptic('kill'); }
  for (const r of m.e) {
    const e = ent(r[0]);
    if (!r[1]) { if (e.alive && e.id !== M.me && !M.bots.has(e.id)) { e.alive = false; } e.alive = false; continue; }
    if (!e.alive) { e.buf.length = 0; e.av?.revive(); }
    e.alive = true; e.hp = r[9];
    if (e.id === M.me) { P.hp = r[9]; M.myLoot = r[10]; continue; }
    if (M.bots.has(e.id)) continue;
    e.buf.push({ t: now, x: r[2], y: r[3], z: r[4], yaw: r[5], pitch: r[6], fl: r[7], w: r[8] });
    if (e.buf.length > 12) e.buf.shift();
  }
  const rs = M.resp[M.me];
  if (P.dead && rs !== undefined) $('mpDeathT').textContent = rs > 0 ? `${Math.ceil(rs)}초 뒤 ${myRole() === 'R' ? '바이크로' : '운전실에서'} 다시 출발` : '출발!';
}
function onEv(m) {
  switch (m.k) {
    case 'spawn': {
      const e = ent(m.id); e.alive = true; e.hp = 100; e.buf.length = 0; e.av?.revive();
      if (amHost() && m.id[0] === 'b' && !M.bots.has(m.id)) M.bots.set(m.id, new Bot(m.id));
      if (m.id === M.me) {
        if (!M.active) enterMatch();
        P.dead = false; M.fallSent = false; spawnAt(m.at, m.w); showDeath(false);
        G.controls?.setVisible(G.state === 'play');
        if (m.at.bike) UI.toast('바이크로 열차를 쫓아가 옆에 붙어 [뛰어오르기]!');
      }
      const b = M.bots.get(m.id); if (b) b.spawn(m.at, m.w);
      break;
    }
    case 'hit': {
      const e = ent(m.tgt); e.hp = m.hp;
      if (m.tgt === M.me) {
        const a = M.ents.get(m.by); const from = a && (M.bots.get(a.id)?.p || a.s);
        P.hp = m.hp; hurtPlayer(m.dmg, from ? V1.set(from.x, from.y, from.z) : null, false);
      }
      break;
    }
    case 'kill': {
      const e = ent(m.tgt); e.alive = false; e.hp = 0;
      killFeed(m.by, m.tgt, m.how, m.head);
      if (m.tgt === M.me) {
        P.dead = true; P.firing = false; M.killer = m.by; M.deathPos.copy(P.pos);
        showDeath(true, m.by, m.how); G.controls?.setVisible(false); UI.setUse(null);
        sfx('enemy_destroy', { vol: 0.6, rate: 0.6 }); G.controls?.haptic('hurt');
        clearDyn();
      } else {
        const dir = e.av ? V1.set(e.av.m.position.x - P.pos.x, 0, e.av.m.position.z - P.pos.z).normalize() : null;
        e.av?.die(dir);
        const b = M.bots.get(m.tgt); if (b) b.alive = false;
      }
      if (m.by === M.me && m.tgt !== M.me) {
        UI.hitmarker(true); hitSound('kill'); G.hitstop = 0.05; G.controls?.haptic('kill');
        M.streak = G.time - (M.streakT || -9) < 5 ? (M.streak || 1) + 1 : 1; M.streakT = G.time;
        const nm = nameOf(m.tgt);
        UI.el.streak.textContent = M.streak >= 2 ? `${M.streak}연속 처치!  ${nm}` : `${m.how === 'fall' ? '열차 밖으로! ' : m.head ? '헤드샷! ' : ''}${nm} 처치`;
        UI.el.streak.animate([{ opacity: 0, transform: 'translate(-50%, 6px) scale(0.96)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1.04)', offset: 0.15 },
          { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.75 }, { opacity: 0, transform: 'translate(-50%, -4px) scale(1)' }], { duration: 1400, easing: 'cubic-bezier(0.23,1,0.32,1)' });
      }
      break;
    }
    case 'knock': {
      if (m.tgt === M.me) knockMe(m.kx, m.kz, m.up);
      const b = M.bots.get(m.tgt); if (b && !b.bike) { b.vel.set(m.kx, m.up, m.kz); b.knockT = 0.8; }
      break;
    }
    case 'bag': {
      const role = myRole();
      if (m.st === 'carry') { const ally = M.ents.get(m.by)?.side === mySide(); UI.toast(m.by === M.me ? '💰 금괴를 챙겼다! 후미 발코니로 달려라' : ally ? `💰 ${nameOf(m.by)}가 금괴를 챙겼다 — 엄호!` : `⚠ ${nameOf(m.by)}가 금괴를 훔쳤다! 막아라`); }
      if (m.st === 'drop') UI.toast(role === 'R' ? '금괴를 떨어뜨렸다! 다시 주워라' : '도둑이 금괴를 떨어뜨렸다! 되찾아라');
      if (m.st === 'home' && m.by) UI.toast(m.by === M.me ? '금괴를 되찾았다!' : `${nameOf(m.by)}가 금괴를 금고로 되돌렸다`);
      break;
    }
    case 'score': {
      const ally = M.ents.get(m.by)?.side === mySide();
      banner(ally ? '금괴 탈취!' : '금괴를 빼앗겼다', `${m.bags}/2`, ally ? 'good' : 'bad', 2200);
      sfx('coin', { vol: 1, rate: 0.7 }); setTimeout(() => sfx('coin', { vol: 0.8, rate: 0.9 }), 120);
      const t = makeSack(1.0); t.position.set(0, FLOOR + 0.5, 37); G.scene.add(t);
      tossFx.push({ m: t, a: new THREE.Vector3(0, FLOOR + 1, 37.5), b: new THREE.Vector3(0, 1.3, 57.5), t: 0 });
      break;
    }
    case 'round': {
      const role = m.roles[mySide()];
      clearDyn();
      banner(`${m.round}라운드`, role === 'R' ? '산적 — 바이크로 쫓아가 금괴 2개를 털어라' : '경비 — 금고의 금괴를 끝까지 지켜라', role, 3400);
      sfx('toggle', { vol: 0.8, rate: 0.8 });
      break;
    }
    case 'ot': banner('연장!', '금괴가 아직 운반 중이다', '', 1800); break;
    case 'roundEnd': {
      const win = m.side === mySide();
      banner(win ? '라운드 승리' : '라운드 패배', `${m.role === 'R' ? (m.reason === 'bags' ? '산적이 금괴 2개를 털었다' : '') : '경비가 시간까지 버텼다'} · ${M.meta.score[mySide()] + (win ? 1 : 0)} : ${M.meta.score[mySide() === 'A' ? 'B' : 'A'] + (win ? 0 : 1)} · 다음 라운드 공수 교대`, win ? 'good' : 'bad', 5600);
      break;
    }
    case 'matchEnd': {
      const win = m.side === mySide();
      setTimeout(() => showResult(win, m.score), 600);
      break;
    }
    case 'left': { const e = M.ents.get(m.id); if (e) { e.av?.dispose(); M.ents.delete(m.id); M.bots.delete(m.id); } break; }
  }
}
function remoteShotFx(from, to, w, av) {
  tracer(from, to, [1, 0.55, 0.35]);
  muzzleWorld(from, V3.subVectors(to, from).normalize());
  gunshot(from, WEAPONS[w]?.size || 1);
  if (av) av.recoil = 1;
  const d = to.distanceTo(G.camera.position);
  if (d < 2.5 && !P.dead) sfx('impact', { vol: 0.3, rate: 2.4 });
}

// ── 게임 쪽에서 부르는 훅 (player.js) ───────────────────
function targets() { const out = []; for (const e of M.ents.values()) if (isEnemy(e) && e.alive && e.av && e.av.dying < 0) out.push(e); return out; }
const AT = [];
M.assist = (cam) => {
  let n = 0;
  for (const e of targets()) {
    const h = e.av.hit[0]; const d = h.c.distanceTo(cam); if (d > 70) continue;
    V2.subVectors(h.c, cam).divideScalar(d);
    if (rayBoxes(cam, V2, d) < d - h.r) continue;
    const t = AT[n] || (AT[n] = { x: 0, y: 0, z: 0, r: 0, ref: null });
    t.x = h.c.x; t.y = h.c.y; t.z = h.c.z; t.r = h.r; t.ref = e; n++;
  }
  AT.length = n; return AT;
};
M.aimTarget = (o, d, cone) => {
  let best = null, bestA = cone;
  for (const e of targets()) {
    const h = e.av.hit[0]; const to = V2.subVectors(h.c, o); const L = to.length(); if (L > 70) continue;
    const a = Math.acos(clamp(to.dot(d) / L, -1, 1)) - h.r / L;
    if (a < bestA && rayBoxes(o, to.divideScalar(L), L) >= L - h.r) { bestA = a; best = h.c; }
  }
  return best;
};
M.raycast = (o, d, maxT) => {
  let best = null;
  for (const e of targets()) for (const h of e.av.hit) {
    const oc = V1.subVectors(o, h.c); const b = oc.dot(d), c = oc.lengthSq() - h.r * h.r;
    const disc = b * b - c; if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t > 0 && t < maxT && (!best || t < best.t || (Math.abs(t - best.t) < 0.3 && h.mult > best.mult))) best = { id: e.id, t, mult: h.mult };
  }
  return best;
};
M.hitPlayer = (id, dmg, head, point, dir, how) => {
  M.net.send({ t: 'hit', tgt: id, dmg: Math.round(dmg), head, how });
  hitPuff(point, head); UI.hitmarker(false); hitSound(head ? 'head' : 'hit');
  UI.floater(point, Math.round(dmg), head ? 'crit' : '');
  G.controls?.haptic('hit');
};
M.shotFx = (from, to, w) => { M.net.send({ t: 'shot', a: arr(from), b: arr(to), w }); };
M.dynFx = (p, v) => { M.net.send({ t: 'dyn', p: arr(p), v: arr(v) }); };
M.enemyNear = (p, r) => targets().some((e) => e.av.hit[0].c.distanceTo(p) < r);
M.explode = (p, mine) => {
  explosion(p, 1.25); sfxAt('enemy_destroy', p, { vol: 1.1, rate: 0.75 });
  if (!mine) return;
  for (const e of targets()) {
    const c = e.av.hit[0].c; const d = c.distanceTo(p); if (d > 4.8) continue;
    const onBike = e.s.fl & FL.BIKE;
    const dx = c.x - p.x, dz = c.z - p.z, L = Math.hypot(dx, dz) || 1;
    M.net.send({ t: 'hit', tgt: e.id, dmg: Math.round(125 * (1 - d / (4.8 * 1.3))), how: 'dyn', ...(onBike ? {} : { kx: dx / L * 8, kz: dz / L * 8, up: 6.8 }) });
    hitPuff(c.clone(), false);
  }
  UI.hitmarker(false);
};
M.meleeTarget = (o, d) => {
  let best = null, bd = 1.9;
  for (const e of targets()) {
    if (e.s.fl & FL.BIKE) continue;
    const to = V1.set(e.s.x - o.x, 0, e.s.z - o.z); const L = to.length();
    if (L < bd && to.normalize().dot(V2.set(d.x, 0, d.z).normalize()) > 0.55 && Math.abs(e.s.y - o.y) < 1) { bd = L; best = e; }
  }
  return best;
};
M.melee = (e, o) => {
  const dx = e.s.x - o.x, dz = e.s.z - o.z, L = Math.hypot(dx, dz) || 1;
  M.net.send({ t: 'hit', tgt: e.id, dmg: 18, how: 'melee', kx: dx / L * 7.5, kz: dz / L * 7.5, up: 6.8 });
  const c = e.av.hit[0].c; sfxAt('impact', c, { vol: 1, rate: 0.8 }); sparks(c, 6); hitSound('hit'); UI.hitmarker(false);
  UI.floater(c.clone().add(V1.set(0, 0.5, 0)), '밀쳐내기!', 'crit');
  return true;
};
M.fell = () => { if (M.fallSent) return; M.fallSent = true; M.net.send({ t: 'fall' }); P.dead = true; M.deathPos.copy(P.pos); showDeath(true, null, 'fall'); G.controls?.setVisible(false); };

// ── 매 프레임 ──────────────────────────────────────────
export function mpTick(dt) {
  if (!M.active) return;
  const now = performance.now() / 1000;
  // 봇 시뮬 (방장)
  for (const b of M.bots.values()) b.update(dt);
  // 사람들 그리기
  for (const e of M.ents.values()) {
    if (e.id === M.me || !e.av) continue;
    const b = M.bots.get(e.id);
    if (b) {
      if (!b.alive && e.av.dying < 0 && !e.alive) { e.av.hide(); continue; }
      if (!b.alive) { if (e.av.dying >= 0) e.av.pose(e.s, dt); continue; }
      const st = b.state(); const s = e.s;
      s.x = st.p[0]; s.y = st.p[1]; s.z = st.p[2]; s.yaw = st.yaw; s.pitch = st.pitch; s.fl = st.fl; s.w = st.w;
      e.av.pose(s, dt);
    } else if (e.alive || e.av.dying >= 0) {
      const s = e.alive ? sampleEnt(e, now) : e.s;
      if (s) e.av.pose(s, dt); else e.av.hide();
    } else e.av.hide();
  }
  // 내 상태·봇 상태 보내기 (초당 20번)
  M.sendT -= dt;
  if (M.sendT <= 0) {
    M.sendT = 0.05;
    if (!P.dead && M.meta?.phase === 'live') {
      let fl = 0;
      if (P.crouch) fl |= FL.CROUCH; if (P.bike) fl |= FL.BIKE; if (P.bike?.leap) fl |= FL.LEAP; if (P.carry) fl |= FL.CARRY;
      if (P.adsOn) fl |= FL.ADS; if (P.sprint) fl |= FL.SPRINT; if (P.slideT > 0) fl |= FL.SLIDE; if (P.climbing) fl |= FL.CLIMB;
      M.net.send({ t: 'st', s: { p: [r2(P.pos.x), r2(P.pos.y), r2(P.pos.z)], yaw: r2(P.yaw), pitch: r2(P.pitch), fl, w: P.weapon } });
    }
    for (const b of M.bots.values()) if (b.alive) M.net.send({ t: 'st', id: b.id, s: b.state() });
  }
  const me = myEnt(); if (me) me.s.w = P.weapon;
  updateProps(dt);
  updateTop();
  updateMarkers();
  // 죽었을 때: 쓰러진 자리 위에서 상대를 바라봄
  if (P.dead) {
    const cam = G.camera;
    const k = M.ents.get(M.killer); const ks = k && (M.bots.get(k.id)?.p || (k.alive ? k.s : null));
    cam.position.lerp(V1.set(M.deathPos.x + 0.8, M.deathPos.y + 2.6, M.deathPos.z + 2.2), Math.min(1, dt * 2));
    if (ks) { V2.set(ks.x, ks.y + 1.3, ks.z); M.look = M.look ? M.look.lerp(V2, Math.min(1, dt * 4)) : V2.clone(); cam.lookAt(M.look); }
    setLoop('engine-motorcycle', 0);
  }
}
export function mpRenderWeapon() { return !P.dead; }

// ── 로비 ───────────────────────────────────────────────
let lobbyMode = null;
function lobbyMsg(t) { const e = $('mpMsg'); if (e) { e.textContent = t; e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); } }
function myName() { return ($('mpName')?.value || '').trim().slice(0, 10) || store.get('dr_name') || `무법자${(Math.random() * 90 + 10) | 0}`; }
async function ensureOnline() {
  if (M.net?.online) return true;
  M.net?.close();
  M.net = new Net(onMsg, (st) => {
    if (st === 'reconnecting') UI.toast('연결이 끊겨 다시 붙는 중…');
    if (st === 'lost') { lobbyMsg('서버와 연결이 끊겼어요'); if (M.active) { UI.toast('서버와 연결이 끊겼어요'); leave(); } }
  });
  try { await M.net.connect(); return true; }
  catch { lobbyMsg('서버에 연결할 수 없어요 — [봇과 연습]은 바로 할 수 있어요'); M.net = null; return false; }
}
export function initMp(api) {
  M.api = api;   // main.js 쪽 setState 등
  buildProps();
  const nm = $('mpName'); nm.value = store.get('dr_name') || ''; nm.addEventListener('change', () => store.set('dr_name', nm.value.trim().slice(0, 10)));
  const go = async (m) => { store.set('dr_name', myName()); if (!(await ensureOnline())) return; M.net.send({ ...m, name: myName() }); };
  $('mpQuick').onclick = () => go({ t: 'quick' });
  $('mpCreate').onclick = () => go({ t: 'create', priv: false });
  $('mpCreatePriv').onclick = () => go({ t: 'create', priv: true });
  $('mpJoin').onclick = () => { const c = $('mpCode').value.trim().toUpperCase(); if (c.length !== 4) { lobbyMsg('방 코드 4글자를 넣어 주세요'); return; } go({ t: 'join', code: c }); };
  $('mpRefresh').onclick = async () => { if (await ensureOnline()) M.net.send({ t: 'list' }); };
  $('mpPractice').onclick = () => { store.set('dr_name', myName()); M.net?.close(); M.net = new Net(onMsg); M.net.startLocal(myName()); };
  $('mpBack').onclick = () => { M.net?.close(); M.net = null; api.setState('title'); };
  $('mpStart').onclick = () => M.net.send({ t: 'start' });
  $('mpFill').onchange = (e) => M.net.send({ t: 'fill', on: e.target.checked });
  $('mpSwap').onclick = () => { const s = mySide() === 'A' ? 'B' : 'A'; M.net.send({ t: 'side', side: s }); };
  $('mpLeave').onclick = () => leave();
  $('mpCopy').onclick = async () => { try { await navigator.clipboard.writeText(M.code); lobbyMsg('방 코드를 복사했어요'); } catch { lobbyMsg(`방 코드: ${M.code}`); } };
  $('mpResultBtn').onclick = () => { $('mpResult').classList.add('hidden'); if (amHost()) M.net.send({ t: 'back' }); };
}
export async function openMenu() {
  M.api.setState('mpmenu');
  lobbyMsg('');
  if (await ensureOnline()) M.net.send({ t: 'list' });
}
function renderList(rooms) {
  const box = $('mpList'); box.innerHTML = '';
  if (!rooms.length) { box.innerHTML = '<p class="empty">열린 방이 없어요 — 방을 만들어 친구를 불러 보세요</p>'; return; }
  for (const r of rooms) {
    const b = document.createElement('button'); b.className = 'room-row';
    b.innerHTML = `<b>${esc(r.code)}</b><span>${esc(r.host)}의 방</span><i>${r.n}/${r.max}</i><em>${r.phase === 'lobby' ? '대기 중' : '진행 중'}</em>`;
    if (r.n >= r.max) b.disabled = true;
    b.onclick = async () => { if (await ensureOnline()) M.net.send({ t: 'join', code: r.code, name: myName() }); };
    box.appendChild(b);
  }
}
function showLobby() {
  if (M.net?.local) setTimeout(() => M.net?.send({ t: 'start' }), 50);
  M.api.setState('mplobby'); renderLobby();
}
function renderLobby() {
  if (!M.meta) return;
  $('mpCodeTxt').textContent = M.net?.local ? '연습' : M.code;
  $('mpCopy').style.display = M.net?.local ? 'none' : '';
  for (const side of ['A', 'B']) {
    const box = $('mpSide' + side); box.innerHTML = '';
    const ps = M.meta.players.filter((p) => p.side === side);
    for (const p of ps) { const d = document.createElement('div'); d.className = 'slot' + (p.id === M.me ? ' me' : '') + (p.bot ? ' bot' : ''); d.innerHTML = `<b>${esc(p.name)}</b><span>${p.bot ? 'BOT' : p.id === M.meta.host ? '방장' : ''}</span>`; box.appendChild(d); }
    for (let i = ps.length; i < 2; i++) { const d = document.createElement('div'); d.className = 'slot empty'; d.innerHTML = `<b>${M.meta.fill ? '빈자리 (봇)' : '빈자리'}</b>`; box.appendChild(d); }
  }
  $('mpStart').style.display = amHost() ? '' : 'none';
  $('mpWait').style.display = amHost() ? 'none' : '';
  $('mpFillRow').style.display = amHost() ? '' : 'none';
  $('mpFill').checked = M.meta.fill;
  renderWeaponPick($('mpLobbyW'));
}
function enterMatch() {
  if (M.active) return;
  M.active = true; G.mode = 'mp'; G.mp = M;
  P.dead = true;
  M.api.enterMp();
  showDeath(true, null, null); $('mpDeathBy').textContent = '곧 출발합니다';
}
function backToLobby() {
  M.active = false; clearDyn(); G.mode = 'sp'; P.dead = false; P.carry = false; mpPropsVisible(false);
  for (const e of M.ents.values()) e.av?.hide();
  showDeath(false); $('mpResult').classList.add('hidden');
  if (M.net?.local) { M.net.close(); M.net = null; resetMp(); M.api.setState('title'); return; }
  M.api.setState('mplobby'); renderLobby();
}
function showResult(win, score) {
  const r = $('mpResult'); r.classList.remove('hidden');
  const me = mySide(), them = me === 'A' ? 'B' : 'A';
  $('mpResultTitle').textContent = win ? '승리!' : '패배';
  $('mpResultTitle').className = win ? 'good' : 'bad';
  $('mpResultScore').textContent = `${score[me]} : ${score[them]}`;
  const rows = [...M.ents.values()].sort((a, b) => (b.kills || 0) - (a.kills || 0)).map((e) =>
    `<tr class="${e.id === M.me ? 'me' : e.side === me ? 'ally' : 'enemy'}"><td>${esc(e.name)}${e.bot ? ' <small>BOT</small>' : ''}</td><td>${e.kills || 0}</td><td>${e.deaths || 0}</td><td>${e.bags || 0}</td></tr>`).join('');
  $('mpResultTable').innerHTML = `<tr><th>이름</th><th>처치</th><th>죽음</th><th>금괴</th></tr>${rows}`;
  $('mpResultBtn').textContent = M.net?.local ? '처음으로' : amHost() ? '로비로' : '확인';
}
function resetMp() {
  for (const e of M.ents.values()) e.av?.dispose();
  M.ents.clear(); M.bots.clear(); M.meta = null; M.me = null; M.active = false;
  for (const d of markers) d.style.display = 'none';
  if (worldBag) { worldBag.visible = bagBeam.visible = false; exitRing.visible = true; wagon.visible = false; }
  G.mode = 'sp'; P.carry = false; P.dead = false;
}
export function leave() {
  M.net?.close(); M.net = null;
  showDeath(false); $('mpResult').classList.add('hidden');
  resetMp(); clearDyn(); setLoop('engine-motorcycle', 0);
  M.api.setState('title');
}
export function mpPropsVisible(on) { if (exitRing) exitRing.visible = on; if (!on && wagon) { wagon.visible = false; worldBag.visible = bagBeam.visible = false; } }

// 테스트용: 오프라인 방과 게임을 렌더 없이 빨리 돌림
window.__mpStep = async (sec, step = 1 / 30) => {
  for (let t = 0; t < sec; t += step) { M.net?.local?.room.tick(step); await null; await null; window.__sim(step, step); }
};
