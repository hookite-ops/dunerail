// 플레이어 v2 — 입력, 이동(달리기), 사다리, 레버액션 소총(정조준·개머리판), 다이너마이트, 거치 기관총
import * as THREE from 'three';
import { G, TRAIN, clamp, lerp, rand, damp } from './state.js';
import { moveBody, rayBoxes, groundAt, updateSunFollow, onTrain } from './world.js';
import { raycastEnemies, aimAssistTarget, meleeHit, nearestBoarder, explodeAt, enemies } from './enemies.js';
import * as UI from './ui.js';
import { sfx, gunshot } from './audio.js';
import { tracer, muzzleWorld, sparks, puff, shake, addShake, smoke } from './fx.js';

export const P = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
  hp: 100, maxHp: 100, crouch: false, onGround: true, climbing: null,
  mounted: false, ammo: 8, mag: 8, reload: 0, fireCd: 0, lever: 0, recoil: 0, lastHurt: 0,
  heat: 0, overheat: false, eye: 1.6, bob: 0, dead: false, firing: false, aimKick: 0,
  ads: 0, adsOn: false, sprint: false, melee: 0, dyn: 3, dynCd: 0, fov: 72,
};
const input = { mx: 0, my: 0, keys: {}, lookDX: 0, lookDY: 0, jump: false, throw: false };

// ── 입력 ───────────────────────────────────────────────
export function initInput() {
  const stickZone = UI.el.stickZone, stick = UI.el.stick, knob = UI.el.stickKnob;
  let stickId = null, sx = 0, sy = 0;
  const R = 58;
  stickZone.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    stickId = e.pointerId; sx = e.clientX; sy = e.clientY;
    stick.style.transform = `translate(${sx}px, ${sy}px)`; stick.classList.remove('hidden');
    knob.style.transform = 'translate(0,0)';
    stickZone.setPointerCapture(e.pointerId);
  });
  stickZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - sx, dy = e.clientY - sy; const L = Math.hypot(dx, dy);
    // 손가락이 멀리 가면 스틱 중심이 따라온다 (방향 바꾸기 쉬움)
    if (L > R * 1.35) { sx += dx * (1 - R * 1.35 / L); sy += dy * (1 - R * 1.35 / L); stick.style.transform = `translate(${sx}px, ${sy}px)`; dx = e.clientX - sx; dy = e.clientY - sy; }
    const L2 = Math.hypot(dx, dy); const k = L2 > R ? R / L2 : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    let mx = dx / R, my = -dy / R; const m = Math.hypot(mx, my);
    if (m < 0.12) { mx = my = 0; }                               // 데드존
    input.mx = mx; input.my = my; input.mag = m;
    stick.classList.toggle('sprint', m > 1.0);
  });
  const endStick = (e) => { if (e.pointerId !== stickId) return; stickId = null; input.mx = input.my = input.mag = 0; stick.classList.add('hidden'); stick.classList.remove('sprint'); };
  stickZone.addEventListener('pointerup', endStick); stickZone.addEventListener('pointercancel', endStick);

  // 시점: 캔버스 위 아무 곳 (손가락마다 따로 추적)
  const looks = new Map();
  const canvas = G.renderer.domElement;
  const lookStart = (e) => { looks.set(e.pointerId, { x: e.clientX, y: e.clientY }); };
  const lookMove = (e) => {
    const l = looks.get(e.pointerId); if (!l) return;
    let dx = e.clientX - l.x, dy = e.clientY - l.y; l.x = e.clientX; l.y = e.clientY;
    // 가속: 빠르게 휙 돌리면 더 많이, 천천히 미세 조준은 그대로
    const sp = Math.hypot(dx, dy), acc = 1 + Math.min(0.9, Math.max(0, sp - 6) * 0.035);
    input.lookDX += dx * acc; input.lookDY += dy * acc;
  };
  const lookEnd = (e) => looks.delete(e.pointerId);
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') { if (G.state === 'play' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); return; }
    lookStart(e); canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') lookMove(e); });
  canvas.addEventListener('pointerup', lookEnd); canvas.addEventListener('pointercancel', lookEnd);

  // 발사 버튼: 누르면 사격, 누른 채 끌면 조준
  const fire = UI.el.btnFire;
  fire.addEventListener('pointerdown', (e) => { P.firing = true; fire.classList.add('on'); lookStart(e); fire.setPointerCapture(e.pointerId); });
  fire.addEventListener('pointermove', lookMove);
  const fireEnd = (e) => { P.firing = false; fire.classList.remove('on'); lookEnd(e); };
  fire.addEventListener('pointerup', fireEnd); fire.addEventListener('pointercancel', fireEnd);
  UI.el.btnJump.addEventListener('pointerdown', () => { input.jump = true; });
  UI.el.btnCrouch.addEventListener('pointerdown', () => setCrouch(!P.crouch));
  UI.el.btnReload.addEventListener('pointerdown', () => startReload());
  UI.el.btnAim.addEventListener('pointerdown', () => setAds(!P.adsOn));
  UI.el.btnDyn.addEventListener('pointerdown', () => { input.throw = true; });
  UI.el.btnUse.addEventListener('pointerdown', () => UI.triggerUse());
  for (const b of [fire, UI.el.btnJump, UI.el.btnCrouch, UI.el.btnReload, UI.el.btnUse, UI.el.btnAim, UI.el.btnDyn]) b.addEventListener('contextmenu', (e) => e.preventDefault());

  // 키보드·마우스 (PC 테스트용)
  addEventListener('keydown', (e) => {
    input.keys[e.code] = true;
    if (e.code === 'Space') input.jump = true;
    if (e.code === 'KeyC' || e.code === 'ControlLeft') setCrouch(!P.crouch);
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyE') UI.triggerUse();
    if (e.code === 'KeyG' || e.code === 'KeyQ') input.throw = true;
  });
  addEventListener('keyup', (e) => { input.keys[e.code] = false; });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { input.lookDX += e.movementX * 0.55; input.lookDY += e.movementY * 0.55; } });
  addEventListener('mousedown', (e) => { if (document.pointerLockElement !== canvas) return; if (e.button === 0) P.firing = true; if (e.button === 2) setAds(true); });
  addEventListener('mouseup', (e) => { if (e.button === 0) P.firing = false; if (e.button === 2) setAds(false); });
  addEventListener('contextmenu', (e) => e.preventDefault());
}
function setCrouch(on) { P.crouch = on; UI.el.btnCrouch.classList.toggle('on', on); }
function setAds(on) { if (P.mounted) on = false; P.adsOn = on; UI.el.btnAim.classList.toggle('on', on); if (on) sfx('toggle', { vol: 0.25, rate: 1.6 }); }

// ── 1인칭 소총 ─────────────────────────────────────────
let rifle, lever, muzzleRef, vmFlash, vmLight;
export function initPlayer() {
  rifle = G.models.rifle.clone(true);
  rifle.scale.setScalar(0.62);
  rifle.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  const holder = new THREE.Group(); holder.add(rifle);
  G.vmCamera.add(holder); G.vmScene.add(G.vmCamera);
  P.holder = holder;
  lever = rifle.getObjectByName('Lever');
  muzzleRef = rifle.getObjectByName('muzzle_ref');
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
}
function makeFlashTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.3, 'rgba(255,180,80,0.9)'); r.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = r; g.beginPath();
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, rr = i % 2 ? 12 : 32; g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr); }
  g.fill();
  return new THREE.CanvasTexture(c);
}

export function resetPlayer(full) {
  const sp = G.map.spawns[0];
  P.pos.set(sp.x, TRAIN.FLOOR, sp.z); P.vel.set(0, 0, 0); P.yaw = 0; P.pitch = -0.05;
  P.maxHp = 100 + G.upgrades.hp * 25;
  if (full) P.hp = P.maxHp;
  P.mag = 8 + G.upgrades.mag * 3; P.ammo = P.mag; P.reload = 0; P.fireCd = 0.3;
  P.mounted = false; P.heat = 0; P.overheat = false; P.climbing = null; P.dead = false;
  setCrouch(false); setAds(false);
  P.dyn = 3; P.dynCd = 0;
  P.holder.visible = true;
  for (const d of dyns) G.scene.remove(d.mesh); dyns.length = 0;
}

function startReload() {
  if (P.mounted || P.reload > 0 || P.ammo >= P.mag || G.state !== 'play') return;
  P.reload = 1.3; sfx('weapon_change', { vol: 0.6, rate: 0.85 });
}

export function hurtPlayer(amount, from) {
  if (P.dead || G.state !== 'play') return;
  if (P.crouch && !P.mounted) amount *= 0.85;
  P.hp -= amount; P.lastHurt = G.time;
  let ang = null;
  if (from) { const a = Math.atan2(from.x - P.pos.x, from.z - P.pos.z); ang = -(a - (P.yaw + Math.PI)); }
  UI.hurtFlash(amount, ang);
  addShake(Math.min(0.25, amount / 80));
  sfx('enemy_hurt', { vol: 0.5, rate: 0.7 });
  if (P.hp <= 0) { P.hp = 0; P.dead = true; }
}

// ── 사격 ───────────────────────────────────────────────
const O = new THREE.Vector3(), D = new THREE.Vector3(), HIT = new THREE.Vector3(), FWD = new THREE.Vector3();
function shoot(isGun) {
  const cam = G.camera;
  O.copy(cam.position);
  cam.getWorldDirection(D);
  const moving = Math.hypot(P.vel.x, P.vel.z) > 0.5;
  let spread = isGun ? 0.016 : lerp((P.crouch ? 0.005 : 0.009) + (moving ? 0.012 : 0) + (P.onGround ? 0 : 0.03) + (P.sprint ? 0.02 : 0), 0.0015, P.ads);
  if (G.touch) {   // 모바일 조준 보정
    const t = aimAssistTarget(O, D, isGun ? 0.07 : lerp(0.065, 0.035, P.ads));
    if (t) { FWD.subVectors(t, O).normalize(); D.lerp(FWD, 0.75).normalize(); spread *= 0.4; }
  }
  D.x += rand(-spread, spread); D.y += rand(-spread, spread); D.z += rand(-spread, spread); D.normalize();
  const wallT = rayBoxes(O, D, 170);
  const hit = raycastEnemies(O, D, wallT);
  const endT = hit ? hit.t : Math.min(wallT, 170);
  HIT.copy(O).addScaledVector(D, endT);
  const muzzle = muzzlePos();
  tracer(muzzle, HIT, isGun ? [1, 0.7, 0.35] : [1, 0.9, 0.6]);
  muzzleWorld(muzzle, D);
  if (hit) {
    const base = isGun ? 15 : 30 * (1 + G.upgrades.dmg * 0.2);
    hit.enemy.damage(base * hit.mult, HIT, hit.mult > 1.5, D);
  } else if (wallT < 170) {
    sparks(HIT, 6); puff(HIT, 3, [0.6, 0.5, 0.4, 0.5]);
  }
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
  if (P.dyn <= 0 || P.mounted) return;
  P.dyn--; if (P.dynCd <= 0) P.dynCd = 9;
  const cam = G.camera; cam.getWorldDirection(D);
  const mesh = G.dynMesh.clone(); G.scene.add(mesh);
  const p = cam.position.clone().addScaledVector(D, 0.5).add(new THREE.Vector3(0, -0.15, 0));
  const v = D.clone().multiplyScalar(15).add(new THREE.Vector3(P.vel.x, 4.2, P.vel.z));
  dyns.push({ p, v, mesh, t: 0, fuse: 1.5, spin: new THREE.Vector3(rand(4, 8), rand(-3, 3), rand(-3, 3)) });
  sfx('jump_a', { vol: 0.4, rate: 1.6 }); sfx('skid', { vol: 0.2, rate: 2.5 });
  P.recoil = 0.6;
}
function updateDynamite(dt) {
  for (let i = dyns.length - 1; i >= 0; i--) {
    const d = dyns[i]; d.t += dt;
    d.v.y -= 18 * dt;
    const n = d.p.clone().addScaledVector(d.v, dt);
    // 열차 표면 위로 튕김
    const g = Math.abs(n.x) < 1.5 && n.z > TRAIN.front && n.z < TRAIN.back ? groundAt(n.x, n.z, d.p.y, 0.05, 0.05) : 0.05;
    const inBox = G.boxes.some((b) => n.x > b.min[0] && n.x < b.max[0] && n.y > b.min[1] && n.y < b.max[1] && n.z > b.min[2] && n.z < b.max[2]);
    if (inBox && n.y > g + 0.05) { d.v.x *= -0.35; d.v.z *= -0.35; }
    else d.p.copy(n);
    if (d.p.y < g + 0.06) { d.p.y = g + 0.06; d.v.y = Math.abs(d.v.y) * 0.3; d.v.x *= 0.6; d.v.z *= 0.6; }
    if (g < 0.5 && d.p.y < 0.4) d.p.z += G.speed * dt;        // 모래 위면 뒤로 흘러감
    d.mesh.position.copy(d.p); d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt;
    if (Math.random() < dt * 40) sparks(d.p.clone().add(new THREE.Vector3(0, 0.15, 0)), 1, [1, 0.8, 0.3, 1]);
    // 적에 닿으면 바로 터짐
    let touch = false;
    for (const e of enemies) if (e.alive && e.hitboxes[0] && e.hitboxes[0].c.distanceTo(d.p) < 1.0) touch = true;
    if (d.t > d.fuse || (touch && d.t > 0.15)) {
      explodeAt(d.p.clone(), 4.8, 150, { playerDmg: 28, scale: 1.25, knock: 8 });
      G.scene.remove(d.mesh); dyns.splice(i, 1);
    }
  }
  if (P.dyn < 3) { P.dynCd -= dt; if (P.dynCd <= 0) { P.dyn++; P.dynCd = P.dyn < 3 ? 9 : 0; sfx('toggle', { vol: 0.3, rate: 1.2 }); } }
  UI.setCharges(P.dyn, P.dyn < 3 ? Math.max(0, P.dynCd / 9) : 0);
}

// ── 매 프레임 ──────────────────────────────────────────
export function updatePlayer(dt) {
  if (P.dead) return;
  // 시점 (정조준이면 느리게, 적 근처면 살짝 끈적하게)
  let k = (G.touch ? 0.0042 : 0.0024) * G.sens * lerp(1, 0.6, P.ads);
  if (G.touch && !P.mounted) {
    G.camera.getWorldDirection(D);
    if (aimAssistTarget(G.camera.position, D, 0.05)) k *= 0.6;
  }
  P.yaw -= input.lookDX * k; P.pitch -= input.lookDY * k;
  input.lookDX = input.lookDY = 0;
  P.pitch = clamp(P.pitch, -1.35, 1.35);

  let mx = input.mx, my = input.my;
  if (input.keys.KeyW) my = 1; if (input.keys.KeyS) my = -1; if (input.keys.KeyA) mx = -1; if (input.keys.KeyD) mx = 1;
  const L = Math.hypot(mx, my); if (L > 1) { mx /= L; my /= L; }
  P.sprint = !P.crouch && !P.adsOn && my > 0.5 && ((input.mag || 0) > 1.0 || input.keys.ShiftLeft) && P.onGround;

  if (P.mounted) updateMounted(dt);
  else {
    const speed = P.crouch ? 2.3 : P.sprint ? 6.6 : P.adsOn ? 3.0 : 4.7;
    const sin = Math.sin(P.yaw), cos = Math.cos(P.yaw);
    const wx = (mx * cos - my * sin) * speed, wz = (-mx * sin - my * cos) * speed;
    const accel = P.onGround ? 16 : 5;
    P.vel.x = damp(P.vel.x, wx, accel, dt); P.vel.z = damp(P.vel.z, wz, accel, dt);
    const lad = nearLadder();
    if (!P.climbing && lad && (my > 0.35 || input.jump) && P.pos.y < lad.top - 0.3) { P.climbing = lad; sfx('land', { vol: 0.4, rate: 1.3 }); setAds(false); }
    if (P.climbing) {
      const l = P.climbing;
      P.vel.set(0, 0, 0);
      P.pos.x = damp(P.pos.x, l.x, 10, dt); P.pos.z = damp(P.pos.z, l.z - l.dir * 0.05, 10, dt);
      P.pos.y += 3.8 * dt; P.bob += dt * 6;
      if (P.pos.y >= l.top - 0.05) { P.pos.y = l.top + 0.02; P.pos.z += l.dir * 0.75; P.pos.x = clamp(P.pos.x, -1.0, 1.0); P.climbing = null; sfx('land', { vol: 0.4 }); }
      if (my < -0.4) P.climbing = null;
      input.jump = false;
    } else {
      if (input.jump && P.onGround) { P.vel.y = 7.3; P.onGround = false; sfx('jump_a', { vol: 0.35 }); if (P.crouch) setCrouch(false); }
      input.jump = false;
      P.vel.y -= 22 * dt;
      const was = P.onGround;
      P.onGround = moveBody(P.pos, P.vel, dt, 0.32, P.crouch ? 1.1 : 1.7, 0.45);
      if (P.onGround && !was) { sfx('land', { vol: 0.3 }); P.landKick = 0.05; }
    }
    if ((P.pos.y < 0.6 && !onTrain(P.pos.x, P.pos.z)) || P.pos.y < 0.3) fellOff();
    const sp = Math.hypot(P.vel.x, P.vel.z);
    if (P.onGround && sp > 0.5) P.bob += dt * sp * 2.0;
  }
  if (input.throw) { input.throw = false; throwDynamite(); }
  updateDynamite(dt);

  // 카메라
  const eyeT = P.mounted ? 1.25 : P.crouch ? 1.05 : 1.6;
  P.eye = damp(P.eye, eyeT, 12, dt);
  P.landKick = damp(P.landKick || 0, 0, 10, dt);
  P.ads = damp(P.ads, P.adsOn && !P.mounted && P.reload <= 0 ? 1 : 0, 14, dt);
  const cam = G.camera;
  const rumble = Math.sin(G.time * 29) * 0.003 + Math.sin(G.time * 11.3) * 0.004;
  const bobAmt = (P.sprint ? 1.6 : 1) * (1 - P.ads * 0.8);
  const bobY = Math.sin(P.bob * 2) * 0.03 * bobAmt, bobX = Math.cos(P.bob) * 0.02 * bobAmt;
  cam.position.set(P.pos.x + bobX * Math.cos(P.yaw), P.pos.y + P.eye + bobY + rumble - P.landKick, P.pos.z - bobX * Math.sin(P.yaw));
  P.recoil = damp(P.recoil, 0, 10, dt);
  P.aimKick = damp(P.aimKick, 0, 9, dt);
  let sx = 0, sy = 0;
  if (shake.amp > 0) { sx = (Math.random() - 0.5) * shake.amp * 0.1; sy = (Math.random() - 0.5) * shake.amp * 0.1; }
  cam.rotation.set(P.pitch + P.aimKick + sy, P.yaw + sx, 0);
  const fovT = P.mounted ? 70 : lerp(P.sprint ? 78 : 72, 46, P.ads);
  P.fov = damp(P.fov, fovT, 12, dt);
  if (Math.abs(cam.fov - P.fov) > 0.05) { cam.fov = P.fov; cam.updateProjectionMatrix(); G.vmCamera.fov = lerp(58, 40, P.ads); G.vmCamera.updateProjectionMatrix(); }
  updateSunFollow(P.pos);

  P.fireCd -= dt; P.melee -= dt;
  if (!P.mounted) updateRifle(dt);
  UI.setHp(P.hp, P.maxHp);
  if (G.time - P.lastHurt > 5 && P.hp < P.maxHp * 0.6) P.hp = Math.min(P.maxHp * 0.6, P.hp + 5 * dt);
  UI.el.hud.classList.toggle('ads', P.ads > 0.6);

  const gd = Math.hypot(P.pos.x - G.gun.pos.x, P.pos.z - G.gun.pos.z);
  if (P.mounted) UI.setUse('기관총에서 내리기', dismount);
  else if (gd < 1.5 && Math.abs(P.pos.y - TRAIN.FLOOR) < 0.3) UI.setUse('거치 기관총 탑승', mount);
  else UI.setUse(null);
}

function nearLadder() {
  for (const l of G.ladders) if (Math.hypot(P.pos.x - l.x, P.pos.z - l.z) < 0.75 && P.pos.y < l.top - 0.3) return l;
  return null;
}
function fellOff() {
  hurtPlayer(25, null);
  UI.toast('열차에서 떨어졌다! 밧줄로 끌어올림');
  const z = clamp(P.pos.z, -26, 36);
  P.pos.set(0, TRAIN.FLOOR + 0.05, z);
  for (let i = 0; i < 20 && groundAt(0, P.pos.z, 3, 0.3, 0.45) > TRAIN.FLOOR + 0.1; i++) P.pos.z += 0.6;
  P.vel.set(0, 0, 0);
}

function updateRifle(dt) {
  if (P.reload > 0) {
    P.reload -= dt;
    if (P.reload <= 0) { P.ammo = P.mag; sfx('toggle', { vol: 0.5, rate: 0.7 }); }
  } else if (P.firing && P.fireCd <= 0 && G.state === 'play') {
    // 바로 앞에 산적이 있으면 개머리판으로 밀쳐낸다
    G.camera.getWorldDirection(D);
    const nb = nearestBoarder(P.pos, 1.9);
    if (nb && P.melee <= 0 && meleeHit(P.pos, D)) {
      P.melee = 0.6; P.fireCd = 0.45; P.swing = 1; addShake(0.12);
      UI.floater(nb.pos.clone().add(new THREE.Vector3(0, 1.6, 0)), '밀쳐내기!', 'crit');
    } else if (P.ammo > 0) {
      P.ammo--; P.fireCd = 0.42; P.lever = 1; P.recoil = 1; P.aimKick = lerp(0.04, 0.02, P.ads);
      shoot(false);
      gunshot(null, 1);
      vmFlash.visible = true; vmFlash.material.rotation = Math.random() * 6; vmFlash.userData.t = 0.05; vmLight.intensity = 6;
      setTimeout(() => sfx('weapon_change', { vol: 0.32, rate: 1.6 }), 180);
      if (P.ammo === 0) setTimeout(startReload, 380);
    } else startReload();
  }
  UI.setAmmo(P.reload > 0 ? '장전 중' : `${P.ammo} / ${P.mag}`);
  P.lever = damp(P.lever, 0, 7, dt);
  P.swing = damp(P.swing || 0, 0, 8, dt);
  const lt = P.lever > 0.02 ? Math.sin((1 - P.lever) * Math.PI) : 0;
  if (lever) lever.rotation.x = lt * 0.9;
  const rl = P.reload > 0 ? Math.sin(Math.min(1, (1.3 - P.reload) / 1.3) * Math.PI) : 0;
  const moveAmt = Math.min(1, Math.hypot(P.vel.x, P.vel.z) / 4.7) * (1 - P.ads * 0.85);
  const h = P.holder, a = P.ads, sw = P.swing;
  const spr = P.sprint ? 1 : 0;
  P.sprintPose = damp(P.sprintPose || 0, spr, 8, dt);
  h.position.set(
    lerp(0.16, 0.0, a) + Math.cos(P.bob) * 0.012 * moveAmt + sw * -0.1 + P.sprintPose * 0.03,
    lerp(-0.17, -0.076, a) + Math.sin(P.bob * 2) * 0.012 * moveAmt - rl * 0.08 - P.sprintPose * 0.04 + (P.landKick || 0) * 0.5,
    lerp(-0.34, -0.27, a) + P.recoil * lerp(0.07, 0.035, a) - sw * 0.18);
  h.rotation.set(P.recoil * lerp(0.18, 0.06, a) + rl * 0.5 + lt * 0.08 * (1 - a) + sw * -0.6 - P.sprintPose * 0.25,
    lerp(-0.04, 0, a) + rl * 0.25 + sw * 0.9 + P.sprintPose * 0.5, rl * 0.6 + lt * 0.1 * (1 - a) + sw * 0.4);
  if (vmFlash.visible) {
    vmFlash.userData.t -= dt; if (vmFlash.userData.t <= 0) vmFlash.visible = false;
    muzzleRef.getWorldPosition(vmFlash.position);
  }
  vmLight.intensity = damp(vmLight.intensity, 0, 30, dt);
  UI.setCross(lerp((P.crouch ? 0.04 : 0.08) + Math.min(0.2, Math.hypot(P.vel.x, P.vel.z) * 0.03) + P.recoil * 0.15, 0.0, a));
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
    P.fireCd = 0.08; P.heat += perShot; P.aimKick = 0.012;
    g.barrels.rotation.z += 0.9;
    shoot(true);
    gunshot(null, 0.75);
    if (P.heat >= 1) { P.heat = 1; P.overheat = true; sfx('skid', { vol: 0.5, rate: 1.4 }); UI.toast('과열! 식는 중…'); }
  }
  if (P.overheat && Math.random() < dt * 20) smoke(g.barrels.localToWorld(new THREE.Vector3(0, 0, -0.9)), 0.3);
  UI.setHeat(P.heat, true); UI.setAmmo(P.overheat ? '과열' : '∞'); UI.setCross(0.05);
}
export function updateHeatHidden() { if (!P.mounted) UI.setHeat(0, false); }
