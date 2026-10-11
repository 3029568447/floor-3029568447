/* ==========================================================================
 * gestures.js · 手部姿态识别
 * --------------------------------------------------------------------------
 * 纯函数模块，不依赖 DOM / Three.js，可在 Node 里直接单测。
 * 对外只暴露一个 analyzeHand()：一次算出张力、每指标的和手势结论。
 * ========================================================================== */

/* 五根手指定义：mcp = 掌指关节，pip = 近端指间关节，tip = 指尖
 * 拇指的运动学和其余四指差别很大（握拳时它横跨掌心而非卷回），
 * 实测 ratio 只在 1.0~1.7 之间变化，所以：单独标定 + 降低权重 + 放低采样门槛。 */
export const FINGER_DEFS = [
  { name: 'thumb',  mcp: 2,  pip: 3,  tip: 4,  weight: 0.35, ratioMin: 1.00, ratioMax: 1.60, minRange: 0.08 },
  { name: 'index',  mcp: 5,  pip: 6,  tip: 8,  weight: 1.15 },
  { name: 'middle', mcp: 9,  pip: 10, tip: 12, weight: 1.20 },
  { name: 'ring',   mcp: 13, pip: 14, tip: 16, weight: 1.10 },
  { name: 'pinky',  mcp: 17, pip: 18, tip: 20, weight: 0.95 },
];

/* 判定「这根手指伸出了」的阈值（0~1 的 openness） */
export const EXTEND_THRESHOLD = 0.55;

/** 是否把手背/掌心朝向相机都算同一套 —— 这里不做左右手区分，保持简单 */
export const FINGER_LABEL = { thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', pinky: '小指' };

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

/** 三维两点距离 */
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 顶点 v 处，两条边 v→a 与 v→b 的夹角（弧度） */
function angleAt(v, a, b) {
  const ax = a.x - v.x, ay = a.y - v.y, az = a.z - v.z;
  const bx = b.x - v.x, by = b.y - v.y, bz = b.z - v.z;
  const la = Math.hypot(ax, ay, az) || 1e-6;
  const lb = Math.hypot(bx, by, bz) || 1e-6;
  const cos = clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1);
  return Math.acos(cos);
}

/* ==========================================================================
 * 分析一帧手部关键点
 * --------------------------------------------------------------------------
 * @param {Array}  lm     MediaPipe 的 21 个归一化关键点
 * @param {number} aspect 画面宽高比（把 x/z 等比化，否则距离会被拉伸）
 * @param {Object} T      张力标定（可被标定面板实时改写）
 * @returns {{
 *   ok: boolean, tension: number, palmScale: number,
 *   fingers: Array, ext: Object, count4: number, count5: number,
 *   gesture: string|null
 * }}
 * ========================================================================== */
export function analyzeHand(lm, aspect, T) {
  if (!lm || lm.length !== 21) return { ok: false, gesture: null };

  // 等比化：x、z 按宽高比缩放，y 不变
  const P = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, z: lm[i].z * aspect });
  const wrist = P(0);

  const fingers = [];
  let sum = 0, wsum = 0;
  const ext = { thumb: false, index: false, middle: false, ring: false, pinky: false };

  for (const f of FINGER_DEFS) {
    const mcp = P(f.mcp), pip = P(f.pip), tip = P(f.tip);
    const rMin = f.ratioMin !== undefined ? f.ratioMin : T.ratioMin;
    const rMax = f.ratioMax !== undefined ? f.ratioMax : T.ratioMax;

    // (1) 距离比指标：握拳≈0.8，伸直≈1.9
    const ratio = dist3(wrist, tip) / Math.max(1e-4, dist3(wrist, mcp));
    const oDist = clamp((ratio - rMin) / Math.max(1e-4, rMax - rMin));

    // (2) 关节夹角指标：伸直≈175°，握拳≈50°
    const angDeg = angleAt(pip, mcp, tip) * 180 / Math.PI;
    const oAng = clamp((angDeg - T.angleMin) / Math.max(1e-4, T.angleMax - T.angleMin));

    // (3) 融合
    const openness = T.wDist * oDist + T.wAngle * oAng;
    fingers.push({ name: f.name, ratio, angDeg, oDist, oAng, openness, weight: f.weight });
    ext[f.name] = openness > EXTEND_THRESHOLD;

    sum += openness * f.weight;
    wsum += f.weight;
  }

  const tension = clamp(sum / Math.max(1e-6, wsum));
  const palmScale = Math.max(1e-4, dist3(wrist, P(9)));   // 手腕→中指掌指关节

  // 食指到小指中，有几根伸出来了
  const fourNames = ['index', 'middle', 'ring', 'pinky'];
  const count4 = fourNames.filter((n) => ext[n]).length;
  const count5 = count4 + (ext.thumb ? 1 : 0);

  /* ------------------------- 手势判定（按优先级） ------------------------- */
  let gesture = null;

  // OK：拇指尖与食指尖捏在一起，其余三指伸出
  const pinch = dist3(P(4), P(8)) / palmScale;
  const threeOut = ext.middle && ext.ring && ext.pinky;
  if (pinch < 0.42 && threeOut) {
    gesture = 'ok';
  } else if (ext.middle && !ext.index && !ext.ring && !ext.pinky) {
    // 只竖中指 —— 与「数字 1」靠伸的是哪根手指区分
    gesture = 'middle';
  } else if (count5 >= 5) {
    gesture = 'palm';
  } else if (count4 === 4) {
    gesture = '4';
  } else if (count4 === 3) {
    gesture = '3';
  } else if (count4 === 2) {
    gesture = '2';
  } else if (count4 === 1) {
    // 只伸一根：食指=数字1；中指已在上面判过了
    gesture = ext.index ? '1' : (ext.middle ? 'middle' : null);
  } else if (count4 === 0 && tension < 0.32) {
    gesture = 'fist';
  }

  return { ok: true, tension, palmScale, fingers, ext, count4, count5, pinch, gesture };
}

/**
 * 手势去抖：同一个手势需要连续 N 帧稳定才认。
 * 手抖、关键点跳变都会造成误触发，这一步必不可少。
 */
export function makeGestureDebouncer(framesNeeded = 4) {
  let current = null, count = 0, confirmed = null;
  return {
    /** 喂入本帧手势，返回「已确认并稳定」的手势（未变化时返回同一个值） */
    push(g) {
      if (g === current) {
        count++;
      } else {
        current = g;
        count = 1;
      }
      if (count >= framesNeeded) confirmed = current;
      return confirmed;
    },
    /** 手势刚变成确认值的「上升沿」——只在切换的那一帧返回 true */
    isNew() { return count === framesNeeded; },
    get value() { return confirmed; },
    reset() { current = null; count = 0; confirmed = null; },
  };
}
