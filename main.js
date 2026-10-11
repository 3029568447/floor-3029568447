/* ==========================================================================
 * 指尖花开 · 手势控制粒子形态
 * --------------------------------------------------------------------------
 * Three.js（GPU 粒子） + MediaPipe Hands（21 关键点） + 原生 JS/CSS
 *
 * 核心设计：
 *   1. 双位置属性 + uMorph：每个粒子保存「起点 position」和「目标 aTarget」，
 *      顶点着色器做插值。切换形态时把当前实际位置烘焙回 position，
 *      因此形态数量不受 attribute 数量限制，且任意时刻切换都不会跳变。
 *   2. 所有形变（自转、脉动、爆炸、指尖力场、呼吸）都在顶点着色器完成，
 *      每帧 CPU 只更新十来个 uniform。
 *   3. 手势 → 状态机 → 形态：
 *        握拳 = 花苞   巴掌 = 绽放
 *        4/3/2/1 根手指 = 粒子组成数字；比 4 会触发完整序列
 *        竖中指 = 星系高速旋转
 *        OK = 漫天烟花 → 汇聚成「爱你老己」
 * ========================================================================== */

import { FINGER_DEFS, FINGER_LABEL, analyzeHand, makeGestureDebouncer } from './gestures.js';
import { buildShape, PALETTES } from './shapes.js';

/* --------------------------------------------------------------------------
 * 依次尝试多个 CDN 加载 Three.js。
 * 静态 import 一旦失败整个模块都不会执行、页面白屏且没有任何提示，
 * 所以这里用动态 import + 多 CDN 兜底 + 失败时给出明确提示。
 * -------------------------------------------------------------------------- */
const THREE_CDN_LIST = [
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://fastly.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://unpkg.com/three@0.160.0/build/three.module.js',
];

let THREE = null;
for (const url of THREE_CDN_LIST) {
  const host = new URL(url).host;
  const tip = document.getElementById('loadingText');
  if (tip) tip.textContent = '加载 Three.js（' + host + '）…';
  try {
    // 动态 import 无法取消，但必须加超时：CDN 挂起时页面会永远停在加载遮罩上
    THREE = await Promise.race([
      import(/* @vite-ignore */ url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('加载超时')), 12000)),
    ]);
    break;
  } catch (err) {
    console.warn('[Three.js] 该 CDN 不可用：', url, err && err.message);
  }
}
if (!THREE) {
  document.getElementById('loading').innerHTML =
    '<div class="loading-box"><p>❌ Three.js 加载失败</p>'
    + '<small>三个 CDN 都无法访问，请检查网络后刷新；<br>'
    + '或参考 README 第 3 节改用 <code>npm install three</code> 本地引入。</small></div>';
  throw new Error('Three.js 加载失败：所有 CDN 均不可用');
}

/* ==========================================================================
 * 一、全局配置
 * ========================================================================== */
const CONFIG = {
  particles: {
    count: 16000,          // 粒子数量（需求区间 5000 ~ 20000）
    mobileCount: 8000,
    size: 3.0,             // 基础粒子直径（CSS 像素 @ 参考距离）
    pixelRatioMax: 2,
  },

  /* 形态几何参数 */
  shape: {
    radius: 2.35,          // 整体尺度基准
    petals: 42,            // 花瓣数：越多越饱满（黄金角螺旋）
    text: '爱你老己',
    digitFontSize: 340,
    textFontSize: 340,
    glyphStep: 3,
  },

  /* 形态过渡 */
  morph: {
    duration: 0.85,        // 常规过渡时长（秒）
    fast: 0.32,            // 快速过渡（手势急变时）
  },

  /* 动画序列时序（秒） */
  seq: {
    digitHold: 1.35,       // 每个数字停留
    tornado: 3.0,          // 龙卷风
    heart: 5.0,            // 爱心怦怦跳
    firework: 3.6,         // 烟花爆开
    text: 4.0,             // 文字停留
    galaxyFade: 1.6,       // 结束星系手势后多久回到常态
  },

  /* 绽放映射（握拳/巴掌） */
  bloom: {
    closeThreshold: 0.32,
    openThreshold: 0.66,
    spreadLerp: 0.1,       // ★ currentSpread += (target - current) * 0.1
    tensionLerp: 0.30,
    tensionFallLerp: 0.20,
    holdTime: 0.30,
    decayLerp: 0.02,
  },

  tension: {
    ratioMin: 0.88, ratioMax: 1.90,
    angleMin: 95,   angleMax: 168,
    wDist: 0.65,    wAngle: 0.35,
  },

  hand: {
    maxHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
    detectFPS: 30,
    influenceRadius: 0.85,
    influenceStrength: 0.38,
    followStrength: 0.55,
    tiltStrength: 0.42,
    gestureDebounce: 4,    // 手势需连续 N 帧稳定才确认（防抖）
  },

  camera: {
    dist: 6.4,
    fov: 46,
    elevation: 38,         // 3D 形态（花 / 星系 / 龙卷风）的俯视角：要看到"花的脸"
    elevationFlat: 0,      // 2D 形态（数字 / 文字 / 爱心）正对相机，否则会变形
    frameHeight: 5.8,
    frameWidth: 6.6,
    desktop: { width: 960, height: 720 },
    mobile: { width: 640, height: 480 },
    fps: 30,
  },

  /* 各形态的自转速度（弧度/秒）。默认全部为 0 —— 画面要稳，不能总在转 */
  spin: {
    idle: 0, bud: 0, bloom: 0,
    galaxy: 2.6, tornado: 0, heart: 0,
    glyph: 0, text: 0, firework: 0, sphere: 0,
  },

  ui: { showVideo: true, showLandmarks: true },
};

const MEDIAPIPE_VERSION = '0.4.1675469240';
const HANDS_CDN_LIST = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_VERSION}/`,
  `https://fastly.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_VERSION}/`,
  `https://unpkg.com/@mediapipe/hands@${MEDIAPIPE_VERSION}/`,
];

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/* 调色板：每套 [核心色, 中段色, 边缘色] */
const PAL = {
  bud:      ['#d6113f', '#ff4f7d', '#ffa8bd'],
  bloom:    ['#e01b4c', '#ff4fa3', '#ff8fa8'],
  galaxy:   ['#2b3fbd', '#5ad0ff', '#fff4d6'],
  tornado:  ['#5b2bd8', '#4fd6ff', '#eaffff'],
  heart:    ['#8a0b45', '#ff2d6f', '#ffd9e8'],
  firework: ['#ff8a3d', '#ffe45e', '#ffffff'],
  glyph:    ['#0f6bd8', '#4fe0ff', '#ffffff'],
  text:     ['#ff6a00', '#ffcc33', '#fffbe8'],
  sphere:   ['#5b2bd8', '#ff77c8', '#fff0b8'],
  // 数字 1~4 各用一种颜色，更有区分度
  d1: ['#0f6bd8', '#4fe0ff', '#ffffff'],
  d2: ['#0a8f6a', '#3dffb0', '#eafff5'],
  d3: ['#8a5a00', '#ffc93d', '#fff6d8'],
  d4: ['#7a0b6b', '#ff4fd8', '#ffe6fb'],
};

/* ==========================================================================
 * 二、工具函数
 * ========================================================================== */
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep01 = (x) => { const t = clamp(x); return t * t * (3 - 2 * t); };
/** 帧率无关的指数平滑：dt = 1/60 时等价于每帧系数 k */
const damp = (k, dt) => 1 - Math.pow(1 - k, dt * 60);
/** 角度插值（走最短弧） */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const isMobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.innerWidth < 900);

/** 给 Promise 加超时 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 带超时的 <script> 注入（否则 CDN 卡住会永远停在加载遮罩） */
function loadScript(src, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => done(reject, new Error('脚本加载超时：' + src)), timeoutMs);
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = () => done(resolve, src);
    s.onerror = () => done(reject, new Error('脚本加载失败：' + src));
    document.head.appendChild(s);
  });
}

/* ==========================================================================
 * 三、DOM 与界面反馈
 * ========================================================================== */
const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const sceneCanvas = $('scene');

const ui = {
  statCamera: $('statCamera'), statHand: $('statHand'), statMode: $('statMode'),
  statFps: $('statFps'), statChain: $('statChain'), statShape: $('statShape'),
  tensionVal: $('tensionVal'), tensionBar: $('tensionBar'),
  spreadVal: $('spreadVal'), spreadBar: $('spreadBar'),
  hint: $('hint'), loading: $('loading'), loadingText: $('loadingText'), toast: $('toast'),
  panel: $('panel'), panelBody: $('panelBody'),
  banner: $('banner'), bannerTitle: $('bannerTitle'), bannerMsg: $('bannerMsg'), bannerTips: $('bannerTips'),
  calibBody: $('calibBody'), calibRows: $('calibRows'), calibHint: $('calibHint'),
  calibCode: $('calibCode'), btnCalibApply: $('btnCalibApply'),
};

function setLoading(text) { if (text) ui.loadingText.textContent = text; }
function hideLoading() { ui.loading.classList.add('hidden'); }
function setStatus(el, text, cls = '') { if (el) el.textContent = text; if (el) el.className = 'val ' + cls; }

let toastTimer = 0;
function showToast(msg, ms = 4200) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

/** 摄像头链路失败时的持久横幅（绝不静默降级） */
function showCameraBanner(title, message, tips) {
  ui.bannerTitle.textContent = title;
  ui.bannerMsg.textContent = message;
  ui.bannerTips.innerHTML = (tips || []).map((t) => `<li>${t}</li>`).join('');
  ui.banner.hidden = false;
}
function hideCameraBanner() { ui.banner.hidden = true; }

async function probeDevices() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return '当前浏览器不支持设备枚举';
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list.filter((d) => d.kind === 'videoinput');
    if (!cams.length) return '系统未检测到摄像头设备';
    const labels = cams.map((c, i) => c.label || `摄像头 ${i + 1}（未授权，看不到名称）`);
    return `检测到 ${cams.length} 个摄像头：${labels.join('、')}`;
  } catch (err) {
    return '设备枚举失败：' + (err && err.message ? err.message : err);
  }
}

/* ==========================================================================
 * 四、全局状态
 * ========================================================================== */
const state = {
  /* 手势 */
  landmarks: null,
  landmarksSmooth: null,
  hasHand: false,
  lastHandTime: -1e9,
  handHold: 0,
  rollTarget: 0,
  palmWorld: new THREE.Vector3(),
  tipWorld: new THREE.Vector3(),
  handActive: 0,
  gesture: null,
  hand: null,               // analyzeHand 的完整结果

  /* 绽放（握拳/巴掌） */
  tensionRaw: 0, tension: 0, targetSpread: 0, spread: 0, spreadVelocity: 0,

  /* 形态 */
  shapeName: 'bud',
  morph: 0,
  morphStart: 0,
  morphDuration: 0.85,
  spin: 0,                  // 当前自转速度（弧度/秒）
  spinAngle: 0,
  pulse: 1,                 // 爱心跳动缩放
  burst: 0,                 // 烟花爆开量
  flash: 0,                 // 烟花闪光
  faceCamera: 0,            // 1 = 正对相机（数字/文字）

  /* 交互 */
  userRotX: 0, userRotY: 0,
  dragging: false,
  zoom: 1,
  camDist: CONFIG.camera.dist,
  camElev: CONFIG.camera.elevation,
  camElevTarget: CONFIG.camera.elevation,
  pointerX: 0.5, pointerY: 0.5, pointerDown: false,
  autoRotY: 0,
  shapeLock: false,

  /* 序列 */
  seq: { phase: 'idle', digit: null, timer: 0, galaxyIdle: 0 },
  tipNorm: null,            // 指尖归一化坐标（备用）

  /* 运行 */
  demo: false, demoTime: 0,
  forceTension: null, debugSnap: false,
  fps: 0,
  viewHeight: 1, viewWidth: 1,
  useVideo: CONFIG.ui.showVideo,
  useLandmarks: CONFIG.ui.showLandmarks,

  diag: { devices: '未检测', camera: '待启动', model: '待加载', infer: '待开始', error: '' },

  calib: {
    open: false, enabled: false, maxSamples: 600,
    ratio: {}, ang: {}, live: [], applied: null,
  },
};

/* 颜色平滑过渡 */
const paletteState = {
  from: PAL.bud.slice(), to: PAL.bud.slice(), t: 1, duration: 0.8,
};
const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();

/* ==========================================================================
 * 五、Three.js 场景
 * ========================================================================== */
let renderer, scene, camera, points, group, geometry, material;
let auxSize, auxRadial, auxKind, auxSeed;
let particleCount = 0;

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas: sceneCanvas,
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,   // 预乘 alpha：叠在视频上呈辉光而非灰块
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.particles.pixelRatioMax));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 1, CONFIG.camera.dist);
  camera.lookAt(0, 0, 0);

  group = new THREE.Group();
  scene.add(group);

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 260));
  bindPointerControls();
  onResize();
}

/** 视口高度自适应：以 800px 高为基准 */
function viewScaleFor(h) { return clamp(h / 800, 0.7, 2.2); }

/** 按画面比例算相机距离，保证形态不被裁切；同时作为粒子尺寸参考距离。
 *  注意这里只算「距离」，相机朝向由主循环每帧根据当前形态插值决定。 */
function fitCamera() {
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const dH = (CONFIG.camera.frameHeight * 0.5) / t;
  const dW = (CONFIG.camera.frameWidth * 0.5) / (t * aspect);
  state.camDist = clamp(Math.max(dH, dW), 4.5, 18) * state.zoom;
  applyCameraPose();
  if (material) material.uniforms.uRefDist.value = state.camDist;
}

/** 相机俯角随形态插值：花朵俯视、数字/文字正对 */
function applyCameraPose() {
  const el = THREE.MathUtils.degToRad(state.camElev);
  const d = state.camDist;
  camera.position.set(0, Math.sin(el) * d, Math.cos(el) * d);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  updateViewMetrics();
}

function updateViewMetrics() {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const d = camera.position.length() || CONFIG.camera.dist;
  state.viewHeight = 2 * Math.tan(vFov / 2) * d;
  state.viewWidth = state.viewHeight * camera.aspect;
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  fitCamera();
  updateViewMetrics();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.particles.pixelRatioMax));
  renderer.setSize(w, h, false);

  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.particles.pixelRatioMax);
  overlay.width = Math.floor(w * dpr);
  overlay.height = Math.floor(h * dpr);
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.landmarksSmooth = null;

  if (material) material.uniforms.uViewScale.value = viewScaleFor(h);
}

/* ==========================================================================
 * 六、粒子几何与形态引擎
 * ========================================================================== */
let auxArrays = null;

/** 把所有 attribute 标记为需要重新上传（GPU 端的 buffer 才会更新） */
function markAttributesDirty() {
  if (!geometry) return;
  for (const key in geometry.attributes) {
    geometry.attributes[key].needsUpdate = true;
  }
}

/** 统一入口：把指定形态写进 aTarget（或 position） */
function fillShape(target, name, extra = {}) {
  buildShape(name, particleCount, CONFIG.shape, auxArrays, target, extra);
}

/* 各形态的相机俯角（度）：花与文字要正对观众，星系要俯视才有纵深 */
const CAM_ELEV = {
  bud: 0, bloom: 0, budBloom: 0,
  glyph: 0, text: 0, heart: 0,
  galaxy: 38, firework: 26, sphere: 20, tornado: 30,
};

/** 切换形态：同时设置相机俯角，避免"平躺的花被斜着看" */
function applyShapeCamera(name) {
  state.camElevTarget = CAM_ELEV[name] !== undefined ? CAM_ELEV[name] : CONFIG.camera.elevation;
}

/**
 * 切换到新形态。
 * 关键：先用当前 morph 把「起点 + 目标」的插值结果烘焙回起点，
 * 这样无论在任何时刻切换，当前画面都不会跳变。
 */
function setShape(name, extra = {}, duration) {
  if (!geometry) return;
  const dur = duration !== undefined ? duration : CONFIG.morph.duration;
  const pos = geometry.attributes.position.array;
  const tgt = geometry.attributes.aTarget.array;
  const m = state.morph;

  // 1) 烘焙当前位置
  for (let i = 0; i < pos.length; i++) pos[i] += (tgt[i] - pos[i]) * m;

  // 2) 写入新形态
  fillShape(tgt, name, extra);

  state.shapeName = name;
  state.morph = 0;
  state.morphStart = performance.now();
  state.morphDuration = dur;
  state.morphManual = false;          // ★ 交给时间驱动，否则会永远停在起点

  // 遍历上传所有 attribute，避免漏掉某个导致 GPU 侧数据不更新。
  markAttributesDirty();

  // 3) 调色板平滑过渡
  const next = extra.palette || firstPalette(name, extra);
  paletteState.from = currentPalette().slice();
  paletteState.to = next.slice();
  paletteState.t = 0;
  paletteState.duration = dur;

  // 4) 自转速度
  const spinKey = extra.spinKey || name;
  state.spinTarget = CONFIG.spin[spinKey] !== undefined ? CONFIG.spin[spinKey] : CONFIG.spin.idle;

  state.faceCamera = (name === 'glyph' || name === 'text') ? 1 : 0;
  applyShapeCamera(name);
}

/** 数字形态用专属调色板 */
function firstPalette(name, extra) {
  if (name === 'glyph' && extra.text && /^[1-4]$/.test(extra.text)) return PAL['d' + extra.text];
  if (name === 'glyph' && extra.text && extra.text.length > 1) return PAL.text;
  return PAL[name] || PAL.sphere;
}

function currentPalette() {
  const t = smoothstep01(paletteState.t);
  return [0, 1, 2].map((i) => mixHex(paletteState.from[i], paletteState.to[i], t));
}

function mixHex(a, b, t) {
  tmpColorA.set(a); tmpColorB.set(b);
  return '#' + tmpColorA.lerp(tmpColorB, t).getHexString();
}

/* ==========================================================================
 * 七、着色器
 * ========================================================================== */
const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uMorph;         // 形态过渡 0~1
  uniform float uSpread;        // 握拳/巴掌的绽放度
  uniform float uSpin;          // 自转角度
  uniform float uPulse;         // 爱心脉动缩放
  uniform float uBurst;         // 烟花爆开量
  uniform float uFlash;         // 烟花闪光（整团提亮）
  uniform float uVelocity;      // 变化速度 → 闪烁强度
  uniform vec3  uHand;
  uniform float uHandActive;
  uniform float uHandRadius;
  uniform float uHandStrength;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uViewScale;
  uniform float uRefDist;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;

  attribute vec3  aTarget;
  attribute float aSize;
  attribute float aRadial;
  attribute float aKind;
  attribute float aSeed;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    /* ---- 1) 形态插值：逐粒子错峰，切换时像星云重组而不是整体平移 ---- */
    float delay = aSeed * 0.35;
    float k = clamp((uMorph - delay) / (1.0 - 0.35), 0.0, 1.0);
    k = k * k * (3.0 - 2.0 * k);

    vec3 p = mix(position, aTarget, k);

    /* ---- 2) 过渡中途的「充气」外扩，让重组更有生命感 ---- */
    float bulge = k * (1.0 - k) * 4.0;
    p += normalize(p + vec3(1e-4)) * bulge * 0.22 * (0.4 + aSeed);

    /* ---- 3) 自转：整体刚性旋转 + 轻微差速摆动 ----
       注意：不能用「内外圈转速不同」的累积差速——转几圈后内外圈角度差会把
       螺旋臂彻底缠成一团。旋臂本身在形态生成时已经是对数螺旋，
       这里只要刚性旋转就能保持清晰，摆动只负责增加"活着"的感觉。 */
    float ang = uSpin + sin(uTime * 0.5 + aRadial * 5.0) * 0.22 * aRadial;
    float ca = cos(ang), sa = sin(ang);
    p.xz = mat2(ca, -sa, sa, ca) * p.xz;

    /* ---- 4) 爱心脉动 ---- */
    p *= uPulse;

    /* ---- 5) 烟花爆开 ---- */
    if (uBurst > 0.001) {
      p += normalize(p + vec3(1e-4)) * uBurst * (0.7 + aSeed);
    }

    /* ---- 6) 呼吸起伏 ---- */
    p.y += sin(uTime * 1.3 + aSeed * 6.2831) * 0.014;

    /* ---- 7) 指尖力场：高斯衰减的排斥 + 托举 ---- */
    if (uHandActive > 0.001) {
      vec3 d = p - uHand;
      float falloff = exp(-dot(d, d) / (2.0 * uHandRadius * uHandRadius));
      p += normalize(d + vec3(1e-4)) * falloff * uHandStrength;
      p.y += falloff * uHandStrength * 0.35;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    /* ---- 8) 点尺寸 ---- */
    float size = uSize * aSize * (0.8 + 0.4 * uMorph) * uPixelRatio * uViewScale;
    gl_PointSize = clamp(size * (uRefDist / max(0.001, -mv.z)), 0.6, 96.0 * uPixelRatio);

    /* ---- 9) 颜色 ---- */
    float r = clamp(aRadial, 0.0, 1.0);
    vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 0.55, r));
    col = mix(col, uColorC, smoothstep(0.5, 1.05, r));
    col *= 0.85 + 0.35 * uMorph;

    // kind=1 的星尘带闪烁；kind=2 是花心 —— 用「红热」而不是白热，
    // 否则一片纯白会脱离整体红粉配色。
    float twinkle = pow(max(0.0, sin(uTime * 2.4 + aSeed * 43.0)), 26.0);
    col += vec3(1.0, 0.72, 0.74) * twinkle * (0.12 + 0.9 * uVelocity) * aKind;
    col += vec3(1.0, 0.26, 0.34) * (aKind > 1.5 ? 0.72 : 0.0);
    col *= 1.0 + 1.6 * uFlash;

    vColor = col;
    vAlpha = (0.6 + 0.4 * aSize) * (aKind > 0.5 && aKind < 1.5 ? 0.75 : 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform float uIntensity;
  uniform float uOpacity;
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    float d = length(pc);
    if (d > 0.5) discard;

    float core = smoothstep(0.5, 0.0, d);
    float glow = pow(core, 2.6);

    vec3 col = vColor * (0.35 + 1.10 * glow);
    float a = (glow * 0.85 + core * 0.25) * vAlpha * uOpacity;

    // 预乘 alpha：与摄像头画面叠加时呈辉光而非灰色方块
    gl_FragColor = vec4(col * a * uIntensity, a);
    #include <colorspace_fragment>
  }
`;

/** 创建（或重建）粒子系统 */
function createParticles(count) {
  if (points) {
    group.remove(points);
    points.geometry.dispose();
    points.material.dispose();
    points = null;
  }
  particleCount = count;

  geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const tgt = new Float32Array(count * 3);
  auxSize = new Float32Array(count);
  auxRadial = new Float32Array(count);
  auxKind = new Float32Array(count);
  auxSeed = new Float32Array(count);
  for (let i = 0; i < count; i++) auxSeed[i] = Math.random();

  auxArrays = { size: auxSize, radial: auxRadial, kind: auxKind };
  fillShape(pos, state.shapeName === 'bloom' ? 'bloom' : 'bud');
  fillShape(tgt, 'bud');

  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aTarget', new THREE.BufferAttribute(tgt, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(auxSize, 1));
  geometry.setAttribute('aRadial', new THREE.BufferAttribute(auxRadial, 1));
  geometry.setAttribute('aKind', new THREE.BufferAttribute(auxKind, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(auxSeed, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CONFIG.shape.radius * 4);

  const pal = currentPalette();
  material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uSpread: { value: 0 },
      uSpin: { value: 0 },
      uPulse: { value: 1 },
      uBurst: { value: 0 },
      uFlash: { value: 0 },
      uVelocity: { value: 0 },
      uHand: { value: new THREE.Vector3(999, 999, 999) },
      uHandActive: { value: 0 },
      uHandRadius: { value: CONFIG.hand.influenceRadius },
      uHandStrength: { value: CONFIG.hand.influenceStrength },
      uSize: { value: CONFIG.particles.size },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uViewScale: { value: viewScaleFor(window.innerHeight) },
      uRefDist: { value: camera.position.length() },
      uIntensity: { value: 1.0 },
      uOpacity: { value: 0.95 },
      uColorA: { value: new THREE.Color(pal[0]) },
      uColorB: { value: new THREE.Color(pal[1]) },
      uColorC: { value: new THREE.Color(pal[2]) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });

  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);
}

/* ==========================================================================
 * 八、形态状态机
 * --------------------------------------------------------------------------
 * idle      握拳=花苞 / 巴掌=绽放（由 tension 连续驱动 bud↔bloom）
 * digit     粒子组成阿拉伯数字（独立触发，不再自动串播）
 * galaxy    竖中指 → 星系
 * firework  OK → 烟花
 * text      烟花之后汇聚成文字
 * ========================================================================== */
const PHASE = {
  IDLE: 'idle', DIGIT: 'digit',
  GALAXY: 'galaxy', FIREWORK: 'firework', TEXT: 'text',
};

/** 让 position/aTarget 成为 bud↔bloom 这一对，morph 由 spread 直接驱动 */
function useBudBloomPair() {
  const pos = geometry.attributes.position.array;
  const tgt = geometry.attributes.aTarget.array;
  fillShape(pos, 'bud');
  fillShape(tgt, 'bloom');
  markAttributesDirty();
  state.shapeName = 'budBloom';
  state.morphManual = true;
  state.faceCamera = 0;
  // ★ 必须重置自转速度：这条路径不经过 setShape()，
  //   之前漏了这一行，导致从「星系」（spin 2.6）回来后，
  //   形态已经变回花了、花却还在按星系的速度一直打转。
  state.spinTarget = CONFIG.spin.idle;
  applyShapeCamera('budBloom');
  paletteState.from = currentPalette().slice();
  paletteState.to = PAL.bloom.slice();
  paletteState.t = 0;
  paletteState.duration = 0.5;
}

function setPhase(p) {
  const s = state.seq;
  const prev = s.phase;
  s.phase = p;
  s.timer = 0;
  state.morphManual = false;
  state.pulse = 1;
  state.burst = 0;
  state.flash = 0;

  switch (p) {
    case PHASE.IDLE:
      useBudBloomPair();
      break;
    case PHASE.GALAXY:
      setShape('galaxy', {}, 0.9);
      s.galaxyIdle = 0;
      break;
    case PHASE.FIREWORK:
      setShape('firework', {}, 0.35);
      state.flash = 1.5;
      state.burst = 1.2;
      break;
    case PHASE.TEXT:
      setShape('glyph', {
        text: CONFIG.shape.text,
        opts: { fontSize: CONFIG.shape.textFontSize, step: CONFIG.shape.glyphStep },
        palette: PAL.text,
      }, 1.1);
      break;
    default:
      break;
  }

}

/** 单独显示某个数字（不参与自动流程） */
function showDigit(n) {
  const s = state.seq;
  s.digit = n;
  s.phase = PHASE.DIGIT;
  s.timer = 0;
  state.morphManual = false;
  setShape('glyph', {
    text: String(n),
    opts: { fontSize: CONFIG.shape.digitFontSize, step: CONFIG.shape.glyphStep },
  }, CONFIG.morph.fast);
}

/** 手势派发（已经过去抖确认） */
function onGesture(g) {
  const s = state.seq;
  const busy = s.phase === PHASE.FIREWORK || s.phase === PHASE.TEXT;

  if (g === 'ok') { if (!busy) setPhase(PHASE.FIREWORK); return; }
  if (busy) return;

  if (g === 'middle') { if (s.phase !== PHASE.GALAXY) setPhase(PHASE.GALAXY); s.galaxyIdle = 0; return; }
  if (g === '1' || g === '2' || g === '3' || g === '4') { showDigit(Number(g)); return; }

  // 握拳 / 巴掌：只有在非常态下才接管
  if ((g === 'fist' || g === 'palm') && (s.phase === PHASE.GALAXY || s.phase === PHASE.DIGIT)) {
    setPhase(PHASE.IDLE);
  }
}

let lastPhaseLabel = '';

function updateSequence(dt) {
  const s = state.seq;
  s.timer += dt;
  const Q = CONFIG.seq;

  switch (s.phase) {
    case PHASE.IDLE:
      // shapeLock：用 ?shape= 指定形态时不要被 IDLE 覆盖，方便调试与截图
      if (!state.shapeLock) {
        if (state.shapeName !== 'budBloom') useBudBloomPair();
        state.morph = state.spread;         // ★ 由张开度连续驱动 花苞↔绽放
      }
      state.pulse = 1;
      state.burst = 0;
      state.flash = Math.max(0, state.flash - dt * 2);
      break;

    case PHASE.DIGIT:
      // 独立显示数字，停留后回到常态（不再自动串播整套流程）
      if (s.timer >= Q.digitHold) setPhase(PHASE.IDLE);
      break;

    case PHASE.GALAXY:
      if (state.gesture === 'middle') s.galaxyIdle = 0;
      else s.galaxyIdle = (s.galaxyIdle || 0) + dt;
      if (s.galaxyIdle > Q.galaxyFade) setPhase(PHASE.IDLE);
      break;

    case PHASE.FIREWORK: {
      const k = Math.max(0, 1 - s.timer * 2.2);
      state.burst = Math.max(0, 1.2 - s.timer * 1.5);
      state.flash = Math.max(0, k * 1.5);
      if (s.timer >= Q.firework) setPhase(PHASE.TEXT);
      break;
    }

    case PHASE.TEXT:
      state.burst = 0;
      state.flash = Math.max(0, state.flash - dt * 2);
      if (s.timer >= Q.text) setPhase(PHASE.IDLE);
      break;

    default:
      break;
  }

  const label = phaseLabel();
  if (label !== lastPhaseLabel) {
    lastPhaseLabel = label;
    setStatus(ui.statShape, label, 'ok');
  }
}

function phaseLabel() {
  const s = state.seq;
  if (state.shapeLock) return '调试：' + state.shapeName;
  switch (s.phase) {
    case PHASE.IDLE: return state.spread < 0.5 ? '花苞（握拳）' : '绽放（巴掌）';
    case PHASE.DIGIT: return '数字 ' + s.digit;
    case PHASE.GALAXY: return '银河系';
    case PHASE.FIREWORK: return '烟花';
    case PHASE.TEXT: return CONFIG.shape.text;
    default: return '—';
  }
}

/* ==========================================================================
 * 九、摄像头与 MediaPipe Hands
 * ========================================================================== */
let hands = null;
let pumping = false;
let lastVideoTime = -1;
let lastInferTime = 0;
let inferFails = 0;
let inferTotal = 0;

async function initCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前浏览器不支持 getUserMedia（请使用 Chrome / Edge / Safari 最新版）');
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !isLocal) {
    throw new Error('摄像头需要 HTTPS 或 localhost 环境，请用 http://localhost:5500 打开');
  }

  const size = isMobile ? CONFIG.camera.mobile : CONFIG.camera.desktop;

  /* 约束必须由宽到窄依次降级。
   * 特别注意：facingMode 写成字符串 'user' 是「必需约束」，
   * 台式机外接 USB 摄像头 / 驱动不上报朝向时会直接抛 OverconstrainedError。 */
  const attempts = [
    {
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: size.width },
        height: { ideal: size.height },
        frameRate: { ideal: CONFIG.camera.fps, max: 60 },
      },
    },
    { audio: false, video: { facingMode: { ideal: 'user' } } },
    { audio: false, video: true },
  ];

  let stream = null;
  let lastErr = null;
  for (let i = 0; i < attempts.length && !stream; i++) {
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia(attempts[i]),
        12000,
        '摄像头启动超时（权限弹窗可能被忽略，或设备无响应）',
      );
    } catch (err) {
      lastErr = err;
      console.warn('[摄像头] 第 ' + (i + 1) + ' 组约束失败：', err && err.name, err && err.message);
      const retryable = err && (err.name === 'OverconstrainedError' || err.name === 'TypeError');
      if (!retryable) break;
    }
  }
  if (!stream) throw new Error(describeCameraError(lastErr));

  video.srcObject = stream;
  video.muted = true;
  try {
    await video.play();
  } catch (err) {
    console.warn('[摄像头] video.play() 未成功，仍尝试继续：', err && err.name);
  }

  if (!video.videoWidth) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      video.addEventListener('loadedmetadata', finish, { once: true });
      video.addEventListener('playing', finish, { once: true });
      setTimeout(finish, 6000);
    });
  }
  if (!video.videoWidth) {
    throw new Error('摄像头已授权但没有画面输出（设备可能被其它程序占用，或系统隐私设置里禁用了摄像头）');
  }

  state.diag.camera = `已就绪 ${video.videoWidth}×${video.videoHeight}`;
  return stream;
}

function describeCameraError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝。请点浏览器地址栏左侧的 🔒 / 摄像头图标，把权限改为「允许」，然后重试';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '系统里没有找到任何摄像头设备。台式机请接一个 USB 摄像头；笔记本请检查系统设置里摄像头是否被禁用';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其它程序占用（如腾讯会议、钉钉、Zoom、相机应用），请关闭它们后重试';
    case 'OverconstrainedError':
      return '摄像头不支持所请求的参数（分辨率 / 朝向），且降级重试后仍失败，可尝试换一个摄像头';
    case 'SecurityError':
      return '安全策略阻止了摄像头访问，请使用 HTTPS 或 localhost 打开页面';
    case 'AbortError':
      return '摄像头启动被中断，请重试';
    default:
      return '摄像头启动失败：' + (err && err.message ? err.message : String(err));
  }
}

async function initHands() {
  let lastErr = null;
  for (const base of HANDS_CDN_LIST) {
    try {
      const host = new URL(base).host;
      state.diag.model = '下载中（' + host + '）';
      setLoading('加载 MediaPipe Hands（' + host + '）…');
      if (typeof window.Hands !== 'function') await loadScript(base + 'hands.js', 20000);
      if (typeof window.Hands !== 'function') throw new Error('hands.js 已加载但未暴露 Hands 构造函数');

      state.diag.model = '初始化模型…';
      const h = new window.Hands({ locateFile: (file) => base + file });
      h.setOptions({
        maxNumHands: CONFIG.hand.maxHands,
        modelComplexity: isMobile ? 0 : CONFIG.hand.modelComplexity,
        minDetectionConfidence: CONFIG.hand.minDetectionConfidence,
        minTrackingConfidence: CONFIG.hand.minTrackingConfidence,
        selfieMode: false,
      });
      h.onResults(onHandResults);

      setLoading('初始化手部识别模型（首次约 6MB）…');
      try {
        await withTimeout(h.send({ image: video }), 25000, '模型预热超时');
      } catch (warmupErr) {
        console.warn('[MediaPipe] 预热未完成（将在推理循环中重试）：', warmupErr && warmupErr.message);
      }
      state.diag.model = '已就绪';
      return h;
    } catch (err) {
      lastErr = err;
      console.warn('[MediaPipe] 该 CDN 不可用：', base, err);
    }
  }
  state.diag.model = '加载失败';
  throw new Error('MediaPipe Hands 模型加载失败：' + (lastErr ? lastErr.message : '未知错误'));
}

async function pumpHands() {
  if (pumping) return;
  pumping = true;
  const interval = 1000 / CONFIG.hand.detectFPS;

  while (pumping) {
    if (document.hidden || state.demo) {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    const now = performance.now();
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastInferTime >= interval) {
      lastVideoTime = video.currentTime;
      lastInferTime = now;
      try {
        await hands.send({ image: video });
        inferFails = 0;
        inferTotal++;
        if (inferTotal === 1) state.diag.infer = '运行中';
      } catch (err) {
        inferFails++;
        console.warn('[MediaPipe] 推理异常（连续 ' + inferFails + ' 次）：', err);
        if (inferFails === 5) {
          state.diag.infer = '连续失败';
          showCameraBanner('⚠️ 手部识别推理失败',
            'MediaPipe 模型已加载，但推理连续失败 5 次：' + (err && err.message ? err.message : String(err)),
            ['刷新页面重试', '若仍失败，把浏览器控制台的红色报错发给开发者', '可先用演示模式继续查看效果']);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    } else {
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
}

/* 手势去抖：避免手抖造成误触发 */
const gestureDebouncer = makeGestureDebouncer(CONFIG.hand.gestureDebounce);

function onHandResults(results) {
  const list = results && results.multiHandLandmarks;
  const lm = list && list.length ? list[0] : null;

  if (lm && lm.length === 21) {
    state.landmarks = lm;
    state.hasHand = true;
    state.lastHandTime = performance.now();
    state.handHold = CONFIG.bloom.holdTime;

    const aspect = (video.videoWidth || 640) / (video.videoHeight || 480);
    const info = analyzeHand(lm, aspect, CONFIG.tension);
    state.hand = info;
    state.tensionRaw = info.tension;
    state.calib.live = info.fingers;
    collectCalibration(info.fingers);

    // 手势去抖：连续稳定 N 帧才确认
    const stable = gestureDebouncer.push(info.gesture);
    state.gesture = stable;
    if (gestureDebouncer.isNew() && stable) onGesture(stable);

    updateHandTransform(lm);
  } else {
    state.hasHand = false;
    state.hand = null;
    gestureDebouncer.push(null);
    state.gesture = null;
  }
}

/** 把归一化关键点映射到世界坐标（视频 CSS 镜像 → x 取反方向） */
function updateHandTransform(lm) {
  const w = state.viewWidth, h = state.viewHeight;
  const tipX = (lm[8].x + lm[12].x) * 0.5;
  const tipY = (lm[8].y + lm[12].y) * 0.5;
  state.tipWorld.set((0.5 - tipX) * w * 0.95, (0.5 - tipY) * h * 0.80, 0);
  state.tipNorm = { x: tipX, y: tipY };      // 指尖归一化坐标（保留备用）

  const palmX = (lm[0].x + lm[9].x) * 0.5;
  const palmY = (lm[0].y + lm[9].y) * 0.5;
  state.palmWorld.set((0.5 - palmX) * w * 0.70, (0.5 - palmY) * h * 0.55, 0);

  const dx = -(lm[9].x - lm[0].x) * w;
  const dy = (lm[9].y - lm[0].y) * h;
  state.rollTarget = Math.atan2(dx, -dy);
}

/* ==========================================================================
 * 十、手型标定 / 诊断
 * ========================================================================== */
function collectCalibration(fingers) {
  const C = state.calib;
  if (!C.enabled || !fingers || !fingers.length) return;
  for (const d of fingers) {
    if (!C.ratio[d.name]) { C.ratio[d.name] = []; C.ang[d.name] = []; }
    C.ratio[d.name].push(d.ratio);
    C.ang[d.name].push(d.angDeg);
    if (C.ratio[d.name].length > C.maxSamples) {
      C.ratio[d.name].shift();
      C.ang[d.name].shift();
    }
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return quantile(s, 0.5);
};

function suggestCalibration() {
  const C = state.calib;
  const per = {};
  for (const f of FINGER_DEFS) {
    const rs = [...(C.ratio[f.name] || [])].sort((a, b) => a - b);
    const as = [...(C.ang[f.name] || [])].sort((a, b) => a - b);
    if (rs.length < 20) continue;
    const range = quantile(rs, 0.9) - quantile(rs, 0.1);
    const minRange = f.minRange !== undefined ? f.minRange : 0.25;
    if (range < minRange) continue;
    per[f.name] = {
      ratioMin: quantile(rs, 0.10) * 0.98,
      ratioMax: quantile(rs, 0.90) * 1.02,
      angMin: quantile(as, 0.10),
      angMax: quantile(as, 0.90),
      n: rs.length,
    };
  }
  return Object.keys(per).length ? per : null;
}

function applyCalibration() {
  const per = suggestCalibration();
  if (!per) return null;
  const fingers = {};
  for (const f of FINGER_DEFS) {
    const p = per[f.name];
    if (!p) continue;
    f.ratioMin = +p.ratioMin.toFixed(3);
    f.ratioMax = +p.ratioMax.toFixed(3);
    fingers[f.name] = { min: f.ratioMin, max: f.ratioMax };
  }
  const others = ['index', 'middle', 'ring', 'pinky'].map((n) => per[n]).filter(Boolean);
  if (others.length) {
    CONFIG.tension.angleMin = +median(others.map((o) => o.angMin)).toFixed(1);
    CONFIG.tension.angleMax = +median(others.map((o) => o.angMax)).toFixed(1);
    CONFIG.tension.ratioMin = +median(others.map((o) => o.ratioMin)).toFixed(3);
    CONFIG.tension.ratioMax = +median(others.map((o) => o.ratioMax)).toFixed(3);
  }
  return { tension: { ...CONFIG.tension }, fingers };
}

function calibrationSnippet(r) {
  if (!r) return '';
  const lines = FINGER_DEFS.map((f) => {
    const k = r.fingers[f.name];
    const tail = k ? `, ratioMin: ${k.min}, ratioMax: ${k.max}` : '';
    return `  { name: '${f.name}', mcp: ${f.mcp}, pip: ${f.pip}, tip: ${f.tip}, weight: ${f.weight}${tail} },`;
  });
  return '// 实测标定（粘回 gestures.js 的 FINGER_DEFS）:\n'
    + 'const FINGER_DEFS = [\n' + lines.join('\n') + '\n];\n'
    + '// main.js 的 CONFIG.tension:\n'
    + `  angleMin: ${r.tension.angleMin},\n  angleMax: ${r.tension.angleMax},\n`
    + `  ratioMin: ${r.tension.ratioMin},\n  ratioMax: ${r.tension.ratioMax},`;
}

let calibCalcTimer = 0;
let calibSuggested = null;

function updateCalibPanel() {
  const C = state.calib;
  const now = performance.now();
  if (now - calibCalcTimer > 500) {
    calibCalcTimer = now;
    calibSuggested = suggestCalibration();
    ui.btnCalibApply.disabled = !calibSuggested;
  }

  for (const f of FINGER_DEFS) {
    let tr = ui.calibRows.querySelector(`tr[data-f="${f.name}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.f = f.name;
      tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
      ui.calibRows.appendChild(tr);
    }
    const d = C.live.find((x) => x.name === f.name);
    const rs = C.ratio[f.name] || [];
    let rangeTxt = '—';
    if (rs.length >= 20) {
      const s = [...rs].sort((a, b) => a - b);
      rangeTxt = quantile(s, 0.1).toFixed(2) + '~' + quantile(s, 0.9).toFixed(2);
    } else if (rs.length) {
      rangeTxt = '采样 ' + rs.length;
    }
    const td = tr.children;
    td[0].textContent = FINGER_LABEL[f.name];
    td[1].textContent = d ? d.ratio.toFixed(2) : '—';
    td[2].textContent = d ? d.angDeg.toFixed(0) + '°' : '—';
    td[3].textContent = d ? d.openness.toFixed(2) : '—';
    td[3].className = d ? (d.openness > 0.66 ? 'good' : d.openness < 0.32 ? 'warn' : '') : '';
    td[4].textContent = rangeTxt;
  }

  if (!C.enabled) ui.calibHint.innerHTML = '采样已暂停。点上面的按钮重新开始。';
  else if (!state.hasHand && !state.demo) ui.calibHint.innerHTML = '未检测到手 —— 请把手放进画面。';
  else if (!calibSuggested) ui.calibHint.innerHTML = '请对着摄像头 <b>握拳一次</b>、再 <b>完全张开一次</b>，程序会自动学习你的手型。';
  else {
    const names = Object.keys(calibSuggested).map((n) => FINGER_LABEL[n]).join('、');
    ui.calibHint.innerHTML = `已学到 <b>${names}</b> 的范围，可以应用了。`;
  }
}

function doApplyCalibration() {
  const r = applyCalibration();
  if (!r) return;
  state.calib.applied = r;
  ui.calibCode.hidden = false;
  ui.calibCode.textContent = calibrationSnippet(r);
  const names = Object.keys(r.fingers).map((n) => FINGER_LABEL[n]).join('、');
  showToast(`已应用实测标定（${names}）：角度 ${r.tension.angleMin}~${r.tension.angleMax}°`, 5200);
}

/* ==========================================================================
 * 十一、骨架叠加绘制
 * ========================================================================== */
function drawOverlay() {
  const W = window.innerWidth, H = window.innerHeight;
  overlayCtx.clearRect(0, 0, W, H);
  const lm = state.landmarks;
  if (!state.useLandmarks || !lm) { state.landmarksSmooth = null; return; }

  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const raw = lm.map((p) => ({ x: ox + (1 - p.x) * dw, y: oy + p.y * dh }));

  if (!state.landmarksSmooth || state.landmarksSmooth.length !== raw.length) {
    state.landmarksSmooth = raw.map((p) => ({ x: p.x, y: p.y }));
  } else {
    for (let i = 0; i < raw.length; i++) {
      state.landmarksSmooth[i].x += (raw[i].x - state.landmarksSmooth[i].x) * 0.45;
      state.landmarksSmooth[i].y += (raw[i].y - state.landmarksSmooth[i].y) * 0.45;
    }
  }
  const pts = state.landmarksSmooth;

  for (const pass of [{ w: 6, a: 0.16, c: '139,233,255' }, { w: 1.6, a: 0.9, c: '170,245,255' }]) {
    overlayCtx.lineWidth = pass.w;
    overlayCtx.lineCap = 'round';
    overlayCtx.strokeStyle = `rgba(${pass.c},${pass.a})`;
    overlayCtx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      overlayCtx.moveTo(pts[a].x, pts[a].y);
      overlayCtx.lineTo(pts[b].x, pts[b].y);
    }
    overlayCtx.stroke();
  }

  const TIPS = new Set([4, 8, 12, 16, 20]);
  // 竖中指时把中指尖点成金色，给点反馈
  const isMiddle = state.gesture === 'middle';
  for (let i = 0; i < pts.length; i++) {
    const isTip = TIPS.has(i);
    overlayCtx.beginPath();
    overlayCtx.arc(pts[i].x, pts[i].y, isTip ? 4.5 : 2.6, 0, Math.PI * 2);
    overlayCtx.fillStyle = (isMiddle && i === 12) ? 'rgba(255,120,220,1)'
      : isTip ? 'rgba(255,211,110,0.95)' : 'rgba(200,250,255,0.9)';
    overlayCtx.fill();
  }
}

/* ==========================================================================
 * 十二、指针控制：拖拽旋转 / 滚轮缩放 / 演示模式虚拟指尖
 * ========================================================================== */
function bindPointerControls() {
  const onMove = (e) => {
    state.pointerX = clamp(e.clientX / window.innerWidth);
    state.pointerY = clamp(e.clientY / window.innerHeight);
    if (state.demo) {
      state.tipWorld.set((state.pointerX - 0.5) * state.viewWidth, (0.5 - state.pointerY) * state.viewHeight, 0);
    }
    if (state.dragging) {
      const dx = e.clientX - state.lastPX;
      const dy = e.clientY - state.lastPY;
      state.lastPX = e.clientX;
      state.lastPY = e.clientY;
      state.userRotY += dx * 0.007;
      state.userRotX = clamp(state.userRotX + dy * 0.005, -1.2, 1.2);
    }
  };

  sceneCanvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    state.lastPX = e.clientX;
    state.lastPY = e.clientY;
    state.pointerDown = true;
    try { sceneCanvas.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  });
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', () => { state.dragging = false; state.pointerDown = false; });
  window.addEventListener('pointercancel', () => { state.dragging = false; state.pointerDown = false; });

  window.addEventListener('wheel', (e) => {
    state.zoom = clamp(state.zoom * (1 + Math.sign(e.deltaY) * 0.07), 0.55, 2.4);
    fitCamera();
    updateViewMetrics();
  }, { passive: true });

  // 双击复位视角
  window.addEventListener('dblclick', () => {
    state.userRotX = 0; state.userRotY = 0; state.zoom = 1;
    fitCamera(); updateViewMetrics();
  });
}

/* ==========================================================================
 * 十三、主循环
 * ========================================================================== */
let lastFrame = performance.now();
let hudTimer = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, Math.max(1 / 240, (now - lastFrame) / 1000));
  lastFrame = now;

  /* ---- 13.1 张力来源：演示 / 固定值 / 真实手势 ---- */
  if (state.forceTension !== null) {
    state.tensionRaw = state.forceTension;
    state.handActive += (1 - state.handActive) * damp(0.08, dt);
    hudTimer = 1;
  } else if (state.demo) {
    state.demoTime += dt;
    if (state.pointerDown) {
      state.tensionRaw = 1;
    } else {
      const cycle = (state.demoTime * 0.22) % 1;
      const p = cycle < 0.5 ? cycle / 0.5 : 1 - (cycle - 0.5) / 0.5;
      state.tensionRaw = 0.05 + 0.95 * smoothstep01(p);
    }
    state.handActive += (1 - state.handActive) * damp(0.08, dt);
  } else {
    const sinceHand = (now - state.lastHandTime) / 1000;
    if (state.hasHand) state.handHold = CONFIG.bloom.holdTime;
    else if (state.handHold > 0) state.handHold -= dt;
    else if (sinceHand > CONFIG.bloom.holdTime) {
      state.tensionRaw += (0 - state.tensionRaw) * damp(CONFIG.bloom.decayLerp, dt);
    }
    state.handActive += ((state.hasHand ? 1 : 0) - state.handActive) * damp(0.08, dt);
  }

  /* ---- 13.2 张力平滑 ---- */
  const target = clamp(state.tensionRaw);
  if (state.debugSnap) {
    state.tension = target;
  } else {
    const tLerp = target > state.tension ? CONFIG.bloom.tensionLerp : CONFIG.bloom.tensionFallLerp;
    state.tension += (target - state.tension) * damp(tLerp, dt);
    if (Math.abs(target - state.tension) < 0.002) state.tension = target;
  }

  /* ---- 13.3 阈值映射 + 0.1 缓动（需求指定公式） ---- */
  state.targetSpread = tensionToSpread(state.tension);
  const prevSpread = state.spread;
  if (state.debugSnap) state.spread = state.targetSpread;
  else state.spread += (state.targetSpread - state.spread) * damp(CONFIG.bloom.spreadLerp, dt);
  const instV = Math.abs(state.spread - prevSpread) / dt;
  state.spreadVelocity += (clamp(instV * 0.3) - state.spreadVelocity) * damp(0.15, dt);

  /* ---- 13.4 状态机 ---- */
  updateSequence(dt);

  /* ---- 13.5 morph 推进（手动 = 由 spread 驱动，自动 = 时间驱动） ---- */
  if (!state.morphManual) {
    const t = clamp((now - state.morphStart) / (state.morphDuration * 1000));
    state.morph = smoothstep01(t);
  }

  /* ---- 13.6 调色板过渡 ---- */
  if (paletteState.t < 1) {
    paletteState.t = clamp(paletteState.t + dt / paletteState.duration);
    const pal = currentPalette();
    material.uniforms.uColorA.value.set(pal[0]);
    material.uniforms.uColorB.value.set(pal[1]);
    material.uniforms.uColorC.value.set(pal[2]);
  }

  /* ---- 13.7 相机俯角：按形态切换（花/文字正对，星系俯视） ---- */
  const elevTarget = state.camElevTarget !== undefined ? state.camElevTarget : CONFIG.camera.elevation;
  if (Math.abs(state.camElev - elevTarget) > 0.05) {
    state.camElev += (elevTarget - state.camElev) * damp(0.06, dt);
    applyCameraPose();
  } else if (state.camElev !== elevTarget) {
    state.camElev = elevTarget;
    applyCameraPose();
  }

  /* ---- 13.8 整体姿态：自转 + 手部跟随 + 用户拖拽 ---- */
  state.spin += ((state.spinTarget !== undefined ? state.spinTarget : CONFIG.spin.idle) - state.spin) * damp(0.05, dt);
  state.spinAngle += state.spin * dt;

  const follow = state.handActive * CONFIG.hand.followStrength;
  const tilt = state.handActive * CONFIG.hand.tiltStrength;
  const baseY = -0.15;

  if (state.demo) {
    const tx = (state.pointerX - 0.5) * state.viewWidth * 0.5 * follow;
    const ty = (0.5 - state.pointerY) * state.viewHeight * 0.4 * follow;
    group.position.x += (tx - group.position.x) * damp(0.06, dt);
    group.position.y += ((baseY + ty) - group.position.y) * damp(0.06, dt);
  } else {
    const tx = state.palmWorld.x * follow;
    const ty = state.palmWorld.y * follow * 0.8;
    group.position.x += (tx - group.position.x) * damp(0.07, dt);
    group.position.y += ((baseY + ty) - group.position.y) * damp(0.07, dt);
  }

  // 数字 / 文字要正对相机；其余形态可以自由旋转
  const handRotY = state.handActive && !state.demo
    ? (state.palmWorld.x / Math.max(0.001, state.viewWidth * 0.35)) * 0.5 * tilt : 0;
  state.autoRotY += ((state.faceCamera > 0.5 ? 0 : 1) - state.autoRotY) * damp(0.06, dt);
  // 全局限定为 0 自转（画面要稳），只保留手部倾斜与用户拖拽
  const rotYTarget = state.userRotY + handRotY + state.spinAngle * state.autoRotY;
  group.rotation.y = lerpAngle(group.rotation.y, rotYTarget, damp(0.12, dt));

  const rotXTarget = state.userRotX + (state.faceCamera > 0.5 ? 0 : Math.sin(now * 0.00016) * 0.05);
  group.rotation.x += (rotXTarget - group.rotation.x) * damp(0.1, dt);

  /* ---- 13.9 uniform ---- */
  const u = material.uniforms;
  u.uTime.value = now * 0.001;
  u.uMorph.value = state.morph;
  u.uSpread.value = state.spread;
  u.uSpin.value = state.spinAngle;
  u.uPulse.value = state.pulse;
  u.uBurst.value = state.burst;
  u.uFlash.value = state.flash;
  u.uVelocity.value = state.spreadVelocity;
  u.uHandActive.value = state.handActive;
  u.uPixelRatio.value = renderer.getPixelRatio();

  const tipLocal = state.tipWorld.clone();
  group.worldToLocal(tipLocal);
  u.uHand.value.copy(tipLocal);

  renderer.render(scene, camera);
  drawOverlay();

  /* ---- 13.10 HUD 限频 8Hz ---- */
  hudTimer += dt;
  if (hudTimer > 0.125) {
    hudTimer = 0;
    state.fps = state.fps ? lerp(state.fps, 1 / dt, 0.25) : 1 / dt;
    updateHUD();
  }
}

function tensionToSpread(t) {
  const a = CONFIG.bloom.closeThreshold;
  const b = CONFIG.bloom.openThreshold;
  if (t <= a) return 0;
  if (t >= b) return 1;
  return smoothstep01((t - a) / (b - a));
}

function updateHUD() {
  ui.tensionVal.textContent = state.tension.toFixed(2);
  ui.tensionBar.style.width = (state.tension * 100).toFixed(1) + '%';
  ui.spreadVal.textContent = state.spread.toFixed(2);
  ui.spreadBar.style.width = (state.spread * 100).toFixed(1) + '%';
  ui.statFps.textContent = state.fps.toFixed(0);

  if (state.demo) {
    setStatus(ui.statHand, '演示中（虚拟手势）', 'warn');
  } else if (state.hasHand && state.hand) {
    const g = state.gesture;
    const label = g ? GESTURE_LABEL[g] || g : '识别中…';
    setStatus(ui.statHand, label, 'ok');
  } else {
    setStatus(ui.statHand, '未检测到手', 'warn');
  }

  updateChainStatus();
  if (state.calib.open) updateCalibPanel();
}

const GESTURE_LABEL = {
  fist: '握拳 ✊', palm: '巴掌 🖐', 1: '数字 1', 2: '数字 2', 3: '数字 3', 4: '数字 4',
  middle: '中指 → 星系', ok: 'OK → 烟花',
};

function updateChainStatus() {
  const d = state.diag;
  if (state.demo && state.forceTension === null) {
    setStatus(ui.statChain, '演示模式（未用摄像头）', 'warn');
    return;
  }
  const short = (s) => String(s).replace(/（.*?）/g, '').slice(0, 12);
  const text = `${short(d.camera)} → ${short(d.model)} → ${short(d.infer)}`;
  const bad = /失败|不可用|未启动/.test(d.camera + d.model + d.infer);
  setStatus(ui.statChain, text, bad ? 'bad' : 'ok');
}

/* ==========================================================================
 * 十四、界面绑定
 * ========================================================================== */
function bindUI() {
  $('btnPanel').addEventListener('click', () => ui.panel.classList.toggle('collapsed'));

  $('btnCamera').addEventListener('click', (e) => {
    state.useVideo = !state.useVideo;
    document.body.classList.toggle('no-video', !state.useVideo);
    e.currentTarget.textContent = '摄像头画面：' + (state.useVideo ? '开' : '关');
    e.currentTarget.classList.toggle('off', !state.useVideo);
  });

  $('btnLandmarks').addEventListener('click', (e) => {
    state.useLandmarks = !state.useLandmarks;
    document.body.classList.toggle('no-skeleton', !state.useLandmarks);
    e.currentTarget.textContent = '手部骨架：' + (state.useLandmarks ? '开' : '关');
    e.currentTarget.classList.toggle('off', !state.useLandmarks);
    if (!state.useLandmarks) overlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  });

  $('btnDemo').addEventListener('click', (e) => {
    state.demo = !state.demo;
    state.demoTime = 0;
    state.landmarks = null;
    state.landmarksSmooth = null;
    state.handHold = 0;
    e.currentTarget.textContent = '演示模式：' + (state.demo ? '开' : '关');
    e.currentTarget.classList.toggle('off', !state.demo);
    setStatus(ui.statMode, state.demo ? '演示（无摄像头）' : '手势控制', state.demo ? 'warn' : 'ok');
    setStatus(ui.statCamera, state.demo ? '未使用' : (video.srcObject ? '已就绪' : '未开启'));
  });

  // 手动播放整段序列（没有摄像头也能看效果）
  const btnGalaxy = $('btnGalaxy');
  if (btnGalaxy) btnGalaxy.addEventListener('click', () => setPhase(PHASE.GALAXY));
  const btnFire = $('btnFirework');
  if (btnFire) btnFire.addEventListener('click', () => setPhase(PHASE.FIREWORK));

  // 粒子数量
  const countInput = $('rangeCount');
  const countVal = $('rangeCountVal');
  countInput.addEventListener('input', () => { countVal.textContent = countInput.value; });
  countInput.addEventListener('change', () => {
    const n = parseInt(countInput.value, 10);
    setLoading('重建粒子（' + n + ' 个）…');
    ui.loading.classList.remove('hidden');
    ui.loading.style.display = '';
    setTimeout(() => {
      createParticles(n);
      onResize();
      setPhase(PHASE.IDLE);
      hideLoading();
    }, 30);
  });

  const bindRange = (id, valId, apply, digits = 1) => {
    const input = $(id), out = $(valId);
    if (!input) return;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = v.toFixed(digits);
      apply(v);
    });
  };
  bindRange('rangeSize', 'rangeSizeVal', (v) => { CONFIG.particles.size = v; if (material) material.uniforms.uSize.value = v; });
  bindRange('rangeGlow', 'rangeGlowVal', (v) => { if (material) material.uniforms.uIntensity.value = v; }, 2);
  bindRange('rangeRadius', 'rangeRadiusVal', (v) => {
    CONFIG.hand.influenceRadius = v;
    if (material) material.uniforms.uHandRadius.value = v;
  }, 2);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); $('btnDemo').click(); }
    if (e.code === 'Digit1') showDigit(1);
    if (e.code === 'Digit2') showDigit(2);
    if (e.code === 'Digit3') showDigit(3);
    if (e.code === 'Digit4') showDigit(4);
    if (e.code === 'KeyG') setPhase(PHASE.GALAXY);
    if (e.code === 'KeyF') setPhase(PHASE.FIREWORK);
  });

  /* 手型标定 */
  const btnCalib = $('btnCalib');
  const setCalibOpen = (open) => {
    state.calib.open = open;
    state.calib.enabled = open;
    $('calibBody').hidden = !open;
    btnCalib.textContent = '手型标定 / 诊断：' + (open ? '开' : '关');
    btnCalib.classList.toggle('off', !open);
    if (!open) state.calib.live = [];
  };
  btnCalib.addEventListener('click', () => setCalibOpen(!state.calib.open));
  $('btnCalibReset').addEventListener('click', () => {
    state.calib.ratio = {};
    state.calib.ang = {};
    state.calib.applied = null;
    ui.calibCode.hidden = true;
    calibSuggested = null;
    ui.btnCalibApply.disabled = true;
    showToast('已清空标定采样', 2400);
  });
  $('btnCalibApply').addEventListener('click', doApplyCalibration);

  if (new URLSearchParams(location.search).get('calibrate') === '1') {
    ui.panel.classList.remove('collapsed');
    setCalibOpen(true);
  }

  $('btnRetry').addEventListener('click', async () => {
    hideCameraBanner();
    setLoading('重新连接摄像头…');
    ui.loading.classList.remove('hidden');
    ui.loading.style.display = '';
    await connectCamera();
  });
  $('btnSkip').addEventListener('click', () => {
    hideCameraBanner();
    enableDemo('你选择了演示模式（未使用摄像头）');
  });
}

function enableDemo(reason) {
  state.demo = true;
  state.landmarks = null;
  state.landmarksSmooth = null;
  $('btnDemo').textContent = '演示模式：开';
  $('btnDemo').classList.add('off');
  setStatus(ui.statMode, '演示（无摄像头）', 'warn');
  setStatus(ui.statHand, '虚拟手势', 'warn');
  updateChainStatus();
  if (reason) showToast(reason, 5200);
}

async function connectCamera() {
  try {
    hideCameraBanner();
    setLoading('检测摄像头设备…');
    state.diag.devices = await probeDevices();

    setLoading('请求摄像头权限（浏览器会弹出授权提示，最长等待 12 秒）…');
    state.diag.camera = '请求权限中…';
    setStatus(ui.statCamera, '请求权限中…', 'warn');
    await initCamera();
    setStatus(ui.statCamera, '已就绪', 'ok');

    setStatus(ui.statHand, '加载模型…', 'warn');
    hands = await initHands();

    setStatus(ui.statHand, '识别中…', 'ok');
    state.demo = false;
    $('btnDemo').textContent = '演示模式：关';
    $('btnDemo').classList.remove('off');
    hideLoading();
    pumpHands();
    updateChainStatus();
    showToast('摄像头已就绪：握拳收拢 / 巴掌绽放 / 比数字 4 看完整流程', 4600);
  } catch (err) {
    console.error('[启动失败]', err);
    state.diag.error = err && err.message ? err.message : String(err);
    hideLoading();
    setStatus(ui.statCamera, '不可用', 'bad');
    setStatus(ui.statHand, '未启动', 'bad');
    enableDemo('');

    const isModel = /MediaPipe|模型|脚本/.test(state.diag.error);
    showCameraBanner(
      isModel ? '⚠️ 手部识别模型加载失败' : '⚠️ 摄像头没有启用',
      state.diag.error,
      [
        `<b>设备情况</b>：${state.diag.devices}`,
        `<b>浏览器</b>：${navigator.userAgent.slice(0, 110)}`,
        `当前页面地址：<code>${location.href}</code>（摄像头必须走 localhost 或 https）`,
        isModel
          ? '模型走 CDN 下载（首次约 6MB），请确认网络能访问 jsdelivr；离线环境可参考 README 第 3 节本地引入'
          : '点浏览器地址栏左侧的 🔒 图标 → 把「摄像头」改成「允许」→ 刷新页面',
        '如果摄像头正被会议软件（腾讯会议 / 钉钉 / Zoom）占用，请先退出它们',
        '改好后点下面的「重试连接摄像头」，不需要刷新页面',
      ],
    );
    updateChainStatus();
  }
}

/* ==========================================================================
 * 十五、启动
 * ========================================================================== */
async function boot() {
  const params = new URLSearchParams(location.search);

  const countParam = parseInt(params.get('count'), 10);
  const initialCount = Number.isFinite(countParam) && countParam >= 500
    ? countParam
    : (isMobile ? CONFIG.particles.mobileCount : CONFIG.particles.count);

  const countInput = $('rangeCount');
  countInput.value = String(initialCount);
  $('rangeCountVal').textContent = String(initialCount);
  $('rangeSize').value = String(CONFIG.particles.size);
  $('rangeSizeVal').textContent = CONFIG.particles.size.toFixed(1);
  CONFIG.hand.influenceRadius = parseFloat($('rangeRadius').value);

  setLoading('初始化 Three.js 场景…');
  try {
    initThree();
    createParticles(initialCount);
    setPhase(PHASE.IDLE);
  } catch (err) {
    console.error(err);
    ui.loading.innerHTML = '<div class="loading-box"><p>❌ 无法初始化 WebGL</p>'
      + '<small>' + (err && err.message ? err.message : err)
      + '<br>请使用支持 WebGL2 的现代浏览器（Chrome / Edge / Safari），并确认已开启硬件加速。</small></div>';
    return;
  }
  bindUI();
  setStatus(ui.statMode, '手势控制', 'ok');

  requestAnimationFrame(animate);
  if (isMobile) ui.panel.classList.add('collapsed');

  // 调试：?tension=0~1 固定张开度；?shape=galaxy 直接看某个形态
  const forced = params.get('tension');
  if (forced !== null && forced !== '' && !Number.isNaN(parseFloat(forced))) {
    state.forceTension = clamp(parseFloat(forced));
    state.debugSnap = true;
    state.spread = tensionToSpread(state.forceTension);
    state.tension = state.forceTension;
    ui.loading.style.transition = 'none';
    ui.loading.style.display = 'none';
  }
  const shapeParam = params.get('shape');
  if (shapeParam) {
    // 纯形态预览：锁定形态，不进入状态机（否则数字会自己播完回到 IDLE）
    state.shapeLock = true;
    if (shapeParam === 'text') {
      setShape('glyph', { text: CONFIG.shape.text, opts: { fontSize: CONFIG.shape.textFontSize, step: CONFIG.shape.glyphStep } }, 0.4);
    } else if (/^[1-4]$/.test(shapeParam)) {
      setShape('glyph', { text: shapeParam, opts: { fontSize: CONFIG.shape.digitFontSize, step: CONFIG.shape.glyphStep } }, 0.4);
    } else {
      setShape(shapeParam, {}, 0.4);
    }
  }

  const forceDemo = params.get('demo') === '1' || state.forceTension !== null;
  if (forceDemo) {
    state.demo = state.forceTension === null;
    $('btnDemo').textContent = '演示模式：' + (state.demo ? '开' : '关');
    $('btnDemo').classList.toggle('off', !state.demo);
    setStatus(ui.statMode, state.demo ? '演示（无摄像头）' : '调试（固定 tension）', 'warn');
    setStatus(ui.statCamera, '未使用');
    setStatus(ui.statHand, state.demo ? '演示中（虚拟手势）' : '—', 'warn');
    updateChainStatus();
    hideLoading();
    if (state.demo) showToast('演示模式：无需摄像头。按 1/2/3/4、G、F 键也能触发各种形态', 6000);
    return;
  }

  await connectCamera();
}

window.addEventListener('beforeunload', () => {
  pumping = false;
  if (hands && typeof hands.close === 'function') hands.close();
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
});

/* 调试接口：控制台里可以直接 __flower.setPhase('galaxy') 之类，方便排查 */
window.__flower = {
  state, CONFIG, PHASE, setPhase, setShape, showDigit,
  get geometry() { return geometry; },
  get material() { return material; },
  get count() { return particleCount; },
  /** 当前粒子位置包围盒，用来确认几何是否正常 */
  bounds() {
    const a = geometry.attributes.position.array;
    const t = geometry.attributes.aTarget.array;
    const m = state.morph;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let nan = 0;
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = a[i + k] + (t[i + k] - a[i + k]) * m;
        if (!Number.isFinite(v)) nan++;
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    return { lo: lo.map((v) => +v.toFixed(2)), hi: hi.map((v) => +v.toFixed(2)), nan, morph: +m.toFixed(3) };
  },
};

boot();
