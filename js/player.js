// 플레이어 — 입력, 이동, 사다리, 소총, 거치 기관총
import * as THREE from 'three';
import { G, TRAIN, clamp, lerp, rand, damp } from './state.js';
import { moveBody, rayBoxes, groundAt, updateSunFollow, onTrain } from './world.js';
import { raycastEnemies, aimAssistTarget } from './enemies.js';
import * as UI from './ui.js';
import { sfx } from './audio.js';
import { tracer, muzzleWorld, sparks, puff, shake, addShake } from './fx.js';

export const P = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
  hp: 100, maxHp: 100, crouch: false, onGround: true, climbing: null,
  mounted: false, ammo: 8, mag: 8, reload: 0, fireCd: 0, lever: 0, recoil: 0, lastHurt: 0,
  heat: 0, overheat: false, eye: 1.6, bob: 0, dead: false, firing: false, aimKick: 0,
};
const input = { mx: 0, my: 0, keys: {}, lookDX: 0, lookDY: 0, jump: false };

// ── 입력 ───────────────────────────────────────────────
export function initInput() {
  const stickZone = UI.el.stickZone, stick = UI.el.stick, knob = UI.el.stickKnob;
  let stickId = null, sx = 0, sy = 0;
  const R = 56;
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
    if (L > R) { dx *= R / L; dy *= R / L; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.mx = dx / R; input.my = -dy / R;
  });
  const endStick = (e) => { if (e.pointerId !== stickId) return; stickId = null; input.mx = input.my = 0; stick.classList.add('hidden'); };
  stickZone.addEventListener('pointerup', endStick); stickZone.addEventListener('pointercancel', endStick);

  // 시점: 캔버스 위 아무 곳 (여러 손가락 각각 추적)
  const looks = new Map();
  const canvas = G.renderer.domElement;
  const lookStart = (e) => { looks.set(e.pointerId, { x: e.clientX, y: e.clientY }); };
  const lookMove = (e) => {
    const l = looks.get(e.pointerId); if (!l) return;
    input.lookDX += e.clientX - l.x; input.lookDY += e.clientY - l.y; l.x = e.clientX; l.y = e.clientY;
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
  UI.el.btnCrouch.addEventListener('pointerdown', () => { P.crouch = !P.crouch; UI.el.btnCrouch.classList.toggle('on', P.crouch); });
  UI.el.btnReload.addEventListener('pointerdown', () => startReload());
  UI.el.btnUse.addEventListener('pointerdown', () => UI.triggerUse());
  for (const b of [fire, UI.el.btnJump, UI.el.btnCrouch, UI.el.btnReload, UI.el.btnUse]) b.addEventListener('contextmenu', (e) => e.preventDefault());

  // 키보드·마우스 (PC 테스트용)
  addEventListener('keydown', (e) => {
    input.keys[e.code] = true;
    if (e.code === 'Space') input.jump = true;
    if (e.code === 'KeyC' || e.code === 'ControlLeft') { P.crouch = !P.crouch; UI.el.btnCrouch.classList.toggle('on', P.crouch); }
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyE') UI.triggerUse();
  });
  addEventListener('keyup', (e) => { input.keys[e.code] = false; });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { input.lookDX += e.movementX * 0.55; input.lookDY += e.movementY * 0.55; } });
  addEventListener('mousedown', (e) => { if (document.pointerLockElement === canvas && e.button === 0) P.firing = true; });
  addEventListener('mouseup', (e) => { if (e.button === 0) P.firing = false; });
  addEventListener('contextmenu', (e) => e.preventDefault());
}

// ── 1인칭 소총 ─────────────────────────────────────────
let rifle, lever, muzzleRef, vmFlash;
export function initPlayer() {
  rifle = G.models.rifle.clone(true);
  rifle.scale.setScalar(0.62);
  rifle.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  const holder = new THREE.Group(); holder.add(rifle);
  G.vmCamera.add(holder); G.vmScene.add(G.vmCamera);
  P.holder = holder;
  lever = rifle.getObjectByName('Lever');
  muzzleRef = rifle.getObjectByName('muzzle_ref');
  // 총구 섬광 (무기 장면)
  const sm = new THREE.SpriteMaterial({ map: (G.flashTex ||= makeFlashTex()), color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  vmFlash = new THREE.Sprite(sm); vmFlash.scale.setScalar(0.22); vmFlash.visible = false; G.vmScene.add(vmFlash);
  // 사다리 방향(지붕 쪽)
  for (const l of G.ladders) {
    let best = null;
    for (const b of G.boxes) if (b.tag.includes('지붕') && !b.tag.includes('환기구')) {
      const zc = (b.min[2] + b.max[2]) / 2; const d = Math.abs(zc - l.z) - (b.max[2] - b.min[2]) / 2;
      if (!best || d < best.d) best = { d, dir: Math.sign(zc - l.z) };
    }
    l.dir = best ? best.dir : 1;
  }
}
function makeFlashTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.3, 'rgba(255,180,80,0.9)'); r.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = r; g.beginPath();
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, rr = i % 2 ? 12 : 32; g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr); }
  g.fill();
  const t = new THREE.CanvasTexture(c); return t;
}

export function resetPlayer(full) {
  const sp = G.map.spawns[0];
  P.pos.set(sp.x, TRAIN.FLOOR, sp.z); P.vel.set(0, 0, 0); P.yaw = 0; P.pitch = -0.05;
  P.maxHp = 100 + G.upgrades.hp * 25;
  if (full) P.hp = P.maxHp;
  P.mag = 8 + G.upgrades.mag * 3; P.ammo = P.mag; P.reload = 0; P.fireCd = 0.3;
  P.mounted = false; P.heat = 0; P.overheat = false; P.climbing = null; P.dead = false; P.crouch = false;
  UI.el.btnCrouch.classList.remove('on');
  P.holder.visible = true;
}

function startReload() {
  if (P.mounted || P.reload > 0 || P.ammo >= P.mag || G.state !== 'play') return;
  P.reload = 1.45; sfx('weapon_change', { vol: 0.6, rate: 0.85 });
}

export function hurtPlayer(amount, from) {
  if (P.dead || G.state !== 'play') return;
  if (P.crouch && !P.mounted) amount *= 0.85;
  P.hp -= amount; P.lastHurt = G.time;
  let ang = null;
  if (from) {
    const a = Math.atan2(from.x - P.pos.x, from.z - P.pos.z);       // 세계 기준
    ang = -(a - (P.yaw + Math.PI));                                 // 화면 위 = 앞
  }
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
  // 퍼짐
  const moving = Math.hypot(P.vel.x, P.vel.z) > 0.5;
  let spread = isGun ? 0.018 : (P.crouch ? 0.004 : 0.008) + (moving ? 0.012 : 0) + (P.onGround ? 0 : 0.03);
  // 모바일 조준 보정: 조준선 근처 적에게 살짝 끌림
  if (G.touch) {
    const t = aimAssistTarget(O, D, isGun ? 0.07 : 0.06);
    if (t) { FWD.subVectors(t, O).normalize(); D.lerp(FWD, 0.75).normalize(); spread *= 0.5; }
  }
  D.x += rand(-spread, spread); D.y += rand(-spread, spread); D.z += rand(-spread, spread); D.normalize();
  const wallT = rayBoxes(O, D, 160);
  const hit = raycastEnemies(O, D, wallT);
  const endT = hit ? hit.t : Math.min(wallT, 160);
  HIT.copy(O).addScaledVector(D, endT);
  // 궤적은 총구에서
  const muzzle = muzzlePos();
  tracer(muzzle, HIT, isGun ? [1, 0.7, 0.35] : [1, 0.9, 0.6]);
  muzzleWorld(muzzle, D);
  if (hit) {
    const base = isGun ? 16 : 34 * (1 + G.upgrades.dmg * 0.2);
    hit.enemy.damage(base * hit.mult, HIT, hit.mult > 1.2);
  } else if (wallT < 160) {
    sparks(HIT, 5); puff(HIT, 2, [0.6, 0.5, 0.4, 0.5]);
  }
}
const MZ = new THREE.Vector3();
function muzzlePos() {
  const cam = G.camera;
  if (P.mounted) return MZ.copy(G.gun.barrels.localToWorld(new THREE.Vector3(0, 0, -1.05)));
  return MZ.set(0.17, -0.12, -0.75).applyQuaternion(cam.quaternion).add(cam.position);
}

// ── 매 프레임 ──────────────────────────────────────────
const tmp = new THREE.Vector3();
export function updatePlayer(dt) {
  if (P.dead) return;
  // 시점
  const touchK = 0.0042 * G.sens, mouseK = 0.0024 * G.sens;
  const k = G.touch ? touchK : mouseK;
  P.yaw -= input.lookDX * k; P.pitch -= input.lookDY * k;
  input.lookDX = input.lookDY = 0;
  P.pitch = clamp(P.pitch, -1.35, 1.35);

  // 이동 입력
  let mx = input.mx, my = input.my;
  if (input.keys.KeyW) my = 1; if (input.keys.KeyS) my = -1; if (input.keys.KeyA) mx = -1; if (input.keys.KeyD) mx = 1;
  const L = Math.hypot(mx, my); if (L > 1) { mx /= L; my /= L; }

  if (P.mounted) {
    updateMounted(dt);
  } else {
    const speed = P.crouch ? 2.3 : 4.6;
    const sin = Math.sin(P.yaw), cos = Math.cos(P.yaw);
    const wx = (mx * cos - my * sin) * speed, wz = (-mx * sin - my * cos) * speed;
    const accel = P.onGround ? 14 : 4;
    P.vel.x = damp(P.vel.x, wx, accel, dt); P.vel.z = damp(P.vel.z, wz, accel, dt);

    // 사다리
    const lad = nearLadder();
    if (!P.climbing && lad && (my > 0.35 || input.jump) && P.pos.y < lad.top - 0.3) { P.climbing = lad; sfx('land', { vol: 0.4, rate: 1.3 }); }
    if (P.climbing) {
      const l = P.climbing;
      P.vel.set(0, 3.4, 0);
      P.pos.x = damp(P.pos.x, l.x, 10, dt); P.pos.z = damp(P.pos.z, l.z - l.dir * 0.05, 10, dt);
      P.pos.y += 3.4 * dt;
      if (P.pos.y >= l.top - 0.05) { P.pos.y = l.top + 0.02; P.pos.z += l.dir * 0.75; P.pos.x = clamp(P.pos.x, -1.0, 1.0); P.climbing = null; P.vel.y = 0; }
      if (my < -0.4) { P.climbing = null; }
      input.jump = false;
    } else {
      if (input.jump && P.onGround) { P.vel.y = 7.3; P.onGround = false; sfx('jump_a', { vol: 0.35 }); if (P.crouch) { P.crouch = false; UI.el.btnCrouch.classList.remove('on'); } }
      input.jump = false;
      P.vel.y -= 22 * dt;
      const h = P.crouch ? 1.1 : 1.7;
      const was = P.onGround;
      P.onGround = moveBody(P.pos, P.vel, dt, 0.32, h, 0.45);
      if (P.onGround && !was) sfx('land', { vol: 0.3 });
    }
    // 열차에서 떨어짐
    if (P.pos.y < 0.6 && !onTrain(P.pos.x, P.pos.z) || P.pos.y < 0.3) fellOff();
    // 걷기 흔들림
    const sp = Math.hypot(P.vel.x, P.vel.z);
    if (P.onGround && sp > 0.5) P.bob += dt * sp * 2.2;
  }

  // 카메라
  const eyeT = P.mounted ? 1.25 : P.crouch ? 1.05 : 1.6;
  P.eye = damp(P.eye, eyeT, 12, dt);
  const cam = G.camera;
  const rumble = Math.sin(G.time * 31) * 0.006 + Math.sin(G.time * 13.7) * 0.008;
  const bobY = Math.sin(P.bob * 2) * 0.035, bobX = Math.cos(P.bob) * 0.025;
  cam.position.set(P.pos.x + bobX * Math.cos(P.yaw), P.pos.y + P.eye + bobY + rumble, P.pos.z - bobX * Math.sin(P.yaw));
  P.recoil = damp(P.recoil, 0, 9, dt);
  P.aimKick = damp(P.aimKick, 0, 10, dt);
  let sx = 0, sy = 0;
  if (shake.amp > 0) { sx = (Math.random() - 0.5) * shake.amp * 0.12; sy = (Math.random() - 0.5) * shake.amp * 0.12; }
  cam.rotation.set(P.pitch + P.aimKick + sy, P.yaw + sx, Math.sin(G.time * 1.7) * 0.004 + rumble * 0.3);
  updateSunFollow(P.pos);

  // 무기
  P.fireCd -= dt;
  if (!P.mounted) updateRifle(dt);
  UI.setHp(P.hp, P.maxHp);
  // 체력 자연 회복 (5초간 안 맞으면 60%까지)
  if (G.time - P.lastHurt > 5 && P.hp < P.maxHp * 0.6) P.hp = Math.min(P.maxHp * 0.6, P.hp + 5 * dt);

  // 상호작용: 거치 기관총
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
  // 가까운 객차 바닥으로
  const z = clamp(P.pos.z, -26, 36);
  P.pos.set(0, TRAIN.FLOOR + 0.05, z);
  for (let i = 0; i < 20 && groundAt(0, P.pos.z, 3, 0.3, 0.45) > TRAIN.FLOOR + 0.1; i++) P.pos.z += 0.6;
  P.vel.set(0, 0, 0);
}

function updateRifle(dt) {
  const ready = P.reload <= 0 && P.fireCd <= 0;
  if (P.reload > 0) {
    P.reload -= dt;
    if (P.reload <= 0) { P.ammo = P.mag; sfx('toggle', { vol: 0.5, rate: 0.7 }); }
  } else if (P.firing && ready && G.state === 'play') {
    if (P.ammo > 0) {
      P.ammo--; P.fireCd = 0.6; P.lever = 1; P.recoil = 1; P.aimKick = 0.035;
      shoot(false);
      sfx('blaster', { vol: 0.7, rate: 0.55 }); sfx('impact', { vol: 0.35, rate: 0.6 });
      vmFlash.visible = true; vmFlash.material.rotation = Math.random() * 6; vmFlash.userData.t = 0.05;
      setTimeout(() => sfx('weapon_change', { vol: 0.35, rate: 1.4 }), 260);
      if (P.ammo === 0) setTimeout(startReload, 420);
    } else startReload();
  }
  UI.setAmmo(P.reload > 0 ? '장전 중' : `${P.ammo} / ${P.mag}`);
  // 무기 자세 (반동·레버·장전·흔들림)
  P.lever = damp(P.lever, 0, 5.5, dt);
  const lt = P.lever > 0.02 ? Math.sin((1 - P.lever) * Math.PI) : 0;
  if (lever) lever.rotation.x = lt * 0.9;
  const rl = P.reload > 0 ? Math.sin(Math.min(1, (1.45 - P.reload) / 1.45) * Math.PI) : 0;
  const moveAmt = Math.min(1, Math.hypot(P.vel.x, P.vel.z) / 4.6);
  const h = P.holder;
  h.position.set(0.16 + Math.cos(P.bob) * 0.008 * moveAmt, -0.17 + Math.sin(P.bob * 2) * 0.01 * moveAmt - rl * 0.08 - (P.crouch ? 0.01 : 0), -0.34 + P.recoil * 0.06);
  h.rotation.set(P.recoil * 0.16 + rl * 0.5 + lt * 0.08, -0.04 + rl * 0.25, rl * 0.6 + lt * 0.1);
  if (vmFlash.visible) {
    vmFlash.userData.t -= dt; if (vmFlash.userData.t <= 0) vmFlash.visible = false;
    muzzleRef.getWorldPosition(vmFlash.position);
  }
  UI.setCross((P.crouch ? 0.04 : 0.08) + Math.min(0.2, Math.hypot(P.vel.x, P.vel.z) * 0.03) + P.recoil * 0.15);
}

// ── 거치 기관총 ────────────────────────────────────────
function mount() {
  P.mounted = true; P.holder.visible = false; P.crouch = false;
  P.reload = 0; sfx('toggle', { vol: 0.6 });
  UI.toast('거치 기관총 — 과열 주의');
}
function dismount() {
  P.mounted = false; P.holder.visible = true; sfx('toggle', { vol: 0.6, rate: 0.8 });
  P.pos.set(G.gun.pos.x + 0.9, TRAIN.FLOOR, G.gun.pos.z + 0.6);
}
function updateMounted(dt) {
  const g = G.gun;
  // 사수 위치: 총 뒤 (조준 방향 반대쪽)
  const back = 0.95;
  P.pos.set(g.pos.x + Math.sin(P.yaw) * back, TRAIN.FLOOR, g.pos.z + Math.cos(P.yaw) * back);
  P.vel.set(0, 0, 0);
  g.yaw.rotation.y = P.yaw;
  g.yaw.rotation.x = clamp(P.pitch, -0.5, 0.6);
  const cool = 0.38, perShot = 0.034 * (1 - G.upgrades.cool * 0.25);
  P.heat = Math.max(0, P.heat - cool * dt * (P.firing && !P.overheat ? 0.25 : 1));
  if (P.overheat && P.heat < 0.3) P.overheat = false;
  if (P.firing && !P.overheat && P.fireCd <= 0 && G.state === 'play') {
    P.fireCd = 0.085; P.heat += perShot; P.aimKick = 0.012;
    g.barrels.rotation.z += 0.9;
    shoot(true);
    sfx('blaster', { vol: 0.45, rate: 0.8 + Math.random() * 0.1 });
    if (P.heat >= 1) { P.heat = 1; P.overheat = true; sfx('skid', { vol: 0.5, rate: 1.4 }); UI.toast('과열! 식는 중…'); }
  }
  UI.setHeat(P.heat, true);
  UI.setAmmo(P.overheat ? '과열' : '∞');
  UI.setCross(0.05);
}
export function updateHeatHidden() { if (!P.mounted) UI.setHeat(0, false); }
