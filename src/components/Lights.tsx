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
/** 画布按容器的这个比例画，再拉伸铺满。墨本来就是虚的，省一半以上的像素 */
const INK_RES = 0.5;

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

/** 不规则的墨团轮廓 */
function blobPath(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, seed: number, rough: number) {
  g.beginPath();
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    let n = 0;
    for (let o = 1; o <= 4; o++) n += Math.sin(a * (o * 2 + 1) + seed * o * 3.1) * (rough / o);
    const rr = r * (1 + n);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr * 0.82;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
}

/** 把一滴墨长到最大时的样子画进一张小画布：一层层渗开的墨、边上一圈深一点的墨线、溅出去的小墨点 */
function makeSprite(r0: number, seed: number): { sprite: HTMLCanvasElement; half: number } {
  const rMax = r0 * 1.4;
  const half = Math.ceil(rMax * 1.8);
  const c = document.createElement("canvas");
  c.width = c.height = half * 2;
  const g = c.getContext("2d")!;
  const col = INK[Math.floor(rnd(seed * 9.1) * INK.length)];
  const blur = Math.max(1, 6 * INK_RES * (r0 / 75));
  g.filter = `blur(${blur.toFixed(1)}px)`;
  for (const [s, a] of [
    [1.0, 0.08],
    [0.82, 0.1],
    [0.62, 0.14],
    [0.4, 0.2],
    [0.2, 0.26],
  ]) {
    g.fillStyle = hexA(col, a * 1.4);
    blobPath(g, half, half, rMax * s, seed + s * 10, 0.13 + 0.1 * (1 - s));
    g.fill();
  }
  g.filter = `blur(${Math.max(0.5, blur / 4).toFixed(1)}px)`;
  g.strokeStyle = hexA(col, 0.22 * 1.5);
  g.lineWidth = Math.max(1, rMax / 70);
  blobPath(g, half, half, rMax, seed + 10, 0.15);
  g.stroke();
  for (let j = 0; j < 7; j++) {
    const a = rnd(seed * 13 + j) * Math.PI * 2;
    const d = rMax * (1.05 + 0.6 * rnd(seed * 17 + j));
    const r = r0 * 0.05 * (0.4 + rnd(seed * 19 + j)) * 1.3;
    g.fillStyle = hexA(col, 0.35);
    g.beginPath();
    g.arc(half + Math.cos(a) * d, half + Math.sin(a) * d * 0.82, r, 0, Math.PI * 2);
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
