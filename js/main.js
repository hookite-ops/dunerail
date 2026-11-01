// DUNE RAIL — 게임 흐름: 로딩 → 출발 → 구간(습격 웨이브·보스) → 역(정비소) → 다음 구간
import * as THREE from 'three';
import { G, TRAIN, clamp, rand, damp } from './state.js';
import { initRenderer, loadModels, buildTrain, updateWorld, trainGroup } from './world.js';
import { initFx, updateFx, resizeFx, sparks } from './fx.js';
import { P, initInput, initPlayer, resetPlayer, updatePlayer, updateHeatHidden } from './player.js';
import { spawnBike, spawnDrones, spawnWalker, updateEnemies, clearEnemies, liveCount, enemies, threats } from './enemies.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as UI from './ui.js';
import { initAudio, sfx, loop, setLoop, suspendAudio } from './audio.js';
import { initMp, openMenu, mpTick, leave as mpLeave, mpPropsVisible } from './mp.js';

const el = UI.el;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
G.sens = 1;   // PC 마우스 감도 (터치 감도는 조작 설정에서)

// ── 부팅 ───────────────────────────────────────────────
initRenderer(el.c);
initFx();
initPost();
const best = parseInt(store.get('dr_best') || '0', 10);
if (best) el.bestTxt.textContent = `최고 기록 · ${best}구간`;
el.btnStart.disabled = true; el.btnMulti.disabled = true;
loadModels((f) => { el.loadTxt.textContent = `짐 싣는 중… ${Math.round(f * 100)}%`; })
  .then(() => {
    buildTrain(); initPlayer(); initInput(); buildStation(); buildPickups();
    resetPlayer(true);
    initMp({ setState, enterMp });
    mpPropsVisible(false);
    el.loadTxt.textContent = ''; el.btnStart.disabled = false; el.btnMulti.disabled = false;
    G.speed = G.targetSpeed;
    requestAnimationFrame(frame);
  })
  .catch((e) => { el.loadTxt.textContent = '불러오기 실패 — 새로고침 해 주세요'; console.error(e); });

// ── 화면 전환 ──────────────────────────────────────────
function setState(s) {
  G.state = s;
  const mp = G.mode === 'mp';
  G.controls?.setVisible(s === 'play' && !(mp && P.dead));
  UI.show('hud', s === 'play' || s === 'pause');
  UI.show('title', s === 'title'); UI.show('pause', s === 'pause'); UI.show('shop', s === 'shop'); UI.show('over', s === 'over');
  UI.show('mpMenu', s === 'mpmenu'); UI.show('mpLobby', s === 'mplobby');
  el.hud.classList.toggle('mp', mp);
  el.btnQuit.textContent = mp ? '방 나가기' : '처음으로';
  if (s === 'title') { G.mode = 'sp'; mpPropsVisible(false); el.hud.classList.remove('mp'); }
  if (s !== 'play' && document.pointerLockElement) document.exitPointerLock?.();
  P.firing = false;
}
async function startRun() {
  await initAudio();
  loop('engine', { vol: 0 }); loop('engine-motorcycle', { vol: 0 });
  try { if (G.touch && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
  try { await screen.orientation?.lock?.('landscape'); } catch {}
  G.mode = 'sp'; UI.resetHud(); P.weapon = 'rifle';
  G.stage = 1; G.scrap = 0; G.totalScrap = 0; G.kills = 0; G.loot = 0;
  G.upgrades = { dmg: 0, mag: 0, hp: 0, vault: 0, cool: 0 };
  startStage();
  resetPlayer(true);
  setState('play');
  sfx('toggle', { vol: 0.6 });
}
function startStage() {
  clearEnemies();
  G.stageTime = 0; G.bossDone = false; G._slowDone = false; G.streak = 0; G.bossAlive = false; G.storm = 0; G.arriving = false; G.departing = G.stage > 1;
  events = makeEvents(G.stage); trickle = 0;
  UI.setWave(`${G.stage}구간 · 출발`);
  UI.toast(G.stage === 1 ? '오아시스 익스프레스 출발! 금고를 지켜라' : `${G.stage}구간 출발 — 습격이 거세진다`);
}
el.btnStart.addEventListener('click', startRun);
el.btnMulti.addEventListener('click', async () => { await initAudio(); openMenu(); });
// 멀티 경기 시작: 싱글 적·역을 치우고 열차만 달린다
function enterMp() {
  clearEnemies();
  loop('engine', { vol: 0 }); loop('engine-motorcycle', { vol: 0 });
  try { if (G.touch && !document.fullscreenElement) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch {}
  try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {}
  station.g.visible = false; station.z = -300; G.arriving = false; G.departing = false; G.storm = 0; G.stormTarget = 0;
  G.speed = G.targetSpeed;
  mpPropsVisible(true);
  setState('play');
}
el.btnPause.addEventListener('click', () => { setState('pause'); if (G.mode !== 'mp') suspendAudio(true); });
let settingsBuilt = false;
const openSettings = () => {
  if (!settingsBuilt && G.controls) {
    settingsBuilt = true;
    G.controls.buildSettings(el.ctrlSettings, { onEditLayout: () => {
      UI.show('pause', false);
      G.controls.openEditor(() => { UI.show('pause', true); G.controls.setVisible(false); });
    } });
  }
};
new MutationObserver(() => { if (!el.pause.classList.contains('hidden')) openSettings(); }).observe(el.pause, { attributes: true, attributeFilter: ['class'] });
el.btnResume.addEventListener('click', () => { setState('play'); suspendAudio(false); });
el.btnQuit.addEventListener('click', () => { suspendAudio(false); if (G.mode === 'mp') { mpLeave(); return; } clearEnemies(); setState('title'); });
el.btnRetry.addEventListener('click', startRun);
el.btnHome.addEventListener('click', () => { clearEnemies(); setState('title'); });
el.sfxToggle.addEventListener('change', () => { G.sfx = el.sfxToggle.checked; });
el.btnDepart.addEventListener('click', () => { G.stage++; startStage(); setState('play'); sfx('toggle'); });
addEventListener('keydown', (e) => { if (e.target?.tagName === 'INPUT') return; if (e.code === 'Escape' || e.code === 'KeyP') { if (G.state === 'play') { setState('pause'); if (G.mode !== 'mp') suspendAudio(true); } else if (G.state === 'pause') { setState('play'); suspendAudio(false); } } });
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play' && G.mode !== 'mp') { setState('pause'); suspendAudio(true); } });
addEventListener('resize', onResize);
function onResize() {
  const w = innerWidth, h = innerHeight;
  G.renderer.setSize(w, h, false);
  G.camera.aspect = w / h; G.camera.updateProjectionMatrix();
  G.vmCamera.aspect = w / h; G.vmCamera.updateProjectionMatrix();
  resizeFx();
  composer?.setSize(w, h); bloom?.resolution.set(w / 2, h / 2);
}

// ── 웨이브 ─────────────────────────────────────────────
let events = [], trickle = 0; const threatList = [];
function makeEvents(stage) {
  const x = stage - 1;
  const b = (n) => () => { for (let i = 0; i < n + Math.floor(x * 0.7); i++) setTimeout(() => G.state !== 'title' && spawnBike(i % 2 ? 1 : -1), i * 900); };
  const d = (n) => () => spawnDrones(n + x);
  const w = () => spawnWalker();
  const say = (t) => () => UI.setWave(`${G.stage}구간 · ${t}`);
  return [
    { t: 2, f: [say('산적 출현'), b(2)] },
    { t: 12, f: [b(1)] },
    { t: 24, f: [b(2)] },
    { t: 38, f: [say('드론 떼'), d(4)] },
    { t: 55, f: [say('보행 전차'), w, b(1)] },
    { t: 76, f: [say('산적 습격대'), b(3)] },
    { t: 92, f: [say('모래폭풍'), () => { G.stormTarget = 1; UI.toast('모래폭풍! 시야가 줄어든다'); }, d(5), b(2)] },
    { t: 112, f: [w, b(2), ...(stage >= 2 ? [w] : [])] },
    { t: 128, f: [() => { G.stormTarget = 0; }, say('폭풍이 걷힌다')] },
    { t: 140, f: [d(4), b(2)] },
    { t: 152, f: [say('보스'), () => spawnWalker(-1, true)] },
  ].map((e) => ({ ...e, done: false }));
}
function updateWaves(dt) {
  G.stageTime += dt;
  for (const e of events) if (!e.done && G.stageTime >= e.t) { e.done = true; e.f.forEach((f) => f()); }
  // 상시 견제: 바이크가 적으면 한 대씩
  if (G.stageTime > 30 && !G.arriving) {
    trickle -= dt;
    const bikes = enemies.filter((e) => e.constructor.name === 'Bike' && e.alive).length;
    if (trickle <= 0 && bikes < 1 + Math.min(3, G.stage)) { trickle = Math.max(6, 14 - G.stage * 2); spawnBike(); }
  }
  G.storm = damp(G.storm, G.stormTarget || 0, 0.6, dt);
  // 역 도착
  if (G.bossDone && !G.arriving && liveCount() === 0) { G.arriving = true; station.z = -150; station.g.visible = true; UI.toast('모래바람 역이 보인다!'); UI.setWave(`${G.stage}구간 · 역 도착`); }
  const prog = G.arriving ? 1 - Math.max(0, -station.z) / 150 * 0.08 : Math.min(G.stageTime / 155, 0.92);
  UI.setRoute(clamp(prog, 0, 1));
}

// ── 역 ─────────────────────────────────────────────────
const station = { g: new THREE.Group(), z: -300 };
function buildStation() {
  const g = station.g;
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.9, map: G.trainMats.floor.map });
  const red = G.trainMats.caboose, roof = G.trainMats.roof;
  const plat = new THREE.Mesh(new THREE.BoxGeometry(5, 1.0, 70), wood); plat.position.set(5.2, 0.5, 0); g.add(plat);
  const house = new THREE.Mesh(new THREE.BoxGeometry(6, 4.5, 12), red); house.position.set(10, 3.25, -4); g.add(house);
  const hr = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.4, 14), roof); hr.position.set(9.6, 5.7, -4); g.add(hr);
  const tower = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3.2, 16), wood); tank.position.y = 7; tower.add(tank);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.4, 16), roof); cap.position.y = 9.3; tower.add(cap);
  for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.25, 5.6, 0.25), wood); l.position.set(x, 2.8, z); tower.add(l); }
  tower.position.set(9, 0, 22); g.add(tower);
  const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d');
  x.fillStyle = '#f2d39a'; x.fillRect(0, 0, 512, 128); x.fillStyle = '#5a2414'; x.font = '900 64px "Black Han Sans", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('모래바람 역', 256, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshStandardMaterial({ map: t })); sign.position.set(6.95, 4.6, -4); sign.rotation.y = -Math.PI / 2; g.add(sign);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  g.visible = false; G.scene.add(g);
}
function updateStation(dt) {
  if (G.arriving) {
    // 남은 거리에 맞춰 감속해 역 앞에 정확히 멈춤
    const remain = Math.max(0, -station.z);
    const v = Math.sqrt(2 * 2.0 * remain);
    G.speed = Math.min(G.speed, v + 0.3);
    if (remain < 0.4 && G.state === 'play') { G.speed = 0; arrive(); }
  } else if (G.departing) {
    G.speed = damp(G.speed, G.targetSpeed, 0.35, dt);
    if (station.z > 200) { station.g.visible = false; G.departing = false; }
  } else G.speed = damp(G.speed, G.targetSpeed + (G.stage - 1) * 2, 0.5, dt);
  station.z += G.speed * dt;
  station.g.position.z = station.z;
}
function arrive() {
  clearEnemies();
  G.loot = Math.max(0, G.loot - 0.15);
  store.set('dr_best', Math.max(parseInt(store.get('dr_best') || '0', 10), G.stage));
  openShop();
}

// ── 정비소 ─────────────────────────────────────────────
const SHOP = [
  { k: 'dmg', t: '강선 총열', d: '레버액션 소총 피해 +20%', cost: (l) => 60 + l * 45, max: 5 },
  { k: 'mag', t: '확장 탄창', d: '탄창 +3발', cost: (l) => 50 + l * 40, max: 4 },
  { k: 'hp', t: '방탄 조끼', d: '최대 체력 +25', cost: (l) => 70 + l * 50, max: 4 },
  { k: 'vault', t: '금고 철판', d: '산적의 약탈 속도 -20%', cost: (l) => 60 + l * 45, max: 3 },
  { k: 'cool', t: '냉각 재킷', d: '거치 기관총 과열 -25%', cost: (l) => 45 + l * 40, max: 3 },
  { k: 'repair', t: '금고 보수', d: '약탈 게이지 -50%', cost: () => 25, once: true },
  { k: 'heal', t: '붕대와 물', d: '체력을 전부 회복', cost: () => 15, once: true },
];
function openShop() {
  setState('shop');
  el.shopEyebrow.textContent = `${G.stage}구간 완주 · 처치 ${G.kills}`;
  renderShop();
}
function renderShop() {
  el.shopScrap.textContent = G.scrap;
  el.shopList.innerHTML = '';
  SHOP.forEach((it, i) => {
    const lvl = it.once ? 0 : G.upgrades[it.k];
    const maxed = !it.once && lvl >= it.max;
    const useless = (it.k === 'repair' && G.loot <= 0) || (it.k === 'heal' && P.hp >= P.maxHp);
    const cost = it.cost(lvl);
    const b = document.createElement('button');
    b.className = 'shop-item'; b.style.animationDelay = `${i * 40}ms`;
    b.innerHTML = `<span class="t">${it.t}<i>${it.once ? '' : `Lv ${lvl}/${it.max}`}</i></span><span class="d">${it.d}</span><span class="c">${maxed ? '최대' : useless ? '필요 없음' : `${cost} ⚙`}</span>`;
    if (maxed || useless || G.scrap < cost) b.setAttribute('disabled', '');
    b.addEventListener('click', () => {
      if (G.scrap < cost) return;
      G.scrap -= cost; sfx('coin', { vol: 0.7 });
      if (it.k === 'repair') G.loot = Math.max(0, G.loot * 0.5 - 0.01);
      else if (it.k === 'heal') P.hp = P.maxHp;
      else { G.upgrades[it.k]++; if (it.k === 'hp') { P.maxHp += 25; P.hp += 25; } if (it.k === 'mag') { P.mag += 3; P.ammo = P.mag; } }
      UI.setScrap(G.scrap); UI.setLoot(G.loot);
      renderShop();
    });
    el.shopList.appendChild(b);
  });
}

// ── 수리 키트 ──────────────────────────────────────────
const kits = [];
function buildPickups() {
  for (const p of G.map.pickups) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.3), new THREE.MeshStandardMaterial({ color: 0xe9e2d0, roughness: 0.6 }));
    const crossM = new THREE.MeshStandardMaterial({ color: 0xc8322a, emissive: 0x551008 });
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.32), crossM), c2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.32), crossM);
    g.add(box, c1, c2); g.position.set(p.x, TRAIN.FLOOR + 0.45, p.z);
    trainGroup.add(g); kits.push({ g, x: p.x, z: p.z, cd: 0 });
  }
}
function updatePickups(dt) {
  for (const k of kits) {
    k.cd -= dt; k.g.visible = k.cd <= 0;
    k.g.rotation.y += dt * 1.5; k.g.position.y = TRAIN.FLOOR + 0.5 + Math.sin(G.time * 3) * 0.06;
    if (k.cd <= 0 && P.hp < P.maxHp && Math.hypot(P.pos.x - k.x, P.pos.z - k.z) < 0.8 && Math.abs(P.pos.y - TRAIN.FLOOR) < 0.5) {
      P.hp = Math.min(P.maxHp, P.hp + 45); k.cd = 35; sfx('coin', { vol: 0.6, rate: 0.8 }); UI.toast('수리 키트 +45');
    }
  }
}

// ── 종료 ───────────────────────────────────────────────
function gameOver(reason) {
  setState('over');
  el.overTitle.textContent = reason === 'loot' ? '금고를 빼앗겼다' : '사막에 쓰러졌다';
  el.overEyebrow.textContent = `${G.stage}구간에서 런 종료`;
  el.overStats.innerHTML = `<span>도달 구간</span><b>${G.stage}</b><span>처치</span><b>${G.kills}</b><span>모은 고철</span><b>${G.totalScrap} ⚙</b>`;
  store.set('dr_best', Math.max(parseInt(store.get('dr_best') || '0', 10), G.stage - 1));
  setLoop('engine-motorcycle', 0);
}

// ── 루프 ───────────────────────────────────────────────
let last = performance.now(), perfAcc = 0, perfN = 0, dpr = G.renderer.getPixelRatio();
const dprMax = dpr;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (G.bossDone && !G._slowDone) { G._slowDone = true; G.slowT = 1.4; UI.toast('철갑 거상 격파!'); }
  if (G.slowT > 0) { G.slowT -= dt; dt *= 0.3; }
  if (G.hitstop > 0) { G.hitstop -= dt; dt *= 0.12; }   // 처치 순간 아주 짧게 멈칫
  tick(dt);
  render();
  // 적응형 해상도: 프레임이 밀리면 픽셀 비율을 낮춘다
  perfAcc += dt; perfN++;
  if (perfAcc > 2.5) {
    const avg = perfAcc / perfN; perfAcc = 0; perfN = 0;
    if (avg > 1 / 44 && fxOn && dpr <= 1.0) { fxOn = false; }
    else if (avg > 1 / 44 && dpr > 0.75) { dpr = Math.max(0.75, dpr - 0.15); G.renderer.setPixelRatio(dpr); onResize(); }
    else if (avg < 1 / 57 && dpr < dprMax) { dpr = Math.min(dprMax, dpr + 0.1); G.renderer.setPixelRatio(dpr); onResize(); }
  }
}
function tick(dt) {
  G.dt = dt;
  if (G.mode === 'mp' && (G.state === 'play' || G.state === 'pause')) {   // 멀티는 일시정지 화면에서도 계속 돈다
    G.time += dt;
    G.speed = damp(G.speed, G.targetSpeed, 0.5, dt);
    updateWorld(dt);
    updatePlayer(dt);
    mpTick(dt);
    updateHeatHidden();
    setLoop('engine', 0.22 * (G.speed / 24), 0.45 + G.speed / 60);
    updateFx(dt);
    return;
  }
  const playing = G.state === 'play';
  if (G.state !== 'pause') {
    G.time += dt;
    updateStation(playing ? dt : dt);
    updateWorld(dt);
    if (playing) {
      updateWaves(dt);
      updatePlayer(dt);
      updateEnemies(dt);
      updatePickups(dt);
      updateHeatHidden();
      UI.setLoot(G.loot); UI.setScrap(G.scrap);
      UI.indicators(threats(threatList));
      if (grade) { grade.uniforms.uStorm.value = G.storm; }
      if (P.dead) gameOver('hp');
      else if (G.loot >= 1) gameOver('loot');
      // 소리
      setLoop('engine', 0.22 * (G.speed / 24), 0.45 + G.speed / 60);
      let nb = 99; for (const e of enemies) if (e.constructor.name === 'Bike' && e.state !== 'crash') nb = Math.min(nb, Math.hypot(e.x - P.pos.x, e.z - P.pos.z));
      setLoop('engine-motorcycle', nb < 60 ? 0.28 * (1 - nb / 60) : 0, 1.1);
    } else {
      // 타이틀 화면: 열차 옆을 천천히 도는 카메라
      const a = G.time * 0.08;
      G.camera.position.set(Math.sin(a) * 16 + 6, 6 + Math.sin(a * 0.7) * 1.5, Math.cos(a) * 22 - 8);
      G.camera.lookAt(0, 2.5, -8);
      setLoop('engine', 0.08, 0.5); setLoop('engine-motorcycle', 0);
    }
    updateFx(dt);
  }
}
// 테스트용: 렌더 없이 게임 시간을 빨리 돌림
window.__sim = (sec, step = 1 / 30) => { for (let t = 0; t < sec; t += step) tick(step); };
// ── 후처리: 블룸(반해상도) + 색보정·비네트 ─────────────
var composer, bloom, grade, fxOn = true;
function initPost() {
  const r = G.renderer;
  composer = new EffectComposer(r);
  composer.addPass(new RenderPass(G.scene, G.camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.32, 0.55, 0.88);
  composer.addPass(bloom);
  grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uHurt: { value: 0 }, uStorm: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uHurt, uStorm; varying vec2 vUv;
      void main(){ vec4 c = texture2D(tDiffuse, vUv);
        float l = dot(c.rgb, vec3(0.299,0.587,0.114));
        c.rgb = mix(vec3(l), c.rgb, 1.08);                                   // 채도 살짝
        c.rgb = c.rgb * vec3(1.04, 1.0, 0.94);                               // 따뜻한 색
        c.rgb = (c.rgb - 0.5) * 1.06 + 0.5;                                  // 대비
        vec2 d = vUv - 0.5; float v = smoothstep(0.85, 0.25, length(d * vec2(1.0, 0.8)));
        c.rgb *= mix(0.72, 1.0, v);
        c.rgb = mix(c.rgb, vec3(0.75, 0.52, 0.34), uStorm * 0.12);
        gl_FragColor = c; }`,
  });
  composer.addPass(grade);
  composer.addPass(new OutputPass());
}
function render() {
  const r = G.renderer;
  if (fxOn && composer) { r.autoClear = true; composer.render(); r.autoClear = false; }
  else { r.clear(); r.render(G.scene, G.camera); }
  if ((G.state === 'play' || G.state === 'pause') && !P.mounted && !P.dead) { r.clearDepth(); r.render(G.vmScene, G.vmCamera); }
}
setState('title');
window.__G = G;
