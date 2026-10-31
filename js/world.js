// 장면·사막·열차·충돌
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { G, TRAIN, rand, clamp } from './state.js';

export const VAULT = { x: -0.85, z: -1.9, w: 0.85, d: 0.8, h: 1.25 };

// ── 텍스처 (캔버스로 생성, 파일 없음) ─────────────────────────
function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function noise(g, s, n, a, col) {
  for (let i = 0; i < n; i++) { g.fillStyle = col(); g.globalAlpha = a; g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); }
  g.globalAlpha = 1;
}
const TEX = {};
function makeTextures() {
  TEX.sand = canvasTex(512, (g, s) => {
    g.fillStyle = '#d9a46b'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 46; i++) {                     // 바람 무늬
      const y = Math.random() * s; g.strokeStyle = Math.random() < 0.5 ? '#c48f5a' : '#e8bb84'; g.globalAlpha = 0.35; g.lineWidth = 2 + Math.random() * 3;
      g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= s; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 6); g.stroke();
    }
    g.globalAlpha = 1; noise(g, s, 9000, 0.25, () => (Math.random() < 0.5 ? '#b37a48' : '#f0c896'));
  });
  TEX.sand.repeat.set(80, 80);
  TEX.gravel = canvasTex(256, (g, s) => {
    g.fillStyle = '#6b5443'; g.fillRect(0, 0, s, s); noise(g, s, 7000, 0.6, () => ['#4a3a30', '#8a7360', '#5c4636'][(Math.random() * 3) | 0]);
    for (let y = 0; y < s; y += 32) { g.fillStyle = '#4a2f1e'; g.fillRect(14, y + 4, s - 28, 14); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(14, y + 16, s - 28, 3); }
  });
  TEX.planks = canvasTex(256, (g, s) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) {
      g.fillStyle = `hsl(28, 10%, ${78 + Math.random() * 18}%)`; g.fillRect(0, y, s, 31);
      g.fillStyle = 'rgba(40,20,10,0.55)'; g.fillRect(0, y + 30, s, 2);
      for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(60,30,15,0.12)'; g.fillRect(0, y + 4 + Math.random() * 24, s, 1); }
      const cut = Math.random() * s; g.fillStyle = 'rgba(40,20,10,0.5)'; g.fillRect(cut, y, 2, 31);
    }
    noise(g, s, 1500, 0.15, () => '#3a2010');
  });
  TEX.metal = canvasTex(256, (g, s) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, s, s); noise(g, s, 5000, 0.18, () => (Math.random() < 0.5 ? '#8a5a40' : '#555'));
    g.fillStyle = 'rgba(0,0,0,0.25)'; for (let x = 8; x < s; x += 64) for (let y = 8; y < s; y += 64) { g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); }
    g.fillRect(0, 0, s, 2); g.fillRect(0, 0, 2, s);
  });
  TEX.crate = canvasTex(128, (g, s) => {
    g.fillStyle = '#c9925a'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 21) { g.fillStyle = 'rgba(60,30,10,0.4)'; g.fillRect(0, y, s, 2); }
    g.strokeStyle = '#6b3f1f'; g.lineWidth = 12; g.strokeRect(6, 6, s - 12, s - 12);
    g.lineWidth = 9; g.beginPath(); g.moveTo(10, 10); g.lineTo(s - 10, s - 10); g.stroke();
  });
  TEX.canvas = canvasTex(128, (g, s) => { g.fillStyle = '#cdb084'; g.fillRect(0, 0, s, s); noise(g, s, 3000, 0.3, () => '#8a6e48'); g.fillStyle = 'rgba(90,60,30,.4)'; g.fillRect(0, s / 2 - 2, s, 4); });
  TEX.dot = canvasTex(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.4, 'rgba(255,255,255,0.5)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  TEX.dot.wrapS = TEX.dot.wrapT = THREE.ClampToEdgeWrapping;
}
export function tex(name) { return TEX[name]; }

// ── 렌더러·장면 ───────────────────────────────────────────
export function initRenderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(devicePixelRatio, G.touch ? 1.5 : 2));
  r.setSize(innerWidth, innerHeight, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.9;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.autoClear = false;
  G.renderer = r;

  const scene = new THREE.Scene(); G.scene = scene;
  scene.fog = new THREE.Fog(0xe2a26a, 60, 260);
  const cam = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 900); cam.rotation.order = 'YXZ';
  G.camera = cam;
  G.vmScene = new THREE.Scene();
  G.vmCamera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 10);
  makeTextures();
  addSky(); addLights(); addDesert();
}

const SUN_DIR = new THREE.Vector3(0.45, 0.32, -0.83).normalize();
let sun, sky;
function addSky() {
  const geo = new THREE.SphereGeometry(800, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: SUN_DIR }, storm: { value: 0 }, time: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 sunDir; uniform float storm; uniform float time;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<4;i++){ v+=a*vnoise(p); p*=2.03; a*=.5; } return v; }
      void main(){ float h = vDir.y;
        vec3 top = vec3(0.17,0.12,0.26), mid = vec3(0.86,0.45,0.27), hor = vec3(1.0,0.74,0.46);
        vec3 c = mix(hor, mid, smoothstep(0.0,0.18,h)); c = mix(c, top, smoothstep(0.18,0.75,h));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += vec3(1.0,0.62,0.3)*pow(s,8.0)*0.55 + vec3(1.0,0.9,0.7)*smoothstep(0.9975,0.999,s);
        // 얇은 새털구름 (지평선 쪽은 해 색으로 물듦)
        if (h > 0.02) {
          vec2 uv = vDir.xz / (h + 0.25) * 1.6 + vec2(time*0.004, time*0.01);
          float cl = smoothstep(0.55, 0.85, fbm(uv * vec2(1.0, 3.2)));
          vec3 cc = mix(vec3(1.0,0.78,0.6), vec3(1.0,0.55,0.38), smoothstep(0.0,0.3,h)) + vec3(1.0,0.6,0.3)*pow(s,4.0)*0.6;
          c = mix(c, cc, cl * smoothstep(0.02, 0.12, h) * 0.75);
        }
        c = mix(c, vec3(0.78,0.52,0.32), storm*0.85);
        if (h < 0.0) c = mix(hor, vec3(0.78,0.52,0.32), storm);
        gl_FragColor = vec4(c,1.); }`,
  });
  sky = new THREE.Mesh(geo, mat); sky.renderOrder = -1; G.scene.add(sky);
  // 환경광: 하늘 그라데이션을 반사맵으로 (금속이 검게 보이지 않게)
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat.clone());
  envSky.material.uniforms.sunDir.value = SUN_DIR;
  const floor = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ color: 0xc8864f }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1;
  envScene.add(envSky, floor);
  const pm = new THREE.PMREMGenerator(G.renderer);
  const env = pm.fromScene(envScene, 0.02).texture;
  G.scene.environment = env; G.scene.environmentIntensity = 0.9;
  G.vmScene.environment = env; G.vmScene.environmentIntensity = 0.9;
}
function addLights() {
  const hemi = new THREE.HemisphereLight(0xffd2a0, 0x7a4026, 1.05); G.scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffc080, 3.1);
  sun.castShadow = true; sun.shadow.mapSize.set(G.touch ? 1024 : 2048, G.touch ? 1024 : 2048);
  const sc = sun.shadow.camera; sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 120;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  G.scene.add(sun, sun.target);
  // 무기 장면 조명
  G.vmScene.add(new THREE.HemisphereLight(0xffe0bb, 0x6b3a20, 1.6));
  const d = new THREE.DirectionalLight(0xffc68a, 2.2); d.position.copy(SUN_DIR); G.vmScene.add(d);
  G.vmScene.add(new THREE.AmbientLight(0xffffff, 0.15));
}
export function updateSunFollow(p) {
  sun.position.set(p.x + SUN_DIR.x * 60, SUN_DIR.y * 60 + 4, p.z + SUN_DIR.z * 60);
  sun.target.position.set(p.x, 2, p.z);
}

// ── 사막 ─────────────────────────────────────────────────
const scroll = { props: [], mesas: [], ground: null, bed: null, S: 0, uS: { value: 0 } };
// GLSL duneH와 같은 식 (소품을 언덕 위에 앉히려고)
export function duneH(x, z) {
  const zz = z - scroll.S, ax = Math.abs(x);
  const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  return ss(16, 46, ax) * (3.4 * Math.sin(x * 0.021 + zz * 0.013) + 2.3 * Math.sin(x * 0.047 - zz * 0.031 + 1.7) + 1.1 * Math.sin(x * 0.11 + zz * 0.07 + 0.4) + 3.0)
    + ss(9, 16, ax) * 0.25 * Math.sin(zz * 0.2 + x) - 0.05;
}
function addDesert() {
  // 모래언덕 지형: 정점 셰이더에서 높이를 만들고 열차 진행에 맞춰 흘려보낸다 (CPU와 같은 식 = duneH)
  const gmat = new THREE.MeshStandardMaterial({ map: TEX.sand, roughness: 0.95, color: 0xe6d2bc });
  gmat.onBeforeCompile = (sh) => {
    sh.uniforms.uS = scroll.uS;
    const H = `uniform float uS;
      float duneH(vec2 p){ float zz = p.y - uS; float ax = abs(p.x); float fl = smoothstep(16.0, 46.0, ax);
        return fl * (3.4*sin(p.x*0.021 + zz*0.013) + 2.3*sin(p.x*0.047 - zz*0.031 + 1.7) + 1.1*sin(p.x*0.11 + zz*0.07 + 0.4) + 3.0)
             + smoothstep(9.0, 16.0, ax) * 0.25 * sin(zz*0.2 + p.x); }`;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + H)
      .replace('#include <beginnormal_vertex>', `vec2 wxz = (modelMatrix*vec4(position,1.)).xz;
        float e = 0.6; float h0 = duneH(wxz);
        float dx = (duneH(wxz+vec2(e,0.)) - h0)/e, dz = (duneH(wxz+vec2(0.,e)) - h0)/e;
        vec3 objectNormal = normalize(vec3(-dx, dz, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position); transformed.z += h0;');
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200, 180, 180), gmat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true; G.scene.add(ground); scroll.ground = ground;
  // 선로 바닥(자갈+침목)
  const bt = TEX.gravel; bt.repeat.set(1, 150);
  const bed = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.3, 600), new THREE.MeshStandardMaterial({ map: bt, roughness: 1 }));
  bed.position.y = 0.0; bed.receiveShadow = true; G.scene.add(bed); scroll.bed = bed;
  const railM = new THREE.MeshStandardMaterial({ color: 0x9a8f86, metalness: 0.9, roughness: 0.35 });
  for (const x of [-0.72, 0.72]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 600), railM); r.position.set(x, 0.23, 0); G.scene.add(r);
  }
  // 옆 선로 (나중 보스 열차용 느낌)
  const bed2 = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.25, 600), bed.material); bed2.position.set(-16, -0.02, 0); bed2.receiveShadow = true; G.scene.add(bed2);
  scroll.bed2 = bed2;
  for (const x of [-16.72, -15.28]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 600), railM); r.position.set(x, 0.2, 0); G.scene.add(r); }
  // 먼 메사(탁상지)
  const mm = new THREE.MeshStandardMaterial({ color: 0xb4603a, roughness: 1, flatShading: true });
  for (let i = 0; i < 16; i++) {
    const r = rand(30, 90), h = rand(25, 70);
    const g = new THREE.CylinderGeometry(r * rand(0.6, 0.85), r, h, 7, 2);
    const pos = g.attributes.position; for (let k = 0; k < pos.count; k++) { pos.setX(k, pos.getX(k) * rand(0.9, 1.1)); pos.setZ(k, pos.getZ(k) * rand(0.9, 1.1)); }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mm);
    const side = i % 2 ? 1 : -1;
    m.position.set(side * rand(220, 520), h / 2 - 2, rand(-700, 500));
    G.scene.add(m); scroll.mesas.push(m);
  }
}

// GLB 소품을 재질별로 합쳐 InstancedMesh로 (수십 개도 그리기 호출 몇 번)
function instancedFromNode(node, count) {
  node.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const groups = new Map();
  node.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    const key = o.material.name || o.material.uuid;
    if (!groups.has(key)) groups.set(key, { mat: o.material, geos: [] });
    groups.get(key).geos.push(g);
  });
  const meshes = [];
  for (const { mat, geos } of groups.values()) {
    const im = new THREE.InstancedMesh(mergeGeometries(geos), mat, count);
    im.castShadow = false; im.receiveShadow = false; im.frustumCulled = false;
    G.scene.add(im); meshes.push(im);
  }
  return meshes;
}
function setupProps() {
  const P = G.models.props;
  const kinds = [
    { node: P.getObjectByName('Cactus'), n: 34, x: [6, 70], s: [0.8, 1.4] },
    { node: P.getObjectByName('Rock'), n: 26, x: [7, 90], s: [0.7, 2.6] },
    { node: P.getObjectByName('Pole'), n: 14, x: [9, 9], s: [1, 1], poles: true },
  ];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  for (const k of kinds) {
    const meshes = instancedFromNode(k.node, k.n);
    const items = [];
    for (let i = 0; i < k.n; i++) {
      const it = { side: k.poles ? 1 : (Math.random() < 0.5 ? -1 : 1), x: 0, z: 0, s: rand(...k.s), ry: rand(0, 6.28) };
      it.x = k.poles ? 8.5 : it.side * rand(...k.x);
      it.z = k.poles ? -300 + i * (500 / k.n) : rand(-300, 200);
      if (!k.poles && it.side < 0 && Math.abs(it.x + 16) < 4) it.x -= 6; // 옆 선로 피하기
      items.push(it);
    }
    scroll.props.push({ meshes, items, poles: k.poles,
      write() {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, k.poles ? 0 : it.ry);
          m4.compose(p.set(it.x, duneH(it.x, it.z) - 0.1, it.z), q, sc.setScalar(it.s));
          for (const m of meshes) m.setMatrixAt(i, m4);
        }
        for (const m of meshes) m.instanceMatrix.needsUpdate = true;
      } });
  }
}
// 전신줄 (전신주 사이를 잇는 선, 같이 흘러감)
let wires;
function setupWires() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(14 * 2 * 3 * 2), 3));
  wires = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a2a20, transparent: true, opacity: 0.6 }));
  wires.frustumCulled = false; G.scene.add(wires);
}

export function updateWorld(dt) {
  const dz = G.speed * dt;
  scroll.S += dz; scroll.uS.value = scroll.S;
  scroll.ground.material.map.offset.y += dz * (80 / 1200);
  sky.material.uniforms.time.value = G.time;
  scroll.bed.material.map.offset.y += dz * (150 / 600);
  for (const m of scroll.mesas) { m.position.z += dz * 0.06; if (m.position.z > 520) m.position.z -= 1220; }
  for (const grp of scroll.props) {
    for (const it of grp.items) {
      it.z += dz;
      if (it.z > 160) {
        it.z -= 460;
        if (!grp.poles) { it.side = Math.random() < 0.5 ? -1 : 1; it.x = it.side * rand(7, 80); if (it.side < 0 && Math.abs(it.x + 16) < 4) it.x -= 6; it.s = rand(0.7, 1.8); }
      }
    }
    grp.write();
  }
  // 전신줄 갱신
  const poles = scroll.props.find((g) => g.poles).items.slice().sort((a, b) => a.z - b.z);
  const arr = wires.geometry.attributes.position.array; let k = 0;
  for (let i = 0; i < poles.length - 1; i++) {
    const a = poles[i], b = poles[i + 1]; if (b.z - a.z > 60) continue;
    for (const ox of [-0.55, 0.55]) {
      arr[k++] = a.x + ox; arr[k++] = 4.75; arr[k++] = a.z; arr[k++] = b.x + ox; arr[k++] = 4.75; arr[k++] = b.z;
    }
  }
  for (; k < arr.length; k++) arr[k] = 0;
  wires.geometry.attributes.position.needsUpdate = true;
  // 모래폭풍
  const f = G.scene.fog;
  f.near = 60 - G.storm * 52; f.far = 260 - G.storm * 205;
  f.color.setRGB(0.89 - G.storm * 0.12, 0.64 - G.storm * 0.1, 0.42 - G.storm * 0.08);
  sky.material.uniforms.storm.value = G.storm;
}

// ── 모델 불러오기 ──────────────────────────────────────────
export async function loadModels(onProgress) {
  const loader = new GLTFLoader();
  const names = ['locomotive', 'bogie', 'bike2', 'bandit', 'walker', 'drone', 'rifle', 'props', 'train_props', 'car_flatgun', 'car_freight', 'car_flatrepair', 'car_passenger', 'car_caboose'];
  let done = 0;
  await Promise.all(names.map(async (n) => {
    const g = await loader.loadAsync(`assets/models/${n}.glb`);
    g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    G.models[n] = g.scene;
    onProgress?.(++done / names.length);
  }));
  const map = await (await fetch('assets/map.json')).json();
  G.map = map;
}

// ── 열차 ─────────────────────────────────────────────────
const LOCO_TAGS = ['보일러', '연통부', '운전실', '기관차 바닥'];
export const trainGroup = new THREE.Group();
export function buildTrain() {
  G.scene.add(trainGroup);
  const M = G.map;
  const mats = {
    floor: new THREE.MeshStandardMaterial({ map: TEX.planks, color: 0x9a6b45, roughness: 0.85 }),
    freight: new THREE.MeshStandardMaterial({ map: TEX.planks, color: 0xa04a2c, roughness: 0.8 }),
    pass: new THREE.MeshStandardMaterial({ map: TEX.planks, color: 0x3f6b5f, roughness: 0.7 }),
    caboose: new THREE.MeshStandardMaterial({ map: TEX.planks, color: 0xb23a26, roughness: 0.75 }),
    roof: new THREE.MeshStandardMaterial({ map: TEX.metal, color: 0x7a3a26, roughness: 0.6, metalness: 0.3 }),
    iron: new THREE.MeshStandardMaterial({ map: TEX.metal, color: 0x6a5f57, roughness: 0.55, metalness: 0.4 }),
    crate: new THREE.MeshStandardMaterial({ map: TEX.crate, roughness: 0.9 }),
    canvas: new THREE.MeshStandardMaterial({ map: TEX.canvas, roughness: 1 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x7a2a22, roughness: 0.8 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9973a, roughness: 0.3, metalness: 1 }),
    stove: new THREE.MeshStandardMaterial({ color: 0x2d2a28, roughness: 0.4, metalness: 0.8 }),
    railing: new THREE.MeshStandardMaterial({ map: TEX.metal, color: 0x8a5236, roughness: 0.6, metalness: 0.35 }),
  };
  G.trainMats = mats;
  const pickMat = (t) => {
    if (t.includes('바닥')) return mats.floor;
    if (t.includes('지붕') && !t.includes('환기구')) return mats.roof;
    if (t.includes('환기구')) return mats.iron;
    if (t.includes('화물칸')) return mats.freight;
    if (t.includes('승객칸')) return mats.pass;
    if (t.includes('전망실')) return mats.caboose;
    if (t.includes('상자') || t.includes('공구함')) return mats.crate;
    if (t.includes('모래주머니')) return mats.canvas;
    if (t.includes('좌석')) return mats.seat;
    if (t.includes('난로')) return mats.stove;
    if (t.includes('난간')) return mats.railing;
    return mats.iron;
  };
  const byMat = new Map();
  const inst = { crate: [], bags: [], seat: [] };
  const STRUCT = ['바닥', '벽', '지붕', '난간', '환기구'];
  G.boxes = [];
  for (const s of M.solids) {
    const y = s.y || 0;
    let min, max;
    if (s.type === 'box') { min = [s.x - s.w / 2, y, s.z - s.d / 2]; max = [s.x + s.w / 2, y + s.h, s.z + s.d / 2]; }
    else if (s.type === 'cyl') { min = [s.x - s.r * 0.8, y, s.z - s.r * 0.8]; max = [s.x + s.r * 0.8, y + s.h, s.z + s.r * 0.8]; }
    else continue;
    G.boxes.push({ min, max, tag: s.tag });
    // 겉모습: 객차 몸체는 Blender 모델, 소품은 인스턴스, 나머지만 상자
    if (LOCO_TAGS.some((t) => s.tag.includes(t)) || s.tag.includes('거치')) continue;
    if (STRUCT.some((t) => s.tag.includes(t))) continue;
    if (s.tag.includes('상자') || s.tag.includes('공구함')) { inst.crate.push(s); continue; }
    if (s.tag.includes('모래주머니')) { inst.bags.push(s); continue; }
    if (s.tag.includes('좌석')) { inst.seat.push(s); continue; }
    const g = new THREE.BoxGeometry(s.w, s.h, s.d);
    g.translate(s.x, y + s.h / 2, s.z);
    const m = pickMat(s.tag);
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m).push(g);
  }
  for (const [m, geos] of byMat) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), m); mesh.castShadow = mesh.receiveShadow = true; trainGroup.add(mesh);
  }
  // 객차 모델 (Blender) — 충돌 상자와 같은 치수
  const cars = [null, 'car_flatgun', 'car_freight', 'car_flatrepair', 'car_passenger', 'car_caboose'];
  for (let i = 1; i < 6; i++) {
    const [z0, z1] = TRAIN.carZ(i);
    const c = G.models[cars[i]].clone(true); c.position.set(0, 0, (z0 + z1) / 2); trainGroup.add(c);
    for (const z of [z0 + 2.4, z1 - 2.4]) { const b = G.models.bogie.clone(true); b.position.set(0, 0, z); trainGroup.add(b); }
  }
  // 소품 인스턴스
  const TP = G.models.train_props;
  const place = (nodeName, list, size) => {
    if (!list.length) return;
    const node = TP.getObjectByName(nodeName);
    node.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
    const groups = new Map();
    node.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
      if (!groups.has(o.material)) groups.set(o.material, []);
      groups.get(o.material).push(g);
    });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (const [mat, geos] of groups) {
      const im = new THREE.InstancedMesh(mergeGeometries(geos), mat, list.length);
      list.forEach((s, i) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.rot || 0);
        m4.compose(p.set(s.x, s.y || 0, s.z), q, size ? sc.set(s.w / size[0], s.h / size[1], s.d / size[2]) : sc.set(1, 1, 1));
        im.setMatrixAt(i, m4);
      });
      im.castShadow = im.receiveShadow = true; trainGroup.add(im);
    }
  };
  inst.crate.forEach((s, i) => { s.rot = (i % 2) * Math.PI / 2; });
  place('Crate', inst.crate, [1, 1, 1]);
  inst.bags.forEach((s, i) => { s.rot = i % 2 ? Math.PI : 0; });
  place('Sandbags', inst.bags, [1.0, 1.04, 0.66]);
  inst.seat.forEach((s) => { s.y = TRAIN.FLOOR - 0.0; s.rot = 0; });
  place('Seat', inst.seat, null);
  // 금고 (Blender 모델)
  const v = VAULT;
  G.boxes.push({ min: [v.x - v.w / 2, TRAIN.FLOOR, v.z - v.d / 2], max: [v.x + v.w / 2, TRAIN.FLOOR + v.h, v.z + v.d / 2], tag: '금고' });
  const vault = TP.getObjectByName('Vault').clone(true);
  vault.position.set(v.x, TRAIN.FLOOR, v.z); vault.rotation.y = Math.PI / 2;
  vault.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  trainGroup.add(vault); G.vaultMesh = vault;

  // 기관차 GLB (중심 z=-34)
  const loco = G.models.locomotive.clone(true); loco.position.set(0, 0, -34); trainGroup.add(loco); G.loco = loco;
  // 사다리 (기관차 앞쪽 것 제외)
  G.ladders = [];
  const ladM = mats.iron;
  for (const p of M.pads) {
    if (p.z < -30 && p.z > -34) continue;
    G.ladders.push({ x: p.x, z: p.z, top: p.to_height });
    const grp = new THREE.Group();
    for (const dx of [-0.17, 0.17]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.0, 0.05), ladM); r.position.set(dx, 2.7, 0); grp.add(r); }
    for (let k = 0; k < 7; k++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.04), ladM); r.position.set(0, 1.5 + k * 0.42, 0); grp.add(r); }
    grp.position.set(p.x, 0, p.z); trainGroup.add(grp);
  }
  // 화물칸 간판 (판자벽 위쪽 띠)
  const sign = canvasTex(512, (g, s) => {
    g.clearRect(0, 0, s, s); g.fillStyle = '#efd29a'; g.fillRect(0, s * 0.36, s, s * 0.28);
    g.strokeStyle = '#5a2414'; g.lineWidth = 6; g.strokeRect(8, s * 0.36 + 8, s - 16, s * 0.28 - 16);
    g.fillStyle = '#5a2414'; g.font = '900 58px "Black Han Sans", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('OASIS EXPRESS', s / 2, s / 2 + 2);
  });
  sign.wrapS = sign.wrapT = THREE.ClampToEdgeWrapping;
  const signM = new THREE.MeshStandardMaterial({ map: sign, transparent: true, roughness: 0.8 });
  for (const sx of [-1, 1]) for (const zc of [-11.1, -3.3]) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), signM);
    pl.position.set(sx * 1.53, 3.55, zc); pl.rotation.y = sx * Math.PI / 2; trainGroup.add(pl);
  }
  buildMountedGun();
  setupProps(); setupWires();
}

// 거치 기관총 (무기칸)
function buildMountedGun() {
  const gp = G.map.gun;
  const root = new THREE.Group(); root.position.set(gp.x, TRAIN.FLOOR, gp.z);
  const iron = G.trainMats.iron, brass = G.trainMats.brass;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.7, 12), iron); base.position.y = 0.35; root.add(base);
  const yaw = new THREE.Group(); yaw.position.y = 0.95; root.add(yaw);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, 0.8), iron); yaw.add(body);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.06), G.trainMats.roof); shield.position.set(0, 0.15, -0.45); yaw.add(shield);
  const barrels = new THREE.Group(); barrels.position.set(0, 0.02, -0.5); yaw.add(barrels);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6), iron); b.rotation.x = Math.PI / 2; b.position.set(Math.cos(a) * 0.08, Math.sin(a) * 0.08, -0.5); barrels.add(b);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 6, 16), brass); ring.position.z = -1.0; barrels.add(ring);
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.05), brass); hand.position.set(0, -0.05, 0.45); yaw.add(hand);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  trainGroup.add(root);
  G.gun = { root, yaw, barrels, pos: new THREE.Vector3(gp.x, TRAIN.FLOOR, gp.z) };
}

// ── 충돌 ─────────────────────────────────────────────────
// 원통형 몸(반지름 r, 높이 h)을 상자 목록과 축별로 밀어내며 이동
export function groundAt(x, z, feetY, r, step) {
  let g = -10;
  for (const b of G.boxes) {
    if (x + r * 0.7 < b.min[0] || x - r * 0.7 > b.max[0] || z + r * 0.7 < b.min[2] || z - r * 0.7 > b.max[2]) continue;
    const top = b.max[1];
    if (top <= feetY + step + 1e-3 && top > g) g = top;
  }
  // 열차 밖은 모래(0) — 떨어지면 처리
  return Math.max(g, 0);
}
export function blocked(x, z, feetY, r, h, step) {
  for (const b of G.boxes) {
    if (b.max[1] <= feetY + step || b.min[1] >= feetY + h) continue;
    if (x + r > b.min[0] && x - r < b.max[0] && z + r > b.min[2] && z - r < b.max[2]) return true;
  }
  return false;
}
export function moveBody(p, v, dt, r, h, step) {
  // p: {x,y,z} feet, v: {x,y,z}
  const nx = p.x + v.x * dt;
  if (!blocked(nx, p.z, p.y, r, h, step)) p.x = nx; else v.x = 0;
  const nz = p.z + v.z * dt;
  if (!blocked(p.x, nz, p.y, r, h, step)) p.z = nz; else v.z = 0;
  // 수직
  const g = groundAt(p.x, p.z, p.y, r, step);
  let onGround = false;
  if (v.y <= 0 && p.y + v.y * dt <= g) { p.y = g; v.y = 0; onGround = true; }
  else {
    const ny = p.y + v.y * dt;
    if (v.y > 0 && blocked(p.x, p.z, ny, r * 0.8, h, 0.0)) v.y = 0; else p.y = ny;
  }
  // 계단 올라서기
  if (onGround && p.y < g) p.y = g;
  return onGround;
}

// 광선 vs 상자 — 가장 가까운 거리(없으면 Infinity)
export function rayBoxes(o, d, maxT = 200) {
  let best = maxT;
  for (const b of G.boxes) {
    let t0 = 0, t1 = best;
    let hit = true;
    for (let a = 0; a < 3; a++) {
      const oa = a === 0 ? o.x : a === 1 ? o.y : o.z, da = a === 0 ? d.x : a === 1 ? d.y : d.z;
      if (Math.abs(da) < 1e-8) { if (oa < b.min[a] || oa > b.max[a]) { hit = false; break; } continue; }
      let ta = (b.min[a] - oa) / da, tb = (b.max[a] - oa) / da;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) { hit = false; break; }
    }
    if (hit && t0 < best) best = t0;
  }
  // 사막 바닥
  if (d.y < -1e-4) { const tg = -o.y / d.y; if (tg > 0 && tg < best) best = tg; }
  return best;
}
export function lineOfSight(a, b) {
  const d = new THREE.Vector3().subVectors(b, a); const L = d.length(); d.divideScalar(L);
  return rayBoxes(a, d, L) >= L - 0.05;
}
export function onTrain(x, z) { return Math.abs(x) < 1.5 && z > TRAIN.front && z < TRAIN.back; }
export { clamp };
