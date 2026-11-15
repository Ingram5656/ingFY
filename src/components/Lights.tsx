import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { pickGradient } from "../lib/palette";
import { mirrored, onAudioLevels, resample, responseCoef, shapeLevel } from "../lib/audio";

export type LightStyle = "ink" | "hist" | "ring" | "wave";
/** 竖条类灯效（墨晕是单独画的） */
type BarStyle = Exclude<LightStyle, "ink">;

interface Props {
  palette: string[];
  style: LightStyle;
  playing: boolean;
  /** 跟着音乐跳（设置里的"跟着节拍闪烁"）。关掉时只缓慢呼吸 */
  reactive: boolean;
  /** 粗细倍数（0.5~1.5）。直方图的柱子是铺满整排的，变粗就是减少根数 */
  thickness?: number;
  /** 演示：超过 1 秒没有真实频谱时，用一段 120 BPM 的假节奏驱动，让设置里的预览也能看出灵敏度和反应速度 */
  demo?: boolean;
}

const COUNT: Record<BarStyle, number> = { hist: 48, ring: 64, wave: 40 };

/** 把 64 段频谱映射到这种灯效的每一根灯上 */
function mapBands(bands: number[], style: BarStyle, n: number): number[] {
  if (style === "hist") return resample(bands, n); // 频谱仪习惯：左低右高
  if (style === "ring") return mirrored(bands, n, true); // 顶部低频，两侧往下是高频
  return mirrored(bands, n); // 声波：中间低频，向两边是高频
}

/**
 * 拾音灯。收到后端的实时频谱后进入"实时模式"（容器加 is-live），
 * 每根灯的高度由 --lv 驱动；回调里直接写 DOM，不触发 React 重绘。
 * 超过 1 秒没收到频谱（没声音、或者采集不可用）就退回 CSS 模拟动画。
 */
export function Lights(p: Props) {
  // 墨晕和竖条类灯效是两套画法，分成两个组件，切换时整个换掉
  return p.style === "ink" ? <InkLights {...p} /> : <BarLights {...p} style={p.style} />;
}

function BarLights({ palette, style, playing, reactive, thickness = 1, demo = false }: Props & { style: BarStyle }) {
  const n = style === "hist" ? Math.max(16, Math.min(96, Math.round(COUNT.hist / thickness))) : COUNT[style];
  const boxRef = useRef<HTMLDivElement>(null);
  const lightRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const items = useMemo(() => {
    return Array.from({ length: n }, (_, i) => {
      let level: number;
      if (style === "hist") level = Math.max(0.1, Math.exp(-i / 22) * (0.65 + 0.35 * Math.abs(Math.sin(i * 0.9))));
      else if (style === "ring") level = Math.abs(Math.sin(i * 0.35) * 0.6 + Math.sin(i * 0.11 + 2) * 0.4);
      else level = Math.abs(Math.sin(i * 0.42) * 0.7 + Math.sin(i * 0.17 + 1) * 0.3);
      const colorIndex = style === "ring" ? Math.abs(n / 2 - i) : i;
      const colorCount = style === "ring" ? n / 2 + 1 : n;
      return {
        level,
        color: pickGradient(palette, colorIndex, colorCount),
        delay: ((i * 0.37) % 1.4).toFixed(2),
        dur: (0.8 + (i % 4) * 0.15).toFixed(2),
        angle: (i * 360) / n,
      };
    });
  }, [palette, style, n]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (!reactive) {
      box.classList.remove("is-live");
      return;
    }
    let idle: ReturnType<typeof setTimeout> | undefined;
    let lastReal = 0;
    const draw = (bands: number[]) => {
      const values = mapBands(bands, style, n);
      const loud = values.some((v) => v > 0.02);
      for (let i = 0; i < n; i++) lightRefs.current[i]?.style.setProperty("--lv", values[i].toFixed(3));
      if (loud) {
        box.classList.add("is-live");
        clearTimeout(idle);
        idle = setTimeout(() => box.classList.remove("is-live"), 1000);
      }
    };
    const off = onAudioLevels((bands) => {
      lastReal = Date.now();
      draw(bands);
    });
    // 演示节奏：底鼓每拍一下，反拍有镲片，中间夹一点起伏；和真实频谱一样经过灵敏度换算、按反应速度平滑
    let timer: ReturnType<typeof setInterval> | undefined;
    if (demo) {
      const smooth = new Array<number>(64).fill(0);
      const t0 = Date.now();
      timer = setInterval(() => {
        if (Date.now() - lastReal < 1000) return;
        const t = (Date.now() - t0) / 1000;
        const beat = t % 0.5;
        const kick = Math.exp(-beat * 9);
        const hat = Math.exp(-((t + 0.25) % 0.5) * 22);
        const swell = 0.5 + 0.5 * Math.sin(t * 0.9);
        const { attack, release } = responseCoef();
        for (let i = 0; i < 64; i++) {
          const f = i / 63;
          const raw =
            kick * Math.max(0, 1 - f * 2.2) * 0.95 +
            (0.18 + 0.32 * swell) * Math.exp(-((f - 0.35) ** 2) / 0.05) * (0.7 + 0.3 * Math.sin(t * 7 + i)) +
            hat * Math.max(0, f - 0.55) * 1.1 +
            0.04;
          const target = shapeLevel(Math.min(1, raw));
          smooth[i] += (target - smooth[i]) * (target > smooth[i] ? attack : release);
        }
        draw(smooth);
      }, 25);
    }
    return () => {
      off();
      clearInterval(timer);
      clearTimeout(idle);
      box.classList.remove("is-live");
    };
  }, [reactive, style, n, demo]);

  return (
    <div ref={boxRef} className={`lights lights--${style}${playing ? "" : " is-paused"}`} aria-hidden="true">
      {items.map((it, i) => {
        const light = (
          <span
            key={i}
            ref={(el) => {
              lightRefs.current[i] = el;
            }}
            className="light"
            style={
              {
                "--level": it.level,
                "--c": it.color,
                animationDelay: `${it.delay}s`,
                animationDuration: `${it.dur}s`,
              } as CSSProperties
            }
          />
        );
        // 圆环：外层负责旋转到对应角度，里层负责伸缩
        return style === "ring" ? (
          <span key={i} className="ring-arm" style={{ "--angle": `${it.angle}deg` } as CSSProperties}>
            {light}
          </span>
        ) : (
          light
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 墨晕

/** 墨晕的配色是固定的：宣纸底上的灰黑墨，不跟专辑色和任何颜色设置走 */
const INK = ["#1b1d1c", "#2f3a36", "#47524c"];
/** 画布按容器的这个比例画，再拉伸铺满。墨本来就是虚的，不用满分辨率；太低毛边会糊掉 */
const INK_RES = 0.75;

interface Drop {
  born: number;
  x: number;
  y: number;
  /** 起始半径（画布像素） */
  r0: number;
  heavy: boolean;
  life: number;
  /** 预先画好的这滴墨（最大时的样子），每帧只缩放和改透明度，不用每帧重新模糊 */
  sprite: HTMLCanvasElement;
  half: number;
}

function rnd(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

/** 不规则的墨团轮廓：几段随机相位的起伏叠在一起，每滴墨形状都不一样 */
function inkPath(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, seed: number, rough: number) {
  const ph = [1, 2, 3, 4, 5, 6].map((k) => rnd(seed * 7.7 + k) * Math.PI * 2);
  g.beginPath();
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    let n = 0;
    for (let k = 2; k <= 7; k++) n += Math.sin(a * k + ph[k - 2]) * (rough / (k * 0.7));
    const rr = r * (1 + n);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr * 0.86;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
}

/** 从中心往外变淡的填充：墨团没有清楚的边 */
function inkFill(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string, a: number, inner = 0.5) {
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r * 1.1);
  gr.addColorStop(0, hexA(col, a));
  gr.addColorStop(inner, hexA(col, a * 0.85));
  gr.addColorStop(1, hexA(col, a * 0.15));
  g.fillStyle = gr;
}

/**
 * 把一滴墨长到最大时的样子画进一张小画布。不描边：
 * 最外面一圈很淡的水晕，边上是往宣纸里渗出去的细毛边，墨身是几层边缘渐变的墨团，里面浓淡不匀，中间一点墨心
 */
function makeSprite(r0: number, seed: number): { sprite: HTMLCanvasElement; half: number } {
  const rMax = r0 * 1.4;
  const half = Math.ceil(rMax * 1.9);
  const c = document.createElement("canvas");
  c.width = c.height = half * 2;
  const g = c.getContext("2d")!;
  const col = INK[Math.floor(rnd(seed * 9.1) * INK.length)];
  const blur = (k: number, min = 0.6) => `blur(${Math.max(min, rMax * k).toFixed(1)}px)`;
  const at = (a: number, d: number): [number, number] => [half + Math.cos(a) * d, half + Math.sin(a) * d * 0.86];

  // 水晕：墨里的水先渗出去的那一圈
  g.filter = blur(0.16);
  g.fillStyle = hexA(col, 0.07);
  inkPath(g, half, half, rMax * 1.18, seed + 3, 0.2);
  g.fill();

  // 毛边：贴着墨团边缘往外渗的细丝，很淡，连起来也看不出是一条线
  g.filter = blur(0.012);
  g.lineCap = "round";
  for (let j = 0; j < 90; j++) {
    const a = rnd(seed * 23 + j) * Math.PI * 2;
    const r1 = rMax * (0.8 + 0.14 * rnd(seed * 29 + j));
    const len = rMax * (0.06 + 0.17 * rnd(seed * 31 + j));
    const bend = (rnd(seed * 41 + j) - 0.5) * 0.25;
    g.strokeStyle = hexA(col, 0.06 + 0.06 * rnd(seed * 43 + j));
    g.lineWidth = Math.max(0.6, rMax * 0.012 * (0.5 + rnd(seed * 37 + j)));
    g.beginPath();
    g.moveTo(...at(a, r1));
    g.lineTo(...at(a + bend, r1 + len));
    g.stroke();
  }

  // 墨身：三层错开的墨团，越往里越浓
  g.filter = blur(0.04);
  for (const [s, a] of [
    [0.95, 0.2],
    [0.72, 0.22],
    [0.5, 0.27],
  ]) {
    const ox = (rnd(seed * 3 + s) - 0.5) * rMax * 0.18;
    const oy = (rnd(seed * 5 + s) - 0.5) * rMax * 0.14;
    inkFill(g, half + ox, half + oy, rMax * s, col, a);
    inkPath(g, half + ox, half + oy, rMax * s, seed + s * 10, 0.2);
    g.fill();
  }

  // 斑驳：墨身里几小团浓淡不一的墨
  g.filter = blur(0.05);
  for (let j = 0; j < 6; j++) {
    const [x, y] = at(rnd(seed * 51 + j) * Math.PI * 2, rMax * 0.55 * rnd(seed * 53 + j));
    g.fillStyle = hexA(col, 0.07 + 0.12 * rnd(seed * 59 + j));
    inkPath(g, x, y, rMax * (0.12 + 0.16 * rnd(seed * 57 + j)), seed * 3 + j, 0.22);
    g.fill();
  }

  // 墨心
  inkFill(g, half, half, rMax * 0.24, col, 0.4, 0.3);
  inkPath(g, half, half, rMax * 0.22, seed + 20, 0.22);
  g.fill();

  // 落下时溅出的几个小墨点：少而虚
  g.filter = blur(0.015, 0.8);
  for (let j = 0; j < 3; j++) {
    const [x, y] = at(rnd(seed * 13 + j) * Math.PI * 2, rMax * (1.05 + 0.35 * rnd(seed * 17 + j)));
    g.fillStyle = hexA(col, 0.28);
    g.beginPath();
    g.arc(x, y, r0 * 0.04 * (0.5 + rnd(seed * 19 + j)), 0, Math.PI * 2);
    g.fill();
  }
  return { sprite: c, half };
}

/**
 * 墨晕：宣纸上一滴滴墨跟着鼓点落下、晕开、慢慢淡掉。
 * 有真实频谱时从低音里找鼓点；没有时（暂停以外）按一段平缓的节奏落墨，设置里的预览用 120 BPM 的假节奏。
 * 鼓越重墨滴越大；粗细滑块改墨滴大小。
 */
function InkLights({ playing, reactive, thickness = 1, demo = false }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ playing, reactive, thickness, demo });
  live.current = { playing, reactive, thickness, demo };

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const g = canvas.getContext("2d")!;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = Math.max(1, Math.round(box.clientWidth * INK_RES));
      h = canvas.height = Math.max(1, Math.round(box.clientHeight * INK_RES));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);

    const drops: Drop[] = [];
    let seed = Math.floor(Math.random() * 1e5);
    const spawn = (strength: number) => {
      if (!w || !h) return;
      seed++;
      const heavy = strength > 0.62;
      const wide = box.clientWidth > 800;
      // 全屏时墨落在右边歌词那一片，灵动岛这种小地方就铺满
      const x = w * (wide ? 0.32 + 0.58 * rnd(seed * 1.7) : 0.06 + 0.88 * rnd(seed * 1.7));
      const y = h * (wide ? 0.2 + 0.62 * rnd(seed * 3.3) : 0.15 + 0.7 * rnd(seed * 3.3));
      const base = h * (heavy ? 0.167 : 0.094) * (0.75 + 0.5 * rnd(seed * 5.9));
      const r0 = Math.max(4, base * (0.7 + 0.5 * Math.min(1, strength)) * live.current.thickness);
      const { sprite, half } = makeSprite(r0, seed);
      drops.push({ born: performance.now() / 1000, x, y, r0, heavy, life: heavy ? 6.5 : 4, sprite, half });
      if (drops.length > 18) drops.shift();
    };

    // 从低音里找鼓点：比最近的平均响一截，并且离上一滴有一点间隔
    let avg = 0;
    let lastHit = 0;
    let lastReal = 0;
    const off = onAudioLevels((bands) => {
      lastReal = performance.now();
      if (!live.current.reactive || !live.current.playing) return;
      let low = 0;
      for (let i = 0; i < 8; i++) low = Math.max(low, bands[i] ?? 0);
      const now = performance.now();
      if (low > avg * 1.3 + 0.06 && low > 0.22 && now - lastHit > 280) {
        lastHit = now;
        spawn(low);
      }
      avg += (low - avg) * 0.08;
    });

    // 没有真实频谱时的节奏：预览用 120 BPM，平时每秒一滴、轻重交替；关掉"跟着节拍"时更慢
    let beatNo = 0;
    let nextBeat = performance.now() + 300;
    let raf = 0;
    let lastDraw = 0;
    let dirty = true;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const L = live.current;
      const silent = now - lastReal > 1000;
      if (L.playing && (silent || !L.reactive) && now >= nextBeat) {
        const k = beatNo++ % 4;
        if (L.demo && L.reactive) {
          if (k === 0 || k === 2 || rnd(beatNo * 7.3) > 0.55) spawn(k === 0 || k === 2 ? 0.9 : 0.4);
          nextBeat = now + 500;
        } else {
          spawn(k % 2 === 0 ? 0.75 : 0.4);
          nextBeat = now + (L.reactive ? 1000 : 1600);
        }
      }
      // 墨晕本来就慢，30 帧足够
      if (ts - lastDraw < 32) return;
      lastDraw = ts;
      const t = now / 1000;
      while (drops.length && t - drops[0].born > drops[0].life) drops.shift();
      if (!drops.length) {
        if (dirty) g.clearRect(0, 0, w, h);
        dirty = false;
        return;
      }
      dirty = true;
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = "multiply";
      for (const d of drops) {
        const age = t - d.born;
        const p = age / d.life;
        const grow = 1 - Math.pow(1 - Math.min(1, age / 2.2), 3);
        const r = d.r0 * (0.18 + 0.95 * grow + 0.25 * p);
        const scale = r / (d.r0 * 1.4);
        g.globalAlpha = Math.pow(1 - p, 1.6);
        const size = d.half * 2 * scale;
        g.drawImage(d.sprite, d.x - size / 2, d.y - size / 2, size, size);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      off();
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={boxRef} className={`lights lights--ink${playing ? "" : " is-paused"}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
