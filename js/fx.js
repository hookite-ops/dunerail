// 파티클·궤적·폭발·화면 흔들림
import * as THREE from 'three';
import { G, rand } from './state.js';
import { tex } from './world.js';

class Particles {
  constructor(n, blending) {
    this.n = n; this.i = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 4); this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.grow = new Float32Array(n); this.drag = new Float32Array(n); this.grav = new Float32Array(n); this.base = new Float32Array(n * 4);
    this.wind = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcol', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending,
      uniforms: { map: { value: tex('dot') }, scale: { value: innerHeight * 0.5 } },
      vertexShader: `attribute float size; attribute vec4 pcol; varying vec4 vC; uniform float scale;
        void main(){ vC = pcol; vec4 mv = modelViewMatrix*vec4(position,1.); gl_PointSize = size*scale/ -mv.z; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vC; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC.rgb, vC.a*t.a); if (gl_FragColor.a < 0.01) discard; }`,
    });
    this.mat = mat;
    this.points = new THREE.Points(g, mat); this.points.frustumCulled = false;
    G.scene.add(this.points);
  }
  emit(p, v, { life = 1, size = 0.5, grow = 1, color = [1, 1, 1, 1], drag = 1, grav = 0, wind = 0 }) {
    const i = this.i; this.i = (this.i + 1) % this.n;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.grow[i] = grow; this.drag[i] = drag; this.grav[i] = grav; this.wind[i] = wind;
    this.base.set(color, i * 4);
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += (this.vel[i * 3 + 2] + this.wind[i] * G.speed) * dt;
      this.size[i] += this.grow[i] * dt;
      const t = Math.max(this.life[i] / this.max[i], 0);
      this.col[i * 4] = this.base[i * 4]; this.col[i * 4 + 1] = this.base[i * 4 + 1]; this.col[i * 4 + 2] = this.base[i * 4 + 2];
      this.col[i * 4 + 3] = this.base[i * 4 + 3] * Math.min(1, t * 1.6);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.pcol.needsUpdate = g.attributes.size.needsUpdate = true;
  }
}

let soft, glow, tracers, flashLight, streaks;
const tr = [];
export const shake = { t: 0, amp: 0 };

export function initFx() {
  soft = new Particles(700, THREE.NormalBlending);
  glow = new Particles(400, THREE.AdditiveBlending);
  // 탄 궤적
  const n = 40, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 8), 4));
  tracers = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  tracers.frustumCulled = false; G.scene.add(tracers);
  for (let i = 0; i < n; i++) tr.push({ life: 0 });
  flashLight = new THREE.PointLight(0xffb060, 0, 14, 2); G.scene.add(flashLight);
  // 속도감 바람 줄
  const m = 70, sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 6), 3));
  streaks = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xfff0d8, transparent: true, opacity: 0.22, depthWrite: false }));
  streaks.frustumCulled = false; streaks.userData.items = Array.from({ length: m }, () => ({ x: rand(-14, 14), y: rand(0.3, 8), z: rand(-40, 40), l: rand(1.5, 4) }));
  G.scene.add(streaks);
}
export function resizeFx() { for (const p of [soft, glow]) if (p) p.mat.uniforms.scale.value = innerHeight * 0.5; }

const V = new THREE.Vector3();
export function tracer(a, b, color = [1, 0.85, 0.5]) {
  const i = tr.findIndex((t) => t.life <= 0); if (i < 0) return;
  const t = tr[i]; t.life = 0.09; t.max = 0.09; t.a = a.clone(); t.b = b.clone(); t.c = color;
}
export function muzzleWorld(p, dir) {
  for (let i = 0; i < 4; i++) glow.emit(p, V.copy(dir).multiplyScalar(rand(2, 6)).add({ x: rand(-1, 1), y: rand(-1, 1), z: rand(-1, 1) }), { life: 0.08, size: rand(0.25, 0.45), grow: -1, color: [1, 0.7, 0.3, 1], drag: 6 });
  flash(p, 3, 0.06);
}
export function flash(p, intensity, dur) { flashLight.position.copy(p); flashLight.intensity = intensity; flashLight.userData.t = dur; }
export function sparks(p, n = 8, color = [1, 0.75, 0.35, 1]) {
  for (let i = 0; i < n; i++) glow.emit(p, { x: rand(-4, 4), y: rand(0, 5), z: rand(-4, 4) }, { life: rand(0.2, 0.45), size: rand(0.06, 0.12), grow: -0.1, color, drag: 2, grav: 12 });
}
export function puff(p, n = 6, color = [0.85, 0.68, 0.5, 0.55]) {
  for (let i = 0; i < n; i++) soft.emit(p, { x: rand(-0.8, 0.8), y: rand(0.2, 1.2), z: rand(-0.8, 0.8) }, { life: rand(0.5, 1.0), size: rand(0.3, 0.6), grow: 1.4, color, drag: 2 });
}
export function blood(p) { // 피 대신 모래먼지+천 조각 느낌
  for (let i = 0; i < 6; i++) soft.emit(p, { x: rand(-2, 2), y: rand(0, 2.5), z: rand(-2, 2) }, { life: 0.4, size: rand(0.1, 0.22), grow: 0.5, color: [0.6, 0.35, 0.22, 0.85], drag: 3, grav: 6 });
}
export function dust(p, wind = 0.9) {
  soft.emit(p, { x: rand(-0.6, 0.6), y: rand(0.3, 1.2), z: rand(-0.5, 0.5) }, { life: rand(0.7, 1.3), size: rand(0.5, 1.0), grow: 2.2, color: [0.86, 0.66, 0.45, 0.42], drag: 1, wind });
}
export function smoke(p, wind = 0.6) {
  soft.emit(p, { x: rand(-0.3, 0.3), y: rand(1.5, 3), z: rand(-0.3, 0.3) }, { life: rand(1.4, 2.4), size: rand(0.6, 1.0), grow: 1.8, color: [0.25, 0.22, 0.2, 0.5], drag: 0.6, wind });
}
export function explosion(p, scale = 1) {
  for (let i = 0; i < 26 * scale; i++) glow.emit(p, { x: rand(-6, 6) * scale, y: rand(0, 7) * scale, z: rand(-6, 6) * scale }, { life: rand(0.25, 0.55), size: rand(0.7, 1.5) * scale, grow: 2, color: [1, rand(0.45, 0.7), 0.2, 1], drag: 4 });
  for (let i = 0; i < 18 * scale; i++) soft.emit(p, { x: rand(-3, 3) * scale, y: rand(1, 5) * scale, z: rand(-3, 3) * scale }, { life: rand(0.9, 1.8), size: rand(0.8, 1.6) * scale, grow: 2.5, color: [0.28, 0.22, 0.18, 0.7], drag: 1.6, wind: 0.5 });
  sparks(p, 14 * scale);
  flash(p, 30 * scale, 0.18);
  const d = G.camera.position.distanceTo(p);
  addShake(Math.max(0, 0.5 - d * 0.02) * scale);
}
export function addShake(a) { shake.amp = Math.max(shake.amp, a); shake.t = 0.35; }

export function updateFx(dt) {
  soft.update(dt); glow.update(dt);
  const pos = tracers.geometry.attributes.position.array, col = tracers.geometry.attributes.color.array;
  for (let i = 0; i < tr.length; i++) {
    const t = tr[i];
    if (t.life > 0) {
      t.life -= dt; const k = Math.max(t.life / t.max, 0);
      pos.set([t.a.x, t.a.y, t.a.z, t.b.x, t.b.y, t.b.z], i * 6);
      col.set([...t.c, 0.0, ...t.c, k], i * 8);
    } else col[i * 8 + 7] = col[i * 8 + 3] = 0;
  }
  tracers.geometry.attributes.position.needsUpdate = tracers.geometry.attributes.color.needsUpdate = true;
  if (flashLight.userData.t > 0) { flashLight.userData.t -= dt; if (flashLight.userData.t <= 0) flashLight.intensity = 0; }
  // 바람 줄
  const sp = streaks.geometry.attributes.position.array, cam = G.camera.position;
  streaks.material.opacity = 0.08 + Math.min(G.speed / 24, 1) * 0.16 + G.storm * 0.2;
  streaks.userData.items.forEach((s, i) => {
    s.z += (G.speed * 1.6 + 6) * dt;
    if (s.z > 30) { s.z = rand(-60, -30); s.x = rand(-14, 14); s.y = rand(0.3, 8); }
    const x = cam.x + s.x, z = cam.z + s.z, y = s.y;
    sp.set([x, y, z, x, y, z + s.l * (0.3 + G.speed / 24)], i * 6);
  });
  streaks.geometry.attributes.position.needsUpdate = true;
  // 모래폭풍 먼지
  if (G.storm > 0.05) for (let i = 0; i < 3 * G.storm; i++) soft.emit({ x: cam.x + rand(-12, 12), y: rand(0.2, 5), z: cam.z + rand(-25, 5) }, { x: rand(2, 6), y: 0, z: 0 }, { life: 1.4, size: rand(1.5, 3), grow: 2, color: [0.82, 0.6, 0.4, 0.18 * G.storm], drag: 0, wind: 0.7 });
  if (shake.t > 0) { shake.t -= dt; if (shake.t <= 0) shake.amp = 0; }
}
// 탄피: 놋쇠 빛 작은 조각이 오른쪽으로 튐
export function brass(p, v) {
  glow.emit(p, v, { life: 0.5, size: 0.035, grow: 0, color: [1, 0.78, 0.35, 1], drag: 0.6, grav: 14 });
}
// 사람 피격: 천 조각·모래 먼지 (멀티)
export function hitPuff(p, head) {
  for (let i = 0; i < (head ? 12 : 7); i++) soft.emit(p, { x: rand(-2.2, 2.2), y: rand(0, 2.8), z: rand(-2.2, 2.2) }, { life: 0.45, size: rand(0.1, 0.24), grow: 0.6, color: head ? [0.72, 0.18, 0.12, 0.9] : [0.6, 0.35, 0.22, 0.85], drag: 3, grav: 6 });
  if (head) sparks(p, 5, [1, 0.9, 0.5, 1]);
}
