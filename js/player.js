// 플레이어 v3 — 입력, 이동(달리기·슬라이딩), 사다리, 무기 3종(레버액션·쌍열 산탄총·리볼버), 다이너마이트, 거치 기관총,
// 멀티 모드용 바이크 추격·뛰어오르기. 멀티일 때 피해 판정은 G.mp 훅으로 넘긴다.
import * as THREE from 'three';
import { G, TRAIN, clamp, lerp, rand, damp } from './state.js';
import { moveBody, rayBoxes, groundAt, blocked, updateSunFollow, onTrain } from './world.js';
import { raycastEnemies, aimAssistTarget, meleeHit, nearestBoarder, explodeAt, enemies, assistTargets } from './enemies.js';
import { MobileFPSControls } from './controls/mfc.js';
import * as UI from './ui.js';
import { sfx, gunshot, setLoop } from './audio.js';
import { tracer, muzzleWorld, sparks, puff, shake, addShake, smoke, dust, brass } from './fx.js';

export const P = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
  hp: 100, maxHp: 100, crouch: false, onGround: true, climbing: null,
  mounted: false, ammo: 8, mag: 8, reload: 0, reloadMax: 1.3, fireCd: 0, lever: 0, recoil: 0, lastHurt: 0,
  heat: 0, overheat: false, eye: 1.6, bob: 0, dead: false, firing: false, aimKick: 0, yawKick: 0, fovPunch: 0,
  ads: 0, adsOn: false, sprint: false, melee: 0, dyn: 3, dynCd: 0, fov: 72, slideT: 0, bloom: 0,
  weapon: 'rifle', bike: null, carry: false, frozen: false,
};
const input = { keys: {}, lookDX: 0, lookDY: 0, jump: false, throw: false, mouseFire: false, mouseAds: false };

// ── 무기 ───────────────────────────────────────────────
// dmg = 사람(멀티) 기준 한 발 피해. 싱글 적에게는 pve 배율을 곱한다.
export const WEAPONS = {
  rifle: { name: '레버액션 소총', model: 'rifle', scale: 0.62, mag: 8, fire: 0.42, reload: 1.3, dmg: 44, pellets: 1, range: 170,
    hip: 0.009, adsSpread: 0.0015, kick: 0.045, yawKick: 0.008, punch: 2.5, shake: 0.05, size: 1, pve: 0.7,
    hipPos: [0.16, -0.17, -0.34], adsPos: [0, -0.076, -0.27], adsFov: 46, haptic: 'fire' },
  shotgun: { name: '쌍열 산탄총', model: 'shotgun', scale: 0.62, mag: 2, fire: 0.3, reload: 1.75, dmg: 13, pellets: 9, range: 40, falloff: [5, 16],
    hip: 0.06, adsSpread: 0.042, kick: 0.095, yawKick: 0.02, punch: 6, shake: 0.14, size: 1.45, pve: 0.75,
    hipPos: [0.15, -0.165, -0.33], adsPos: [0, -0.083, -0.27], adsFov: 58, haptic: 'kill' },
  revolver: { name: '리볼버', model: 'revolver', scale: 0.95, mag: 6, fire: 0.19, reload: 1.5, dmg: 27, pellets: 1, range: 120,
    hip: 0.012, adsSpread: 0.003, kick: 0.032, yawKick: 0.01, punch: 1.6, shake: 0.035, size: 0.8, pve: 0.75, bloomPer: 0.006,
    hipPos: [0.17, -0.15, -0.31], adsPos: [0, -0.08, -0.29], adsFov: 52, haptic: 'fire' },
};

// ── 입력 ───────────────────────────────────────────────
// 터치는 MobileFPSControls(controls/mfc.js)가 전부 맡고, 여기서는 PC 테스트용 키보드·마우스만 받는다.
export function initInput() {
  const canvas = G.renderer.domElement;
  G.controls = new MobileFPSControls({ root: UI.el.hud, hooks: { targets: () => (G.mode === 'mp' ? G.mp.assist(G.camera.position) : assistTargets(G.camera.position)) } });
  UI.el.btnUse.addEventListener('pointerdown', () => UI.triggerUse());
  UI.el.btnUse.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && G.state === 'play' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
  addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT') return;
    input.keys[e.code] = true;
    if (e.code === 'Space') input.jump = true;
    if (e.code === 'KeyC' || e.code === 'ControlLeft') { if (P.sprint) startSlide(); else setCrouch(!P.crouch); }
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyE') UI.triggerUse();
    if (e.code === 'KeyG' || e.code === 'KeyQ') input.throw = true;
  });
  addEventListener('keyup', (e) => { input.keys[e.code] = false; });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { input.lookDX += e.movementX * 0.55; input.lookDY += e.movementY * 0.55; } });
  addEventListener('mousedown', (e) => { if (document.pointerLockElement !== canvas) return; if (e.button === 0) input.mouseFire = true; if (e.button === 2) input.mouseAds = true; });
  addEventListener('mouseup', (e) => { if (e.button === 0) input.mouseFire = false; if (e.button === 2) input.mouseAds = false; });
  addEventListener('contextmenu', (e) => e.preventDefault());
}
function setCrouch(on) { P.crouch = on; G.controls?.sync({ crouch: on }); }
function setAds(on) { if (P.mounted) on = false; P.adsOn = on; G.controls?.sync({ ads: on }); }
function startSlide() {
  if (!P.onGround || P.slideT > 0 || P.mounted || P.climbing || P.bike) return;
  P.slideT = 0.75; setCrouch(true);
  const sp = Math.hypot(P.vel.x, P.vel.z);
  P.slideDir = sp > 1 ? { x: P.vel.x / sp, z: P.vel.z / sp } : { x: -Math.sin(P.yaw), z: -Math.cos(P.yaw) };
  sfx('skid', { vol: 0.35, rate: 1.5 }); P.landKick = 0.06;
}

// ── 1인칭 무기 모델 ────────────────────────────────────
const VM = {};      // weapon → { holder, root, parts }
let vmFlash, vmLight;
export function initPlayer() {
  for (const [id, w] of Object.entries(WEAPONS)) {
    const root = G.models[w.model].clone(true);
    root.scale.setScalar(w.scale);
    root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    const holder = new THREE.Group(); holder.add(root); holder.visible = false;
    G.vmCamera.add(holder);
    VM[id] = { holder, root, muzzle: root.getObjectByName('muzzle_ref'), lever: root.getObjectByName('Lever'),
      barrels: root.getObjectByName('Barrels'), cyl: root.getObjectByName('Cylinder'), hammer: root.getObjectByName('Hammer') };
  }
  G.vmScene.add(G.vmCamera);
  P.holder = VM.rifle.holder;
  const sm = new THREE.SpriteMaterial({ map: (G.flashTex ||= makeFlashTex()), color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  vmFlash = new THREE.Sprite(sm); vmFlash.scale.setScalar(0.3); vmFlash.visible = false; G.vmScene.add(vmFlash);
  vmLight = new THREE.PointLight(0xffa050, 0, 1.5, 2); G.vmCamera.add(vmLight); vmLight.position.set(0.1, -0.05, -0.6);
  for (const l of G.ladders) {
    let best = null;
    for (const b of G.boxes) if (b.tag.includes('지붕') && !b.tag.includes('환기구')) {
      const zc = (b.min[2] + b.max[2]) / 2; const d = Math.abs(zc - l.z) - (b.max[2] - b.min[2]) / 2;
      if (!best || d < best.d) best = { d, dir: Math.sign(zc - l.z) };
    }
    l.dir = best ? best.dir : 1;
  }
  // 다이너마이트 모양
  const g = new THREE.Group();
  const stickM = new THREE.MeshStandardMaterial({ color: 0xc8321f, roughness: 0.6 });
  for (let i = 0; i < 3; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.32, 8), stickM); c.position.x = (i - 1) * 0.09; g.add(c); }
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.1), new THREE.MeshStandardMaterial({ color: 0x3a2416 })); g.add(band);
  G.dynMesh = g;
  // 내가 타는 바이크 (멀티)
  G.myBike = G.models.bike2.clone(true); G.myBike.visible = false; G.scene.add(G.myBike);
  G.myBikeWheels = ['wf', 'wb'].map((n) => G.myBike.getObjectByName(n));
  setWeapon('rifle');
}
function makeFlashTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.3, 'rgba(255,180,80,0.9)'); r.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = r; g.beginPath();
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, rr = i % 2 ? 12 : 32; g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr); }
  g.fill();
  return new THREE.CanvasTexture(c);
}
export function setWeapon(id) {
  if (!WEAPONS[id]) id = 'rifle';
  P.weapon = id;
  for (const k in VM) VM[k].holder.visible = k === id && !P.mounted;
  P.holder = VM[id].holder;
  const w = WEAPONS[id];
  P.mag = w.mag + (G.mode === 'mp' || id !== 'rifle' ? 0 : G.upgrades.mag * 3);
  P.ammo = P.mag; P.reload = 0; P.fireCd = 0.35; P.bloom = 0;
  P.holder.position.y = -0.5;      // 아래에서 올라오는 꺼내기 동작
}

export function resetPlayer(full) {
  const sp = G.map.spawns[0];
  P.pos.set(sp.x, TRAIN.FLOOR, sp.z); P.vel.set(0, 0, 0); P.yaw = 0; P.pitch = -0.05;
  P.maxHp = 100 + (G.mode === 'mp' ? 0 : G.upgrades.hp * 25);
  if (full) P.hp = P.maxHp;
  P.mounted = false; P.heat = 0; P.overheat = false; P.climbing = null; P.dead = false;
  setCrouch(false); setAds(false); P.slideT = 0;
  P.dyn = G.mode === 'mp' ? 2 : 3; P.dynCd = 0;
  leaveBike();
  setWeapon(P.weapon);
  for (const d of dyns) G.scene.remove(d.mesh); dyns.length = 0;
}
// 멀티: 서버가 정한 자리에서 다시 태어남
export function spawnAt(at, weapon) {
  P.weapon = weapon || P.weapon;
  resetPlayer(true);
  P.pos.set(at.x, at.y, at.z); P.yaw = at.bike ? (at.side > 0 ? 0.6 : -0.6) : Math.PI; P.pitch = -0.05;
  if (at.bike) enterBike(at.side, at.x, at.z);
  else P.yaw = Math.PI;   // 운전실에서 열차 뒤쪽(+z)을 바라봄
}

function startReload() {
  if (P.mounted || P.reload > 0 || P.ammo >= P.mag || G.state !== 'play' || P.dead) return;
  const w = WEAPONS[P.weapon];
  P.reload = P.reloadMax = w.reload; sfx('weapon_change', { vol: 0.6, rate: P.weapon === 'shotgun' ? 0.7 : 0.85 });
  if (P.weapon === 'shotgun') setTimeout(() => sfx('impact', { vol: 0.35, rate: 1.8 }), 260);
}

// 피해 연출. apply=false면 체력은 건드리지 않는다(멀티: 서버가 체력을 정함)
export function hurtPlayer(amount, from, apply = true) {
  if (P.dead || (G.state !== 'play' && G.state !== 'pause')) return;
  if (apply) {
    if (P.crouch && !P.mounted) amount *= 0.85;
    P.hp -= amount;
  }
  P.lastHurt = G.time;
  let ang = null;
  if (from) { const a = Math.atan2(from.x - P.pos.x, from.z - P.pos.z); ang = -(a - (P.yaw + Math.PI)); }
  UI.hurtFlash(amount, ang);
  addShake(Math.min(0.25, amount / 80));
  P.aimKick += Math.min(0.05, amount / 900); P.yawKick += rand(-1, 1) * Math.min(0.03, amount / 1200);
  sfx('enemy_hurt', { vol: 0.5, rate: 0.7 });
  G.controls?.haptic('hurt');
  if (apply && P.hp <= 0) { P.hp = 0; P.dead = true; }
}

// ── 사격 ───────────────────────────────────────────────
const O = new THREE.Vector3(), D = new THREE.Vector3(), D0 = new THREE.Vector3(), HIT = new THREE.Vector3(), FWD = new THREE.Vector3();
function shoot(isGun) {
  const cam = G.camera, w = WEAPONS[P.weapon];
  O.copy(cam.position);
  cam.getWorldDirection(D0);
  const moving = Math.hypot(P.vel.x, P.vel.z) > 0.5;
  let spread = isGun ? 0.016 : lerp(w.hip * (P.crouch ? 0.6 : 1) + (moving ? 0.01 : 0) + (P.onGround || P.bike ? 0 : 0.03) + (P.sprint ? 0.02 : 0) + (P.bike ? 0.008 : 0), w.adsSpread, P.ads) + P.bloom;
  if (G.touch && w.pellets === 1) {   // 모바일 조준 보정 (산탄은 원래 넓으니 제외)
    const t = G.mode === 'mp' ? G.mp.aimTarget(O, D0, isGun ? 0.05 : lerp(0.04, 0.025, P.ads)) : aimAssistTarget(O, D0, isGun ? 0.05 : lerp(0.04, 0.025, P.ads));
    if (t) { FWD.subVectors(t, O).normalize(); D0.lerp(FWD, 0.6).normalize(); spread *= 0.5; }
  }
  const muzzle = muzzlePos();
  const pellets = isGun ? 1 : w.pellets;
  const hits = new Map();   // 멀티: 대상별로 산탄을 묶어 한 번에 보냄
  let anyHit = false;
  for (let k = 0; k < pellets; k++) {
    D.copy(D0);
    if (pellets > 1) {   // 산탄: 원 안에 고르게
      const a = (k / pellets) * Math.PI * 2 + rand(-0.3, 0.3), r = spread * (k === 0 ? 0.1 : Math.sqrt(rand(0.15, 1)));
      const right = FWD.set(1, 0, 0).applyQuaternion(cam.quaternion), up = HIT.set(0, 1, 0).applyQuaternion(cam.quaternion);
      D.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r);
    } else { D.x += rand(-spread, spread); D.y += rand(-spread, spread); D.z += rand(-spread, spread); }
    D.normalize();
    const range = isGun ? 170 : w.range;
    const wallT = rayBoxes(O, D, range);
    const hit = G.mode === 'mp' ? G.mp.raycast(O, D, wallT) : raycastEnemies(O, D, wallT);
    const endT = hit ? hit.t : Math.min(wallT, range);
    HIT.copy(O).addScaledVector(D, endT);
    if (k < 3 || hit) tracer(muzzle, HIT, isGun ? [1, 0.7, 0.35] : [1, 0.9, 0.6]);
    let dmg = isGun ? 15 : w.dmg;
    if (w.falloff && hit) dmg *= clamp(1 - (hit.t - w.falloff[0]) / (w.falloff[1] - w.falloff[0]) * 0.75, 0.25, 1);
    if (hit) {
      anyHit = true;
      if (G.mode === 'mp') {
        const h = hits.get(hit.id) || { dmg: 0, head: false, point: HIT.clone(), dir: D.clone() };
        h.dmg += dmg * hit.mult; h.head ||= hit.mult > 1.5; hits.set(hit.id, h);
      } else {
        const base = isGun ? dmg : dmg * w.pve * (P.weapon === 'rifle' ? 1 + G.upgrades.dmg * 0.2 : 1 + G.upgrades.dmg * 0.12);
        hit.enemy.damage(base * hit.mult, HIT.clone(), hit.mult > 1.5, D);
      }
    } else if (wallT < range) {
      sparks(HIT, pellets > 1 ? 2 : 6); if (k < 4) puff(HIT, pellets > 1 ? 1 : 3, [0.6, 0.5, 0.4, 0.5]);
    }
  }
  if (G.mode === 'mp') {
    for (const [id, h] of hits) G.mp.hitPlayer(id, h.dmg, h.head, h.point, h.dir, 'gun');
    G.mp.shotFx(muzzle, HIT, P.weapon);
  }
  muzzleWorld(muzzle, D0);
  return anyHit;
}
const MZ = new THREE.Vector3();
function muzzlePos() {
  const cam = G.camera;
  if (P.mounted) return MZ.copy(G.gun.barrels.localToWorld(new THREE.Vector3(0, 0, -1.05)));
  return MZ.set(lerp(0.17, 0, P.ads), lerp(-0.12, -0.06, P.ads), -0.75).applyQuaternion(cam.quaternion).add(cam.position);
}

// ── 다이너마이트 ───────────────────────────────────────
const dyns = [];
function throwDynamite() {
  if (P.dyn <= 0 || P.mounted || P.dead) return;
  P.dyn--; if (P.dynCd <= 0) P.dynCd = G.mode === 'mp' ? 14 : 9;
  const cam = G.camera; cam.getWorldDirection(D);
  const p = cam.position.clone().addScaledVector(D, 0.5).add(new THREE.Vector3(0, -0.15, 0));
  const v = D.clone().multiplyScalar(15).add(new THREE.Vector3(P.vel.x, 4.2, P.vel.z));
  addDyn(p, v, true);
  if (G.mode === 'mp') G.mp.dynFx(p, v);
  sfx('jump_a', { vol: 0.4, rate: 1.6 }); sfx('skid', { vol: 0.2, rate: 2.5 });
  P.recoil = 0.6;
}
// mine=false: 다른 사람이 던진 것 — 모습만 (피해는 던진 사람이 판정)
export function addDyn(p, v, mine) {
  const mesh = G.dynMesh.clone(); G.scene.add(mesh);
  dyns.push({ p: p.clone(), v: v.clone(), mesh, t: 0, fuse: 1.5, mine, spin: new THREE.Vector3(rand(4, 8), rand(-3, 3), rand(-3, 3)) });
}
function updateDynamite(dt) {
  for (let i = dyns.length - 1; i >= 0; i--) {
    const d = dyns[i]; d.t += dt;
    d.v.y -= 18 * dt;
    const n = d.p.clone().addScaledVector(d.v, dt);
    const g = Math.abs(n.x) < 1.5 && n.z > TRAIN.front && n.z < TRAIN.back ? groundAt(n.x, n.z, d.p.y, 0.05, 0.05) : 0.05;
    const inBox = G.boxes.some((b) => n.x > b.min[0] && n.x < b.max[0] && n.y > b.min[1] && n.y < b.max[1] && n.z > b.min[2] && n.z < b.max[2]);
    if (inBox && n.y > g + 0.05) { d.v.x *= -0.35; d.v.z *= -0.35; }
    else d.p.copy(n);
    if (d.p.y < g + 0.06) { d.p.y = g + 0.06; d.v.y = Math.abs(d.v.y) * 0.3; d.v.x *= 0.6; d.v.z *= 0.6; }
    if (g < 0.5 && d.p.y < 0.4) d.p.z += G.speed * dt;
    d.mesh.position.copy(d.p); d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt;
    if (Math.random() < dt * 40) sparks(d.p.clone().add(new THREE.Vector3(0, 0.15, 0)), 1, [1, 0.8, 0.3, 1]);
    let touch = false;
    if (G.mode === 'mp') touch = d.mine && G.mp.enemyNear(d.p, 1.0);
    else for (const e of enemies) if (e.alive && e.hitboxes[0] && e.hitboxes[0].c.distanceTo(d.p) < 1.0) touch = true;
    if (d.t > d.fuse || (touch && d.t > 0.15)) {
      if (G.mode === 'mp') G.mp.explode(d.p.clone(), d.mine);
      else explodeAt(d.p.clone(), 4.8, 150, { playerDmg: 28, scale: 1.25, knock: 8 });
      G.scene.remove(d.mesh); dyns.splice(i, 1);
    }
  }
  const maxDyn = G.mode === 'mp' ? 2 : 3, cd = G.mode === 'mp' ? 14 : 9;
  if (P.dyn < maxDyn) { P.dynCd -= dt; if (P.dynCd <= 0) { P.dyn++; P.dynCd = P.dyn < maxDyn ? cd : 0; sfx('toggle', { vol: 0.3, rate: 1.2 }); } }
  UI.setCharges(P.dyn, P.dyn < maxDyn ? Math.max(0, P.dynCd / cd) : 0);
}
export function clearDyn() { for (const d of dyns) G.scene.remove(d.mesh); dyns.length = 0; }

// ── 바이크 (멀티 산적) ─────────────────────────────────
function enterBike(side, x, z) {
  P.bike = { side, x, z, vx: 0, vz: 0, leap: null, lean: 0 };
  P.pos.set(x, 0, z); P.vel.set(0, 0, 0); P.onGround = true; P.climbing = null;
  setCrouch(false); G.myBike.visible = true;
}
function leaveBike() { P.bike = null; if (G.myBike) G.myBike.visible = false; setLoop('engine-motorcycle', 0); }
const LV = new THREE.Vector3(), LD = new THREE.Vector3();
// 이 자리에서 열차로 뛰어오를 수 있나: 착지점이 바닥이고, 옆이 트여 있어야 함(난간은 넘고 창문은 못 넘음)
export function canLand(side, z) {
  const x = side * 1.0;
  if (z < -26.6 || z > 38.6) return false;
  if (Math.abs(groundAt(x, z, TRAIN.FLOOR + 0.05, 0.3, 0.45) - TRAIN.FLOOR) > 0.06) return false;
  if (blocked(x, z, TRAIN.FLOOR, 0.3, 1.6, 0.45)) return false;
  LD.set(-side, 0, 0);
  for (const y of [TRAIN.FLOOR + 1.25, TRAIN.FLOOR + 2.2]) if (rayBoxes(LV.set(side * 2.0, y, z), LD, 1.0) < 1.0) return false;
  return true;
}
function bikeLeap() {
  const b = P.bike; if (!b || b.leap) return;
  if (!canLand(b.side, b.z)) { UI.toast('여기선 못 뛰어올라요 — 평판차·문 옆으로'); return; }
  b.leap = { t: 0, from: new THREE.Vector3(b.x, 0.3, b.z), to: new THREE.Vector3(b.side * 1.0, TRAIN.FLOOR, b.z) };
  sfx('jump_a', { vol: 0.7, rate: 0.85 }); G.controls?.haptic('hit');
}
function updateBike(dt, mx, my) {
  const b = P.bike;
  if (b.leap) {
    const L = b.leap; L.t = Math.min(1, L.t + dt / 0.5);
    P.pos.lerpVectors(L.from, L.to, L.t); P.pos.y += Math.sin(L.t * Math.PI) * 1.5;
    P.bob += dt * 4;
    // 빈 바이크는 뒤로 흘러가며 쓰러짐
    b.x += b.side * 2 * dt; b.z += G.speed * 0.4 * dt; b.lean = Math.min(1.4, b.lean + dt * 2);
    G.myBike.position.set(b.x, 0.02, b.z); G.myBike.rotation.set(0, 0, b.side * b.lean);
    if (L.t >= 1) {
      leaveBike(); P.pos.copy(L.to); P.vel.set(0, 0, 0); P.onGround = true;
      sfx('land', { vol: 0.8 }); P.landKick = 0.12; addShake(0.12);
      UI.toast('열차에 올라탔다!');
    }
    return;
  }
  // 카메라 기준 방향으로 바이크를 몬다 — 앞으로 밀면 보는 쪽으로
  const sin = Math.sin(P.yaw), cos = Math.cos(P.yaw);
  const sp = 11;
  const wx = (mx * cos - my * sin) * sp, wz = (-mx * sin - my * cos) * sp;
  b.vx = damp(b.vx, wx, 3.2, dt); b.vz = damp(b.vz, wz, 2.6, dt);
  b.x += b.vx * dt; b.z += b.vz * dt;
  const ax = Math.abs(b.x);
  if (ax < 2.35) { b.x = b.side * 2.35; b.vx = 0; }
  if (ax > 8) { b.x = b.side * 8; b.vx = 0; }
  b.z = clamp(b.z, -46, 62);
  b.lean = damp(b.lean, clamp(-b.vx * 0.06, -0.35, 0.35), 6, dt);
  P.pos.set(b.x, 0, b.z); P.vel.set(b.vx, 0, b.vz); P.onGround = true;
  G.myBike.position.set(b.x, 0.02 + Math.sin(G.time * 17) * 0.01, b.z);
  G.myBike.rotation.set(0, 0, b.lean + Math.sin(G.time * 3.1) * 0.02);
  for (const wh of G.myBikeWheels) if (wh) wh.rotation.x -= dt * 24;
  if (Math.random() < dt * 22) dust(new THREE.Vector3(b.x, 0.2, b.z + 0.9), 0.85);
  setLoop('engine-motorcycle', 0.32, 1.0 + Math.hypot(b.vx, b.vz) * 0.03);
  P.bob += dt * 3;
}

// ── 매 프레임 ──────────────────────────────────────────
export function updatePlayer(dt) {
  if (P.dead) { UI.setUse(null); return; }
  // 터치 조작 (시점·이동·버튼·이벤트)
  const c = G.controls.update(dt, {
    pos: G.camera.position, yaw: P.yaw, pitch: P.pitch, fov: G.camera.fov, baseFov: 72, adsAmt: P.ads,
    moving: Math.hypot(P.vel.x, P.vel.z) > 0.6, sprinting: P.sprint,
  });
  const live = G.state === 'play' && !P.frozen;
  const mk = 0.0024 * G.sens * lerp(1, 0.6, P.ads);           // 마우스(PC)
  if (live) { P.yaw += c.dyaw - input.lookDX * mk; P.pitch += c.dpitch - input.lookDY * mk; }
  input.lookDX = input.lookDY = 0;
  P.pitch = clamp(P.pitch, -1.35, 1.35);
  for (const ev of c.events) {
    if (!live) continue;
    if (ev === 'jump') input.jump = true;
    else if (ev === 'reload') startReload();
    else if (ev === 'grenade') input.throw = true;
    else if (ev === 'slide') startSlide();
  }
  if (G.touch) { if (c.crouch !== P.crouch && P.slideT <= 0) P.crouch = c.crouch; if (c.ads !== P.adsOn) P.adsOn = P.mounted ? false : c.ads; }
  else P.adsOn = input.mouseAds && !P.mounted;
  P.firing = live && (c.fire || input.mouseFire);

  let mx = live ? c.move.x : 0, my = live ? c.move.y : 0;
  if (live) { if (input.keys.KeyW) my = 1; if (input.keys.KeyS) my = -1; if (input.keys.KeyA) mx = -1; if (input.keys.KeyD) mx = 1; }
  const L = Math.hypot(mx, my); if (L > 1) { mx /= L; my /= L; }
  P.sprint = !P.carry && !P.bike && !P.crouch && !P.adsOn && !P.firing && my > 0.5 && (c.sprint || input.keys.ShiftLeft) && P.onGround && P.slideT <= 0;

  if (P.bike) {
    if (input.jump) bikeLeap();
    input.jump = false;
    updateBike(dt, mx, my);
  } else if (P.mounted) updateMounted(dt);
  else {
    const speed = (P.crouch ? 2.3 : P.sprint ? 6.6 : P.adsOn ? 3.0 : 4.7) * (P.carry ? 0.82 : 1);
    const sin = Math.sin(P.yaw), cos = Math.cos(P.yaw);
    let wx = (mx * cos - my * sin) * speed, wz = (-mx * sin - my * cos) * speed;
    let accel = P.onGround ? 16 : 5;
    if (P.knockT > 0) { P.knockT -= dt; accel = 0.6; wx = P.vel.x; wz = P.vel.z; }
    if (P.slideT > 0) {   // 슬라이딩: 달리던 방향으로 미끄러지며 감속
      P.slideT -= dt;
      const v = lerp(2.4, 9.0, Math.max(0, P.slideT) / 0.75);
      wx = P.slideDir.x * v; wz = P.slideDir.z * v; accel = 30;
      if (Math.random() < dt * 30) puff(new THREE.Vector3(P.pos.x, P.pos.y + 0.1, P.pos.z), 1, [0.8, 0.62, 0.45, 0.4]);
    }
    P.vel.x = damp(P.vel.x, wx, accel, dt); P.vel.z = damp(P.vel.z, wz, accel, dt);
    const lad = nearLadder();
    if (!P.climbing && lad && !P.carry && (my > 0.35 || input.jump) && P.pos.y < lad.top - 0.3) { P.climbing = lad; sfx('land', { vol: 0.4, rate: 1.3 }); setAds(false); }
    if (P.climbing) {
      const l = P.climbing;
      P.vel.set(0, 0, 0);
      P.pos.x = damp(P.pos.x, l.x, 10, dt); P.pos.z = damp(P.pos.z, l.z - l.dir * 0.05, 10, dt);
      P.pos.y += 3.8 * dt; P.bob += dt * 6;
      if (P.pos.y >= l.top - 0.05) { P.pos.y = l.top + 0.02; P.pos.z += l.dir * 0.75; P.pos.x = clamp(P.pos.x, -1.0, 1.0); P.climbing = null; sfx('land', { vol: 0.4 }); }
      if (my < -0.4) P.climbing = null;
      input.jump = false;
    } else {
      if (input.jump && P.onGround) { P.vel.y = 7.3; P.onGround = false; P.slideT = 0; sfx('jump_a', { vol: 0.35 }); if (P.crouch) setCrouch(false); }
      input.jump = false;
      P.vel.y -= 22 * dt;
      const was = P.onGround;
      // 밀려날 때는 난간을 넘어갈 수 있다
      const step = P.knockT > 0 ? 0.45 + Math.max(0, P.pos.y - TRAIN.FLOOR) : 0.45;
      P.onGround = moveBody(P.pos, P.vel, dt, 0.32, P.crouch ? 1.1 : 1.7, step);
      if (P.onGround && !was) { sfx('land', { vol: 0.3 }); P.landKick = 0.05; }
    }
    if (Math.abs(P.pos.x) > 1.55 && P.knockT > 0) P.pos.z += G.speed * 0.2 * dt;
    if ((P.pos.y < 0.6 && !onTrain(P.pos.x, P.pos.z)) || P.pos.y < 0.3) fellOff();
    const sp = Math.hypot(P.vel.x, P.vel.z);
    if (P.onGround && sp > 0.5) P.bob += dt * sp * 2.0;
  }
  if (input.throw) { input.throw = false; throwDynamite(); }
  updateDynamite(dt);

  // 카메라
  const eyeT = P.bike ? 1.55 : P.mounted ? 1.25 : P.slideT > 0 ? 0.85 : P.crouch ? 1.05 : 1.6;
  P.eye = damp(P.eye, eyeT, 12, dt);
  P.landKick = damp(P.landKick || 0, 0, 10, dt);
  P.ads = damp(P.ads, P.adsOn && !P.mounted && P.reload <= 0 && !P.sprint ? 1 : 0, 14, dt);
  const cam = G.camera;
  const rumble = P.bike ? Math.sin(G.time * 41) * 0.006 + Math.sin(G.time * 13) * 0.008 : Math.sin(G.time * 29) * 0.003 + Math.sin(G.time * 11.3) * 0.004;
  const bobAmt = (P.sprint ? 1.6 : 1) * (1 - P.ads * 0.8) * (P.bike ? 0.4 : 1);
  const bobY = Math.sin(P.bob * 2) * 0.03 * bobAmt, bobX = Math.cos(P.bob) * 0.02 * bobAmt;
  cam.position.set(P.pos.x + bobX * Math.cos(P.yaw), P.pos.y + P.eye + bobY + rumble - P.landKick, P.pos.z - bobX * Math.sin(P.yaw));
  P.recoil = damp(P.recoil, 0, 10, dt);
  // 반동: 화면이 튀었다가 제자리로 (멈춰 있으면 조금 더 빨리 돌아옴)
  P.aimKick = damp(P.aimKick, 0, P.firing ? 7 : 10, dt);
  P.yawKick = damp(P.yawKick, 0, 9, dt);
  P.fovPunch = damp(P.fovPunch, 0, 14, dt);
  P.bloom = damp(P.bloom, 0, 5, dt);
  let sx = 0, sy = 0;
  if (shake.amp > 0) { sx = (Math.random() - 0.5) * shake.amp * 0.1; sy = (Math.random() - 0.5) * shake.amp * 0.1; }
  cam.rotation.set(P.pitch + P.aimKick + sy, P.yaw + P.yawKick + sx, P.bike ? -P.bike.lean * 0.25 : 0);
  const w = WEAPONS[P.weapon];
  const fovT = (P.mounted ? 70 : lerp(P.sprint || P.slideT > 0 ? 78 : P.bike ? 76 : 72, w.adsFov, P.ads)) - P.fovPunch;
  P.fov = damp(P.fov, fovT, 16, dt);
  if (Math.abs(cam.fov - P.fov) > 0.05) { cam.fov = P.fov; cam.updateProjectionMatrix(); G.vmCamera.fov = lerp(58, 40, P.ads); G.vmCamera.updateProjectionMatrix(); }
  updateSunFollow(P.pos);

  P.fireCd -= dt; P.melee -= dt;
  if (!P.mounted) updateWeapon(dt);
  UI.setHp(P.hp, P.maxHp);
  if (G.mode !== 'mp' && G.time - P.lastHurt > 5 && P.hp < P.maxHp * 0.6) P.hp = Math.min(P.maxHp * 0.6, P.hp + 5 * dt);
  UI.el.hud.classList.toggle('ads', P.ads > 0.6);

  if (P.bike) {
    const ok = !P.bike.leap && canLand(P.bike.side, P.bike.z);
    UI.setUse(P.bike.leap ? null : ok ? '뛰어오르기!' : null, bikeLeap);
    UI.el.btnUse.classList.toggle('ready', ok);
  } else if (G.mode === 'mp') UI.setUse(null);
  else {
    const gd = Math.hypot(P.pos.x - G.gun.pos.x, P.pos.z - G.gun.pos.z);
    if (P.mounted) UI.setUse('기관총에서 내리기', dismount);
    else if (gd < 1.5 && Math.abs(P.pos.y - TRAIN.FLOOR) < 0.3) UI.setUse('거치 기관총 탑승', mount);
    else UI.setUse(null);
  }
}
// 밀쳐내기를 맞음 (멀티)
export function knockMe(kx, kz, up) {
  if (P.bike || P.dead) return;
  P.vel.set(kx, up, kz); P.onGround = false; P.knockT = 0.7; P.slideT = 0; P.climbing = null;
  addShake(0.2); sfx('impact', { vol: 0.8, rate: 0.8 });
}

function nearLadder() {
  for (const l of G.ladders) if (Math.hypot(P.pos.x - l.x, P.pos.z - l.z) < 0.75 && P.pos.y < l.top - 0.3) return l;
  return null;
}
function fellOff() {
  if (G.mode === 'mp') { G.mp.fell(); P.vel.set(0, 0, 0); P.pos.y = 0.6; return; }
  hurtPlayer(25, null);
  UI.toast('열차에서 떨어졌다! 밧줄로 끌어올림');
  const z = clamp(P.pos.z, -26, 36);
  P.pos.set(0, TRAIN.FLOOR + 0.05, z);
  for (let i = 0; i < 20 && groundAt(0, P.pos.z, 3, 0.3, 0.45) > TRAIN.FLOOR + 0.1; i++) P.pos.z += 0.6;
  P.vel.set(0, 0, 0);
}

function updateWeapon(dt) {
  const w = WEAPONS[P.weapon], vm = VM[P.weapon];
  if (P.reload > 0) {
    P.reload -= dt;
    if (P.reload <= 0) { P.ammo = P.mag; sfx('toggle', { vol: 0.5, rate: 0.7 }); }
  } else if (P.firing && P.fireCd <= 0 && G.state === 'play' && !(P.bike && P.bike.leap)) {
    // 바로 앞에 적이 있으면 개머리판으로 밀쳐낸다
    G.camera.getWorldDirection(D);
    const nb = P.melee <= 0 && !P.bike ? (G.mode === 'mp' ? G.mp.meleeTarget(P.pos, D) : nearestBoarder(P.pos, 1.9)) : null;
    if (nb && (G.mode === 'mp' ? G.mp.melee(nb, P.pos) : meleeHit(P.pos, D))) {
      P.melee = 0.6; P.fireCd = 0.45; P.swing = 1; addShake(0.12);
      if (G.mode !== 'mp') UI.floater(nb.pos.clone().add(new THREE.Vector3(0, 1.6, 0)), '밀쳐내기!', 'crit');
    } else if (P.ammo > 0) {
      P.ammo--; P.fireCd = w.fire; P.lever = 1; P.recoil = 1;
      const kick = w.kick * lerp(1, 0.55, P.ads) * (P.crouch ? 0.8 : 1);
      P.aimKick += kick; P.yawKick += rand(-1, 1) * w.yawKick; P.fovPunch = w.punch; addShake(w.shake);
      if (w.bloomPer) P.bloom = Math.min(0.05, P.bloom + w.bloomPer);
      shoot(false);
      gunshot(null, w.size); G.controls.haptic(w.haptic);
      vmFlash.visible = true; vmFlash.material.rotation = Math.random() * 6; vmFlash.userData.t = 0.05; vmLight.intensity = P.weapon === 'shotgun' ? 10 : 6;
      vmFlash.scale.setScalar(P.weapon === 'shotgun' ? 0.5 : P.weapon === 'revolver' ? 0.24 : 0.3);
      // 탄피
      const ej = new THREE.Vector3(0.12, -0.05, -0.35).applyQuaternion(G.camera.quaternion).add(G.camera.position);
      const ev = new THREE.Vector3(2.2, 1.6, 0.4).applyQuaternion(G.camera.quaternion);
      if (P.weapon === 'rifle') { setTimeout(() => { sfx('weapon_change', { vol: 0.32, rate: 1.6 }); brass(ej, ev); }, 160); }
      if (P.weapon === 'revolver' && vm.cyl) vm.cylT = (vm.cylT || 0) + Math.PI / 3;
      if (P.ammo === 0) setTimeout(startReload, P.weapon === 'shotgun' ? 220 : 380);
    } else startReload();
  }
  UI.setAmmo(P.reload > 0 ? '장전 중' : `${P.ammo} / ${P.mag}`);
  P.lever = damp(P.lever, 0, P.weapon === 'rifle' ? 7 : 12, dt);
  P.swing = damp(P.swing || 0, 0, 8, dt);
  const lt = P.lever > 0.02 ? Math.sin((1 - P.lever) * Math.PI) : 0;
  if (vm.lever) vm.lever.rotation.x = lt * 0.9;
  const rp = P.reload > 0 ? clamp((P.reloadMax - P.reload) / P.reloadMax, 0, 1) : 0;
  const rl = P.reload > 0 ? Math.sin(rp * Math.PI) : 0;
  if (vm.barrels) vm.barrels.rotation.x = -0.55 * Math.sin(clamp(rp * 1.15, 0, 1) * Math.PI);   // 산탄총 꺾기
  if (vm.cyl) { vm.cylA = damp(vm.cylA || 0, vm.cylT || 0, 22, dt); vm.cyl.rotation.z = vm.cylA + (P.reload > 0 ? rp * 12 : 0); }
  if (vm.hammer) vm.hammer.rotation.x = P.lever > 0.5 ? 0.5 : 0;
  const moveAmt = Math.min(1, Math.hypot(P.vel.x, P.vel.z) / 4.7) * (1 - P.ads * 0.85) * (P.bike ? 0.3 : 1);
  const h = P.holder, a = P.ads, sw = P.swing;
  const spr = P.sprint ? 1 : 0;
  P.sprintPose = damp(P.sprintPose || 0, spr, 8, dt);
  const hp = w.hipPos, ap = w.adsPos;
  const rk = P.weapon === 'shotgun' ? 1.6 : P.weapon === 'revolver' ? 0.8 : 1;
  const ty = lerp(hp[1], ap[1], a) + Math.sin(P.bob * 2) * 0.012 * moveAmt - rl * 0.08 - P.sprintPose * 0.04 + (P.landKick || 0) * 0.5;
  h.position.set(
    lerp(hp[0], ap[0], a) + Math.cos(P.bob) * 0.012 * moveAmt + sw * -0.1 + P.sprintPose * 0.03,
    h.position.y < ty - 0.05 ? damp(h.position.y, ty, 12, dt) : ty,
    lerp(hp[2], ap[2], a) + P.recoil * lerp(0.07, 0.035, a) * rk - sw * 0.18);
  h.rotation.set(P.recoil * lerp(0.18, 0.06, a) * rk + rl * 0.5 + lt * 0.08 * (1 - a) + sw * -0.6 - P.sprintPose * 0.25,
    lerp(-0.04, 0, a) + rl * 0.25 + sw * 0.9 + P.sprintPose * 0.5, rl * 0.6 + lt * 0.1 * (1 - a) + sw * 0.4);
  if (vmFlash.visible) {
    vmFlash.userData.t -= dt; if (vmFlash.userData.t <= 0) vmFlash.visible = false;
    vm.muzzle.getWorldPosition(vmFlash.position);
  }
  vmLight.intensity = damp(vmLight.intensity, 0, 30, dt);
  UI.setCross(lerp((P.crouch ? 0.04 : 0.08) + Math.min(0.2, Math.hypot(P.vel.x, P.vel.z) * 0.03) + P.recoil * 0.15 + P.bloom * 3, 0.0, a) + (w.pellets > 1 ? w.hip * lerp(2.2, 1.6, a) : 0));
}

// ── 거치 기관총 ────────────────────────────────────────
function mount() { P.mounted = true; P.holder.visible = false; setCrouch(false); setAds(false); P.reload = 0; sfx('toggle', { vol: 0.6 }); UI.toast('거치 기관총 — 과열 주의'); }
function dismount() { P.mounted = false; P.holder.visible = true; sfx('toggle', { vol: 0.6, rate: 0.8 }); P.pos.set(G.gun.pos.x + 0.9, TRAIN.FLOOR, G.gun.pos.z + 0.6); }
function updateMounted(dt) {
  const g = G.gun;
  P.pos.set(g.pos.x + Math.sin(P.yaw) * 0.95, TRAIN.FLOOR, g.pos.z + Math.cos(P.yaw) * 0.95);
  P.vel.set(0, 0, 0);
  g.yaw.rotation.y = P.yaw; g.yaw.rotation.x = clamp(P.pitch, -0.5, 0.6);
  const cool = 0.38, perShot = 0.03 * (1 - G.upgrades.cool * 0.25);
  P.heat = Math.max(0, P.heat - cool * dt * (P.firing && !P.overheat ? 0.25 : 1));
  if (P.overheat && P.heat < 0.3) P.overheat = false;
  if (P.firing && !P.overheat && P.fireCd <= 0 && G.state === 'play') {
    P.fireCd = 0.08; P.heat += perShot; P.aimKick += 0.008; P.yawKick += rand(-0.004, 0.004);
    g.barrels.rotation.z += 0.9;
    shoot(true);
    gunshot(null, 0.75); if (Math.random() < 0.5) G.controls.haptic('fire');
    if (P.heat >= 1) { P.heat = 1; P.overheat = true; sfx('skid', { vol: 0.5, rate: 1.4 }); UI.toast('과열! 식는 중…'); }
  }
  if (P.overheat && Math.random() < dt * 20) smoke(g.barrels.localToWorld(new THREE.Vector3(0, 0, -0.9)), 0.3);
  UI.setHeat(P.heat, true); UI.setAmmo(P.overheat ? '과열' : '∞'); UI.setCross(0.05);
}
export function updateHeatHidden() { if (!P.mounted) UI.setHeat(0, false); }
