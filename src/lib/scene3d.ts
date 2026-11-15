import type { LightStyle } from "../components/Lights";
import type { LyricLine } from "./types";
import { mirrored, resample } from "./audio";
import { findLineIndex, lineProgress } from "./lrc";

/**
 * 拾音灯的 3D 模式：整幅画在一张画布上。
 *
 * 思路：2D 时的每一根灯都按软件里的尺寸摆在 z = 0 这个面上；打开 3D 只是把镜头转过去、退后，
 * 再让后面的东西（刚才的频谱、地面、星空、山水…）显出来。所以开关 3D 是一次连续的镜头运动，不是换一套画面。
 *
 * 坐标：画布里 1 个单位 = 设计稿（1440×900 舞台）的 1 像素，舞台左上角是 (0,0)；
 * 窗口比例和舞台不一样时，画布比舞台多出来的部分用 full 这个范围表示，天空、地面这些要铺满它。
 */

type P4 = [number, number, number, number];
type Pt = number[];
type G = CanvasRenderingContext2D;
interface Cam {
  p: (x: number, y: number, z: number) => P4;
}

export interface SceneProps {
  style: LightStyle;
  /** 拾音灯配色（专辑色或自定义渐变） */
  palette: string[];
  /** 底色，用来调暗部的色调 */
  base: string;
  /** 灯的亮度 0.25~1（设置里的"亮度"） */
  alpha: number;
  /** 粗细倍数 0.5~1.5 */
  thickness: number;
  playing: boolean;
  /** 跟着音乐跳；关掉时只缓慢呼吸 */
  reactive: boolean;
  /** 3D 开着（关掉时镜头转回 2D 的样子） */
  on3d: boolean;
  /** 系统开了"减少动态效果"：不晃镜头、不浮动，开关直接切 */
  reduce: boolean;
  /** 有时间轴的歌词；没有、或者不显示歌词时是 null */
  lines: LyricLine[] | null;
  duration: number;
  /** 歌词字号倍数 0.7~1.3 */
  lyricScale: number;
  /** 唱过的字的颜色 */
  sung: [number, number, number];
}

const W = 1440;
const H = 900;
const F = 64;
const SANS = `900 ${F}px "Noto Sans SC", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif`;
/** 毛笔字：装了 Ma Shan Zheng 或华文行楷就用，没有就退到楷体 */
export const BRUSH = `400 ${F}px "Ma Shan Zheng", "STXingkai", "华文行楷", "KaiTi", "楷体", serif`;
const INK = ["#1b1d1c", "#2f3a36", "#47524c"];
const PAPER = "238,232,219";

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const rnd = (s: number) => {
  const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const hexRgb = (h: string): number[] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  const n = m ? parseInt(m[1], 16) : 0x1a1238;
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const rgba = (c: number[], a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a)})`;
const hexA = (h: string, a: number) => rgba(hexRgb(h), a);
const line = (g: G, pts: Pt[]) => {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
};
const poly = (g: G, pts: Pt[]) => {
  pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.closePath();
};

interface Tok {
  text: string;
  /** 在这一句里占第几个字到第几个字（算演唱进度用） */
  a: number;
  b: number;
  w: number;
  /** 2D 列表里这个词左边到行首的距离 */
  left: number;
  /** 英文单词：竖排时侧过来写 */
  latin: boolean;
}
interface Mountain {
  z: number;
  a: number;
  blur: number;
  col: string;
  hs: number;
  xs: number[];
  hts: number[];
}
interface Drop {
  born: number;
  seed: number;
  heavy: boolean;
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;
const CJK_PUNCT = /[　-〿！-／：-＠［-｀｛-･·…—～]/;

export class Scene3D {
  props: SceneProps;
  /** 3D 程度：0 是 2D 的样子，1 是完全转过去 */
  k: number;
  /** 手动拖动转的角度 */
  yaw = 0;
  dragging = false;
  private g: G;
  /** 画布上每个舞台像素对应多少个真实像素 */
  private px = 1;
  private x0 = 0;
  private y0 = 0;
  private fw = W;
  private fh = H;
  private last = 0;
  private pal: number[][] = [[255, 111, 145]];
  private baseRgb: number[] = [26, 18, 56];
  private palKey = "";

  // ---- 音乐 ----
  private hist: { t: number; b: number[] }[] = [];
  private lastReal = -1e9;
  private kickEnv = 0;
  private hhEnv = 0;
  private midEnv = 0;
  private avgLow = 0;
  private lastBeat = -1e9;
  private lastHit = -1e9;
  private simT = 0;
  private simBeat = 0;
  private nextSim = 0;

  // ---- 墨晕 ----
  private drops: Drop[] = [];
  private seed = Math.floor(Math.random() * 1e5);
  private layer: HTMLCanvasElement | null = null;
  private layerK = -1;
  private layerN = 0;
  private mt: Mountain[] | null = null;
  private fibers: number[][] | null = null;

  // ---- 其他场景的点缀 ----
  private stars: number[][] | null = null;
  private dust: { r: number; a: number; w: number; s: number; u: number }[] | null = null;
  private moteList: { x: number; z: number; y0: number; sp: number; s: number; u: number; ph: number }[] | null = null;

  // ---- 歌词 ----
  private linesRef: LyricLine[] | null = null;
  private toks = new Map<number, Tok[]>();
  private curTo = -1;
  private curFrom = -1;
  private curAt = -1e9;
  private page = 0;
  private prevPage = -1;
  private pageAt = -1e9;
  private sungLine = -2;
  private sungAt = new Map<number, number>();

  constructor(
    private canvas: HTMLCanvasElement,
    props: SceneProps,
    startK: number,
  ) {
    this.g = canvas.getContext("2d")!;
    this.props = props;
    this.k = startK;
  }

  /** 画布的 CSS 尺寸（窗口像素）和舞台的缩放比例变了 */
  resize(cssW: number, cssH: number, stageScale: number) {
    // 4K 全屏时按原分辨率画太费，总像素封顶在 2560×1440 左右
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3.7e6 / Math.max(1, cssW * cssH)));
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.px = (bw / cssW) * stageScale;
    this.fw = cssW / stageScale;
    this.fh = cssH / stageScale;
    this.x0 = -(this.fw - W) / 2;
    this.y0 = -(this.fh - H) / 2;
    this.layerK = -1;
    this.stars = null;
    this.fibers = null;
  }

  /** 后端推来的一帧频谱（64 段，已经按灵敏度换算过） */
  pushBands(b: number[]) {
    const now = performance.now();
    const t = now / 1000;
    this.lastReal = now;
    this.hist.push({ t, b });
    while (this.hist.length > 2 && t - this.hist[0].t > 1.6) this.hist.shift();
    if (!this.props.reactive || !this.props.playing) return;
    let low = 0;
    for (let i = 0; i < 8; i++) low = Math.max(low, b[i] ?? 0);
    let hh = 0;
    for (let i = 44; i < 64; i++) hh += b[i] ?? 0;
    let mid = 0;
    for (let i = 16; i < 40; i++) mid += b[i] ?? 0;
    this.hhEnv = Math.max(this.hhEnv * 0.6, Math.min(1, (hh / 20) * 2.2));
    this.midEnv += (Math.min(1, (mid / 24) * 1.6) - this.midEnv) * 0.25;
    // 从低音里找鼓点：比最近的平均响一截，并且离上一下有一点间隔
    if (low > this.avgLow * 1.3 + 0.06 && low > 0.22 && now - this.lastHit > 280) {
      this.lastHit = now;
      this.lastBeat = t;
      this.kickEnv = Math.max(this.kickEnv, Math.min(1, 0.45 + low * 0.6));
      this.spawnDrop(low, t);
    }
    this.avgLow += (low - this.avgLow) * 0.08;
  }

  private spawnDrop(strength: number, t: number) {
    if (this.props.style !== "ink") return;
    this.seed++;
    this.drops.push({ born: t, seed: this.seed, heavy: strength > 0.62 });
    if (this.drops.length > 18) this.drops.shift();
  }

  private live(now: number): boolean {
    return this.props.reactive && this.props.playing && now - this.lastReal < 1000;
  }

  /** dt 秒之前的频谱，换算成这种灯效的 n 根灯。没有真实声音时用一段缓慢的起伏代替（和 2D 的呼吸动画一个意思） */
  private levels(kind: "hist" | "ring" | "wave", n: number, dt: number, now: number): number[] {
    if (this.live(now)) {
      const t = now / 1000 - dt;
      let b = this.hist[0]?.b ?? [];
      for (let i = this.hist.length - 1; i >= 0; i--) {
        if (this.hist[i].t <= t) {
          b = this.hist[i].b;
          break;
        }
      }
      if (!b.length) return new Array<number>(n).fill(0);
      return kind === "hist" ? resample(b, n) : mirrored(b, n, kind === "ring");
    }
    const t = this.simT - dt;
    const slow = this.props.reactive ? 1 : 0.3;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const lv =
        kind === "hist"
          ? Math.max(0.1, Math.exp(-i / (n * 0.46)) * (0.65 + 0.35 * Math.abs(Math.sin(i * 0.9))))
          : kind === "ring"
            ? Math.abs(Math.sin(i * 0.35) * 0.6 + Math.sin(i * 0.11 + 2) * 0.4)
            : Math.abs(Math.sin(i * 0.42) * 0.7 + Math.sin(i * 0.17 + 1) * 0.3);
      const dur = 0.8 + (i % 4) * 0.15;
      out[i] = lv * (0.75 + 0.25 * Math.sin(((t * slow) / dur) * Math.PI + ((i * 0.37) % 1.4) * 2));
    }
    return out;
  }

  // ---------------- 配色、相机 ----------------

  private syncColors() {
    const key = this.props.palette.join(",") + "|" + this.props.base;
    if (key === this.palKey) return;
    this.palKey = key;
    const p = this.props.palette.map(hexRgb);
    this.pal = p.length > 1 ? p : [p[0] ?? [255, 111, 145], p[0] ?? [195, 74, 159]];
    this.baseRgb = hexRgb(this.props.base);
  }
  /** 调色板上 0~1 位置的颜色；lift > 0 往白提亮，< 0 往黑压暗 */
  private palAt(u: number, a: number, lift = 0): string {
    const P = this.pal;
    const x = clamp(u) * (P.length - 1);
    const i = Math.min(P.length - 2, Math.floor(x));
    const f = x - i;
    return rgba(
      P[i].map((v, q) => {
        const c = v + (P[i + 1][q] - v) * f;
        return lift >= 0 ? Math.min(255, c + (255 - c) * lift) : c * (1 + lift);
      }),
      a,
    );
  }
  /** 和 2D 一样：一根灯只取调色板里的某一个颜色，不做渐变 */
  private step(i: number, n: number): number {
    const m = this.pal.length - 1;
    return Math.round((i / Math.max(n - 1, 1)) * m) / m;
  }
  /** 底色的明暗变体：地面、水面、阴影这些暗部跟着底色走，不固定是紫的 */
  private baseAt(mult: number, a: number): string {
    return rgba(
      this.baseRgb.map((v) => Math.min(255, v * mult)),
      a,
    );
  }
  private blur(stagePx: number): string {
    return `blur(${(stagePx * this.px).toFixed(1)}px)`;
  }
  /** 像素相机：平视（yaw = pitch = 0、D = f、不平移）时 z = 0 这个面和屏幕一一对应 */
  private view(o: { yaw: number; pitch: number; D: number; f: number; tx: number; ty: number; tz: number; cx: number; cy: number }): Cam {
    const cyw = Math.cos(o.yaw);
    const syw = Math.sin(o.yaw);
    const cp = Math.cos(o.pitch);
    const sp = Math.sin(o.pitch);
    return {
      p: (x, y, z) => {
        x -= o.tx;
        y -= o.ty;
        z -= o.tz;
        const x1 = x * cyw - z * syw;
        const z1 = x * syw + z * cyw;
        const y2 = y * cp + z1 * sp;
        const z2 = Math.max(40, -y * sp + z1 * cp + o.D);
        const s = o.f / z2;
        return [o.cx + x1 * s, o.cy - y2 * s, z2, s];
      },
    };
  }
  /** 墨晕用的相机（单位是"纸上的格"） */
  private camera(yaw: number, pitch: number, dist: number, f: number, cx: number, cy: number): Cam {
    const cyw = Math.cos(yaw);
    const syw = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    return {
      p: (x, y, z) => {
        const x1 = x * cyw - z * syw;
        const z1 = x * syw + z * cyw;
        const y2 = y * cp + z1 * sp;
        const z2 = -y * sp + z1 * cp + dist;
        const s = f / z2;
        return [cx + x1 * s, cy - y2 * s, z2, s];
      },
    };
  }
  /** 只画某个形状的外发光（等于 CSS 的 box-shadow）：形状本身不画，光只落在形状外面 */
  private outerGlow(path: (dx: number) => void, color: string, blurPx: number) {
    const g = this.g;
    g.save();
    g.beginPath();
    g.rect(this.x0, this.y0, this.fw, this.fh);
    path(0);
    g.clip("evenodd");
    g.shadowColor = color;
    g.shadowBlur = blurPx * this.px;
    g.shadowOffsetX = 6000 * this.px;
    g.fillStyle = "#000";
    g.beginPath();
    path(-6000);
    g.fill();
    g.restore();
  }
  /** 星空：圆环和声波 3D 时的背景，高音来时亮一下 */
  private drawStars(yMax: number, k: number, t: number) {
    if (k < 0.02) return;
    if (!this.stars) this.stars = Array.from({ length: 190 }, (_, i) => [rnd(i * 1.9), rnd(i * 3.7), 0.6 + rnd(i * 6.1) * 1.3, rnd(i * 8.3) * 6.28]);
    const g = this.g;
    for (const st of this.stars) {
      const a = k * (0.2 + 0.45 * rnd(st[3])) * (0.65 + 0.35 * Math.sin(t * 1.7 + st[3])) + (st[2] > 1.5 ? k * 0.35 * this.hhEnv : 0);
      g.fillStyle = `rgba(255,240,250,${Math.min(1, a)})`;
      g.fillRect(this.x0 + st[0] * this.fw, this.y0 + st[1] * (yMax - this.y0), st[2], st[2]);
    }
  }

  // ---------------- 直方图 ----------------
  // 2D：一排分格 LED 柱贴着底边，左低频右高频。
  // 3D：同一排柱子有了厚度；后面一排排是刚才的频谱，立在镜面地上，尽头的地平线上落着一团光，空气里飘着光尘
  private drawHist(t: number, k: number, now: number) {
    const g = this.g;
    const N = Math.max(16, Math.min(96, Math.round(48 / this.props.thickness)));
    const ROWS = 9;
    const BW = (W - 80 - (N - 1) * 6) / N;
    const STEP = BW + 6;
    const Y0 = -H / 2;
    const AREA = H * 0.62;
    const GAPZ = 80;
    const f = 1200;
    const L = (a: number, b: number) => a + (b - a) * k;
    const sway = this.props.reduce ? 0 : 1;
    const kk = this.kickEnv;
    const cam = this.view({ yaw: L(0, -0.34 + 0.1 * Math.sin(t * 0.25) * sway) + this.yaw * k, pitch: L(0, 0.25), D: L(f, f * 1.5), f, tx: 0, ty: L(0, -150), tz: L(0, 250), cx: W / 2, cy: L(H / 2, H * 0.53) });
    const quad = (pts: Pt[], fill: string | CanvasGradient) => {
      g.beginPath();
      poly(g, pts);
      g.fillStyle = fill;
      g.fill();
    };
    const { x0, fw } = this;
    const yEnd = this.y0 + this.fh;

    if (k > 0.02) {
      const far = cam.p(-21000, Y0, 60000);
      const yH = far[1];
      const sx = far[0];
      const sr = 110 * (1 + 0.04 * kk);
      // 天边的雾光：越靠近地平线越亮
      const sky = g.createLinearGradient(0, yH - 300, 0, yH);
      sky.addColorStop(0, this.palAt(0.7, 0));
      sky.addColorStop(0.7, this.palAt(0.6, 0.14 * k));
      sky.addColorStop(1, this.palAt(0.4, 0.4 * k, 0.1));
      g.fillStyle = sky;
      g.fillRect(x0, yH - 300, fw, 300);
      // 落在地平线上的那团光，跟着鼓点呼吸
      const halo = g.createRadialGradient(sx, yH, sr * 0.4, sx, yH, sr * 5);
      halo.addColorStop(0, this.palAt(0.1, (0.5 + 0.15 * kk) * k, 0.35));
      halo.addColorStop(0.35, this.palAt(0.3, 0.18 * k));
      halo.addColorStop(1, this.palAt(0.5, 0));
      g.fillStyle = halo;
      g.fillRect(x0, yH - sr * 5, fw, sr * 5);
      g.save();
      g.beginPath();
      g.rect(x0, this.y0, fw, yH - this.y0);
      g.clip();
      g.filter = this.blur(3);
      const disc = g.createLinearGradient(0, yH - sr, 0, yH);
      disc.addColorStop(0, this.palAt(0, k, 0.8));
      disc.addColorStop(1, this.palAt(0.2, k, 0.35));
      g.fillStyle = disc;
      g.beginPath();
      g.arc(sx, yH + sr * 0.15, sr, 0, 7);
      g.fill();
      g.restore();
      // 地面：远处被光染亮，近处沉下去
      const fl = g.createLinearGradient(0, yH, 0, Math.max(yH + 1, yEnd));
      fl.addColorStop(0, this.palAt(0.45, 0.5 * k, 0.05));
      fl.addColorStop(0.12, this.baseAt(1.5, 0.6 * k));
      fl.addColorStop(0.5, this.baseAt(0.45, 0.72 * k));
      fl.addColorStop(1, this.baseAt(0.22, 0.85 * k));
      g.fillStyle = fl;
      g.fillRect(x0, yH, fw, yEnd - yH);
      // 那团光在地面上拖出的倒影
      g.save();
      g.globalCompositeOperation = "lighter";
      g.filter = this.blur(26);
      const rf = g.createLinearGradient(0, yH, 0, yH + 520);
      rf.addColorStop(0, this.palAt(0.1, (0.5 + 0.15 * kk) * k, 0.3));
      rf.addColorStop(0.4, this.palAt(0.3, 0.14 * k));
      rf.addColorStop(1, this.palAt(0.5, 0));
      g.fillStyle = rf;
      g.beginPath();
      g.moveTo(sx - sr * 0.9, yH);
      g.lineTo(sx + sr * 0.9, yH);
      g.lineTo(sx + sr * 2.2, yH + 520);
      g.lineTo(sx - sr * 2.2, yH + 520);
      g.closePath();
      g.fill();
      g.restore();
      const hl = g.createLinearGradient(sx - 700, 0, sx + 700, 0);
      hl.addColorStop(0, this.palAt(0.2, 0));
      hl.addColorStop(0.5, this.palAt(0.05, 0.8 * k, 0.6));
      hl.addColorStop(1, this.palAt(0.2, 0));
      g.fillStyle = hl;
      g.fillRect(sx - 700, yH - 0.75, 1400, 1.5);
      // 地面网格，往远处淡掉
      g.lineWidth = 1;
      const cell = 113.8;
      for (let i = -24; i <= 24; i++) {
        const x = i * cell;
        const a = cam.p(x, Y0, -500);
        const b = cam.p(x, Y0, 4200);
        const gr = g.createLinearGradient(a[0], a[1], b[0], b[1]);
        gr.addColorStop(0, `rgba(255,255,255,${0.08 * k})`);
        gr.addColorStop(1, "rgba(255,255,255,0)");
        g.strokeStyle = gr;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      }
      for (let j = 0; j < 40; j++) {
        const z = -500 + j * cell;
        const a = cam.p(-2800, Y0, z);
        const b = cam.p(2800, Y0, z);
        g.strokeStyle = `rgba(255,255,255,${0.08 * k * Math.pow(1 - j / 40, 1.5)})`;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      }
      // 远处的光尘
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const m of this.motes()) if (m.z >= -40) this.mote(cam, m, t, k, false);
      g.restore();
    }

    const rows: number[][] = [];
    for (let r = 0; r < (k > 0.01 ? ROWS : 1); r++) rows.push(this.levels("hist", N, r * 0.1, now));
    const leftFar = cam.p(-600, Y0, 0)[2] > cam.p(600, Y0, 0)[2];
    const X = (i: number) => -W / 2 + 40 + BW / 2 + i * STEP;
    const hOf = (r: number, i: number) => Math.max(0.02, rows[r][i]) * AREA;
    const rowA = (r: number) => (r === 0 ? 1 : k * Math.pow(1 - r / ROWS, 1.2));

    // 柱脚在镜面地上的倒影和漫开的一圈光
    if (k > 0.05) {
      for (let r = Math.min(4, rows.length - 1); r >= 0; r--)
        for (let i = 0; i < N; i++) {
          const h = hOf(r, i);
          const xa = X(i) - BW / 2;
          const xb = X(i) + BW / 2;
          const z = r * GAPZ * k;
          const u = this.step(i, N);
          const n = Math.ceil(h / 18);
          const a = cam.p(X(i), Y0, z);
          const b = cam.p(X(i), Y0 - h * 0.8, z);
          const gr = g.createLinearGradient(a[0], a[1], b[0], b[1]);
          gr.addColorStop(0, this.palAt(u, 0.3 * rowA(r) * k));
          gr.addColorStop(1, this.palAt(u, 0));
          g.beginPath();
          for (let j = 0; j < n; j++) {
            const ya = Y0 - j * 18;
            const yb = Y0 - Math.min(j * 18 + 14, h);
            poly(g, [cam.p(xa, ya, z), cam.p(xb, ya, z), cam.p(xb, yb, z), cam.p(xa, yb, z)]);
          }
          g.fillStyle = gr;
          g.fill();
        }
      g.save();
      g.globalCompositeOperation = "lighter";
      for (let r = Math.min(2, rows.length - 1); r >= 0; r--)
        for (let i = 0; i < N; i++) {
          const v = rows[r][i];
          const c0 = cam.p(X(i), Y0, r * GAPZ * k + BW / 2);
          const rr = (40 + v * 80) * c0[3];
          const u = this.step(i, N);
          g.save();
          g.translate(c0[0], c0[1]);
          g.scale(1, 0.3);
          const gr = g.createRadialGradient(0, 0, 0, 0, 0, rr);
          gr.addColorStop(0, this.palAt(u, (0.08 + 0.2 * v) * k * (1 - r / 3)));
          gr.addColorStop(1, this.palAt(u, 0));
          g.fillStyle = gr;
          g.beginPath();
          g.arc(0, 0, rr, 0, 7);
          g.fill();
          g.restore();
        }
      g.restore();
    }

    // 鼓点来时一道亮从最前排往后一排排传过去
    const beat = Math.min(1, t - this.lastBeat);
    const sweepR = beat * ROWS * 1.4;
    const sweepA = (1 - beat) * k;
    const A0 = 0.8 * this.props.alpha;
    for (let r = rows.length - 1; r >= 0; r--) {
      const z0 = r * GAPZ * k;
      const z1 = z0 + BW * k;
      const A = rowA(r) * A0;
      const lit = Math.exp(-((r - sweepR) ** 2) / 0.9) * sweepA;
      if (A < 0.004) continue;
      // 2D 里每根柱子外面有一圈同色的光（最前面两排有）
      if (r < 2)
        for (let i = 0; i < N; i++) {
          const h = hOf(r, i);
          const xa = X(i) - BW / 2;
          const xb = X(i) + BW / 2;
          const c = [cam.p(xa, Y0, z0), cam.p(xb, Y0, z0), cam.p(xb, Y0 + h, z0), cam.p(xa, Y0 + h, z0)];
          this.outerGlow(
            (dx) => {
              c.forEach((p, q) => (q ? g.lineTo(p[0] + dx, p[1]) : g.moveTo(p[0] + dx, p[1])));
              g.closePath();
            },
            this.palAt(this.step(i, N), 0.6 * A * (r ? 0.5 : 1)),
            24,
          );
        }
      for (let q = 0; q < N; q++) {
        const i = leftFar ? q : N - 1 - q;
        const h = hOf(r, i);
        const n = Math.ceil(h / 18);
        const xa = X(i) - BW / 2;
        const xb = X(i) + BW / 2;
        const u = this.step(i, N);
        if (k > 0.02) {
          // 侧面：只画朝着镜头的那一面
          const rightSeen = cam.p(xb, Y0, z1)[0] > cam.p(xb, Y0, z0)[0] + 0.3;
          const leftSeen = cam.p(xa, Y0, z1)[0] < cam.p(xa, Y0, z0)[0] - 0.3;
          const xs = rightSeen ? xb : leftSeen ? xa : null;
          if (xs !== null) {
            g.beginPath();
            for (let j = 0; j < n; j++) {
              const ya = Y0 + j * 18;
              const yb = Y0 + Math.min(j * 18 + 14, h);
              poly(g, [cam.p(xs, ya, z0), cam.p(xs, ya, z1), cam.p(xs, yb, z1), cam.p(xs, yb, z0)]);
            }
            g.fillStyle = this.palAt(u, A, -0.5);
            g.fill();
          }
          // 每一格的顶面：从上往下看，格子之间的缝里能看到
          g.beginPath();
          for (let j = 0; j < n; j++) {
            const yb = Y0 + Math.min(j * 18 + 14, h);
            poly(g, [cam.p(xa, yb, z0), cam.p(xb, yb, z0), cam.p(xb, yb, z1), cam.p(xa, yb, z1)]);
          }
          g.fillStyle = this.palAt(u, Math.min(1, A * (1.25 + lit)), 0.3 + 0.5 * lit);
          g.fill();
        }
        // 正面：14 像素一格、隔 4 像素，最上面一格是圆角（转成立体后圆角收平）
        g.beginPath();
        for (let j = 0; j < n; j++) {
          const ya = Y0 + j * 18;
          const yb = Y0 + Math.min(j * 18 + 14, h);
          const a = cam.p(xa, ya, z0);
          const b = cam.p(xb, ya, z0);
          const c = cam.p(xb, yb, z0);
          const d = cam.p(xa, yb, z0);
          const rr = j === n - 1 ? Math.min(8 * (1 - k), yb - ya, BW / 2) : 0;
          if (rr > 0.4) {
            g.moveTo(a[0], a[1]);
            g.lineTo(b[0], b[1]);
            g.arcTo(c[0], c[1], d[0], d[1], rr);
            g.arcTo(d[0], d[1], a[0], a[1], rr);
            g.closePath();
          } else poly(g, [a, b, c, d]);
        }
        g.fillStyle = this.palAt(u, A, 0.3 * lit);
        g.fill();
      }
    }

    if (k > 0.02) {
      g.save();
      g.globalCompositeOperation = "lighter";
      // 最前排柱顶往上散的光
      for (let i = 0; i < N; i++) {
        const v = rows[0][i];
        const h = hOf(0, i);
        const u = this.step(i, N);
        const Lh = 20 + v * 150;
        const z = BW * k * 0.5;
        const a0 = cam.p(X(i) - BW / 2, Y0 + h, z);
        const a1 = cam.p(X(i) + BW / 2, Y0 + h, z);
        const b1 = cam.p(X(i) + BW * 0.8, Y0 + h + Lh, z);
        const b0 = cam.p(X(i) - BW * 0.8, Y0 + h + Lh, z);
        const gr = g.createLinearGradient(a0[0], a0[1], b0[0], b0[1]);
        gr.addColorStop(0, this.palAt(u, (0.04 + 0.14 * v) * k, 0.2));
        gr.addColorStop(1, this.palAt(u, 0));
        quad([a0, a1, b1, b0], gr);
      }
      for (const m of this.motes()) if (m.z < -40) this.mote(cam, m, t, k, true);
      g.restore();
    }
  }
  /** 光尘：慢慢往上飘，高音来时亮一下；离镜头近的是大而虚的光斑 */
  private motes() {
    return (this.moteList ??= Array.from({ length: 170 }, (_, i) => ({
      x: (rnd(i * 1.3) - 0.5) * 3400,
      z: -700 + rnd(i * 2.7) * 3400,
      y0: rnd(i * 3.9) * 760,
      sp: 14 + rnd(i * 5.1) * 34,
      s: 0.5 + rnd(i * 6.7),
      u: rnd(i * 8.3),
      ph: rnd(i * 9.9) * 6.283,
    })));
  }
  private mote(cam: Cam, m: { x: number; z: number; y0: number; sp: number; s: number; u: number; ph: number }, t: number, k: number, near: boolean) {
    const g = this.g;
    const y = (m.y0 + t * m.sp) % 760;
    const p = cam.p(m.x + 30 * Math.sin(t * 0.5 + m.ph), -450 + y, m.z);
    if (p[2] < 200) return;
    const a = k * Math.sin((Math.PI * y) / 760) * (0.35 + 0.35 * Math.sin(t * 1.3 + m.ph) + 0.5 * this.hhEnv * m.u);
    if (a <= 0.01) return;
    const r = m.s * 2.6 * p[3] * (near ? 2.4 : 1);
    if (near) {
      const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      gr.addColorStop(0, this.palAt(m.u, 0.2 * a, 0.5));
      gr.addColorStop(0.7, this.palAt(m.u, 0.14 * a, 0.3));
      gr.addColorStop(1, this.palAt(m.u, 0));
      g.fillStyle = gr;
    } else g.fillStyle = this.palAt(m.u, Math.min(1, 0.75 * a), 0.6);
    g.beginPath();
    g.arc(p[0], p[1], Math.max(0.6, r), 0, 7);
    g.fill();
  }

  // ---------------- 圆环 ----------------
  // 2D：窗口正中一个发光的圆，64 根灯从圆上往外放射，顶上是低频。
  // 3D：同一个圆环往后放平、慢慢自转；每根灯的末梢升起一道光，圆心浮起一颗星球，外面绕着一圈星尘
  private drawRing(t: number, k: number, now: number) {
    const g = this.g;
    const N = 64;
    const CQ = 5.8;
    const R0 = 36 * CQ;
    const RA = 37 * CQ;
    const AW = 1.6 * CQ * this.props.thickness;
    const AL = 15 * CQ;
    const f = 1200;
    const GA = this.props.alpha;
    const L = (a: number, b: number) => a + (b - a) * k;
    const kk = this.kickEnv;
    const hh = this.hhEnv;
    const b = this.levels("ring", N, 0, now);
    // 放平的角度、自转（关掉 3D 时转回正位）、整体下移一点给星球和光柱让位置
    const th = k * 1.03;
    const spin = this.props.reduce ? 0 : ((t * 0.12 + Math.PI) % (Math.PI * 2)) - Math.PI;
    const phi = (spin + this.yaw) * k;
    const cph = Math.cos(phi);
    const sph = Math.sin(phi);
    const cth = Math.cos(th);
    const sth = Math.sin(th);
    const CY = L(27, -50);
    const D = L(f, f * 0.92);
    // u 往右、v 在 2D 里往上（放平后是往远处）、w 在 2D 里朝着你（放平后是往上）
    const P = (u: number, v: number, w: number): P4 => {
      const u1 = u * cph - v * sph;
      const v1 = u * sph + v * cph;
      const z = v1 * sth - w * cth + D;
      const s = f / z;
      return [W / 2 + u1 * s, H / 2 - (CY + v1 * cth + w * sth) * s, z, s];
    };
    const circle = (r: number, dx = 0, w = 0) => {
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const p = P(Math.sin(a) * r, Math.cos(a) * r, w);
        if (i) g.lineTo(p[0] + dx, p[1]);
        else g.moveTo(p[0] + dx, p[1]);
      }
      g.closePath();
    };

    this.drawStars(this.y0 + this.fh, k, t);
    const c0 = P(0, 0, 0);
    const eu = P(1, 0, 0);
    const ev = P(0, 1, 0);
    const onPlane = () => g.transform(eu[0] - c0[0], eu[1] - c0[1], -(ev[0] - c0[0]), -(ev[1] - c0[1]), c0[0], c0[1]);
    // 镜面台：3D 时圆环底下铺开一片贴地的光
    if (k > 0.02) {
      g.save();
      onPlane();
      const fl = g.createRadialGradient(0, 0, R0, 0, 0, 760);
      fl.addColorStop(0, this.palAt(0.3, (0.16 + 0.1 * kk) * k));
      fl.addColorStop(1, this.palAt(0.6, 0));
      g.fillStyle = fl;
      g.beginPath();
      g.arc(0, 0, 760, 0, 7);
      g.fill();
      g.restore();
    }
    // 圆：里面一团淡淡的专辑色，外面一圈光，边上一道白线
    g.save();
    g.globalAlpha = GA;
    g.save();
    onPlane();
    const inner = g.createRadialGradient(0, 0, 0, 0, 0, R0);
    inner.addColorStop(0, this.palAt(0.2, 0.35));
    inner.addColorStop(0.99, this.palAt(0.2, 0));
    g.fillStyle = inner;
    g.beginPath();
    g.arc(0, 0, R0, 0, 7);
    g.fill();
    g.restore();
    this.outerGlow((dx) => circle(R0, dx), this.palAt(0.6, 0.6 * GA), 40);
    g.save();
    g.beginPath();
    circle(R0);
    g.clip();
    g.shadowColor = `rgba(255,255,255,${0.12 * GA})`;
    g.shadowBlur = 30 * this.px;
    g.shadowOffsetX = 6000 * this.px;
    g.fillStyle = "#000";
    g.beginPath();
    g.rect(-6000 - W, -H, W * 3, H * 3);
    circle(R0, -6000);
    g.fill("evenodd");
    g.restore();
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 2 * c0[3];
    g.beginPath();
    circle(R0);
    g.stroke();
    g.restore();

    // 冲击波：每个鼓点从圆环往外推一圈
    const sa = t - this.lastBeat;
    if (k > 0.05 && sa < 0.9) {
      g.save();
      g.shadowColor = this.palAt(0.15, 0.9);
      g.shadowBlur = 14 * this.px;
      g.strokeStyle = this.palAt(0.15, (1 - sa / 0.9) * 0.5 * k, 0.3);
      g.lineWidth = 2;
      g.beginPath();
      circle(RA + AL + 20 + sa * 560);
      g.stroke();
      g.restore();
    }
    // 星球：浮在圆心上方；它在台面里有一个淡淡的倒影
    const wc = 20 + 105 * k;
    const pc = P(0, 0, wc);
    const zc = pc[2];
    const planet = (mirror: boolean) => {
      const c = mirror ? P(0, 0, -wc * 0.8) : pc;
      const rr = 84 * (1 + 0.04 * kk) * c[3];
      g.save();
      g.globalAlpha = k * (mirror ? 0.22 : 1);
      if (mirror) {
        g.beginPath();
        circle(R0);
        g.clip();
        g.filter = this.blur(6);
      }
      g.shadowColor = this.palAt(0.3, 0.8);
      g.shadowBlur = mirror ? 0 : (50 + 30 * kk) * this.px;
      const gr = g.createRadialGradient(c[0] - rr * 0.35, c[1] - rr * 0.4, rr * 0.1, c[0], c[1], rr);
      gr.addColorStop(0, this.palAt(0, 1, 0.7));
      gr.addColorStop(0.5, this.palAt(0.3, 1, 0.1));
      gr.addColorStop(1, this.palAt(0.9, 1, -0.4));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(c[0], c[1], rr, 0, 7);
      g.fill();
      g.shadowBlur = 0;
      g.save();
      g.beginPath();
      g.arc(c[0], c[1], rr, 0, 7);
      g.clip();
      for (let j = 0; j < 8; j++) {
        const y = c[1] - rr + (j + 0.5) * rr * 0.25 + Math.sin(t * 0.4 + j) * rr * 0.03;
        g.fillStyle = "rgba(255,255,255,0.1)";
        g.fillRect(c[0] - rr, y, rr * 2, rr * 0.09);
      }
      const sh = g.createRadialGradient(c[0] - rr * 0.4, c[1] - rr * 0.45, rr * 0.6, c[0], c[1], rr * 1.15);
      sh.addColorStop(0, this.baseAt(0.4, 0));
      sh.addColorStop(1, this.baseAt(0.4, 0.4));
      g.fillStyle = sh;
      g.fillRect(c[0] - rr, c[1] - rr, rr * 2, rr * 2);
      g.restore();
      g.strokeStyle = this.palAt(0, 0.55, 0.4);
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(c[0], c[1], rr - 0.5, 0, 7);
      g.stroke();
      g.restore();
    };
    if (k > 0.03) planet(true);
    // 星尘：贴着台面绕圈，高音来时闪
    this.dust ??= Array.from({ length: 460 }, (_, i) => ({ r: 340 + Math.pow(rnd(i * 1.7), 0.7) * 330, a: rnd(i * 2.9) * 6.283, w: (rnd(i * 3.3) - 0.5) * 26, s: 0.7 + rnd(i * 4.1) * 1.5, u: rnd(i * 5.5) }));
    const near: [{ s: number; u: number }, P4][] = [];
    const speck = (d: { s: number; u: number }, p: P4) => {
      g.fillStyle = this.palAt(d.u, Math.min(1, k * (0.25 + 0.5 * d.u) * (0.7 + 0.8 * hh * d.u)), 0.4);
      const z = d.s * p[3] * 1.5;
      g.fillRect(p[0], p[1], z, z);
    };
    if (k > 0.02)
      for (const d of this.dust) {
        const a = d.a + (t * 26) / Math.pow(d.r / 10, 1.2);
        const p = P(Math.sin(a) * d.r, Math.cos(a) * d.r, 8 + d.w);
        if (p[2] > zc) speck(d, p);
        else near.push([d, p]);
      }

    // 64 根灯：贴在台面上往外放射（这就是 2D 里的样子）；3D 时每根的末梢再往上升一道光
    const arms: { A: P4; B: P4; u: number; v: number; tip: number[]; z: number }[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const lv = Math.max(0.15, b[i]);
      const len = Math.max(AW + 1, AL * lv);
      const su = Math.sin(a);
      const sv = Math.cos(a);
      const A = P(su * (RA + AW / 2), sv * (RA + AW / 2), 0);
      const B = P(su * (RA + len - AW / 2), sv * (RA + len - AW / 2), 0);
      arms.push({ A, B, u: this.step(Math.abs(N / 2 - i), N / 2 + 1), v: b[i], tip: [su * (RA + len), sv * (RA + len)], z: (A[2] + B[2]) / 2 });
    }
    arms.sort((p, q) => q.z - p.z);
    g.lineCap = "round";
    let planetDone = k < 0.03;
    for (const m of arms) {
      if (!planetDone && m.z < zc) {
        planet(false);
        planetDone = true;
      }
      g.save();
      g.globalAlpha = GA;
      const gr = g.createLinearGradient(m.A[0], m.A[1], m.B[0], m.B[1]);
      gr.addColorStop(0, this.palAt(m.u, 1));
      gr.addColorStop(1, "rgba(255,255,255,0.85)");
      g.shadowColor = this.palAt(m.u, 1);
      g.shadowBlur = 12 * this.px;
      g.strokeStyle = gr;
      g.lineWidth = (AW * (m.A[3] + m.B[3])) / 2;
      g.beginPath();
      g.moveTo(m.A[0], m.A[1]);
      g.lineTo(m.B[0], m.B[1]);
      g.stroke();
      g.restore();
      if (k > 0.03) {
        const hb = (24 + m.v * 250) * k;
        const a0 = P(m.tip[0], m.tip[1], 0);
        const a1 = P(m.tip[0], m.tip[1], hb);
        g.save();
        g.globalCompositeOperation = "lighter";
        const bg = g.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
        bg.addColorStop(0, this.palAt(m.u, 0.75 * k, 0.25));
        bg.addColorStop(1, this.palAt(m.u, 0.04 * k));
        g.strokeStyle = bg;
        g.lineWidth = 3.4 * a0[3];
        g.beginPath();
        g.moveTo(a0[0], a0[1]);
        g.lineTo(a1[0], a1[1]);
        g.stroke();
        g.fillStyle = `rgba(255,255,255,${0.8 * k})`;
        g.beginPath();
        g.arc(a1[0], a1[1], 2.4 * a1[3], 0, 7);
        g.fill();
        g.restore();
      }
    }
    if (!planetDone) planet(false);
    for (const [d, p] of near) speck(d, p);
  }

  // ---------------- 声波 ----------------
  // 2D：40 根胶囊灯沿中线上下对称，中间是低频。
  // 3D：中线其实是一片水面——上半截是立在水上的光，下半截是它的倒影；后面一排排是刚才的声音，头顶是星空和月亮
  private drawWave(t: number, k: number, now: number) {
    const g = this.g;
    const N = 40;
    const ROWS = 12;
    const X0 = -W / 2 + 66;
    const DX = (W - 132) / (N - 1);
    const CY = H / 2 - H * 0.47;
    const AREA = H * 0.46;
    const GAPZ = 86;
    const f = 1200;
    const TH = 12 * this.props.thickness;
    const L = (a: number, b: number) => a + (b - a) * k;
    const sway = this.props.reduce ? 0 : 1;
    const kk = this.kickEnv;
    const { x0, fw } = this;
    const yEnd = this.y0 + this.fh;
    const cam = this.view({ yaw: L(0, 0.13 * Math.sin(t * 0.21) * sway) + this.yaw * k * 0.7, pitch: L(0, 0.19), D: L(f, f * 1.42), f, tx: 0, ty: L(0, CY + 60), tz: L(0, 360), cx: W / 2, cy: L(H / 2, H * 0.6) });
    if (k > 0.02) {
      const yH = cam.p(0, CY, 90000)[1];
      this.drawStars(Math.max(this.y0 + 120, yH), k, t);
      // 月亮和它在水里拖出的一道光
      const mp = cam.p(34000, CY + 15500, 90000);
      const mx = mp[0];
      const my = mp[1];
      const mr = 50;
      const halo = g.createRadialGradient(mx, my, mr, mx, my, mr * 4.5);
      halo.addColorStop(0, this.palAt(0.1, 0.2 * k, 0.4));
      halo.addColorStop(1, this.palAt(0.1, 0));
      g.fillStyle = halo;
      g.fillRect(mx - mr * 4.5, my - mr * 4.5, mr * 9, mr * 9);
      const mg = g.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, mr * 0.1, mx, my, mr);
      mg.addColorStop(0, this.palAt(0, 0.95 * k, 0.75));
      mg.addColorStop(1, this.palAt(0.1, 0.85 * k, 0.4));
      g.fillStyle = mg;
      g.beginPath();
      g.arc(mx, my, mr, 0, 7);
      g.fill();
      // 地平线上的光，跟着鼓点亮一点
      g.save();
      g.translate(W / 2, yH);
      g.scale(1, 0.2);
      const hg = g.createRadialGradient(0, 0, 0, 0, 0, fw * 0.6);
      hg.addColorStop(0, this.palAt(0.35, (0.34 + 0.12 * kk) * k, 0.2));
      hg.addColorStop(1, this.palAt(0.35, 0));
      g.fillStyle = hg;
      g.beginPath();
      g.arc(0, 0, fw * 0.6, 0, 7);
      g.fill();
      g.restore();
      // 水面：往近处暗下去
      const wg = g.createLinearGradient(0, yH, 0, Math.max(yH + 1, yEnd));
      wg.addColorStop(0, this.baseAt(1.15, 0.25 * k));
      wg.addColorStop(0.4, this.baseAt(0.4, 0.55 * k));
      wg.addColorStop(1, this.baseAt(0.25, 0.75 * k));
      g.fillStyle = wg;
      g.fillRect(x0, yH, fw, yEnd - yH);
      g.save();
      g.globalCompositeOperation = "lighter";
      g.filter = this.blur(14);
      const ms = g.createLinearGradient(0, yH, 0, yH + 300);
      ms.addColorStop(0, this.palAt(0.05, 0.4 * k, 0.5));
      ms.addColorStop(1, this.palAt(0.2, 0));
      g.fillStyle = ms;
      g.beginPath();
      g.moveTo(mx - 26, yH);
      g.lineTo(mx + 26, yH);
      g.lineTo(mx + 70, yH + 300);
      g.lineTo(mx - 70, yH + 300);
      g.closePath();
      g.fill();
      g.restore();
      g.fillStyle = this.palAt(0.2, 0.35 * k, 0.4);
      g.fillRect(x0, yH - 0.5, fw, 1);
      // 水纹
      g.lineWidth = 1;
      for (let j = 0; j < 46; j++) {
        const z = -300 + rnd(j * 3.3) * 3600;
        const x = (rnd(j * 7.1) - 0.5) * 3800 + Math.sin(t * 0.5 + j) * 14;
        const len = 50 + rnd(j * 2.9) * 190;
        const a = cam.p(x, CY, z);
        const b2 = cam.p(x + len, CY, z);
        g.strokeStyle = `rgba(255,255,255,${0.1 * k * (1 - (z + 300) / 3900)})`;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b2[0], b2[1]);
        g.stroke();
      }
      // 流星：偶尔划过一颗
      const idx = Math.floor(t / 2.6);
      const sa = t - idx * 2.6;
      if (!this.props.reduce && sa < 0.8 && rnd(idx * 4.7) > 0.3) {
        const dir = rnd(idx * 1.3) > 0.5 ? 1 : -1;
        const sx = x0 + fw * (0.15 + 0.7 * rnd(idx));
        const sy = this.y0 + Math.max(90, yH - this.y0) * (0.1 + 0.4 * rnd(idx + 1));
        const hx = sx + dir * Math.cos(0.38) * sa * 700;
        const hy = sy + Math.sin(0.38) * sa * 700;
        const tx = hx - dir * Math.cos(0.38) * 150;
        const ty = hy - Math.sin(0.38) * 150;
        const al = Math.sin((Math.PI * sa) / 0.8) * k;
        const sg = g.createLinearGradient(hx, hy, tx, ty);
        sg.addColorStop(0, `rgba(255,240,250,${al})`);
        sg.addColorStop(1, "rgba(255,240,250,0)");
        g.strokeStyle = sg;
        g.lineWidth = 1.8;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(hx, hy);
        g.lineTo(tx, ty);
        g.stroke();
      }
    }
    g.lineCap = "round";
    const A0 = 0.85 * this.props.alpha;
    for (let r = (k > 0.01 ? ROWS : 1) - 1; r >= 0; r--) {
      const A = (r === 0 ? 1 : k * Math.pow(1 - r / ROWS, 1.3)) * A0;
      if (A < 0.004) continue;
      const b = this.levels("wave", N, r * 0.09, now);
      const z = r * GAPZ * k;
      for (let i = 0; i < N; i++) {
        const x = X0 + i * DX;
        const h = Math.max(TH + 1, Math.max(0.04, b[i]) * AREA);
        const u = this.step(i, N);
        const top = cam.p(x, CY + h / 2 - TH / 2, z);
        const bot = cam.p(x, CY - h / 2 + TH / 2, z);
        const mid = cam.p(x, CY, z);
        const span = bot[1] - top[1] || 1;
        const m = Math.max(0.02, Math.min(0.98, (mid[1] - top[1]) / span));
        // 上半截原样；下半截是倒影，转成立体后暗下去、越往下越淡
        const dim = 1 - 0.55 * k;
        const gr = g.createLinearGradient(top[0], top[1], bot[0], bot[1]);
        gr.addColorStop(0, "rgba(255,255,255,0.7)");
        gr.addColorStop(m * 0.6, this.palAt(u, 1));
        gr.addColorStop(m, this.palAt(u, 1));
        gr.addColorStop(Math.min(1, m + 0.001), this.palAt(u, dim));
        gr.addColorStop(m + (1 - m) * 0.4, this.palAt(u, dim * (1 - 0.3 * k)));
        gr.addColorStop(1, `rgba(255,255,255,${0.7 * (1 - 0.92 * k)})`);
        g.save();
        g.globalAlpha = A;
        if (r < 3) {
          g.shadowColor = this.palAt(u, r ? 0.5 : 1);
          g.shadowBlur = 18 * this.px;
        }
        g.strokeStyle = gr;
        g.lineWidth = TH * mid[3];
        g.beginPath();
        g.moveTo(top[0], top[1]);
        g.lineTo(bot[0], bot[1]);
        g.stroke();
        g.restore();
      }
    }
  }

  // ---------------- 墨晕 ----------------
  // 2D：俯看宣纸，墨滴跟着鼓点落下、晕开。
  // 3D：镜头低下来，纸面变成湖，纸上立起一幅山水：远山淡、近山浓，山脚化进雾里；墨滴落进山前的湖里，晕开、起涟漪
  private mountains(): Mountain[] {
    if (this.mt) return this.mt;
    const defs = [
      { z: 44, a: 0.15, blur: 4.5, col: INK[2], hs: 7.2, open: null as number[] | null, off: 0 },
      { z: 28, a: 0.24, blur: 2.6, col: INK[2], hs: 5.8, open: null, off: 0 },
      { z: 17, a: 0.42, blur: 1.4, col: INK[1], hs: 4.4, open: [1.5, 7], off: 5 },
      { z: 9.5, a: 0.72, blur: 0.5, col: INK[0], hs: 3.1, open: [2.6, 6.2], off: -0.6 },
    ];
    this.mt = defs.map((l, i) => {
      // 山铺得比舞台宽，超宽屏两边也有山
      const S = (l.z + 9) * 1.5 + 6;
      const m = 16;
      const pk: { c: number; H: number; w: number }[] = [];
      for (let j = 0; j < m; j++) pk.push({ c: -S + ((j + rnd(i * 31 + j)) * 2 * S) / m, H: l.hs * (0.35 + 0.65 * rnd(i * 17 + j * 3.1)), w: (0.45 + rnd(i * 7 + j * 1.9)) * (l.z + 9) * 0.075 });
      const xs: number[] = [];
      const hts: number[] = [];
      for (let q = 0; q <= 340; q++) {
        const x = -S + (q / 340) * 2 * S;
        let h = 0;
        for (const p of pk) h = Math.max(h, p.H / Math.pow(1 + ((x - p.c) / p.w) ** 2, 1.6));
        h += l.hs * 0.03 * (Math.sin(x * 2.3 + i) + 0.6 * Math.sin(x * 5.1 + i * 2) + 0.3 * Math.sin(x * 11.7));
        if (l.open) {
          const e = clamp((Math.abs(x - l.off) - l.open[0]) / (l.open[1] - l.open[0]));
          h *= e * e * (3 - 2 * e);
        }
        xs.push(x);
        hts.push(Math.max(0, h));
      }
      return { z: l.z, a: l.a, blur: l.blur, col: l.col, hs: l.hs, xs, hts };
    });
    return this.mt;
  }
  private paper(q: G, k: number) {
    const mix = (a: number[], b: number[]) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    const gr = q.createLinearGradient(0, this.y0, 0, this.y0 + this.fh);
    gr.addColorStop(0, `rgb(${mix([239, 233, 220], [240, 236, 226])})`);
    gr.addColorStop(1, `rgb(${mix([239, 233, 220], [226, 218, 202])})`);
    q.fillStyle = gr;
    q.fillRect(this.x0, this.y0, this.fw, this.fh);
  }
  private drawInk(t: number, k: number) {
    const g = this.g;
    const sway = this.props.reduce ? 0 : 1;
    const L = (a: number, b: number) => a + (b - a) * k;
    const cam = this.camera(L(0, -0.05 + 0.05 * Math.sin(t * 0.12) * sway) + this.yaw * k * 0.3, L(Math.PI / 2 - 0.0001, 0.2), L(13, 9), L(1720, 950), W / 2, H * L(0.5, 0.74));
    const kick = this.kickEnv;
    const mid = this.midEnv;
    const PW = 5.6;
    const PD = 3.6;
    const { x0, y0, fw, fh } = this;
    // 省力的画法：所有带晕染的东西（山、雾、倒影、墨团）画在一张小一号的画布上，再整张铺上来——
    // 晕染本来就是虚的，小一号看不出来，要模糊的像素却少了好几倍；清楚的线条（近山的皴笔、小舟、涟漪）照旧按原尺寸画
    const S = Math.max(0.6, Math.min(1.2, 0.5 * this.px));
    const IL = (this.layer ??= document.createElement("canvas"));
    const lw = Math.round(fw * S);
    const lh = Math.round(fh * S);
    if (IL.width !== lw || IL.height !== lh) {
      IL.width = lw;
      IL.height = lh;
      this.layerK = -1;
    }
    // 模糊的数值是按 1.5 倍屏调的
    const B = (v: number) => `blur(${((v / 1.5) * S).toFixed(2)}px)`;
    const BM = (v: number) => `blur(${((v / 1.5) * this.px).toFixed(2)}px)`;
    const ridge = (l: Mountain) => {
      const top: P4[] = [];
      const base: P4[] = [];
      const refl: P4[] = [];
      for (let q = 0; q < l.xs.length; q++) {
        const x = l.xs[q];
        const h = l.hts[q] * k;
        top.push(cam.p(x, h, l.z));
        base.push(cam.p(x, 0, l.z));
        refl.push(cam.p(x, -h * 0.8, l.z));
      }
      let yT = 1e9;
      let yB = -1e9;
      top.forEach((p) => (yT = Math.min(yT, p[1])));
      base.forEach((p) => (yB = Math.max(yB, p[1])));
      return { top, base, refl, yT, yB };
    };
    const mist = (q: G, yT: number, yB: number) => {
      const mh = (yB - yT) * 0.42;
      const mg = q.createLinearGradient(0, yB - mh, 0, yB + 6);
      mg.addColorStop(0, `rgba(${PAPER},0)`);
      mg.addColorStop(0.75, `rgba(${PAPER},${0.8 * k})`);
      mg.addColorStop(1, `rgba(${PAPER},0)`);
      q.fillStyle = mg;
      q.fillRect(x0, yB - mh, fw, mh + 6);
    };
    const FALL = 0.4 * k;
    const LIFE = 6.5;
    while (this.drops.length && t - this.drops[0].born > LIFE + 1) this.drops.shift();
    const dx = PW * 1.5;
    const dz = PD * (1.4 - 0.4 * k);
    const dz0 = -0.6 * k;
    const dropAt = (d: Drop) => ({
      x: (rnd(d.seed * 1.7) - 0.5) * dx,
      z: (rnd(d.seed * 3.3) - 0.5) * dz + dz0,
      r0: (d.heavy ? 0.9 : 0.55) * (0.75 + 0.5 * rnd(d.seed * 5.9)) * this.props.thickness,
    });

    // ---------- 晕染层：镜头在动（开关 3D、拖动）时每帧重画，平时隔一帧画一次 ----------
    const target = this.props.on3d ? 1 : 0;
    const moving = this.layerK < 0 || Math.abs(k - this.layerK) > 1e-4 || this.dragging || Math.abs(this.yaw) > 0.002 || Math.abs(this.k - target) > 1e-4;
    this.layerN++;
    this.layerK = k;
    if (moving || this.layerN % 2 === 0) {
      const q = IL.getContext("2d")!;
      q.setTransform(S, 0, 0, S, -x0 * S, -y0 * S);
      q.globalCompositeOperation = "source-over";
      q.globalAlpha = 1;
      q.filter = "none";
      this.paper(q, k);
      if (k > 0.02)
        this.mountains().forEach((l, i) => {
          const { top, base, refl, yT, yB } = ridge(l);
          if (yB - yT < 2) return;
          const Aa = l.a * k;
          const wash = (pts: Pt[], al: number) => {
            line(q, pts);
            for (let j = base.length - 1; j >= 0; j--) q.lineTo(base[j][0], base[j][1]);
            q.closePath();
            const gr = q.createLinearGradient(0, yT, 0, yB);
            gr.addColorStop(0, hexA(l.col, al));
            gr.addColorStop(0.35, hexA(l.col, al * 0.6));
            gr.addColorStop(0.78, hexA(l.col, al * 0.1));
            gr.addColorStop(1, hexA(l.col, 0));
            q.fillStyle = gr;
            q.fill();
          };
          q.save();
          q.filter = B(l.blur);
          wash(top, Aa);
          // 积墨：山体里再压一层更低的墨，看起来是一遍遍染出来的
          wash(
            top.map((p, j) => [p[0], p[1] + (base[j][1] - p[1]) * (0.28 + 0.08 * Math.sin(j * 0.21 + i))]),
            Aa * 0.55,
          );
          if (i < 3) {
            q.filter = B(l.blur * 0.6 + 0.6);
            q.strokeStyle = hexA(l.col, Aa * 0.85);
            q.lineWidth = 1.6;
            line(q, top);
            q.stroke();
          }
          // 近处两层的山脊跟着鼓点洇一下
          if (i >= 2) {
            q.filter = B(7);
            q.strokeStyle = hexA(l.col, Aa * 0.35 * kick);
            q.lineWidth = 6;
            line(q, top);
            q.stroke();
          }
          q.restore();
          // 倒影
          if (i >= 1) {
            q.save();
            q.filter = B(2.5 + i);
            line(q, refl);
            for (let j = base.length - 1; j >= 0; j--) q.lineTo(base[j][0], base[j][1]);
            q.closePath();
            let yR = -1e9;
            refl.forEach((p) => (yR = Math.max(yR, p[1])));
            const gr = q.createLinearGradient(0, yB, 0, Math.max(yB + 1, yR));
            gr.addColorStop(0, hexA(l.col, Aa * 0.24));
            gr.addColorStop(1, hexA(l.col, 0));
            q.fillStyle = gr;
            q.fill();
            q.restore();
          }
          if (i < 3) {
            // 山脚的雾：留白；再加几团飘着的云气，跟着中频慢慢浓淡
            mist(q, yT, yB);
            q.save();
            q.filter = B(22);
            q.fillStyle = `rgba(${PAPER},${(0.45 + 0.25 * mid) * k})`;
            q.beginPath();
            const span = (l.z + 9) * 1.2;
            for (let j = 0; j < 3; j++) {
              const x = ((rnd(i * 13 + j) * 2 * span + t * 0.22 * (1 + i * 0.4) * sway) % (2 * span)) - span;
              const c = cam.p(x, l.hs * (0.15 + 0.2 * rnd(i + j * 3)) * k, l.z);
              q.moveTo(c[0] + 5 * c[3], c[1]);
              q.ellipse(c[0], c[1], 5 * c[3], 0.55 * c[3], 0, 0, 7);
            }
            q.fill();
            q.restore();
          }
        });
      // 墨团：平视时落在纸上；3D 时落进山前的湖里晕开
      q.save();
      q.globalCompositeOperation = "multiply";
      for (const d of this.drops) {
        const age = t - d.born - FALL;
        if (age < 0 || age > LIFE) continue;
        const n = d.seed;
        const { x, z, r0 } = dropAt(d);
        const grow = 1 - Math.pow(1 - Math.min(1, age / 2.2), 3);
        const p = age / LIFE;
        const R = r0 * (0.2 + 0.95 * grow + 0.25 * p);
        const fade = Math.pow(1 - p, 1.6) * (1 - 0.35 * k);
        const col = INK[Math.floor(rnd(n * 9.1) * 3)];
        const ph = [1, 2, 3, 4, 5, 6].map((j) => rnd(n * 7.7 + j) * 6.283);
        const sc = cam.p(x, 0, z)[3];
        const blot = (rr: number, ox: number, oz: number, rough: number, sd: number) => {
          q.beginPath();
          for (let i = 0; i <= 60; i++) {
            const a = (i / 60) * Math.PI * 2;
            let nn = 0;
            for (let j = 2; j <= 7; j++) nn += Math.sin(a * j + ph[j - 2] + sd) * (rough / (j * 0.7));
            const s = cam.p(x + ox + Math.cos(a) * rr * (1 + nn), 0, z + oz + Math.sin(a) * rr * (1 + nn));
            if (i) q.lineTo(s[0], s[1]);
            else q.moveTo(s[0], s[1]);
          }
          q.closePath();
        };
        q.filter = B(R * sc * 0.18);
        q.fillStyle = hexA(col, 0.09 * fade);
        blot(R * 1.2, 0, 0, 0.2, 1);
        q.fill();
        q.filter = B(R * sc * 0.07);
        for (const [s, a] of [
          [0.95, 0.24],
          [0.68, 0.26],
          [0.4, 0.36],
        ]) {
          q.fillStyle = hexA(col, a * fade);
          blot(R * s, (rnd(n + s) - 0.5) * R * 0.2, (rnd(n * 2 + s) - 0.5) * R * 0.15, 0.2, s * 3);
          q.fill();
        }
        // 毛边：40 根细丝并成一笔画
        q.filter = B(0.8);
        q.strokeStyle = hexA(col, 0.12 * fade);
        q.lineWidth = 1.2;
        q.beginPath();
        for (let j = 0; j < 40; j++) {
          const a = rnd(n * 23 + j) * 6.283;
          const r1 = R * (0.82 + 0.12 * rnd(n * 29 + j));
          const r2 = r1 + R * (0.06 + 0.16 * rnd(n * 31 + j));
          const s1 = cam.p(x + Math.cos(a) * r1, 0, z + Math.sin(a) * r1);
          const s2 = cam.p(x + Math.cos(a) * r2, 0, z + Math.sin(a) * r2);
          q.moveTo(s1[0], s1[1]);
          q.lineTo(s2[0], s2[1]);
        }
        q.stroke();
        q.filter = "none";
      }
      q.restore();
    }
    g.drawImage(IL, x0, y0, fw, fh);

    // ---------- 清楚的部分：按原尺寸画 ----------
    if (k > 0.02) {
      // 最近一层山：山脊线、皴笔、点苔，然后是它山脚的雾
      const l = this.mountains()[3];
      const { top, yT, yB } = ridge(l);
      const Aa = l.a * k;
      if (yB - yT >= 2) {
        g.save();
        g.filter = BM(l.blur * 0.6 + 0.6);
        g.strokeStyle = hexA(l.col, Aa * 0.85);
        g.lineWidth = 1.6;
        line(g, top);
        g.stroke();
        g.filter = BM(0.6);
        g.lineCap = "round";
        g.strokeStyle = hexA(INK[0], 0.2 * k);
        // 皴笔按粗细分三档，每档并成一笔画
        for (let wb = 0; wb < 3; wb++) {
          g.lineWidth = 1.27 + wb * 0.53;
          g.beginPath();
          for (let j = 0; j < 130; j++) {
            if (Math.min(2, Math.floor(rnd(j) * 3)) !== wb) continue;
            const qi = Math.floor(rnd(j * 3.7) * top.length);
            const h = l.hts[qi];
            if (h < 0.5) continue;
            const x = l.xs[qi];
            const ya = h * k * (0.92 - 0.5 * rnd(j * 5.1));
            const len = h * k * (0.18 + 0.3 * rnd(j * 6.3));
            const a1 = cam.p(x, ya, l.z);
            const a2 = cam.p(x + (rnd(j * 8.9) - 0.6) * 0.35, ya - len, l.z);
            g.moveTo(a1[0], a1[1]);
            g.lineTo(a2[0], a2[1]);
          }
          g.stroke();
        }
        g.filter = "none";
        g.fillStyle = hexA(INK[0], 0.75 * k);
        g.beginPath();
        for (let j = 0; j < 66; j++) {
          const qi = Math.floor(rnd(j * 9.3 + 2) * top.length);
          const h = l.hts[qi];
          if (h < 0.7) continue;
          const p = cam.p(l.xs[qi] + (rnd(j * 4.4) - 0.5) * 0.2, h * k + 0.03, l.z);
          const r = ((1.2 + rnd(j * 2.2) * 2.2) * p[3]) / 52;
          g.moveTo(p[0] + r * 1.3, p[1]);
          g.ellipse(p[0], p[1], r * 1.3, r, 0, 0, 7);
        }
        g.fill();
        g.restore();
        mist(g, yT, yB);
      }
      // 水纹
      g.strokeStyle = `rgba(47,58,54,${0.16 * k})`;
      g.lineWidth = 1.1;
      g.beginPath();
      for (let j = 0; j < 30; j++) {
        const z = -1.5 + rnd(j * 3.3) * 14;
        const x = (rnd(j * 7.1) - 0.5) * (z + 9) * 1.5 + Math.sin(t * 0.5 + j) * 0.15 * sway;
        const len = 0.5 + rnd(j * 2.9) * 1.8;
        const a1 = cam.p(x, 0, z);
        const a2 = cam.p(x + len, 0, z);
        g.moveTo(a1[0], a1[1]);
        g.lineTo(a2[0], a2[1]);
      }
      g.stroke();
      // 孤舟：随低音轻轻起伏
      const bc = cam.p(2.6, 0.04 * kick, 2.2);
      const bs = bc[3] / 100;
      const roll = (0.04 * Math.sin(t * 1.4) + 0.05 * kick) * sway;
      const boat = (flip: number, al: number) => {
        g.save();
        g.translate(bc[0], bc[1]);
        g.scale(bs, bs * flip);
        g.rotate(roll * flip);
        g.globalAlpha *= al * k;
        g.fillStyle = INK[0];
        g.beginPath();
        g.moveTo(-46, -4);
        g.quadraticCurveTo(-4, 12, 44, -6);
        g.lineTo(38, -9);
        g.quadraticCurveTo(0, 1, -40, -8);
        g.closePath();
        g.fill();
        g.strokeStyle = INK[0];
        g.lineCap = "round";
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(6, -8);
        g.lineTo(8, -27);
        g.stroke();
        g.beginPath();
        g.moveTo(-3, -27);
        g.lineTo(19, -27);
        g.lineTo(8, -35);
        g.closePath();
        g.fill();
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(10, -18);
        g.lineTo(-34, -52);
        g.stroke();
        g.restore();
      };
      boat(-1, 0.14);
      boat(1, 1);
      g.strokeStyle = `rgba(27,29,28,${0.25 * kick * k})`;
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(bc[0], bc[1] + 2 * bs * 10, (60 + 30 * (1 - kick)) * bs, (6 + 3 * (1 - kick)) * bs, 0, 0, 7);
      g.stroke();
    }
    // 涟漪和正在往下掉的墨滴
    if (k > 0.05) {
      g.lineWidth = 1.3;
      for (const d of this.drops) {
        const age = t - d.born - FALL;
        if (age < 0 || age > LIFE) continue;
        const { x, z, r0 } = dropAt(d);
        for (let j = 0; j < 3; j++) {
          const aj = age - j * 0.35;
          if (aj < 0 || aj > 2.4) continue;
          const rr = r0 * (0.3 + aj * 1.4);
          g.strokeStyle = `rgba(40,45,42,${(1 - aj / 2.4) * 0.3 * k})`;
          g.beginPath();
          for (let i = 0; i <= 64; i++) {
            const a = (i / 64) * Math.PI * 2;
            const s = cam.p(x + Math.cos(a) * rr, 0, z + Math.sin(a) * rr);
            if (i) g.lineTo(s[0], s[1]);
            else g.moveTo(s[0], s[1]);
          }
          g.stroke();
        }
      }
      for (const d of this.drops) {
        const fa = t - d.born;
        if (fa < 0 || fa > FALL) continue;
        const { x, z } = dropAt(d);
        const s = cam.p(x, 4.2 * (1 - (fa / FALL) ** 2), z);
        const gr = g.createRadialGradient(s[0] - 0.03 * s[3], s[1] - 0.05 * s[3], 0, s[0], s[1], 0.13 * s[3]);
        gr.addColorStop(0, "#5b6660");
        gr.addColorStop(1, "#141615");
        g.save();
        g.fillStyle = gr;
        g.globalAlpha *= k;
        g.beginPath();
        g.ellipse(s[0], s[1], 0.08 * s[3], 0.11 * s[3], 0, 0, 7);
        g.fill();
        g.restore();
      }
    }
    // 宣纸：纤维和四角微微发旧（只在 3D 时有，2D 保持原样）
    if (k > 0.02) {
      this.fibers ??= Array.from({ length: 220 }, (_, i) => [x0 + rnd(i * 1.3) * fw, y0 + rnd(i * 2.7) * fh, 8 + rnd(i * 4.1) * 30, (rnd(i * 5.3) - 0.5) * 0.8]);
      g.strokeStyle = `rgba(120,100,70,${0.06 * k})`;
      g.lineWidth = 1;
      g.beginPath();
      for (const fb of this.fibers) {
        g.moveTo(fb[0], fb[1]);
        g.lineTo(fb[0] + Math.cos(fb[3]) * fb[2], fb[1] + Math.sin(fb[3]) * fb[2]);
      }
      g.stroke();
      const rad = Math.max(fw / W, fh / H) * H;
      const vg = g.createRadialGradient(W / 2, H / 2, rad * 0.45, W / 2, H / 2, rad * 1.05);
      vg.addColorStop(0, "rgba(110,90,60,0)");
      vg.addColorStop(1, `rgba(110,90,60,${0.14 * k})`);
      g.fillStyle = vg;
      g.fillRect(x0, y0, fw, fh);
    }
  }

  // ---------------- 歌词 ----------------
  // 直方图 / 圆环 / 声波：一页三句，均匀铺满整个画面；每个字（英文是每个词）大小、高低、歪斜、远近都不一样，轻轻浮动。
  //   三句依次唱亮，唱完翻页：旧的一页散开淡掉，新的一页从远处一个字一个字飘到位。
  // 墨晕：像写书法——竖排，从上往下一个字一个字写出来，一句一列，新的一列写在左边；写过的几列留在右边，越旧墨色越淡。
  // 关着 3D 时不画（2D 的歌词是界面上原来那一列）；打开时每个字从列表里的位置飞到空中的位置
  private tokens(i: number, text: string): Tok[] {
    const hit = this.toks.get(i);
    if (hit) return hit;
    const g = this.g;
    g.font = SANS;
    const chars = Array.from(text);
    const out: Tok[] = [];
    let cur = "";
    let start = 0;
    const flush = (end: number) => {
      if (cur) out.push({ text: cur, a: start, b: end, w: g.measureText(cur).width, left: g.measureText(chars.slice(0, start).join("")).width, latin: true });
      cur = "";
    };
    chars.forEach((ch, c) => {
      if (/\s/.test(ch)) flush(c);
      else if (CJK_PUNCT.test(ch)) {
        // 标点跟着前一个字，不单独占位置
        flush(c);
        const prev = out[out.length - 1];
        if (prev) prev.b = c + 1;
      } else if (CJK.test(ch) || /[぀-ヿ]/.test(ch)) {
        flush(c);
        out.push({ text: ch, a: c, b: c + 1, w: g.measureText(ch).width, left: g.measureText(chars.slice(0, c).join("")).width, latin: false });
      } else {
        if (!cur) start = c;
        cur += ch;
      }
    });
    flush(chars.length);
    this.toks.set(i, out);
    return out;
  }
  private drawLyrics(t: number, k: number, at: number) {
    const lines = this.props.lines;
    if (lines !== this.linesRef) {
      this.linesRef = lines;
      this.toks.clear();
      this.curTo = this.curFrom = -1;
      this.curAt = this.pageAt = -1e9;
      this.page = 0;
      this.prevPage = -1;
    }
    // 2D 的歌词是界面上原来那一列，这里从它淡出的地方接上
    const show = clamp((k - 0.1) / 0.45);
    if (!lines || !lines.length || show <= 0) return;
    const g = this.g;
    const inkW = this.props.style === "ink" ? 1 : 0;
    const f = 1200;
    const PAGE = 3;
    const sway = this.props.reduce ? 0 : 1;
    const LS = this.props.lyricScale;
    const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
    const lerp = (a: number, b: number) => a + (b - a) * k;
    const n = findLineIndex(lines, at);
    if (n !== this.curTo) {
      const was = this.curFrom + (this.curTo - this.curFrom) * ease((t - this.curAt) / 0.7);
      // 拖进度条跳了好几句：不一句句滑过去，直接到位
      this.curFrom = Math.abs(n - was) > 3 ? n : was;
      this.curTo = n;
      this.curAt = t;
    }
    const cur = this.props.reduce ? n : this.curFrom + (n - this.curFrom) * ease((t - this.curAt) / 0.7);
    const page = Math.floor(Math.max(0, n) / PAGE);
    if (page !== this.page) {
      this.prevPage = this.page;
      this.page = page;
      this.pageAt = t;
    }
    const tp = t - this.pageAt;
    const pin = this.props.reduce ? 1 : clamp(tp / 1.0);
    const pout = this.props.reduce ? 1 : clamp(tp / 0.6);
    if (n !== this.sungLine) {
      this.sungLine = n;
      this.sungAt.clear();
    }
    const prog = n >= 0 ? lineProgress(lines, n, at, this.props.duration) : 0;
    g.save();
    g.textBaseline = "middle";
    g.textAlign = "center";
    // 歌词自己的镜头：只跟着左右转，所以远近不同的字会错开
    const cam = this.view({ yaw: (0.06 * Math.sin(t * 0.23) * sway + this.yaw * 0.6) * k, pitch: 0, D: f + 500, f, tx: 0, ty: 0, tz: 500, cx: W / 2, cy: H / 2 });
    const place = (sx: number, sy: number, z: number) => cam.p(((sx - W / 2) * (f + z)) / f, ((H / 2 - sy) * (f + z)) / f, z);
    const ROWY = [238, 468, 692];
    const COLA = [1, 0.62, 0.4, 0.22];
    const dark = [29, 26, 22];
    for (let i = Math.floor(cur) - 3; i <= Math.floor(cur) + 4; i++) {
      if (i < 0 || i >= lines.length) continue;
      const text = lines[i].text;
      const toks = this.tokens(i, text);
      if (!toks.length) continue;
      const total = Array.from(text).length;
      const rel = i - cur;
      const act = Math.max(0, 1 - Math.abs(rel));
      // 2D 列表里的位置（飞出来的起点）
      const sc2 = (0.62 + 0.38 * act) * LS;
      const cy2 = 364 + rel * 95.5 * LS;
      // 铺开的那一页：这句在第几行、这一页是正在进来还是正在出去
      const pg = Math.floor(i / PAGE);
      const row = i % PAGE;
      const onPage = pg === this.page;
      const leaving = pg === this.prevPage && pout < 1;
      const lineA = i === n ? -1 : i < n ? 0.5 : 0.3;
      const sumW = toks.reduce((s, tk) => s + tk.w + (tk.latin ? F * 0.4 : 0), 0);
      const base = Math.min(124 / F, (1150 * 0.86) / sumW) * LS;
      // 书法：第几列（0 是正在写的那列，往右是写过的）
      const col = -rel;
      const fl = Math.floor(col);
      const colA = col <= -1 || col >= 4 ? 0 : col < 0 ? col + 1 : col >= 3 ? COLA[3] * (4 - col) : COLA[fl] + (COLA[fl + 1] - COLA[fl]) * (col - fl);
      const colLen = toks.reduce((s, tk) => s + (tk.latin ? tk.w + 20 : 74), 0);
      const colS = Math.min(1.16 * LS, 640 / colLen);
      if (inkW ? colA <= 0 : !onPage && !leaving) continue;
      let cumS = 0;
      let cumC = 0;
      toks.forEach((tk, c) => {
        const R = (q: number) => rnd(i * q + c * (q * 0.137 + 1.1));
        const filled = prog * total;
        const pr = i < n ? 1 : i > n ? 0 : clamp((filled - tk.a) / Math.max(1, tk.b - tk.a));
        let since = -1;
        if (i === n && pr > 0) {
          if (!this.sungAt.has(c)) this.sungAt.set(c, t);
          since = t - this.sungAt.get(c)!;
        }
        const x2 = 540 + (tk.left + tk.w / 2) * sc2;
        // 铺开：每行的字按宽度均匀摊在整个画面上，再各自乱一点
        const span = tk.w + (tk.latin ? F * 0.4 : 0);
        const wide = tk.w > F * 1.6;
        let aS = 0;
        let zAdd = 0;
        if (onPage) {
          const q = ease((pin - R(29) * 0.4) / 0.6);
          aS = q;
          zAdd = (1 - q) * 1000;
        } else if (leaving) {
          aS = (1 - pout) * (1 - pout);
          zAdd = -pout * 150;
        }
        aS *= lineA < 0 ? 0.42 + 0.58 * pr : lineA;
        const ps = place(
          145 + ((cumS + span / 2) / sumW) * 1150 + (R(13) - 0.5) * 0.42 * ((span / sumW) * 1150) + (row === 1 ? 20 : 0),
          ROWY[row] + (R(17) - 0.5) * 150 + 9 * Math.sin(t * 0.9 + i * 2.1 + c * 1.3) * sway,
          -140 + R(19) * 700 + zAdd,
        );
        cumS += span;
        const scS = base * (wide ? 0.7 + 0.45 * R(31) : 0.55 + 1.05 * R(31)) * ps[3];
        const rotS = (R(23) - 0.5) * (wide ? 0.4 : 0.84) + 0.035 * Math.sin(t * 0.6 + c * 2 + i) * sway;
        // 书法：竖着往下排，每个字略有大小、左右的出入；英文单词侧过来写
        const adv = (tk.latin ? tk.w + 20 : 74) * colS;
        const pc = place(1052 + col * 98 + (R(37) - 0.5) * 9, 122 - 37 * colS + cumC + adv / 2 + 3 * Math.sin(t * 0.7 + i + c * 0.8) * sway, Math.max(0, col) * 70);
        cumC += adv;
        const scC = colS * (0.92 + 0.2 * R(41)) * pc[3] * (1 + 0.2 * (i === n ? 1 - pr : 0));
        const rotC = (R(43) - 0.5) * 0.12 + (tk.latin ? Math.PI / 2 : 0);
        const aC = colA * (i < n ? 1 : Math.pow(pr, 0.6));
        // 唱到这个字的那一下往上跳一下、放大一点（书法里不跳，是写出来的）
        const bump = !inkW && since >= 0 && since < 0.45 ? Math.sin((Math.PI * since) / 0.45) * k : 0;
        const al = Math.min(1, (inkW ? aC : aS) * show);
        if (al < 0.01) return;
        if (!inkW) {
          const on = i === n ? 1 : 0;
          g.shadowColor = on ? this.palAt(0, 0.55) : this.baseAt(0.4, 0.5 * k);
          g.shadowBlur = (on ? 16 + 10 * k : 12) * this.px;
        } else if (since >= 0 && since < 0.7) {
          // 刚写下去的字墨还是湿的，边上洇一圈
          g.shadowColor = `rgba(27,29,28,${0.7 * (1 - since / 0.7) * k})`;
          g.shadowBlur = 9 * this.px;
        } else g.shadowBlur = 0;
        const p3 = inkW ? pc : ps;
        g.save();
        g.translate(lerp(x2, p3[0]), lerp(cy2, p3[1]) - 12 * bump);
        g.rotate((inkW ? rotC : rotS) * k);
        const sc = lerp(sc2, inkW ? scC : scS) * (1 + 0.22 * bump);
        g.scale(sc, sc);
        const rgb = inkW ? dark : i === n ? this.props.sung.map((v) => 255 + (v - 255) * pr) : [255, 255, 255];
        g.font = inkW && k > 0.5 ? BRUSH : SANS;
        g.fillStyle = rgba(rgb, al);
        g.fillText(tk.text, 0, 0);
        g.restore();
      });
    }
    g.restore();
  }

  // ---------------- 每一帧 ----------------

  /** now：performance.now()；at：歌词用的播放位置（毫秒，已经加上偏移） */
  frame(now: number, at: number) {
    const g = this.g;
    const t = now / 1000;
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    this.syncColors();
    const P = this.props;
    // 3D 开关：0.9 秒转过去
    const target = P.on3d ? 1 : 0;
    this.k = P.reduce ? target : this.k + Math.sign(target - this.k) * Math.min(Math.abs(target - this.k), dt / 0.9);
    const x = this.k;
    const k = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    if (!this.dragging) this.yaw *= Math.exp(-dt * 0.9);

    // 音乐：鼓点的余韵慢慢落下；没有真实声音时按一段平缓的节奏走
    this.kickEnv *= Math.exp(-dt * 7);
    this.hhEnv *= Math.exp(-dt * 10);
    if (P.playing) this.simT += dt;
    if (!this.live(now)) {
      this.midEnv += (0 - this.midEnv) * Math.min(1, dt * 2);
      if (P.playing && now >= this.nextSim) {
        const heavy = this.simBeat++ % 2 === 0;
        this.nextSim = now + (P.reactive ? 1000 : 1600);
        this.lastBeat = t;
        this.kickEnv = Math.max(this.kickEnv, heavy ? 0.6 : 0.35);
        this.spawnDrop(heavy ? 0.75 : 0.4, t);
      }
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(this.px, 0, 0, this.px, -this.x0 * this.px, -this.y0 * this.px);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.filter = "none";
    g.shadowBlur = 0;
    g.shadowOffsetX = 0;
    // 3D 时把背景压暗一点，像到了夜里（墨晕自己铺宣纸，不压）
    if (P.style !== "ink" && k > 0.01) {
      g.fillStyle = this.baseAt(0.25, 0.32 * k);
      g.fillRect(this.x0, this.y0, this.fw, this.fh);
    }
    if (P.style === "hist") this.drawHist(t, k, now);
    else if (P.style === "ring") this.drawRing(t, k, now);
    else if (P.style === "wave") this.drawWave(t, k, now);
    else this.drawInk(t, k);
    this.drawLyrics(t, k, at);
  }
}
