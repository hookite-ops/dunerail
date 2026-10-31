// 공유 상태와 작은 도우미
export const G = {
  scene: null, camera: null, renderer: null,
  vmScene: null, vmCamera: null,         // 1인칭 무기 전용 장면 (벽에 안 파묻힘)
  map: null, boxes: [], ladders: [],
  models: {},
  time: 0, dt: 0,
  speed: 0, targetSpeed: 24,              // 사막이 흘러가는 속도 (m/s)
  state: 'title',                          // title | play | pause | shop | over
  stage: 1, stageTime: 0, stageLen: 170,
  scrap: 0, kills: 0, totalScrap: 0,
  loot: 0,                                 // 금고 약탈 진행 0..1
  storm: 0,                                // 모래폭풍 강도 0..1
  bossAlive: false, bossDone: false,
  upgrades: { dmg: 0, mag: 0, hp: 0, vault: 0, cool: 0 },
  sens: 1, sfx: true,
  touch: matchMedia('(pointer: coarse)').matches,
};

export const TRAIN = {
  FLOOR: 1.2, ROOF: 4.2, W: 3.0, L: 12, GAP: 1.4,
  carZ(i) { const z0 = -40 + i * 13.4; return [z0, z0 + 12]; },
  jx(j) { return j % 2 === 0 ? 0.4 : -0.4; },
  front: -40, back: 39,
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
