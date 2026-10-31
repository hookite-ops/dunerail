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
export function setAmmo(txt) { if (txt === lastAmmo) return; lastAmmo = txt; G.controls?.setBadge('fire', txt); G.controls?.setBadge('leftFire', txt.split(' ')[0]); }
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
export function streak(n, bonus) {
  const t = el.streak; t.textContent = n >= 5 ? `무법자 사냥 ×${n}  +${bonus}⚙` : `${n}연속 처치  +${bonus}⚙`;
  t.animate([{ opacity: 0, transform: 'translate(-50%, 6px) scale(0.96)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1.04)', offset: 0.15 },
    { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.75 }, { opacity: 0, transform: 'translate(-50%, -4px) scale(1)' }], { duration: 1400, easing: EASE });
}
// 화면 밖 위협 화살표 (요소를 재사용, transform만 바꿈)
const arrows = [];
const ICON = { boarder: '🤠', loot: '💰', walker: '⚙', shell: '💥' };
export function indicators(list) {
  const cam = G.camera, w = innerWidth, h = innerHeight, cx = w / 2, cy = h / 2;
  let k = 0;
  for (const t of list) {
    V.copy(t.p).project(cam);
    const behind = V.z > 1;
    let x = V.x, y = V.y;
    if (behind) { x = -x; y = -y; }
    if (!behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.88) continue;   // 화면 안이면 표시 안 함
    if (t.kind === 'shell' && t.p.distanceTo(cam.position) > 30) continue;
    const a = Math.atan2(-y, x);
    const r = Math.min((w * 0.5 - 46) / Math.abs(Math.cos(a) || 1e-3), (h * 0.5 - 46) / Math.abs(Math.sin(a) || 1e-3));
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    let d = arrows[k];
    if (!d) { d = document.createElement('div'); d.className = 'ind'; d.innerHTML = '<i></i><b></b>'; el.indicators.appendChild(d); arrows[k] = d; }
    d.className = 'ind ' + t.kind;
    d.style.transform = `translate(${px}px, ${py}px)`;
    d.firstChild.style.transform = `rotate(${a}rad)`;
    if (d.lastChild.textContent !== ICON[t.kind]) d.lastChild.textContent = ICON[t.kind];
    d.style.display = '';
    if (++k >= 8) break;
  }
  for (; k < arrows.length; k++) arrows[k].style.display = 'none';
}
export function setCharges(n, cd) {
  G.controls?.setBadge('grenade', n);
  G.controls?.setCooldown('grenade', n <= 0 ? Math.max(cd, 0.02) : 0);
  G.controls?.setDisabled('grenade', n <= 0);
}
export function show(id, on) { el[id].classList.toggle('hidden', !on); }
