// 접속 — 웹소켓(온라인) 또는 같은 페이지 안의 가짜 서버(오프라인 봇 연습). 둘 다 같은 메시지로 말한다.
import { Room } from './rules.js';

export class Net {
  constructor(onMsg, onStatus) { this.onMsg = onMsg; this.onStatus = onStatus || (() => {}); this.ws = null; this.local = null; this.token = null; this.want = false; this.queue = []; }
  get online() { return !!this.ws; }
  // 온라인 접속
  connect() {
    this.want = true;
    return new Promise((res, rej) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { rej(e); return; }
      this.ws = ws;
      const to = setTimeout(() => { rej(new Error('timeout')); try { ws.close(); } catch {} }, 6000);
      ws.onopen = () => { clearTimeout(to); this.onStatus('open'); for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m)); res(); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.t === 'joined') this.token = m.token; this.onMsg(m); };
      ws.onerror = () => {};
      ws.onclose = () => { clearTimeout(to); if (this.ws === ws) { this.ws = null; this.onStatus('closed'); if (this.want && this.token) this.retry(0); } rej(new Error('closed')); };
    });
  }
  // 끊기면 같은 자리로 다시 붙는다 (Cloud Run 요청 제한 시간 등)
  async retry(n) {
    if (!this.want || n > 25) { this.onStatus('lost'); return; }
    this.onStatus('reconnecting');
    try { await this.connect(); this.send({ t: 'rejoin', token: this.token }); }
    catch { setTimeout(() => this.retry(n + 1), 1000); }
  }
  // 오프라인: 이 페이지 안에서 규칙을 돌린다
  startLocal(name) {
    const me = 'p1';
    const deliver = (m) => queueMicrotask(() => this.onMsg(JSON.parse(JSON.stringify(m))));
    const room = new Room('연습', { priv: true, send: (id, m) => { if (id === me) deliver(m); }, broadcast: (m, except) => { if (except !== me) deliver(m); } });
    room.join(me, name);
    this.local = { room, me, last: performance.now() };
    this.local.iv = setInterval(() => { const now = performance.now(); room.tick(Math.min(0.2, (now - this.local.last) / 1000)); this.local.last = now; }, 50);
    deliver({ t: 'joined', id: me, code: '연습', token: null });
  }
  send(m) {
    if (this.local) { const { room, me } = this.local; queueMicrotask(() => room.msg(me, JSON.parse(JSON.stringify(m)))); return; }
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
    else if (m.t !== 'st' && m.t !== 'shot') this.queue.push(m);
  }
  close() {
    this.want = false; this.token = null;
    if (this.local) { clearInterval(this.local.iv); this.local = null; }
    if (this.ws) { try { this.send({ t: 'leave' }); this.ws.close(); } catch {} this.ws = null; }
  }
}
