// mfc.js — Mobile FPS Controls (CoD Mobile / Delta Force Mobile 급 터치 조작)
// 엔진 독립: three.js 없이 동작. 게임은 매 프레임 update(dt, view)를 부르고 결과(시점 변화·이동·버튼 상태·이벤트)를 쓴다.
// 각도 규약(three.js): yaw +는 왼쪽으로 돎, pitch +는 위를 봄, 정면 = (-sin yaw, 0, -cos yaw)
//
// 핵심 설계
//  · 화면 전체를 덮는 터치 레이어 1장이 모든 손가락을 받아 '눌린 위치'로 컨트롤을 정한다(히트테스트).
//    → 버튼 위에서 시작한 손가락도 계속 끌면 조준이 된다(발사 누른 채 조준). 손가락마다 독립 추적.
//  · 버튼 그림은 pointer-events:none. 움직이는 건 transform/opacity만.
//  · 같은 x/y 줄에 놓인 두 버튼을 동시에 누르면 씹히는 기기(갤럭시탭 등)가 있어 편집기가 줄 겹침을 검사·자동 정리한다.

const STORE_SET = 'mfc_settings_v1', STORE_LAY = 'mfc_layout_v1';
export const DEFAULT_SETTINGS = {
  sens: 1.0,          // 시점 감도 (기준: 1px = 0.0042rad)
  adsSens: 0.8,       // 정조준 감도 배율 (FOV 비율에 곱해짐)
  accel: 0.6,         // 시점 가속: 빠르게 휙 = 최대 1+accel 배
  gyro: 'off',        // off | ads | always
  gyroSens: 1.0, gyroInvX: false, gyroInvY: false,
  invertY: false,
  aimAssist: true,
  fireMode: 'advanced',   // advanced(버튼) | simple(조준선이 적에 닿으면 자동 사격)
  adsMode: 'tap',         // tap(토글) | hold
  crouchMode: 'tap',      // tap | hold
  leftFire: true,
  haptics: true,
  opacity: 0.85,
};
// 위치 = 화면 비율(가로 x, 세로 y), s = 기준 지름(px, 화면 크기로 배율). 오른쪽 버튼은 x·y가 서로 모두 다른 줄에 오도록 계단식 배치.
export const DEFAULT_LAYOUT = {
  reload:   { x: 0.665, y: 0.14, s: 52 },
  ads:      { x: 0.94,  y: 0.265, s: 58 },
  leftFire: { x: 0.10,  y: 0.39, s: 64 },
  grenade:  { x: 0.72,  y: 0.515, s: 58 },
  fire:     { x: 0.885, y: 0.64, s: 96 },
  jump:     { x: 0.775, y: 0.765, s: 62 },
  crouch:   { x: 0.83,  y: 0.89, s: 58 },
  stick:    { x: 0.16,  y: 0.70, s: 136 },
};
const ICON = {
  fire: '<path d="M12 2.5c2.2 2 3.2 5 3.2 8v8.5H8.8V10.5c0-3 1-6 3.2-8z"/><path d="M7.5 21.5h9"/>',
  ads: '<circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  jump: '<path d="M5.5 13.5l6.5-6.5 6.5 6.5M5.5 20l6.5-6.5 6.5 6.5"/>',
  crouch: '<circle cx="13" cy="4.5" r="2.2"/><path d="M12.5 7.5l-1.5 5.5 4.5 2.5v5.5M11 13l-4.5 2 1 5.5M8.5 9.5l4-2 3.5 3"/>',
  slide: '<circle cx="17" cy="6" r="2.2"/><path d="M15 9l-4 4-6 1M11 13l5 2 4 5M3 20h18"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v5h-5"/>',
  grenade: '<rect x="6" y="9" width="12" height="12" rx="2.5"/><path d="M9 9V6.5h6V9M12 6.5c0-2 1.5-3.5 3.5-3.5"/><path d="M17 2.5l1.5-1M17.5 4l2 .2"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
};
const BTN = {
  fire:     { kind: 'fire', look: true, icon: 'fire', label: '발사' },
  leftFire: { kind: 'fire', look: false, icon: 'fire', label: '왼쪽 발사' },
  ads:      { kind: 'ads', look: true, icon: 'ads', label: '정조준' },
  jump:     { kind: 'tap', ev: 'jump', look: true, icon: 'jump', label: '점프' },
  crouch:   { kind: 'crouch', look: true, icon: 'crouch', label: '앉기' },
  reload:   { kind: 'tap', ev: 'reload', look: true, icon: 'reload', label: '장전' },
  grenade:  { kind: 'tap', ev: 'grenade', look: true, icon: 'grenade', label: '투척' },
};
const CONFLICT_PX = 36;      // 이보다 x 또는 y가 가까우면 '같은 줄' 경고
const EDGE_PX = 18;          // 화면 가장자리(시스템 뒤로가기 제스처) 무시 폭

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ? { ...d, ...v } : { ...d }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

export class MobileFPSControls {
  constructor({ root, hooks = {}, enabled = true } = {}) {
    this.root = root; this.hooks = hooks;
    this.S = load(STORE_SET, DEFAULT_SETTINGS);
    this.L = {}; const lay = load(STORE_LAY, {});
    for (const k in DEFAULT_LAYOUT) this.L[k] = { ...DEFAULT_LAYOUT[k], ...(lay[k] || {}) };
    this.ptrs = new Map();
    this.look = { dx: 0, dy: 0, active: 0 };
    this.stick = { id: null, bx: 0, by: 0, x: 0, y: 0, mag: 0, armed: false };
    this.sprintLock = false;
    this.fireHeld = 0; this.ads = false; this.crouch = false; this.adsHeld = 0; this.crouchHeld = 0;
    this.events = [];
    this.gyro = { yaw: 0, pitch: 0, t: 0, on: false };
    this.aa = { last: null, lyaw: 0, lpitch: 0, snapT: 0, snapRef: null, onT: 0 };
    this.prevAds = false; this.autoFire = false; this.sprinting = false;
    this.enabled = enabled; this.visible = true; this.editing = false;
    this.out = { dyaw: 0, dpitch: 0, move: { x: 0, y: 0 }, sprint: false, fire: false, ads: false, crouch: false, events: [], lookActive: false };
    injectCSS();
    this.build();
    this.onResize = () => this.layoutAll(); addEventListener('resize', this.onResize);
    screen.orientation?.addEventListener?.('change', this.onResize);
    if (this.S.gyro !== 'off') this.enableGyro(false);
  }

  // ── DOM ──────────────────────────────────────────────
  build() {
    const r = document.createElement('div'); r.className = 'mfc'; this.el = r;
    const layer = document.createElement('div'); layer.className = 'mfc-layer'; this.layer = layer;
    r.appendChild(layer);
    this.btns = {};
    for (const id in BTN) {
      const b = document.createElement('div'); b.className = 'mfc-btn mfc-' + id;
      b.innerHTML = `<div class="mfc-face">${svg(BTN[id].icon)}<em></em><i class="mfc-cd"></i></div>`;
      r.appendChild(b); this.btns[id] = { el: b, face: b.firstChild, badge: b.querySelector('em'), cd: b.querySelector('.mfc-cd'), def: BTN[id] };
    }
    const st = document.createElement('div'); st.className = 'mfc-stick';
    st.innerHTML = `<div class="mfc-base"></div><div class="mfc-knob"></div><div class="mfc-lock">${svg('lock')}</div>`;
    r.appendChild(st); this.stickEl = st; this.knobEl = st.querySelector('.mfc-knob'); this.lockEl = st.querySelector('.mfc-lock');
    this.root.insertBefore(r, this.root.firstChild);
    const opt = { passive: false };
    const move = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';   // 한 프레임 더 빠른 원시 입력
    layer.addEventListener('pointerdown', (e) => this.down(e), opt);
    layer.addEventListener(move, (e) => this.move(e), opt);
    if (move !== 'pointermove') layer.addEventListener('pointermove', (e) => { if (!this.ptrs.get(e.pointerId)?.raw) this.move(e); }, opt);
    layer.addEventListener('pointerup', (e) => this.up(e)); layer.addEventListener('pointercancel', (e) => this.up(e));
    layer.addEventListener('lostpointercapture', (e) => this.up(e));
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    this.layoutAll(); this.applyVisibility();
  }
  scale() { return clamp(Math.min(innerWidth, innerHeight) / 400, 0.85, 1.4); }
  px(k) { const l = this.L[k]; return { x: l.x * innerWidth, y: l.y * innerHeight, r: l.s * this.scale() / 2 }; }
  layoutAll() {
    this.el.style.setProperty('--mfc-op', this.S.opacity);
    for (const id in this.btns) {
      const p = this.px(id), b = this.btns[id];
      b.el.style.width = b.el.style.height = `${p.r * 2}px`;
      b.el.style.transform = `translate(${p.x - p.r}px, ${p.y - p.r}px)`;
    }
    const s = this.px('stick');
    this.stickEl.style.setProperty('--d', `${s.r * 2}px`);
    if (this.stick.id === null) this.placeStick(s.x, s.y, true);
    this.applyVisibility();
  }
  applyVisibility() {
    this.el.classList.toggle('mfc-hidden', !this.visible || !this.enabled);
    this.btns.leftFire.el.style.display = this.S.leftFire ? '' : 'none';
    this.btns.fire.el.classList.toggle('mfc-simple', this.S.fireMode === 'simple');
  }
  setVisible(on) { this.visible = on; if (!on) this.releaseAll(); this.applyVisibility(); }
  placeStick(x, y, idle) {
    this.stick.bx = x; this.stick.by = y;
    this.stickEl.style.transform = `translate(${x}px, ${y}px)`;
    this.stickEl.classList.toggle('idle', !!idle);
    this.knobEl.style.transform = 'translate(-50%, -50%)';
  }

  // ── 터치 ─────────────────────────────────────────────
  hit(x, y) {
    let best = null, bd = 1e9;
    for (const id in this.btns) {
      if (id === 'leftFire' && !this.S.leftFire) continue;
      const p = this.px(id), d = Math.hypot(x - p.x, y - p.y);
      if (d < p.r * 1.22 && d < bd) { bd = d; best = id; }   // 손가락 굵기만큼 판정 넓게
    }
    if (best) return best;
    if (x < innerWidth * 0.42 && y > innerHeight * 0.3) return 'stick';
    return 'look';
  }
  down(e) {
    e.preventDefault();
    if (this.editing) return this.editDown(e);
    if (!this.enabled || !this.visible) return;
    if (e.clientX < EDGE_PX || e.clientX > innerWidth - EDGE_PX) return;
    const ctrl = this.hit(e.clientX, e.clientY);
    try { this.layer.setPointerCapture(e.pointerId); } catch {}
    const p = { ctrl, x: e.clientX, y: e.clientY, t: e.timeStamp, raw: e.type === 'pointerrawupdate' };
    if (ctrl === 'stick') {
      if (this.stick.id !== null) { p.ctrl = 'look'; }
      else {
        this.stick.id = e.pointerId; this.sprintLock = false; this.lockEl.classList.remove('on');
        const s = this.px('stick');
        // 떠다니는 스틱: 누른 곳이 중심(화면 밖으로 안 나가게)
        this.placeStick(clamp(e.clientX, s.r + 8, innerWidth * 0.5), clamp(e.clientY, s.r + 8, innerHeight - s.r - 8), false);
      }
    } else if (ctrl !== 'look') this.press(ctrl, p);
    this.ptrs.set(e.pointerId, p);
  }
  move(e) {
    if (this.editing) return this.editMove(e);
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    if (e.type === 'pointerrawupdate') p.raw = true;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    const dt = Math.max(1, e.timeStamp - p.t);
    p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
    if (p.ctrl === 'stick') return this.stickMove(e.clientX, e.clientY);
    if (p.ctrl === 'look' || BTN[p.ctrl]?.look) {
      // 시점 가속: 손가락 속도(px/s)가 빠를수록 더 많이 돈다. 느린 미세 조준은 1:1
      const v = Math.hypot(dx, dy) / dt * 1000;
      const m = 1 + this.S.accel * ss(260, 1800, v);
      this.look.dx += dx * m; this.look.dy += dy * m;
      this.look.active = 0.12;
    }
  }
  up(e) {
    if (this.editing) return this.editUp(e);
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    this.ptrs.delete(e.pointerId);
    if (p.ctrl === 'stick') {
      if (this.stick.armed) { this.sprintLock = true; this.lockEl.classList.add('on'); this.haptic('tick'); }
      this.stick.id = null; this.stick.x = this.stick.y = this.stick.mag = 0; this.stick.armed = false; this.lockEl.classList.remove('armed');
      const s = this.px('stick'); this.placeStick(s.x, s.y, true);
      this.stickEl.classList.remove('sprint');
    } else if (p.ctrl !== 'look') this.release(p.ctrl);
  }
  releaseAll() { for (const [id, p] of [...this.ptrs]) this.up({ pointerId: id }); this.fireHeld = 0; this.adsHeld = 0; this.crouchHeld = 0; this.sprintLock = false; }
  stickMove(cx, cy) {
    const s = this.px('stick'), R = s.r * 0.62;
    let dx = cx - this.stick.bx, dy = cy - this.stick.by;
    const L = Math.hypot(dx, dy);
    // 너무 멀리 끌면 중심이 따라온다 (방향 전환이 쉬움) — 단, 위로 끌어올리는 스프린트 잠금 동작은 예외
    const lockZone = dy < -R * 1.2 && Math.abs(dx) < R * 0.9;
    if (L > R * 1.6 && !lockZone) {
      const k = 1 - R * 1.6 / L; this.placeStick(this.stick.bx + dx * k, this.stick.by + dy * k, false);
      dx = cx - this.stick.bx; dy = cy - this.stick.by;
    }
    const L2 = Math.hypot(dx, dy), kk = L2 > R ? R / L2 : 1;
    this.knobEl.style.transform = `translate(calc(-50% + ${dx * kk}px), calc(-50% + ${dy * kk}px))`;
    let x = dx / R, y = -dy / R; const m = Math.hypot(x, y);
    if (m < 0.1) { x = y = 0; }                      // 데드존
    else { const r = (m - 0.1) / 0.9 / m; x *= Math.min(r, 1 / m * 1.6); y *= Math.min(r, 1 / m * 1.6); }
    this.stick.x = clamp(x, -1, 1); this.stick.y = clamp(y, -1, 1); this.stick.mag = m;
    // 스프린트 잠금: 스틱을 위로 바깥까지 끌어올리면 자물쇠가 켜지고, 그 상태로 떼면 계속 달린다
    const armed = dy < -R * 1.55 && Math.abs(dx) < R * 0.85;
    if (armed !== this.stick.armed) { this.stick.armed = armed; this.lockEl.classList.toggle('armed', armed); if (armed) this.haptic('tick'); }
    this.stickEl.classList.toggle('sprint', m > 1.05 && y > 0.55);
  }
  press(id, p) {
    const b = this.btns[id], k = b.def.kind;
    b.el.classList.add('down');
    if (k === 'fire') { this.fireHeld++; if (this.sprintLock) this.cancelSprintLock(); }
    else if (k === 'ads') {
      if (this.S.adsMode === 'hold') { this.adsHeld++; this.setAds(true); }
      else this.setAds(!this.ads);
    } else if (k === 'crouch') {
      if (this.sprinting) { this.events.push('slide'); this.haptic('tick'); if (this.S.crouchMode === 'hold') this.crouchHeld++; return; }
      if (this.S.crouchMode === 'hold') { this.crouchHeld++; this.setCrouch(true); }
      else this.setCrouch(!this.crouch);
    } else if (k === 'tap') this.events.push(b.def.ev);
    this.haptic('press');
  }
  release(id) {
    const b = this.btns[id], k = b.def.kind;
    b.el.classList.remove('down');
    if (k === 'fire') this.fireHeld = Math.max(0, this.fireHeld - 1);
    else if (k === 'ads' && this.S.adsMode === 'hold') { this.adsHeld = Math.max(0, this.adsHeld - 1); if (!this.adsHeld) this.setAds(false); }
    else if (k === 'crouch' && this.S.crouchMode === 'hold') { this.crouchHeld = Math.max(0, this.crouchHeld - 1); if (!this.crouchHeld) this.setCrouch(false); }
  }
  setAds(on) { this.ads = on; this.btns.ads.el.classList.toggle('on', on); if (on) this.cancelSprintLock(); }
  setCrouch(on) { this.crouch = on; this.btns.crouch.el.classList.toggle('on', on); }
  cancelSprintLock() { this.sprintLock = false; this.lockEl.classList.remove('on'); }
  // 게임이 상태를 바꿨을 때(점프로 앉기 풀림 등) 버튼 표시 맞추기
  sync({ ads, crouch } = {}) { if (ads !== undefined && ads !== this.ads) this.setAds(ads); if (crouch !== undefined && crouch !== this.crouch) this.setCrouch(crouch); }
  setBadge(id, text) { const b = this.btns[id]; if (b && b.badge.textContent !== String(text)) b.badge.textContent = text; }
  setCooldown(id, f) { const b = this.btns[id]; if (b) { b.cd.style.transform = `scaleY(${clamp(f, 0, 1)})`; b.el.classList.toggle('empty', f >= 0.999); } }
  setDisabled(id, on) { this.btns[id]?.el.classList.toggle('off', !!on); }

  // ── 진동 ─────────────────────────────────────────────
  haptic(kind) {
    if (!this.S.haptics || !navigator.vibrate) return;
    const P = { press: 6, tick: 10, fire: 9, hit: 14, kill: [0, 18, 40, 22], hurt: 30 };
    try { navigator.vibrate(P[kind] ?? 8); } catch {}
  }

  // ── 자이로 ───────────────────────────────────────────
  async enableGyro(fromGesture) {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    // 듣기는 바로 시작. 허용 요청(iOS·최신 Chrome)은 사용자 탭 안에서만 되므로, 탭이 아니면 다음 터치 때 요청한다
    if (!this.gyro.on) { this.gyro.on = true; addEventListener('devicemotion', (e) => this.onMotion(e)); }
    if (typeof DeviceMotionEvent.requestPermission === 'function' && !this.gyro.granted) {
      const ask = async () => { try { this.gyro.granted = (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch { this.gyro.granted = false; } return this.gyro.granted; };
      if (fromGesture) return ask();
      this.layer.addEventListener('pointerdown', () => ask(), { once: true });
    }
    return true;
  }
  onMotion(e) {
    const r = e.rotationRate; if (!r) return;
    const now = e.timeStamp, dt = this.gyro.t ? clamp((now - this.gyro.t) / 1000, 0, 0.05) : 0.016; this.gyro.t = now;
    const D = Math.PI / 180;
    // 기기 좌표 각속도 → 화면 기준 '위' 축(yaw)과 '오른쪽' 축(pitch)
    const wx = (r.beta || 0) * D, wy = (r.gamma || 0) * D;
    const ang = (screen.orientation?.angle ?? window.orientation ?? 0) % 360;
    let yaw, pitch;
    if (ang === 90) { yaw = wx; pitch = -wy; }
    else if (ang === 270 || ang === -90) { yaw = -wx; pitch = wy; }
    else if (ang === 180) { yaw = -wy; pitch = -wx; }
    else { yaw = wy; pitch = wx; }
    // 손떨림 데드존(약 0.5°/s)
    const dz = (v) => Math.sign(v) * Math.max(0, Math.abs(v) - 0.009);
    this.gyro.yaw += dz(yaw) * dt; this.gyro.pitch += dz(pitch) * dt;
  }

  // ── 매 프레임 ────────────────────────────────────────
  // view: { pos:{x,y,z}, yaw, pitch, fov, baseFov, adsAmt(0..1), moving(bool), sprinting(bool) }
  update(dt, view) {
    const o = this.out, S = this.S;
    o.events = this.events; this.events = [];
    this.sprinting = !!view.sprinting;
    // 수동 시점
    const fovRatio = Math.tan((view.fov || 70) * Math.PI / 360) / Math.tan((view.baseFov || 70) * Math.PI / 360);
    const kAds = lerp(1, S.adsSens * fovRatio, view.adsAmt || 0);   // 줌 배율만큼 느려져야 화면상 같은 속도
    const k = 0.0042 * S.sens * kAds;
    let dyaw = -this.look.dx * k, dpitch = -this.look.dy * k * (S.invertY ? -1 : 1);
    const manual = this.look.dx !== 0 || this.look.dy !== 0;
    this.look.dx = this.look.dy = 0;
    this.look.active = Math.max(0, this.look.active - dt);
    // 조준 보조
    let aaYaw = 0, aaPitch = 0;
    const tg = S.aimAssist || S.fireMode === 'simple' ? this.bestTarget(view) : null;
    if (tg && S.aimAssist) {
      const zone = tg.zone;
      // 1) 감속: 조준선이 적 근처면 손가락 움직임을 덜 반영 (지나치지 않게)
      if (manual && tg.off < zone) { const f = lerp(0.5, 1, tg.off / zone); dyaw *= f; dpitch *= f; }
      // 2) 회전 추적: 내가 움직이거나 조준 중일 때 적의 상대 각속도 일부를 따라간다
      if (this.aa.last === tg.ref && tg.off < zone * 1.5 && (view.moving || this.look.active > 0 || this.fireHeld)) {
        const rot = lerp(0.42, 0.62, view.adsAmt || 0);
        aaYaw += clamp(wrap(tg.yaw - this.aa.lyaw) * rot, -0.05, 0.05);
        aaPitch += clamp((tg.pitch - this.aa.lpitch) * rot, -0.05, 0.05);
      }
      // 3) 정조준 스냅: 정조준을 켜는 순간 가까운 적 쪽으로 짧게 끌어당김
      if (this.ads && !this.prevAds && tg.off < 0.16) { this.aa.snapT = 0.16; this.aa.snapRef = tg.ref; }
      if (this.aa.snapT > 0 && this.aa.snapRef === tg.ref) {
        this.aa.snapT -= dt;
        const a = (1 - Math.exp(-dt * 16)) * 0.85;
        aaYaw += wrap(tg.yaw - view.yaw) * a; aaPitch += (tg.pitch - view.pitch) * a;
      }
    } else this.aa.snapT = 0;
    if (tg) { this.aa.last = tg.ref; this.aa.lyaw = tg.yaw; this.aa.lpitch = tg.pitch; } else this.aa.last = null;
    this.prevAds = this.ads;
    // 간편 사격: 조준선이 적 몸에 60ms 이상 머물면 자동 사격
    if (S.fireMode === 'simple' && tg && tg.off < tg.angR * 1.05 + 0.006) this.aa.onT += dt; else this.aa.onT = 0;
    this.autoFire = this.aa.onT > 0.06;
    // 자이로
    let gYaw = 0, gPitch = 0;
    if (this.gyro.on && (S.gyro === 'always' || (S.gyro === 'ads' && (view.adsAmt || 0) > 0.5))) {
      const gk = S.gyroSens * lerp(1, 0.75, view.adsAmt || 0);
      gYaw = this.gyro.yaw * gk * (S.gyroInvX ? -1 : 1); gPitch = this.gyro.pitch * gk * (S.gyroInvY ? -1 : 1);
    }
    this.gyro.yaw = this.gyro.pitch = 0;   // 쓰든 안 쓰든 소비 (켤 때 튀지 않게)
    o.dyaw = dyaw + aaYaw + gYaw; o.dpitch = dpitch + aaPitch + gPitch;
    o.lookActive = manual;
    // 이동
    if (this.sprintLock) { o.move.x = 0; o.move.y = 1; }
    else { o.move.x = this.stick.x; o.move.y = this.stick.y; }
    o.sprint = this.sprintLock || (this.stick.mag > 1.05 && this.stick.y > 0.55);
    o.fire = this.fireHeld > 0 || this.autoFire;
    o.ads = this.ads; o.crouch = this.crouch;
    if (this._slideIcon !== this.sprinting) this.swapCrouchIcon();
    return o;
  }
  swapCrouchIcon() {
    this._slideIcon = this.sprinting;
    this.btns.crouch.face.querySelector('svg').outerHTML = svg(this.sprinting ? 'slide' : 'crouch');
  }
  bestTarget(v) {
    const list = this.hooks.targets?.() || [];
    let best = null;
    for (const t of list) {
      const dx = t.x - v.pos.x, dy = t.y - v.pos.y, dz = t.z - v.pos.z;
      const h = Math.hypot(dx, dz), dist = Math.hypot(h, dy); if (dist < 0.5) continue;
      const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, h);
      const oy = wrap(yaw - v.yaw), op = pitch - v.pitch, off = Math.hypot(oy, op);
      const angR = Math.atan((t.r || 0.4) / dist);
      const zone = Math.max(angR * 2.4, 0.035) * lerp(1, 1.3, v.adsAmt || 0);
      const score = off / zone;
      if (score < 1.6 && (!best || score < best.score)) best = { ref: t.ref ?? t, yaw, pitch, off, angR, zone, score };
    }
    return best;
  }

  // ── 배치 편집기 ──────────────────────────────────────
  openEditor(onClose) {
    this.releaseAll(); this.editing = true; this.onEditClose = onClose;
    this.el.classList.add('mfc-edit'); this.visible = true; this.applyVisibility();
    const bar = document.createElement('div'); bar.className = 'mfc-bar';
    bar.innerHTML = `<span class="mfc-sel">버튼을 끌어서 옮기세요</span>
      <button data-a="s-">크기 −</button><button data-a="s+">크기 +</button>
      <button data-a="tidy">자동 정리</button><button data-a="reset">기본값</button><button data-a="done" class="pri">저장</button>
      <span class="mfc-warn"></span>`;
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      const a = e.target.dataset?.a; if (!a) return;
      if (a === 's-' || a === 's+') { if (this.sel) { const l = this.L[this.sel]; l.s = clamp(l.s * (a === 's+' ? 1.1 : 0.91), 40, 170); this.layoutAll(); this.checkConflicts(); } }
      if (a === 'tidy') this.tidy();
      if (a === 'reset') { for (const k in DEFAULT_LAYOUT) this.L[k] = { ...DEFAULT_LAYOUT[k] }; this.layoutAll(); this.checkConflicts(); }
      if (a === 'done') this.closeEditor();
    });
    this.el.appendChild(bar); this.bar = bar;
    this.checkConflicts();
  }
  closeEditor() {
    this.editing = false; this.el.classList.remove('mfc-edit'); this.bar?.remove(); this.sel = null;
    for (const id in this.btns) this.btns[id].el.classList.remove('sel', 'conflict');
    save(STORE_LAY, this.L); this.layoutAll();
    this.onEditClose?.();
  }
  editDown(e) {
    const id = this.hit(e.clientX, e.clientY);
    if (!this.btns[id] && id !== 'stick') return;
    const key = id === 'stick' ? 'stick' : id;
    if (id === 'stick') { const s = this.px('stick'); if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > s.r) return; }
    this.sel = key; this.drag = { id: e.pointerId };
    for (const b in this.btns) this.btns[b].el.classList.toggle('sel', b === key);
    this.stickEl.classList.toggle('sel', key === 'stick');
    this.bar.querySelector('.mfc-sel').textContent = key === 'stick' ? '이동 스틱 (기본 위치)' : BTN[key].label;
    try { this.layer.setPointerCapture(e.pointerId); } catch {}
  }
  editMove(e) {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    const l = this.L[this.sel], r = l.s * this.scale() / 2;
    l.x = clamp(e.clientX, r + 6, innerWidth - r - 6) / innerWidth;
    l.y = clamp(e.clientY, r + 6, innerHeight - r - 6) / innerHeight;
    this.layoutAll(); this.checkConflicts();
  }
  editUp(e) { if (this.drag?.id === e.pointerId) this.drag = null; }
  conflicts() {
    const ids = Object.keys(BTN).filter((k) => k !== 'leftFire' || this.S.leftFire);
    const out = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = this.px(ids[i]), b = this.px(ids[j]);
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      const overlap = Math.hypot(dx, dy) < a.r + b.r + 4;
      if (overlap || dx < CONFLICT_PX || dy < CONFLICT_PX) out.push({ a: ids[i], b: ids[j], dx, dy, overlap });
    }
    return out;
  }
  checkConflicts() {
    const c = this.conflicts(), bad = new Set(c.flatMap((p) => [p.a, p.b]));
    for (const id in this.btns) this.btns[id].el.classList.toggle('conflict', bad.has(id));
    if (this.bar) this.bar.querySelector('.mfc-warn').textContent = c.length ? `같은 줄·겹침 ${c.length}곳 — 동시에 누르면 씹힐 수 있음` : '✓ 겹침 없음';
    return c;
  }
  tidy() {
    // 겹치거나 같은 줄에 있는 버튼을 '가장 가까운 빈 자리'로 옮긴다. 발사 버튼은 기준점이라 고정.
    const ids = Object.keys(BTN).filter((k) => k !== 'leftFire' || this.S.leftFire);
    const ok = (id, x, y) => {
      const r = this.L[id].s * this.scale() / 2;
      if (x < r + 6 || x > innerWidth - r - 6 || y < r + 6 || y > innerHeight - r - 6) return false;
      for (const o of ids) {
        if (o === id) continue;
        const q = this.px(o), dx = Math.abs(x - q.x), dy = Math.abs(y - q.y);
        if (dx < CONFLICT_PX || dy < CONFLICT_PX || Math.hypot(dx, dy) < r + q.r + 4) return false;
      }
      return true;
    };
    for (let pass = 0; pass < 3; pass++) {
      const c = this.conflicts(); if (!c.length) break;
      const count = {}; for (const p of c) { count[p.a] = (count[p.a] || 0) + 1; count[p.b] = (count[p.b] || 0) + 1; }
      const order = Object.keys(count).filter((k) => k !== 'fire').sort((a, b) => count[b] - count[a]);
      for (const id of order) {
        const p = this.px(id);
        if (ok(id, p.x, p.y)) continue;
        let best = null;
        for (let rad = 6; rad < Math.max(innerWidth, innerHeight) && !best; rad += 6) {
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2, x = p.x + Math.cos(a) * rad, y = p.y + Math.sin(a) * rad;
            // 원래 쪽(왼쪽 화면 버튼은 왼쪽, 오른쪽은 오른쪽)을 벗어나지 않게
            if ((p.x < innerWidth / 2) !== (x < innerWidth / 2)) continue;
            if (ok(id, x, y)) { best = { x, y }; break; }
          }
        }
        if (best) { this.L[id].x = best.x / innerWidth; this.L[id].y = best.y / innerHeight; }
      }
    }
    this.layoutAll(); this.checkConflicts();
  }

  // ── 설정 패널 ────────────────────────────────────────
  buildSettings(container, { onEditLayout } = {}) {
    const S = this.S;
    const row = (label, html) => `<div class="mfc-row"><span>${label}</span>${html}</div>`;
    const slider = (k, min, max, step) => `<span class="mfc-sl"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${S[k]}"><b data-v="${k}">${(+S[k]).toFixed(2)}</b></span>`;
    const seg = (k, opts) => `<span class="mfc-seg" data-k="${k}">${opts.map(([v, t]) => `<button data-v="${v}" class="${S[k] === v ? 'on' : ''}">${t}</button>`).join('')}</span>`;
    const tog = (k) => `<button class="mfc-tog ${S[k] ? 'on' : ''}" data-t="${k}"><i></i></button>`;
    container.innerHTML = `
      <div class="mfc-tabs"><button data-tab="a" class="on">감도</button><button data-tab="b">조작</button><button data-tab="c">자이로</button></div>
      <div class="mfc-pane" data-pane="a">
        ${row('시점 감도', slider('sens', 0.3, 3, 0.05))}
        ${row('정조준 감도', slider('adsSens', 0.3, 2, 0.05))}
        ${row('시점 가속', slider('accel', 0, 1.5, 0.05))}
        ${row('상하 반전', tog('invertY'))}
        ${row('조준 보조', tog('aimAssist'))}
      </div>
      <div class="mfc-pane hidden" data-pane="b">
        ${row('사격 방식', seg('fireMode', [['advanced', '버튼'], ['simple', '간편(자동)']]))}
        ${row('정조준', seg('adsMode', [['tap', '탭'], ['hold', '누르고 있기']]))}
        ${row('앉기', seg('crouchMode', [['tap', '탭'], ['hold', '누르고 있기']]))}
        ${row('왼쪽 발사 버튼', tog('leftFire'))}
        ${row('진동', tog('haptics'))}
        ${row('버튼 투명도', slider('opacity', 0.3, 1, 0.05))}
        <button class="mfc-edit-btn">조작 버튼 배치 편집</button>
      </div>
      <div class="mfc-pane hidden" data-pane="c">
        ${row('자이로 조준', seg('gyro', [['off', '끄기'], ['ads', '정조준 때만'], ['always', '항상']]))}
        ${row('자이로 감도', slider('gyroSens', 0.2, 3, 0.05))}
        ${row('좌우 반전', tog('gyroInvX'))}
        ${row('상하 반전', tog('gyroInvY'))}
        <p class="mfc-note">폰을 기울여 미세 조준합니다. 방향이 반대로 느껴지면 반전을 켜세요.</p>
      </div>`;
    const set = (k, v) => { S[k] = v; save(STORE_SET, S); this.applyVisibility(); this.layoutAll(); };
    container.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => {
      set(inp.dataset.k, parseFloat(inp.value)); container.querySelector(`[data-v="${inp.dataset.k}"]`).textContent = (+inp.value).toFixed(2);
    }));
    container.querySelectorAll('.mfc-seg').forEach((g) => g.addEventListener('click', async (e) => {
      const v = e.target.dataset.v; if (!v) return;
      if (g.dataset.k === 'gyro' && v !== 'off') { const ok = await this.enableGyro(true); if (!ok) { container.querySelector('.mfc-note').textContent = '이 기기·브라우저에서는 자이로를 쓸 수 없어요.'; return; } }
      set(g.dataset.k, v); g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    }));
    container.querySelectorAll('.mfc-tog').forEach((b) => b.addEventListener('click', () => { set(b.dataset.t, !S[b.dataset.t]); b.classList.toggle('on', S[b.dataset.t]); }));
    container.querySelectorAll('.mfc-tabs button').forEach((b) => b.addEventListener('click', () => {
      container.querySelectorAll('.mfc-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      container.querySelectorAll('.mfc-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
    }));
    container.querySelector('.mfc-edit-btn').addEventListener('click', () => onEditLayout?.());
  }
}

let cssDone = false;
function injectCSS() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement('style');
  s.textContent = `
.mfc { position: absolute; inset: 0; pointer-events: none; --mfc-op: .85; --mfc-ease: cubic-bezier(.23,1,.32,1); }
.mfc-hidden .mfc-btn, .mfc-hidden .mfc-stick { display: none; }
.mfc-layer { position: absolute; inset: 0; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.mfc-hidden .mfc-layer { pointer-events: none; }
.mfc-btn { position: absolute; left: 0; top: 0; opacity: var(--mfc-op); pointer-events: none; }
.mfc-face { position: relative; width: 100%; height: 100%; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
  background: rgba(18,10,6,.38); border: 2px solid rgba(255,240,220,.32); color: #fff2df;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.25); transition: transform 100ms var(--mfc-ease), background-color 100ms ease, border-color 100ms ease; }
.mfc-face svg { width: 46%; height: 46%; filter: drop-shadow(0 1px 1px rgba(0,0,0,.6)); }
.mfc-btn.down .mfc-face { transform: scale(.92); background: rgba(232,131,58,.55); border-color: rgba(255,210,170,.8); }
.mfc-btn.on .mfc-face { background: rgba(242,193,78,.6); color: #2a160b; border-color: rgba(255,230,170,.9); }
.mfc-btn.off { opacity: calc(var(--mfc-op) * .4); }
.mfc-fire .mfc-face { background: rgba(181,70,42,.48); border-color: rgba(255,200,160,.55); }
.mfc-fire .mfc-face svg { width: 40%; height: 40%; }
.mfc-fire.mfc-simple { opacity: calc(var(--mfc-op) * .45); }
.mfc-leftFire .mfc-face { background: rgba(181,70,42,.4); }
.mfc-face em { position: absolute; bottom: 9%; font-style: normal; font-weight: 900; font-size: 11px; color: #f2c14e; text-shadow: 0 1px 2px rgba(0,0,0,.8); }
.mfc-fire .mfc-face em { font-size: 13px; bottom: 11%; }
.mfc-cd { position: absolute; inset: 0; background: rgba(0,0,0,.5); transform-origin: bottom; transform: scaleY(0); pointer-events: none; }
.mfc-btn.empty svg { opacity: .35; }
.mfc-stick { position: absolute; left: 0; top: 0; width: 0; height: 0; opacity: var(--mfc-op); pointer-events: none; }
.mfc-base { position: absolute; left: calc(var(--d) / -2); top: calc(var(--d) / -2); width: var(--d); height: var(--d); border-radius: 50%;
  background: radial-gradient(circle, rgba(0,0,0,.12), rgba(0,0,0,.28)); border: 2px solid rgba(255,240,220,.28); transition: opacity 160ms ease, border-color 120ms ease; }
.mfc-knob { position: absolute; left: 0; top: 0; width: calc(var(--d) * .42); height: calc(var(--d) * .42); border-radius: 50%;
  background: rgba(255,240,220,.6); box-shadow: 0 2px 8px rgba(0,0,0,.35); transform: translate(-50%,-50%); }
.mfc-stick.idle .mfc-base { opacity: .45; } .mfc-stick.idle .mfc-knob { opacity: .5; }
.mfc-stick.sprint .mfc-base { border-color: rgba(242,193,78,.85); } .mfc-stick.sprint .mfc-knob { background: rgba(242,193,78,.85); }
.mfc-lock { position: absolute; left: -17px; top: calc(var(--d) * -.5 - 46px); width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(0,0,0,.35); color: #fff2df; opacity: 0; transform: scale(.9); transition: opacity 120ms ease, transform 120ms var(--mfc-ease), background-color 120ms ease; }
.mfc-lock svg { width: 58%; height: 58%; }
.mfc-stick:not(.idle) .mfc-lock { opacity: .7; transform: scale(1); }
.mfc-lock.armed { background: rgba(242,193,78,.9); color: #2a160b; opacity: 1 !important; transform: scale(1.12) !important; }
.mfc-lock.on { opacity: 1 !important; transform: scale(1) !important; background: rgba(242,193,78,.85); color: #2a160b; }
.mfc-edit { background: rgba(10,6,3,.55); pointer-events: auto; z-index: 40; }
.mfc-edit .mfc-btn, .mfc-edit .mfc-stick { opacity: 1; }
.mfc-edit .mfc-face, .mfc-edit .mfc-base { outline: 2px dashed rgba(255,240,220,.5); outline-offset: 3px; }
.mfc-edit .mfc-btn.sel .mfc-face, .mfc-edit .mfc-stick.sel .mfc-base { outline: 2px solid #f2c14e; }
.mfc-edit .mfc-btn.conflict .mfc-face { outline: 2px solid #ff4b36; }
.mfc-bar { position: absolute; left: 50%; top: calc(8px + env(safe-area-inset-top, 0px)); transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center;
  align-items: center; gap: 6px; padding: 8px 10px; border-radius: 14px; background: rgba(30,16,10,.92); border: 1px solid rgba(255,240,220,.15);
  pointer-events: auto; max-width: calc(100% - 24px); font: 700 13px "Noto Sans KR", system-ui, sans-serif; color: #f6e7cf; z-index: 2; }
.mfc-bar button { min-height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid rgba(255,240,220,.18); background: rgba(255,240,220,.08); color: inherit; font: inherit;
  touch-action: manipulation; transition: transform 100ms var(--mfc-ease); }
.mfc-bar button:active { transform: scale(.96); }
.mfc-bar button.pri { background: #e8833a; color: #2a160b; border-color: transparent; }
.mfc-sel { color: #f2c14e; min-width: 90px; }
.mfc-warn { flex-basis: 100%; text-align: center; font-size: 12px; color: #c9a27a; }
.mfc-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.mfc-tabs button { flex: 1; min-height: 38px; border-radius: 10px; border: 1px solid rgba(255,240,220,.14); background: rgba(255,240,220,.05); color: #c9a27a; font: 700 14px inherit; }
.mfc-tabs button.on { background: rgba(232,131,58,.25); color: #f6e7cf; border-color: rgba(232,131,58,.6); }
.mfc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; border-bottom: 1px solid rgba(255,240,220,.07); font-size: 14px; }
.mfc-sl { display: flex; align-items: center; gap: 8px; flex: 0 1 220px; }
.mfc-sl input { flex: 1; accent-color: #e8833a; height: 28px; min-width: 0; }
.mfc-sl b { width: 36px; text-align: right; font-size: 12px; color: #f2c14e; }
.mfc-seg { display: flex; gap: 4px; }
.mfc-seg button { min-height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(255,240,220,.14); background: transparent; color: #c9a27a; font: 700 12.5px inherit; }
.mfc-seg button.on { background: #e8833a; color: #2a160b; border-color: transparent; }
.mfc-tog { width: 46px; height: 26px; border-radius: 13px; border: 0; background: rgba(255,240,220,.15); position: relative; transition: background-color 140ms ease; }
.mfc-tog i { position: absolute; left: 3px; top: 3px; width: 20px; height: 20px; border-radius: 50%; background: #f6e7cf; transition: transform 160ms var(--mfc-ease); }
.mfc-tog.on { background: #e8833a; } .mfc-tog.on i { transform: translateX(20px); }
.mfc-edit-btn { width: 100%; margin-top: 12px; min-height: 44px; border-radius: 12px; border: 1px dashed rgba(242,193,78,.6); background: rgba(242,193,78,.08); color: #f2c14e; font: 700 14px inherit; }
.mfc-note { font-size: 12px; color: #c9a27a; margin-top: 10px; line-height: 1.5; }
.mfc-pane.hidden { display: none; }
@media (pointer: fine) { .mfc-btn, .mfc-stick, .mfc-layer { display: none; } .mfc-edit .mfc-btn, .mfc-edit .mfc-stick, .mfc-edit .mfc-layer { display: block; } }
`;
  document.head.appendChild(s);
}
