/* ==========================================================================
 * shapes.js · 粒子形态库
 * --------------------------------------------------------------------------
 * 每个 build* 函数把 count 个粒子的目标位置写进 out（Float32Array, count*3），
 * 同时写 aux 里的每粒子属性：
 *   aux.size   [count]  粒子大小系数
 *   aux.radial [count]  0~1，用于在调色板三色之间渐变
 *   aux.kind   [count]  0=普通 1=星尘/闪光 2=核心
 *
 * 纯计算 + 字形采样（字形需要 canvas），不依赖 Three.js。
 * ========================================================================== */

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

/** 确定性伪随机：同一粒子索引在每次构建时得到相同值，形状可复现 */
const hash = (n) => {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
};
/** 近似高斯（三均匀相加），用于给盘面/云团做柔和厚度 */
const gauss = (n) => (hash(n * 1.7) + hash(n * 3.1) + hash(n * 5.3) - 1.5) * 1.155;

/* ==========================================================================
 * 一、粒子形态
 * ========================================================================== */

/** 花苞：把整朵花收拢成一颗水滴形，螺旋包裹像层叠花瓣 */
function buildBud(out, count, p, aux) {
  const R = p.radius;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37);

    const tRaw = h1 * 2 - 1;
    const t = clamp(tRaw * 0.8 + (h3 * 2 - 1) * 0.28, -1, 1);
    const theta = h2 * TAU + t * 1.9;                          // 螺旋包裹
    const profile = Math.pow(Math.max(1e-4, 1 - t * t), 0.58) * (1 - 0.16 * t);
    const rr = R * 0.33 * profile * (0.88 + 0.24 * h3);

    out[i3] = Math.cos(theta) * rr;
    out[i3 + 1] = Math.sin(theta) * rr;
    out[i3 + 2] = R * 0.22 + t * R * 0.88;      // 花苞朝观众竖起

    aux.size[i] = 0.6 + h2 * 0.9;
    aux.radial[i] = clamp(Math.abs(t) * 0.5 + h2 * 0.5);
    aux.kind[i] = 0;
  }
}

/**
 * 绽放的立体花 —— 花轴朝 +Z（面向观众）。
 * 参照效果：花瓣在屏幕平面层层展开、中心白热，而不是平躺着从侧面看。
 * 花瓣按黄金角螺旋排列：外圈平摊、内圈挺立，每片自带拱起/外翻/碗状弧度，
 * 层次沿 Z 轴堆叠，所以正面看是饱满的花，侧一点看仍有厚度。
 */
function buildBloom(out, count, p, aux) {
  const R = p.radius;
  const petals = p.petals || 30;
  const GOLDEN = 2.39996323;                 // 黄金角，保证花瓣不重叠、不放射状排列

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37), h4 = hash(i * 6.19);

    /* --- 18% 白热花心：整个花的亮度都在这里，必须接近纯白 --- */
    if (h4 < 0.18) {
      const r = R * 0.26 * Math.pow(h1, 0.45);
      const th = i * GOLDEN;
      const ph = Math.acos(2 * h2 - 1);
      out[i3] = Math.sin(ph) * Math.cos(th) * r;
      out[i3 + 1] = Math.sin(ph) * Math.sin(th) * r;
      out[i3 + 2] = R * 0.16 + Math.cos(ph) * r * 0.75;      // 花心凸向观众
      aux.size[i] = 0.55 + h3 * 0.7;
      aux.radial[i] = h1 * 0.10;             // 最内圈 → 走白热色
      aux.kind[i] = 2;
      continue;
    }

    /* --- 8% 外围星尘：范围收窄，只做氛围不抢主体 --- */
    if (h4 > 0.92) {
      const theta = h1 * TAU;
      const phi = Math.acos(2 * h2 - 1);
      const rr = R * (0.85 + 0.38 * Math.pow(h3, 0.7));
      out[i3] = Math.sin(phi) * Math.cos(theta) * rr;
      out[i3 + 1] = Math.sin(phi) * Math.sin(theta) * rr;
      out[i3 + 2] = Math.cos(phi) * rr * 0.55;
      aux.size[i] = 0.4 + h1 * 0.6;
      aux.radial[i] = 0.82 + h2 * 0.18;
      aux.kind[i] = 1;
      continue;
    }

    /* --- 花瓣：黄金角螺旋，由外到内逐渐变短、变立、升高 --- */
    const petalIdx = Math.floor(h1 * petals);
    const layer = petalIdx / petals;                          // 0 外圈 → 1 内圈
    const theta = petalIdx * GOLDEN;

    const len = R * lerp(0.86, 0.24, Math.pow(layer, 0.82));
    const wid = R * lerp(0.92, 0.34, Math.pow(layer, 0.9));    // 宽 ≈ 长，才是花瓣而不是触须
    const tilt = lerp(0.06, 1.46, Math.pow(layer, 0.72));      // 外平摊、内挺立
    const yOff = R * lerp(-0.02, 0.80, Math.pow(layer, 1.4));  // 内层抬高，强化立体感

    // 径向分布偏向瓣缘：边缘粒子更密 → 花瓣轮廓被"勾"出来，而不是一团雾
    const u = Math.pow(h2, 0.58);                              // 0 花心 → 1 瓣尖
    const s = h3 * 2 - 1;                                      // 横向 -1 → 1

    // 花瓣轮廓半宽：指数压低 → 轮廓更圆润，不像尖角星形
    const hw = 0.5 * wid * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.58) * (1 - 0.15 * u);

    // 外层花瓣尖端下翻、内层尖端上包 —— 这是「层层包裹」的关键
    const curl = lerp(-0.52, 0.42, layer) * len * Math.pow(u, 2.4);

    const lx = u * len;                                        // 沿花瓣方向
    const lz = s * hw;                                         // 花瓣横向
    const ly = 0.30 * len * Math.sin(u * Math.PI * 0.92) * (0.35 + layer)   // 纵向拱起
             + curl                                                        // 瓣尖上包/下翻
             + 0.42 * wid * s * s * (0.6 + layer)                          // 横向碗状弧度（包裹感）
             + (h4 - 0.5) * 0.012 * R;                                     // 轻微自然抖动

    // 先绕 Z 轴倾斜（把 +X 抬向 +Y），再绕 Y 轴转到花瓣方位
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const px = lx * ct - ly * st;
    const py = lx * st + ly * ct;
    const c = Math.cos(theta), sn = Math.sin(theta);

    // 花轴朝 +Z：花瓣在 XY 平面展开，「层高」沿 Z 堆叠（内层在前）
    out[i3] = px * c + lz * sn;
    out[i3 + 1] = -px * sn + lz * c;
    out[i3 + 2] = py + yOff;

    aux.size[i] = 0.46 + h2 * 0.62;                            // 粒子偏小 → 更细腻
    aux.radial[i] = clamp(0.10 + layer * 0.62 + (h3 * 0.5 + 0.5) * 0.35);
    aux.kind[i] = 0;
  }
}

/** 星系：四条对数螺旋臂 + 中央核球，整体倾斜成一个好看的盘面 */
function buildGalaxy(out, count, p, aux) {
  const R = p.radius * 1.32;
  const arms = 4;
  const twist = 2.6;
  const tiltX = 1.02;                    // 盘面倾角（弧度），让相机看到斜盘
  const ct = Math.cos(tiltX), st = Math.sin(tiltX);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37), h4 = hash(i * 6.19);

    let px, py, pz;

    if (h4 < 0.16) {
      /* --- 核球：偏球形的致密核心 --- */
      const r = R * 0.20 * Math.pow(h1, 0.55);
      const th = h2 * TAU;
      const ph = Math.acos(2 * h3 - 1);
      px = r * Math.sin(ph) * Math.cos(th);
      pz = r * Math.sin(ph) * Math.sin(th);
      py = r * Math.cos(ph) * 0.85;
      aux.radial[i] = 0.05 + h1 * 0.25;
      aux.size[i] = 0.5 + h2 * 0.7;
      aux.kind[i] = 2;
    } else {
      /* --- 螺旋臂：对数螺旋 + 臂宽随半径收窄 --- */
      const arm = Math.floor(h1 * arms);
      const t = Math.pow(h2, 0.62);                       // 径向 0 内 → 1 外
      const rad = R * (0.14 + 0.9 * t);
      const armWidth = 0.55 * (1 - t * 0.45);
      const base = arm * (TAU / arms) + twist * Math.log(rad / R * 5.2 + 0.25);
      const th = base + (h3 * 2 - 1) * armWidth;
      px = Math.cos(th) * rad;
      pz = Math.sin(th) * rad;
      py = gauss(i * 0.77) * R * 0.045 * (1 - t * 0.55);  // 盘厚：内厚外薄
      aux.radial[i] = clamp(0.15 + t * 0.9);
      aux.size[i] = 0.42 + h4 * 0.75;
      aux.kind[i] = h3 > 0.93 ? 1 : 0;
    }

    // 盘面绕 X 轴倾斜
    out[i3] = px;
    out[i3 + 1] = py * ct - pz * st;
    out[i3 + 2] = py * st + pz * ct;
  }
}

/** 龙卷风：下窄上宽的漏斗 + 强螺旋 */
function buildTornado(out, count, p, aux) {
  const R = p.radius * 1.05;
  const H = p.radius * 1.95;
  const turns = 3.4;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37);

    const t = Math.pow(h1, 0.85);                  // 0 底部 → 1 顶部
    const radius = R * (0.10 + 0.95 * Math.pow(t, 1.55));
    const theta = h2 * TAU + t * turns * TAU;      // 越往上螺旋越多
    const jitter = 1 + (h3 - 0.5) * 0.22;

    out[i3] = Math.cos(theta) * radius * jitter;
    out[i3 + 1] = -H * 0.5 + t * H + (h3 - 0.5) * 0.06 * H;
    out[i3 + 2] = Math.sin(theta) * radius * jitter;

    aux.size[i] = 0.45 + h2 * 0.9;
    aux.radial[i] = clamp(t * 1.05);
    aux.kind[i] = h1 > 0.9 ? 1 : 0;
  }
}

/** 立体爱心：经典心形参数方程填充 + 中心隆起成饱满的三维心 */
function buildHeart(out, count, p, aux) {
  const S = p.radius * 0.072;        // 心形方程的量纲缩放
  const THICK = p.radius * 0.52;     // 厚度

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37), h4 = hash(i * 6.19);

    const t = h1 * TAU;
    // 经典心形轮廓
    const ex = 16 * Math.pow(Math.sin(t), 3);
    const ey = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);

    const s = Math.sqrt(h2);                            // 面积均匀：中心不再堆积
    const x = ex * s * S;
    const y = ey * s * S + p.radius * 0.12;
    // 厚度：中心最鼓、边缘收平，配合少量噪声更像粒子团
    const z = (h3 > 0.5 ? 1 : -1) * THICK * Math.sqrt(Math.max(0, 1 - s * s)) * (0.55 + 0.45 * h4);

    out[i3] = x;
    out[i3 + 1] = y;
    out[i3 + 2] = z;

    aux.size[i] = 0.5 + h4 * 0.85;
    aux.radial[i] = clamp(s * 0.9 + h3 * 0.2);
    aux.kind[i] = s > 0.9 ? 1 : 0;
  }
}

/** 烟花爆开：接近球壳的爆散，半径铺满画面 */
function buildFirework(out, count, p, aux) {
  const R = p.radius * 1.45;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37);

    const theta = h1 * TAU;
    const phi = Math.acos(2 * h2 - 1);
    const rr = R * (0.72 + 0.28 * Math.pow(h3, 0.5));   // 偏球壳，中心留空

    out[i3] = Math.sin(phi) * Math.cos(theta) * rr;
    out[i3 + 1] = Math.cos(phi) * rr * 0.92;
    out[i3 + 2] = Math.sin(phi) * Math.sin(theta) * rr;

    aux.size[i] = 0.4 + h2 * 0.9;
    aux.radial[i] = h3;
    aux.kind[i] = h1 > 0.86 ? 1 : 0;
  }
}

/** 星尘球：小尺寸球壳，用于收拢/过场 */
function buildSphere(out, count, p, aux) {
  const R = p.radius * 0.55;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37);
    const theta = h1 * TAU;
    const phi = Math.acos(2 * h2 - 1);
    const rr = R * (0.35 + 0.65 * Math.pow(h3, 0.5));
    out[i3] = Math.sin(phi) * Math.cos(theta) * rr;
    out[i3 + 1] = Math.cos(phi) * rr;
    out[i3 + 2] = Math.sin(phi) * Math.sin(theta) * rr;
    aux.size[i] = 0.5 + h2 * 0.8;
    aux.radial[i] = h3;
    aux.kind[i] = 0;
  }
}

/* ==========================================================================
 * 三、字形采样（数字 / 文字）
 * ========================================================================== */

const glyphCache = new Map();

/**
 * 把文字画到离屏 canvas，再读出像素点，作为粒子目标位置。
 * 这是让「粒子组成漂亮的阿拉伯数字 / 汉字」最可靠的做法。
 *
 * @returns {{pts: Array<[number,number]>, w: number, h: number}}
 */
export function sampleGlyph(text, opts = {}) {
  const key = text + '|' + JSON.stringify(opts);
  if (glyphCache.has(key)) return glyphCache.get(key);

  const dpr = 1;
  const fontSize = opts.fontSize || 300;
  const font = opts.font || `bold ${fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const step = opts.step || 4;
  const pad = Math.round(fontSize * 0.18);

  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textW = Math.max(1, Math.ceil(metrics.width));

  cv.width = Math.ceil(textW + pad * 2) * dpr;
  cv.height = Math.ceil(fontSize * 1.35 + pad) * dpr;

  // 尺寸变了要重设 font
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, cv.width / 2, cv.height / 2);

  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const pts = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < cv.height; y += step) {
    for (let x = 0; x < cv.width; x += step) {
      if (data[(y * cv.width + x) * 4] > 128) {
        pts.push([x, y]);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  // 实际墨迹的外接框 —— 用它来缩放/居中，比 canvas 尺寸准得多
  // （canvas 里有一大圈 padding，用它缩放会让字变得又小又偏）
  const bbox = pts.length
    ? { x0, y0, x1, y1, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
    : { x0: 0, y0: 0, x1: cv.width, y1: cv.height, w: cv.width, h: cv.height };

  const result = { pts, w: cv.width, h: cv.height, bbox };
  glyphCache.set(key, result);
  return result;
}

/**
 * 把字形点铺成粒子。
 * 缩放取「宽度约束」和「高度约束」中更严格的那个，
 * 这样单个数字受高度限制、一排文字受宽度限制，都不会溢出画面。
 */
function buildGlyph(out, count, p, aux, text, opts) {
  const { pts, bbox } = sampleGlyph(text, opts);
  const targetW = p.radius * (opts.widthFactor || 2.05);
  const targetH = p.radius * (opts.heightFactor || 2.2);
  const scale = Math.min(targetW / bbox.w, targetH / bbox.h);
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  // 立体厚度按字形实际高度取比例 —— 用绝对值会让笔画厚的方向糊成一片
  const depth = bbox.h * scale * (opts.depth !== undefined ? opts.depth : 0.09);

  const n = Math.max(1, pts.length);
  // ★ 均匀映射：不能用 pts[i % n]。
  //   字形点是按行扫描生成的，粒子数少于点数时 i % n 只会取到前面若干个点，
  //   也就是「只有上半部分」。这里把 i 均匀映射到整份点列表上。
  const sparse = Math.max(1, n / count);          // 点比粒子多 → 需要放大抖动补空隙
  const jitter = (opts.step || 4) * 0.5 * Math.sqrt(sparse);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71), h3 = hash(i * 4.37);

    const pt = pts[Math.floor(i * n / count) % n];
    const px = pt[0] + (h1 - 0.5) * jitter;
    const py = pt[1] + (h2 - 0.5) * jitter;

    out[i3] = (px - cx) * scale;
    out[i3 + 1] = (cy - py) * scale;
    out[i3 + 2] = (h3 * 2 - 1) * depth * (0.4 + 0.6 * h1);

    aux.size[i] = 0.38 + h2 * 0.62;
    aux.radial[i] = clamp(0.15 + h1 * 0.85);
    aux.kind[i] = h3 > 0.92 ? 1 : 0;
  }
}

/* ==========================================================================
 * 三、统一入口
 * ========================================================================== */

/**
 * 构建指定形态。
 * @param {string} name  bud | bloom | galaxy | tornado | heart | firework | sphere | glyph
 * @param {number} count 粒子数
 * @param {Object} p     参数（radius / petals 等）
 * @param {Object} aux   { size, radial, kind } 三个 Float32Array
 * @param {Object} out   Float32Array(count*3)
 * @param {Object} extra 文字形态专用 { text, opts }
 */
export function buildShape(name, count, p, aux, out, extra = {}) {
  switch (name) {
    case 'bud':        return buildBud(out, count, p, aux);
    case 'bloom':      return buildBloom(out, count, p, aux);
    case 'galaxy':     return buildGalaxy(out, count, p, aux);
    case 'tornado':    return buildTornado(out, count, p, aux);
    case 'heart':      return buildHeart(out, count, p, aux);
    case 'firework':   return buildFirework(out, count, p, aux);
    case 'glyph':      return buildGlyph(out, count, p, aux, extra.text || '1', extra.opts || {});
    case 'sphere':
    default:           return buildSphere(out, count, p, aux);
  }
}

/** 每种形态的调色板：核心色 / 中段色 / 边缘色（sRGB 十六进制） */
export const PALETTES = {
  bud:      ['#c94bd8', '#ff4fa3', '#ffeebb'],
  bloom:    ['#c94bd8', '#ff4fa3', '#ffeebb'],
  galaxy:   ['#2b3fbd', '#5ad0ff', '#fff4d6'],
  tornado:  ['#5b2bd8', '#4fd6ff', '#eaffff'],
  heart:    ['#7a0b3d', '#ff2d6f', '#ffd9e8'],
  firework: ['#ff8a3d', '#ffe45e', '#ffffff'],
  glyph:    ['#0f6bd8', '#4fe0ff', '#ffffff'],
  text:     ['#ff9a2e', '#ffd75e', '#fff8d9'],
  sphere:   ['#5b2bd8', '#ff77c8', '#fff0b8'],
};

/** 文字形态专用调色板（爱你老己） */
export const TEXT_PALETTE = ['#ff6a00', '#ffcc33', '#fffbe8'];
