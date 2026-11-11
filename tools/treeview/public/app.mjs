/* treeview 前端：3D 整树 + 实时路径/失败标记。核心只依赖 /api/model 与 /api/state。 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const TYPE_COLOR = {
  recipe: 0xffb74d,
  step: 0x4fc3f7,
  skill: 0xb388ff,
  interrupt: 0xff5252,
  schedule: 0x69f0ae,
  craft: 0xffd54f,
  port: 0x62f5ff,
  core: 0xffcc66,
};
const TYPE_SIZE = { recipe: 2.5, step: 1.25, skill: 1.45, interrupt: 1.55, schedule: 1.8, craft: 1.15, port: 3.1, core: 2.4 };
const EDGE_COLOR = {
  start: 0x4fc3f7,
  step: 0x2b5680,
  next: 0x4fc3f7,
  onFail: 0xff6d6d,
  match: 0x8a7dff,
  uses: 0x6f5cff,
  interrupt: 0xff5252,
  interrupt_plan: 0xff8a80,
  schedule_work: 0x69f0ae,
  schedule_skill: 0x69f0ae,
  craft: 0xffd54f,
  port_in: 0x62f5ff,
  port_out: 0xffcc66,
  core: 0xffcc66,
  plans: 0xffd08a,
  exec: 0x8f7bff,
  interrupt_check: 0xff5252,
  schedule: 0x69f0ae,
};

const state = {
  model: null,
  nodeById: new Map(),
  nodeMeshes: [],
  labels: [],
  edgeLines: [],
  modelVersion: null,
  pollTimer: null,
  lastState: null,
  lastEventAt: new Map(), // companion -> last processed event t
  companions: new Map(), // name -> {history:[], markers:Map, color, hue, group}
  showLabels: true,
  showFail: true,
  pathN: 3,
  hovered: null,
  pinned: null,
  lastPollOk: null,
  cardEls: new Map(), // companion name -> 已创建的卡片 DOM 引用（增量更新，不每秒重建）
  cardCollapsed: new Map(), // companion name -> 折叠状态（跨轮询保留）
  cardPlaceholder: null, // 无同伴时的占位卡
};

// ── HUD 尺寸实测 ─────────────────────────────────────────────
// 顶栏在窄视口会换行变高；左右面板的 top 由 --top-h 驱动，避免写死 56px 导致盖住顶栏。
// 图例/底部提示同理，面板底部避开它们。
function markScrollable(el) {
  if (el) el.classList.toggle('scrollable', el.scrollHeight > el.clientHeight + 1);
}
// 面板内容溢出（每个滚动区）时才接管指针，否则空白处仍可拖拽旋转 3D
function syncPanelScrollable() {
  markScrollable($('companions'));
  markScrollable(document.querySelector('.hud.right'));
}
function syncHudMetrics() {
  const style = document.documentElement.style;
  const h = (el) => (el ? Math.ceil(el.getBoundingClientRect().height) : 0);
  style.setProperty('--top-h', `${h(document.querySelector('.hud.top'))}px`);
  style.setProperty('--legend-h', `${h(document.getElementById('legend'))}px`);
  syncPanelScrollable();
}
(function watchHudMetrics() {
  syncHudMetrics();
  const targets = [document.querySelector('.hud.top'), document.getElementById('legend')].filter(Boolean);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(syncHudMetrics);
    for (const el of targets) ro.observe(el);
  }
  addEventListener('resize', syncHudMetrics);
})();


// ── three 基础 ────────────────────────────────────────────────
const app = $('app');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050810, 0.0022);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);
camera.position.set(0, 90, 210);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.set(0, 10, 0);
controls.minDistance = 12;
controls.maxDistance = 420;
controls.maxPolarAngle = Math.PI * 0.92;

scene.add(new THREE.AmbientLight(0x8899ff, 0.55));
const key = new THREE.DirectionalLight(0xaad4ff, 1.1);
key.position.set(60, 120, 40);
scene.add(key);
const warm = new THREE.PointLight(0xffb74d, 1.2, 900);
warm.position.set(-80, 40, 60);
scene.add(warm);
const cool = new THREE.PointLight(0x4fc3f7, 1.0, 900);
cool.position.set(90, 70, -70);
scene.add(cool);

// 星尘背景
(function stars() {
  const n = 1600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 320 + Math.random() * 900;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.7;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fc4ff, size: 1.6, transparent: true, opacity: 0.55, depthWrite: false })));
})();

// 底座光晕
(function core() {
  const g = new THREE.CylinderGeometry(2.2, 2.2, 160, 24, 1, true);
  const m = new THREE.MeshBasicMaterial({ color: 0x3f7fff, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
  const cyl = new THREE.Mesh(g, m);
  cyl.position.y = 10;
  scene.add(cyl);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(26, 27.2, 128),
    new THREE.MeshBasicMaterial({ color: 0x4f8fff, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -30;
  scene.add(ring);
})();

// ── 标签/发光 sprite ─────────────────────────────────────────
function canvasTexture(text, color = '#dbe8ff', fontPx = 44, bg = 'rgba(5,10,20,0.72)') {
  const pad = 14;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${fontPx}px "Segoe UI","Microsoft YaHei",sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.font = `600 ${fontPx}px "Segoe UI","Microsoft YaHei",sans-serif`;
  x.fillStyle = bg;
  x.beginPath();
  const r = 16;
  x.moveTo(r, 0);
  x.arcTo(w, 0, w, h, r);
  x.arcTo(w, h, 0, h, r);
  x.arcTo(0, h, 0, 0, r);
  x.arcTo(0, 0, w, 0, r);
  x.fill();
  x.fillStyle = color;
  x.textBaseline = 'middle';
  x.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return { tex, aspect: w / h };
}
function makeLabel(text, color, px = 42, scale = 3.2) {
  const { tex, aspect } = canvasTexture(text, color, px);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scale * aspect, scale, 1);
  return sp;
}
let glowTex = null;
function getGlowTex() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d').createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  const ctx = c.getContext('2d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
function glowSprite(color, size) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTex(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0.75 }));
  sp.scale.set(size, size, 1);
  return sp;
}

// ── 布局（确定性：模型加载时算一次）──────────────────────────
function layout(model) {
  const pos = new Map();
  const recipes = model.nodes.filter((n) => n.type === 'recipe');
  const steps = model.nodes.filter((n) => n.type === 'step');
  const skills = model.nodes.filter((n) => n.type === 'skill');
  const ints = model.nodes.filter((n) => n.type === 'interrupt');
  const scheds = model.nodes.filter((n) => n.type === 'schedule');
  const crafts = model.nodes.filter((n) => n.type === 'craft');

  const R0 = 36;
  const recipeAngle = new Map();
  recipes.forEach((r, i) => {
    const a = (i / Math.max(1, recipes.length)) * Math.PI * 2 - Math.PI / 2;
    recipeAngle.set(r.id, a);
    pos.set(r.id, new THREE.Vector3(Math.cos(a) * R0, 2, Math.sin(a) * R0));
  });
  // 步骤沿半径向外展开（同一配方一条链）
  const byRecipe = new Map();
  for (const s of steps) {
    if (!byRecipe.has(s.recipeId)) byRecipe.set(s.recipeId, []);
    byRecipe.get(s.recipeId).push(s);
  }
  for (const [rid, list] of byRecipe) {
    const a = recipeAngle.get(rid) ?? 0;
    list.sort((x, y) => x.stepIndex - y.stepIndex);
    list.forEach((s, k) => {
      const rr = R0 + 7.5 + k * 7;
      pos.set(s.id, new THREE.Vector3(Math.cos(a) * rr, 2 + Math.sin(k * 0.9) * 1.2, Math.sin(a) * rr));
    });
  }
  // 技能：上层环
  skills.forEach((s, i) => {
    const a = (i / Math.max(1, skills.length)) * Math.PI * 2;
    pos.set(s.id, new THREE.Vector3(Math.cos(a) * 64, 30 + (i % 3) * 3, Math.sin(a) * 64));
  });
  // 中断：更外圈
  ints.forEach((s, i) => {
    const a = (i / Math.max(1, ints.length)) * Math.PI * 2 + 0.2;
    pos.set(s.id, new THREE.Vector3(Math.cos(a) * 82, 14 + (i % 2) * 4, Math.sin(a) * 82));
  });
  // 日程：内圈高处
  scheds.forEach((s, i) => {
    const a = (i / Math.max(1, scheds.length)) * Math.PI * 2;
    pos.set(s.id, new THREE.Vector3(Math.cos(a) * 20, 46, Math.sin(a) * 20));
  });
  // 合成树：下方方阵
  crafts.forEach((s, i) => {
    const cols = 8;
    const x = ((i % cols) - (cols - 1) / 2) * 9;
    const z = (Math.floor(i / cols) - 1.5) * 9;
    pos.set(s.id, new THREE.Vector3(x, -26 - (i % 2) * 1.5, z));
  });
  // 边界端口（两头端点）：左 = 输入（LLM/控制），右 = 游戏出入口
  pos.set('port:tree_mcp', new THREE.Vector3(-132, 26, 0));
  pos.set('port:control', new THREE.Vector3(-132, -2, 34));
  pos.set('port:numen', new THREE.Vector3(132, 18, 0));
  // 核心链路（中间脊柱）
  pos.set('core:lane', new THREE.Vector3(0, 14, 0));
  pos.set('core:planner', new THREE.Vector3(-14, 34, -10));
  pos.set('core:arbiter', new THREE.Vector3(14, 34, 10));
  pos.set('core:executor', new THREE.Vector3(0, 26, 18));
  pos.set('core:observer', new THREE.Vector3(0, 40, 26));
  return pos;
}

// ── 构建/重建场景 ────────────────────────────────────────────
// worldGroup 是"树的主体"根 group：整树 + 同伴路径/标记/名字都挂在它下面。
// 空闲自动旋转只转 worldGroup，不动相机/OrbitControls，也不动 HUD。
const worldGroup = new THREE.Group();
scene.add(worldGroup);

const treeGroup = new THREE.Group();
worldGroup.add(treeGroup);

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    g.remove(c);
    c.traverse?.((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.map?.dispose?.();
          m.dispose?.();
        }
      }
    });
  }
}

function buildScene(model) {
  clearGroup(treeGroup);
  state.nodeById.clear();
  state.nodeMeshes = [];
  state.labels = [];
  state.edgeLines = [];
  state.model = model;
  const pos = layout(model);

  // 边
  const edgePts = (a, b, lift = 6) => {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += lift;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    return curve.getPoints(18);
  };
  for (const e of model.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const color = EDGE_COLOR[e.type] ?? 0x35507a;
    const lift = e.type === 'uses' ? 12 : e.type === 'interrupt' || e.type === 'interrupt_plan' ? 20 : 5;
    const pts = edgePts(a, b, lift);
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const opacity = ['step', 'craft'].includes(e.type) ? 0.4 : 0.26;
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(g, m);
    line.userData = { edge: e };
    treeGroup.add(line);
    state.edgeLines.push(line);
  }

  // 节点
  const geoFor = (type) => {
    switch (type) {
      case 'recipe': return new THREE.IcosahedronGeometry(TYPE_SIZE.recipe, 1);
      case 'step': return new THREE.SphereGeometry(TYPE_SIZE.step, 18, 12);
      case 'skill': return new THREE.OctahedronGeometry(TYPE_SIZE.skill, 0);
      case 'interrupt': return new THREE.TetrahedronGeometry(TYPE_SIZE.interrupt, 0);
      case 'schedule': return new THREE.BoxGeometry(TYPE_SIZE.schedule, TYPE_SIZE.schedule, TYPE_SIZE.schedule);
      case 'port': return new THREE.TorusGeometry(TYPE_SIZE.port * 0.72, TYPE_SIZE.port * 0.2, 14, 44);
      case 'core': return new THREE.IcosahedronGeometry(TYPE_SIZE.core, 0);
      default: return new THREE.DodecahedronGeometry(TYPE_SIZE.craft, 0);
    }
  };
  for (const n of model.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const color = TYPE_COLOR[n.type] ?? 0x9fb4d8;
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0.25 });
    const mesh = new THREE.Mesh(geoFor(n.type), mat);
    mesh.position.copy(p);
    mesh.userData = { node: n };
    treeGroup.add(mesh);
    state.nodeMeshes.push(mesh);
    state.nodeById.set(n.id, { node: n, mesh, pos: p, label: null, glow: null });
    const glow = glowSprite(color, n.type === 'recipe' ? 18 : n.type === 'skill' ? 11 : 8);
    glow.position.copy(p);
    treeGroup.add(glow);
    state.nodeById.get(n.id).glow = glow;
    state.nodeById.get(n.id).glowBase = n.type === 'recipe' ? 18 : n.type === 'skill' ? 11 : 8;

    const labelText = n.type === 'recipe' ? n.label : n.type === 'step' ? n.label : n.label;
    const big = n.type === 'recipe' || n.type === 'port' || n.type === 'core';
    const label = makeLabel(labelText, n.type === 'port' ? '#b8fbff' : n.type === 'core' ? '#ffe1a8' : n.type === 'recipe' ? '#ffd9a0' : '#cfe2ff', big ? 46 : 38, big ? 4.2 : 2.6);
    label.position.copy(p).add(new THREE.Vector3(0, (big ? 5.4 : 2.6), 0));
    label.userData = { node: n };
    treeGroup.add(label);
    state.nodeById.get(n.id).label = label;
    state.labels.push(label);
  }
  applyLabelVisibility();
  $('modelCounts').textContent = `${model.counts.nodes} 节点 / ${model.counts.edges} 边`;
  $('modelVersion').textContent = state.modelVersion ?? '–';
  $('hint').textContent = `模型: ${model.counts.recipes} 配方 · ${model.counts.steps} 步骤 · ${model.counts.skills} 技能 · ${model.counts.interrupts} 中断 · ${model.counts.schedules} 日程 · ${model.counts.craft} 合成`;
}

function applyLabelVisibility() {
  const d = camera.position.distanceTo(controls.target);
  for (const l of state.labels) {
    const n = l.userData.node;
    let vis = state.showLabels;
    if (vis) {
      if (n.type === 'step') vis = d < 210;
      if (n.type === 'skill') vis = d < 260;
      if (n.type === 'interrupt' || n.type === 'schedule') vis = d < 300;
      if (n.type === 'craft') vis = d < 180;
      if (n.type === 'recipe') vis = true;
    }
    l.visible = vis;
    l.material.opacity = n.type === 'recipe' ? 0.95 : 0.8;
  }
}

// ── 同伴路径（实时）───────────────────────────────────────────
function hueColor(h, s = 0.95, l = 0.55) {
  return new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l);
}
function companionMeta(name) {
  if (!state.companions.has(name)) {
    const idx = state.companions.size;
    const n = Math.max(2, state.lastState?.status?.companions?.length ?? 2);
    const hue = (idx * 360) / n;
    state.companions.set(name, { history: [], markers: new Map(), color: hueColor(hue), hue, group: new THREE.Group(), label: null });
    worldGroup.add(state.companions.get(name).group);
  }
  return state.companions.get(name);
}

function nodePos(id) {
  return state.nodeById.get(id)?.pos ?? null;
}

function nodeExists(id) {
  return state.nodeById.has(id);
}

function pushHistory(meta, id, dedupe = true) {
  if (!nodeExists(id)) return;
  if (dedupe && meta.history[meta.history.length - 1] === id) return;
  meta.history.push(id);
  if (meta.history.length > 16) meta.history.shift();
}

function clearMarker(meta, id) {
  meta.markers.delete(id);
}

function addMarker(meta, id, failKind) {
  if (!nodeExists(id)) return;
  const m = meta.markers.get(id) ?? { kind: failKind, at: Date.now(), count: 0 };
  m.kind = failKind ?? m.kind;
  m.at = Date.now();
  m.count += 1;
  meta.markers.set(id, m);
}

function processEvents(status, events) {
  const comps = status?.status?.companions ?? [];
  for (const c of comps) {
    const meta = companionMeta(c.name);
    const last = state.lastEventAt.get(c.name) ?? 0;
    let newest = last;
    const list = events.filter((e) => e.companion === c.name);
    for (const e of list) {
      const t = Date.parse(e.t);
      if (!Number.isFinite(t) || t <= last) continue;
      newest = Math.max(newest, t);
      const stepNode = e.activity === 'plan_step' && e.recipeId && e.step ? `r:${e.recipeId}:step:${e.step}` : null;
      const skillNode = e.skill ? `k:${e.skill}` : null;
      if (e.activity === 'plan_step') {
        if (stepNode) {
          pushHistory(meta, stepNode);
          if (e.ok === false) addMarker(meta, stepNode, e.failKind ?? 'failed');
          else clearMarker(meta, stepNode);
        }
        if (skillNode) {
          pushHistory(meta, skillNode);
          if (e.ok === false) addMarker(meta, skillNode, e.failKind ?? 'failed');
          else clearMarker(meta, skillNode);
        }
      } else if (e.activity === 'dispatch' || e.activity === 'auto' || e.activity === 'done' || e.activity === 'fail') {
        if (skillNode) {
          pushHistory(meta, skillNode);
          if (e.activity === 'fail') addMarker(meta, skillNode, e.failKind ?? 'failed');
          if (e.activity === 'done') clearMarker(meta, skillNode);
        }
        if (e.activity === 'fail' && stepNode) addMarker(meta, stepNode, e.failKind ?? 'failed');
      }
    }
    state.lastEventAt.set(c.name, newest);
  }
}

function currentActivityId(c) {
  const plan = c.plan;
  if (plan?.status === 'active' && plan.recipeId && plan.cursor) {
    const id = `r:${plan.recipeId}:step:${plan.cursor}`;
    if (nodeExists(id)) return id;
  }
  const skill = c.current?.skill ?? c.lastAction?.skill;
  if (skill && nodeExists(`k:${skill}`)) return `k:${skill}`;
  return null;
}

function renderCompanions(status) {
  for (const [name, meta] of state.companions) {
    clearGroup(meta.group);
    if (meta.label) {
      worldGroup.remove(meta.label);
      meta.label = null;
    }
  }
  const comps = status?.status?.companions ?? [];
  comps.forEach((c) => {
    const meta = companionMeta(c.name);
    const cur = currentActivityId(c);
    if (cur) pushHistory(meta, cur, false);
    const hist = meta.history.filter((id) => nodeExists(id));
    if (!hist.length) return;
    const n = Math.max(3, Math.min(8, state.pathN));
    const recent = hist.slice(-n);
    const tempColors = recent.map((_, i) => {
      const t = i / Math.max(1, recent.length - 1); // 0 旧 → 1 新
      return meta.color.clone().lerp(new THREE.Color(0xfff3c4), 0.25 + 0.7 * t);
    });
    // 淡色历史尾巴（走过的更早路径）
    for (const id of hist.slice(0, Math.max(0, hist.length - n))) {
      const p = nodePos(id);
      if (!p) continue;
      const sp = glowSprite(meta.color.clone().multiplyScalar(0.55), 8);
      sp.position.copy(p);
      sp.material.opacity = 0.35;
      sp.renderOrder = 3;
      meta.group.add(sp);
    }
    // 路径连线：发光管（比 1px 细线显眼得多）
    for (let i = 1; i < recent.length; i++) {
      const a = nodePos(recent[i - 1]);
      const b = nodePos(recent[i]);
      if (!a || !b) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += 3.5;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const g = new THREE.TubeGeometry(curve, 24, i === recent.length - 1 ? 0.55 : 0.42, 8, false);
      const m = new THREE.MeshBasicMaterial({
        color: tempColors[i],
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });
      const tube = new THREE.Mesh(g, m);
      tube.renderOrder = 6;
      meta.group.add(tube);
    }
    // 路径节点：环 + 光球；当前节点额外加光柱 + 大环 + 高亮
    recent.forEach((id, i) => {
      const p = nodePos(id);
      if (!p) return;
      const isCur = i === recent.length - 1;
      const sp = glowSprite(tempColors[i], isCur ? 30 : 14 + i * 2);
      sp.position.copy(p).add(new THREE.Vector3(0, isCur ? 1.2 : 0, 0));
      sp.material.opacity = isCur ? 1 : 0.7;
      sp.renderOrder = 8;
      sp.userData = { pulse: isCur };
      meta.group.add(sp);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(isCur ? 4.4 : 2.8, isCur ? 6.2 : 3.7, 64),
        new THREE.MeshBasicMaterial({
          color: tempColors[i],
          transparent: true,
          opacity: isCur ? 1 : 0.6,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
        }),
      );
      ring.position.copy(p);
      ring.lookAt(camera.position);
      ring.renderOrder = 9;
      ring.userData = { pulse: isCur };
      meta.group.add(ring);
      if (isCur) {
        // 光柱：把这个节点从整棵树里"拎出来"
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, 34, 8, 1, true),
          new THREE.MeshBasicMaterial({ color: tempColors[i], transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
        );
        beam.position.copy(p).add(new THREE.Vector3(0, 18, 0));
        beam.renderOrder = 7;
        beam.userData = { pulse: true };
        meta.group.add(beam);
        // 当前节点下方小环
        const ring2 = new THREE.Mesh(
          new THREE.RingGeometry(1.6, 2.6, 40),
          new THREE.MeshBasicMaterial({ color: tempColors[i], transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }),
        );
        ring2.rotation.x = -Math.PI / 2;
        ring2.position.copy(p).add(new THREE.Vector3(0, -2.6, 0));
        ring2.renderOrder = 9;
        meta.group.add(ring2);
      }
    });
    // 失败标记（红色，显眼且保留到节点再次激活）
    if (state.showFail) {
      for (const [id, mk] of meta.markers) {
        const p = nodePos(id);
        if (!p) continue;
        const age = (Date.now() - mk.at) / 1000;
        const alpha = Math.max(0.55, 1 - age / 90); // 渐隐但保持醒目
        const color = new THREE.Color(0xff2a2a);
        const glow = glowSprite(color, 34);
        glow.position.copy(p);
        glow.material.opacity = Math.min(1, alpha + 0.15);
        glow.renderOrder = 10;
        glow.userData = { pulse: true };
        meta.group.add(glow);
        for (const [ri, ro, op] of [[5.0, 6.4, 1], [3.0, 3.8, 0.9]]) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(ri, ro, 56),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: alpha * op, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }),
          );
          ring.position.copy(p);
          ring.lookAt(camera.position);
          ring.renderOrder = 11;
          ring.userData = { pulse: true };
          meta.group.add(ring);
        }
        // 红色光柱
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.1, 22, 8, 1, true),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: alpha * 0.5, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
        );
        beam.position.copy(p).add(new THREE.Vector3(0, 12, 0));
        beam.renderOrder = 7;
        meta.group.add(beam);
        // "✕ kind ×n" 标签
        const info = makeLabel(`✕ ${mk.kind ?? 'fail'}${mk.count > 1 ? ` ×${mk.count}` : ''}`, '#ffd6d6', 32, 2.0);
        info.position.copy(p).add(new THREE.Vector3(0, 7.6, 0));
        info.material.opacity = alpha;
        info.renderOrder = 12;
        meta.group.add(info);
      }
    }
    // 当前节点材质高亮（让节点本体也亮起来）
    for (const [, rec] of state.nodeById) {
      rec.mesh.material.emissiveIntensity = 0.6;
      rec.mesh.scale.setScalar(1);
      rec.glow.material.opacity = 0.75;
      rec.glow.scale.setScalar(rec.glowBase ?? 8);
    }
    for (const c2 of comps) {
      const curId = currentActivityId(c2);
      const rec = curId ? state.nodeById.get(curId) : null;
      if (rec) {
        rec.mesh.material.emissiveIntensity = 2.2;
        rec.mesh.scale.setScalar(1.35);
        rec.glow.material.opacity = 1;
        rec.glow.scale.setScalar(22);
      }
    }
    // 同伴名标签挂当前节点
    const lastId = recent[recent.length - 1];
    const lp = nodePos(lastId);
    if (lp) {
      if (!meta.label) {
        meta.label = makeLabel(c.name, `#${meta.color.getHexString()}`, 44, 3.0);
        worldGroup.add(meta.label);
      }
      meta.label.position.copy(lp).add(new THREE.Vector3(0, 5.4, 0));
    }
  });
  // 清理已消失同伴
  for (const [name, meta] of [...state.companions]) {
    if (!comps.some((c) => c.name === name)) {
      worldGroup.remove(meta.group);
      if (meta.label) worldGroup.remove(meta.label);
      state.companions.delete(name);
    }
  }
}

// ── 同伴信息卡 ───────────────────────────────────────────────
// 设计要点：
// - 增量更新：卡片 DOM 只创建一次，之后只改文本/属性 → 队列滚动位置、折叠状态不会每秒被重置
// - 队列有界：渲染上限 + 内部滚动 + 超量折叠成"省略 N 项"，卡片高度不会随 goals 无限增长
// - 多同伴：卡片纵向堆叠在 .left（自身滚动）；>3 个时新卡片默认折叠，点卡头可展开
const CARD_QUEUE_RENDER_MAX = 60; // 单卡队列最多渲染的条目数
const CARD_QUEUE_HEAD = 40; // 超量时保留队首条数
const CARD_QUEUE_TAIL = 12; // 超量时保留队尾条数
const CARD_AUTO_COLLAPSE_OVER = 3; // 同伴多于这个数量时，新卡片默认折叠

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function queueItems(goals) {
  const n = goals.length;
  const shown = [];
  const push = (g, i) =>
    shown.push({ i, skill: String(g?.skill ?? g?.id ?? '?'), status: String(g?.status ?? '') });
  if (n <= CARD_QUEUE_RENDER_MAX) {
    goals.forEach((g, i) => push(g, i));
  } else {
    for (let i = 0; i < CARD_QUEUE_HEAD; i++) push(goals[i], i);
    const omitted = n - CARD_QUEUE_HEAD - CARD_QUEUE_TAIL;
    if (omitted > 0) shown.push({ i: -1, elide: omitted });
    for (let i = Math.max(CARD_QUEUE_HEAD, n - CARD_QUEUE_TAIL); i < n; i++) push(goals[i], i);
  }
  return { n, shown };
}

function ensureCard(name) {
  let refs = state.cardEls.get(name);
  if (refs) return refs;

  const root = document.createElement('div');
  root.className = 'card companion';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'card-head';
  head.title = '点击折叠 / 展开';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  const cname = document.createElement('span');
  cname.className = 'cname';
  const csched = document.createElement('span');
  csched.className = 'csched';
  const chev = document.createElement('span');
  chev.className = 'chev';
  head.append(swatch, cname, csched, chev);

  const body = document.createElement('div');
  body.className = 'cbody';
  const hp = document.createElement('div');
  hp.className = 'kv';
  const cur = document.createElement('div');
  cur.className = 'kv';
  const plan = document.createElement('div');
  plan.className = 'plan';
  // 优先度调度监控（只读）：时段 / 当前意图 / 候选 / 三线 / 窄学习 / 求助
  const sched = document.createElement('div');
  sched.className = 'sched';
  const schedTop = document.createElement('div');
  schedTop.className = 'sched-top';
  const schedTitle = document.createElement('span');
  schedTitle.className = 'sched-title';
  schedTitle.textContent = '优先度调度';
  const schedPhase = document.createElement('span');
  schedPhase.className = 'sched-phase';
  schedPhase.textContent = '时段 –';
  schedTop.append(schedTitle, schedPhase);
  const schedIntent = document.createElement('div');
  schedIntent.className = 'sched-intent';
  schedIntent.textContent = '等待树上报…';
  const schedCands = document.createElement('div');
  schedCands.className = 'sched-cands';
  const driveGrid = document.createElement('div');
  driveGrid.className = 'drive-grid';
  const driveEls = {};
  for (const [key, label] of [
    ['hunger', '饥饿'],
    ['fatigue', '疲劳'],
    ['safety', '安全'],
    ['resource', '资源'],
  ]) {
    const row = document.createElement('div');
    row.className = 'drive';
    row.title = `drives.${key}`;
    const dn = document.createElement('span');
    dn.className = 'dn';
    dn.textContent = label;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    bar.append(fill);
    const dv = document.createElement('b');
    dv.className = 'dv';
    dv.textContent = '–';
    row.append(dn, bar, dv);
    driveGrid.append(row);
    driveEls[key] = { row, fill, dv };
  }
  const schedLines = document.createElement('div');
  schedLines.className = 'sched-lines';
  const attLine = document.createElement('div');
  attLine.className = 'sched-line';
  const instLine = document.createElement('div');
  instLine.className = 'sched-line';
  schedLines.append(attLine, instLine);
  const schedLearn = document.createElement('div');
  schedLearn.className = 'sched-learn';
  schedLearn.textContent = '学习 未上报';
  const schedHelp = document.createElement('div');
  schedHelp.className = 'sched-help';
  schedHelp.hidden = true;
  sched.append(schedTop, schedIntent, schedCands, driveGrid, schedLines, schedLearn, schedHelp);
  const q = document.createElement('div');
  q.className = 'q';
  const qHead = document.createElement('div');
  qHead.className = 'q-head';
  const qLabel = document.createElement('span');
  qLabel.textContent = '队列';
  const qCount = document.createElement('b');
  qCount.textContent = '0';
  const qUnit = document.createElement('span');
  qUnit.textContent = '项';
  const qRun = document.createElement('span');
  qRun.className = 'q-run';
  qHead.append(qLabel, qCount, qUnit, qRun);
  const qList = document.createElement('div');
  qList.className = 'q-list';
  q.append(qHead, qList);
  body.append(hp, cur, plan, sched, q);
  root.append(head, body);

  const setCollapsed = (v) => {
    state.cardCollapsed.set(name, v);
    root.classList.toggle('collapsed', v);
    chev.textContent = v ? '▸' : '▾';
  };
  head.addEventListener('click', () => setCollapsed(!root.classList.contains('collapsed')));

  refs = {
    root,
    head,
    swatch,
    cname,
    csched,
    chev,
    hp,
    cur,
    plan,
    schedPhase,
    schedIntent,
    schedCands,
    driveEls,
    attLine,
    instLine,
    schedLearn,
    schedHelp,
    schedSig: null,
    qCount,
    qRun,
    qList,
    qSig: '',
    setCollapsed,
  };
  state.cardEls.set(name, refs);
  return refs;
}

// ── 优先度调度面板（只读）────────────────────────────────────
// 数据来自 /api/state 的 companions[]（src/state.mjs snapshot() 追加字段）。
// 只展示，不参与任何决策；树没上报对应字段时显示"未上报"而不是报错。
const PHASE_LABEL = {
  dawn: '黎明',
  morning: '上午',
  noon: '中午',
  afternoon: '下午',
  dusk: '黄昏',
  night: '夜晚',
  midnight: '深夜',
  day: '白天',
};

function clampUnit(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}
function pctText(v) {
  return `${Math.round(clampUnit(v) * 100)}%`;
}
function signed(n) {
  const x = Number(n) || 0;
  return `${x >= 0 ? '+' : ''}${x}`;
}
function strategyForIntent(intentState) {
  const cur = intentState?.current;
  if (cur?.strategy) return cur.strategy;
  const cands = Array.isArray(intentState?.candidates) ? intentState.candidates : [];
  if (cur?.intent) {
    const hit = cands.find((x) => x?.intent === cur.intent);
    if (hit?.strategy) return hit.strategy;
  }
  return cands[0]?.strategy ?? null;
}

function renderSched(refs, c) {
  const phase = c.timePhase ?? null;
  refs.schedPhase.textContent = `时段 ${phase ? PHASE_LABEL[phase] ?? phase : '–'}`;
  refs.schedPhase.classList.toggle('night', phase === 'dusk' || phase === 'night' || phase === 'midnight');

  const is = c.intentState ?? null;
  const cur = is?.current ?? null;
  const att = c.attention ?? null;
  const inst = c.instinct ?? null;
  const learning = c.learning ?? null;
  const drives = c.drives ?? null;
  const help = c.helpNeeded ?? null;
  const hasAny = phase != null || is != null || drives != null || att != null || inst != null || learning != null || help != null;

  // 当前意图 / 计划
  if (cur) {
    if (cur.need) {
      refs.schedIntent.innerHTML = `意图 <b>${esc(cur.intent ?? '?')}</b> · 需求 ${esc(cur.need)} · 优先度 <b>${esc(cur.priority ?? '–')}</b> · 状态 ${esc(cur.status ?? '?')}`;
    } else {
      refs.schedIntent.innerHTML = `计划 <b>${esc(cur.recipeId ?? '?')}</b>${cur.source ? ` · ${esc(cur.source)}` : ''} · 状态 ${esc(cur.status ?? '?')}${cur.priority != null ? ` · 优先度 ${esc(cur.priority)}` : ''}`;
    }
  } else if (is) {
    refs.schedIntent.textContent = '当前无意图/计划（空闲）';
  } else {
    refs.schedIntent.textContent = hasAny ? '意图未上报' : '调度字段未上报（树重启后生效）';
  }

  // 候选意图（最多 3 个）
  const cands = Array.isArray(is?.candidates) ? is.candidates.slice(0, 3) : [];
  const candSig = cands.map((x) => `${x.need}|${x.intent}|${x.priority}|${x.switchCost}`).join(';');
  if (candSig !== refs.schedSig) {
    refs.schedSig = candSig;
    refs.schedCands.innerHTML = cands.length
      ? cands
          .map((x, i) => {
            const isCur = (cur?.intent && x.intent === cur.intent) || (cur?.need && x.need === cur.need);
            return `<div class="sched-cand${isCur ? ' cur' : ''}"><span class="ci">${i + 1}</span><span class="cn">${esc(x.need ?? '?')} → ${esc(x.intent ?? '?')}</span><span class="cp">P${esc(x.priority ?? '–')} · 切换 ${esc(x.switchCost ?? '–')}</span></div>`;
          })
          .join('')
      : '<div class="sched-empty">无候选意图</div>';
  }

  // 三线之一：压力池（0~1 → 小条/百分比）
  for (const key of ['hunger', 'fatigue', 'safety', 'resource']) {
    const el = refs.driveEls[key];
    const raw = drives?.[key];
    const ok = raw != null && Number.isFinite(Number(raw));
    const v = ok ? clampUnit(raw) : 0;
    el.fill.style.width = ok ? pctText(raw) : '0%';
    el.dv.textContent = ok ? pctText(raw) : '–';
    el.row.classList.toggle('hot', ok && v >= 0.66);
    el.row.classList.toggle('warm', ok && v >= 0.33 && v < 0.66);
  }

  // 三线之二：注意力
  if (att) {
    const cap = att.captured;
    const capText = cap ? `${cap.kind ?? 'captured'}${cap.salience != null ? ` ${cap.salience}` : ''}` : '无';
    const topSalience = Object.entries(att.salience ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 2)
      .map(([k, v]) => `${k} ${Math.round(Number(v) || 0)}`)
      .join(' / ');
    refs.attLine.innerHTML = `注意 焦点 <b>${esc(att.focus ?? '–')}</b> · 捕获 <b${cap ? ' class="warn"' : ''}>${esc(capText)}</b>${topSalience ? ` · 显著 ${esc(topSalience)}` : ''}`;
  } else {
    refs.attLine.textContent = '注意 未上报';
  }

  // 三线之三：本能
  if (inst) {
    const active = !!inst.active;
    refs.instLine.innerHTML = `本能 <b${active ? ' class="warn"' : ''}>${active ? esc(inst.kind ?? 'active') : '无'}</b>${active && inst.priority != null ? ` · 优先度 ${esc(inst.priority)}` : ''}${active && inst.reason ? ` · ${esc(inst.reason)}` : ''}`;
  } else {
    refs.instLine.textContent = '本能 未上报';
  }

  // 窄学习：当前意图对应策略的 attempts / successRate / bonus（有样本才显示）
  const sid = strategyForIntent(is);
  const stat = sid ? learning?.strategies?.[sid] : null;
  if (stat) {
    refs.schedLearn.innerHTML = `学习 <b>${esc(sid)}</b> · ${esc(stat.attempts ?? 0)} 次 · 成功率 ${Math.round(clampUnit(stat.successRate) * 100)}% · 加成 <b>${esc(signed(stat.bonus))}</b>`;
  } else if (learning && !sid) {
    // 当前是计划/无候选意图时没有"当前策略"，给样本最多的策略做参考（明确标注）
    const top = Object.entries(learning.strategies ?? {}).sort((a, b) => (b[1]?.attempts ?? 0) - (a[1]?.attempts ?? 0))[0];
    if (top) {
      const [topId, st] = top;
      refs.schedLearn.innerHTML = `学习 当前无策略 · 样本最多 <b>${esc(topId)}</b> · ${esc(st.attempts ?? 0)} 次 · 成功率 ${Math.round(clampUnit(st.successRate) * 100)}% · 加成 <b>${esc(signed(st.bonus))}</b>`;
    } else {
      refs.schedLearn.textContent = '学习 当前策略无样本';
    }
  } else if (learning) {
    refs.schedLearn.textContent = `学习 ${sid} · 暂无样本`;
  } else {
    refs.schedLearn.textContent = '学习 未上报';
  }

  // 需要玩家动手的短报
  if (help) {
    refs.schedHelp.hidden = false;
    refs.schedHelp.textContent = `需要你：${help.hint || help.message || help.kind || '（未提供说明）'}`;
    refs.schedHelp.title = [help.kind, help.message, help.at].filter(Boolean).join(' · ');
  } else {
    refs.schedHelp.hidden = true;
    refs.schedHelp.textContent = '';
    refs.schedHelp.title = '';
  }
}

function renderCards(status) {
  const wrap = $('companions');
  const comps = status?.status?.companions ?? [];

  // 无同伴：清掉卡片，显示占位卡
  if (!comps.length) {
    for (const refs of state.cardEls.values()) refs.root.remove();
    state.cardEls.clear();
    if (!state.cardPlaceholder) {
      const d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<h3>暂无同伴</h3><div class="kv"></div>';
      state.cardPlaceholder = d;
    }
    state.cardPlaceholder.querySelector('.kv').innerHTML =
      status?.mode === 'offline'
        ? '树没有在运行（离线）。<br>启动树后自动连接：<b>node src/daemon.mjs</b>'
        : '等待树上报…';
    if (state.cardPlaceholder.parentNode !== wrap) wrap.appendChild(state.cardPlaceholder);
    syncPanelScrollable();
    return;
  }
  if (state.cardPlaceholder) {
    state.cardPlaceholder.remove();
    state.cardPlaceholder = null;
  }

  // 先移除已消失的同伴，再按上报顺序重排（用 insertBefore 移动，避免重建导致滚动条跳动）
  const names = new Set(comps.map((c) => c.name));
  for (const [name, refs] of [...state.cardEls]) {
    if (!names.has(name)) {
      refs.root.remove();
      state.cardEls.delete(name);
      state.cardCollapsed.delete(name);
    }
  }

  const defaultCollapsed = comps.length > CARD_AUTO_COLLAPSE_OVER;
  comps.forEach((c, i) => {
    const refs = ensureCard(c.name);
    if (!state.cardCollapsed.has(c.name)) {
      state.cardCollapsed.set(c.name, defaultCollapsed);
      refs.setCollapsed(defaultCollapsed);
    }

    const meta = companionMeta(c.name);
    const color = `#${meta.color.getHexString()}`;
    refs.swatch.style.background = color;
    refs.swatch.style.color = color;
    refs.cname.textContent = c.name;
    refs.csched.textContent = c.schedule?.id ? `日程 ${c.schedule.id}` : '';

    const pos = c.pos ? `${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}` : '?';
    refs.hp.innerHTML = `HP <b>${esc(c.hp ?? '?')}</b> · 饥饿 <b>${esc(c.hunger ?? '?')}</b> · 位置 <b>${esc(pos)}</b>`;
    const curSkill = c.current?.skill ?? c.lastAction?.skill ?? '空闲';
    refs.cur.innerHTML = `当前 <b>${esc(curSkill)}</b>${c.paused ? ' · 已暂停' : ''} · 槽 ${esc(c.slotBlocked ?? 0)}`;

    const plan = c.plan;
    refs.plan.textContent = plan
      ? `${plan.recipeId} · ${plan.status}${plan.steps_total ? ` ${plan.steps_done ?? 0}/${plan.steps_total}` : ''}${plan.cursor ? ` · 当前步 ${plan.cursor}` : ''}`
      : '无计划';
    renderSched(refs, c);

    // 队列：限高滚动，超量折叠；内容没变就不碰 DOM（保住滚动位置）
    const goals = Array.isArray(c.goals) ? c.goals : [];
    const { n, shown } = queueItems(goals);
    refs.qCount.textContent = String(n);
    const running = goals.find((g) => g?.status === 'running');
    refs.qRun.textContent = running ? `▶ ${running.skill ?? running.id ?? ''}` : '';
    const sig = shown.map((it) => (it.elide ? `…${it.elide}` : `${it.i}:${it.status}:${it.skill}`)).join('|');
    if (sig !== refs.qSig) {
      refs.qSig = sig;
      if (!shown.length) {
        refs.qList.innerHTML = '<div class="q-empty">空</div>';
      } else {
        const keepScroll = refs.qList.scrollTop;
        refs.qList.innerHTML = shown
          .map((it) =>
            it.elide
              ? `<div class="q-elide">… 省略 ${it.elide} 项 …</div>`
              : `<div class="q-item${it.status === 'running' ? ' running' : ''}" title="${esc(it.skill)}"><span class="q-idx">${it.i + 1}</span><span class="q-status">${it.status === 'running' ? '▶' : it.status === 'pending' ? '…' : ''}</span><span class="q-skill">${esc(it.skill)}</span></div>`,
          )
          .join('');
        refs.qList.scrollTop = keepScroll;
      }
    }

    const at = wrap.children[i] ?? null;
    if (at !== refs.root) wrap.insertBefore(refs.root, at);
  });
  syncPanelScrollable();
}


// ── 轮询 ─────────────────────────────────────────────────────
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const data = await r.json();
    state.lastState = data;
    const mode = data.mode ?? 'offline';
    const pill = $('modePill');
    pill.className = `pill ${mode === 'live' ? 'live' : mode === 'mock' ? 'mock' : 'offline'}`;
    $('modeText').textContent = mode === 'live' ? 'LIVE · 运行中的树' : mode === 'mock' ? 'MOCK · 演示数据' : 'OFFLINE · 树未运行';
    $('banner').classList.remove('show');
    if (mode === 'offline') {
      $('banner').textContent = '树未运行：只显示静态结构；启动树后自动恢复实时高亮';
      $('banner').classList.add('show');
    }
    const needModel =
      !state.model ||
      (data.modelVersion != null && data.modelVersion !== state.modelVersion) ||
      (state.modelVersion == null && data.modelVersion != null);
    if (needModel) {
      const mr = await fetch(`/api/model?force=1${data.modelVersion != null ? `&v=${data.modelVersion}` : ''}`, { cache: 'no-store' });
      if (!mr.ok) throw new Error(`/api/model HTTP ${mr.status}`);
      const model = await mr.json();
      state.modelVersion = data.modelVersion ?? state.modelVersion;
      buildScene(model);
      const ld = $('loading');
      if (ld) {
        ld.classList.add('hide');
        setTimeout(() => ld.remove(), 600);
      }
    }
    processEvents(data, data.events ?? []);
    renderCompanions(data);
    renderCards(data);
    $('modelVersion').textContent = state.modelVersion ?? '–';
  } catch (e) {
    $('modePill').className = 'pill offline';
    $('modeText').textContent = 'OFFLINE · 连不上 treeview 服务';
    const sub = $('loadingSub');
    if (sub) sub.textContent = '连不上 treeview 服务：' + (e?.message ?? e);
    console.error('[treeview] poll failed', e);
  }
}

// ── 交互：悬停/点击 ──────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(ev) {
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(state.nodeMeshes, false);
  return hits[0]?.object ?? null;
}
function showDetail(node) {
  if (!node) return;
  const evs = (state.lastState?.events ?? []).filter((e) => {
    return (node.type === 'step' && e.recipeId === node.recipeId && e.step === node.label) || (e.skill && node.type === 'skill' && `k:${e.skill}` === node.id);
  });
  const recent = evs.slice(-4).map((e) => `${e.activity}${e.ok === false ? ` ✗ ${e.failKind ?? ''}` : e.ok === true ? ' ✓' : ''}`).join(' · ') || '—';
  $('detailDesc').textContent = `${node.title}\n\n${node.desc || ''}`;
  $('detailMeta').textContent = `类型: ${node.type} · id: ${node.id} · 最近活动: ${recent}`;
  syncPanelScrollable();
}
renderer.domElement.addEventListener('pointermove', (ev) => {
  const obj = pick(ev);
  if (obj !== state.hovered) {
    if (state.hovered) state.hovered.scale.setScalar(1);
    state.hovered = obj;
    if (obj) obj.scale.setScalar(1.35);
    renderer.domElement.style.cursor = obj ? 'pointer' : 'default';
  }
  if (obj && (!state.pinned || state.pinned === obj)) showDetail(obj.userData.node);
});
renderer.domElement.addEventListener('click', (ev) => {
  const obj = pick(ev);
  if (obj) {
    state.pinned = obj;
    showDetail(obj.userData.node);
  } else {
    state.pinned = null;
    $('detailDesc').textContent = '点击/悬停节点查看说明。滚轮缩放，拖拽旋转。';
    $('detailMeta').textContent = 'treeview 只读监控 · 不改树';
  }
});

// ── UI 按钮 ──────────────────────────────────────────────────
$('btnReset').onclick = () => {
  camera.position.set(0, 90, 210);
  controls.target.set(0, 10, 0);
  controls.update();
};
$('btnLabels').onclick = () => {
  state.showLabels = !state.showLabels;
  applyLabelVisibility();
};
$('btnFail').onclick = () => {
  state.showFail = !state.showFail;
  renderCompanions(state.lastState ?? {});
};
$('pathN').oninput = () => {
  state.pathN = Number($('pathN').value);
  $('pathNVal').textContent = String(state.pathN);
  renderCompanions(state.lastState ?? {});
};

// ── 空闲自动旋转（只转树主体 worldGroup，不碰相机/OrbitControls）────
// 9s 无鼠标/触摸/滚轮/键盘操作后，整棵 3D 树绕 Y 轴缓慢自转（0.08 rad/s ≈ 78s/圈）。
// 任意操作立即停回用户控制；按住指针期间不启动，避免和拖拽/缩放打架。
const AUTO_ROTATE_IDLE_MS = 9000;
const AUTO_ROTATE_SPEED = 0.08; // rad/s
let lastUserInputAt = performance.now();
let autoRotating = false;
let pointerHeld = false;
let lastFrameAt = 0;

function noteUserInput() {
  lastUserInputAt = performance.now();
  autoRotating = false;
}
for (const type of ['pointermove', 'pointerdown', 'mousedown', 'wheel', 'touchstart', 'touchmove', 'keydown']) {
  addEventListener(type, noteUserInput, { passive: true });
}
addEventListener('pointerdown', () => {
  pointerHeld = true;
}, { passive: true });
addEventListener('pointerup', () => {
  pointerHeld = false;
  noteUserInput();
}, { passive: true });
addEventListener('pointercancel', () => {
  pointerHeld = false;
  noteUserInput();
}, { passive: true });
addEventListener('blur', () => {
  pointerHeld = false;
  noteUserInput();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) noteUserInput();
});

// ── 渲染循环 ─────────────────────────────────────────────────
let lastCam = 0;
function tick(t) {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 0;
  lastFrameAt = now;
  if (!pointerHeld && !autoRotating && now - lastUserInputAt >= AUTO_ROTATE_IDLE_MS) autoRotating = true;
  if (autoRotating && !pointerHeld) {
    worldGroup.rotation.y = (worldGroup.rotation.y + AUTO_ROTATE_SPEED * dt) % (Math.PI * 2);
  }
  controls.update();
  // 当前节点呼吸
  const time = t / 1000;
  for (const meta of state.companions.values()) {
    for (const child of meta.group.children) {
      if (child.userData?.pulse) {
        const s = 1 + Math.sin(time * 3) * 0.18;
        child.scale.setScalar(s);
      }
    }
  }
  if (performance.now() - lastCam > 250) {
    lastCam = performance.now();
    applyLabelVisibility();
  }
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// 启动
requestAnimationFrame(tick);
poll();
state.pollTimer = setInterval(poll, 1000);
