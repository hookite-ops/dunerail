// 효과음 — Kenney CC0 음원(assets/sfx). 피치·음량을 바꿔 여러 소리로 재활용한다.
import { G } from './state.js';

let ctx = null, master = null;
const buf = {};
const loops = {};
const FILES = ['blaster', 'coin', 'enemy_attack', 'enemy_destroy', 'enemy_hurt', 'engine-motorcycle', 'engine',
  'impact', 'jump_a', 'land', 'skid', 'toggle', 'weapon_change'];

export async function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
  await Promise.all(FILES.map(async (f) => {
    try {
      const r = await fetch(`assets/sfx/${f}.ogg`);
      buf[f] = await ctx.decodeAudioData(await r.arrayBuffer());
    } catch (e) { /* 소리 없이도 게임은 돈다 */ }
  }));
}

export function sfx(name, { vol = 1, rate = 1, jitter = 0.06, pan = 0 } = {}) {
  if (!ctx || !G.sfx || !buf[name]) return;
  const s = ctx.createBufferSource();
  s.buffer = buf[name];
  s.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
  const g = ctx.createGain(); g.gain.value = vol;
  let node = g;
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
  s.connect(g); node.connect(master);
  s.start();
}

// 거리·방향으로 음량과 좌우를 정하는 3D 근사
export function sfxAt(name, pos, opts = {}) {
  if (!G.camera) return sfx(name, opts);
  const c = G.camera.position;
  const dx = pos.x - c.x, dz = pos.z - c.z;
  const d = Math.hypot(dx, pos.y - c.y, dz);
  const vol = (opts.vol ?? 1) * Math.min(1, 6 / (d + 3));
  if (vol < 0.03) return;
  const yaw = G.camera.rotation.y;
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const pan = Math.max(-0.8, Math.min(0.8, (dx * right.x + dz * right.z) / (d + 0.01)));
  sfx(name, { ...opts, vol, pan });
}

export function loop(name, { vol = 0.3, rate = 1 } = {}) {
  if (!ctx || !buf[name]) return null;
  if (loops[name]) return loops[name];
  const s = ctx.createBufferSource(); s.buffer = buf[name]; s.loop = true; s.playbackRate.value = rate;
  const g = ctx.createGain(); g.gain.value = 0;
  s.connect(g); g.connect(master); s.start();
  loops[name] = { s, g, target: vol };
  return loops[name];
}
export function setLoop(name, vol, rate) {
  const l = loops[name]; if (!l || !ctx) return;
  l.g.gain.setTargetAtTime(G.sfx ? vol : 0, ctx.currentTime, 0.25);
  if (rate) l.s.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.3);
}
export function suspendAudio(on) { if (!ctx) return; on ? ctx.suspend() : ctx.resume(); }
