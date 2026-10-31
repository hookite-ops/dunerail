// HUD — transform/opacity만 움직인다 (레이아웃 재계산 없음)
import * as THREE from 'three';
import { G } from './state.js';

const $ = (id) => document.getElementById(id);
export const el = new Proxy({}, { get: (_, k) => $(k) });
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

let lastHp = -1, lastLoot = -1, lastAmmo = '', lastScrap = -1, lastRoute = -1, lastHeat = -1;
export function setHp(hp, max) {
  const v = Math.max(0, Math.round(hp)); if (v === lastHp) return; lastHp = v;
  el.hpFill.style.transform = `scaleX(${Math.max(0, hp / max)})`; el.hpTxt.textContent = v;
}
export function setLoot(l) {
  const v = Math.round(l * 100); if (v === lastLoot) return; lastLoot = v;
  el.lootFill.style.transform = `scaleX(${l})`;
  el.lootTxt.textContent = l <= 0 ? '금고 안전' : `약탈 ${v}%`;
}
export function setAmmo(txt) { if (txt === lastAmmo) return; lastAmmo = txt; el.ammoTxt.textContent = txt; }
export function setScrap(n) { if (n === lastScrap) return; lastScrap = n; el.scrapTxt.textContent = n; }
export function setRoute(f) {
  const v = Math.round(f * 400) / 400; if (v === lastRoute) return; lastRoute = v;
  el.routeFill.style.transform = `scaleX(${v})`;
  el.routeTrain.style.transform = `translateX(calc(${v * (el.routeFill.parentElement.clientWidth || 200)}px - 50%))`;
}
export function setWave(t) { el.waveTxt.textContent = t; }
export function setHeat(h, show) {
  el.heatWrap.classList.toggle('hidden', !show);
  const v = Math.round(h * 100) / 100; if (v === lastHeat) return; lastHeat = v;
  el.heatFill.style.transform = `scaleX(${h})`;
}
export function setCross(spread) { el.cross.style.setProperty('--s', `${8 + spread * 120}px`); }

let useCb = null;
export function setUse(label, cb) {
  if (!label) { if (useCb) { el.btnUse.classList.add('hidden'); useCb = null; } return; }
  if (el.btnUse.textContent !== label) el.btnUse.textContent = label;
  el.btnUse.classList.remove('hidden'); useCb = cb;
}
export function triggerUse() { useCb?.(); }

export function toast(text) {
  const t = el.toast; t.textContent = text; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
}
export function hitmarker(kill) {
  el.hitmark.classList.toggle('kill', !!kill);
  el.hitmark.animate([{ opacity: 1, transform: 'scale(1.15)' }, { opacity: 0, transform: 'scale(0.9)' }], { duration: kill ? 320 : 180, easing: EASE });
}
export function hurtFlash(amount, angle) {
  el.vignette.animate([{ opacity: Math.min(0.9, 0.3 + amount / 40) }, { opacity: 0 }], { duration: 600, easing: EASE });
  if (angle !== null && angle !== undefined) {
    el.dmgDir.style.transform = `rotate(${angle}rad)`;
    el.dmgDir.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: EASE });
  }
}
const V = new THREE.Vector3();
export function floater(pos, text, cls = '') {
  V.copy(pos).project(G.camera);
  if (V.z > 1) return;
  const x = (V.x * 0.5 + 0.5) * innerWidth, y = (-V.y * 0.5 + 0.5) * innerHeight;
  const d = document.createElement('div'); d.className = 'floater ' + cls; d.textContent = text;
  el.floaters.appendChild(d);
  const dx = (Math.random() - 0.5) * 30;
  d.animate([
    { transform: `translate(${x}px, ${y}px) translate(-50%, 0) scale(0.9)`, opacity: 0 },
    { transform: `translate(${x + dx * 0.4}px, ${y - 18}px) translate(-50%, 0) scale(1.05)`, opacity: 1, offset: 0.18 },
    { transform: `translate(${x + dx}px, ${y - 46}px) translate(-50%, 0) scale(1)`, opacity: 0 },
  ], { duration: 800, easing: EASE }).onfinish = () => d.remove();
}
export function show(id, on) { el[id].classList.toggle('hidden', !on); }
