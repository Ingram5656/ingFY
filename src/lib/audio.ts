import { listen } from "@tauri-apps/api/event";

/**
 * 订阅后端推来的频谱（64 段，低频在前，0~1）。
 * 整个窗口只建一个监听，多个组件共享；回调里直接改 DOM，不走 React 重绘。
 */
type Fn = (bands: number[]) => void;

const subs = new Set<Fn>();
let started = false;

export function onAudioLevels(fn: Fn): () => void {
  if (!started) {
    started = true;
    listen<number[]>("audio-levels", (e) => {
      const bands = e.payload.map((v) => v / 255);
      subs.forEach((f) => f(bands));
    });
  }
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 把 src 重新采样成 n 段：每段取对应区间的最大值，保留峰值的冲击感 */
export function resample(src: number[], n: number): number[] {
  const out = new Array<number>(n);
  const m = src.length;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * m) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * m) / n));
    let v = 0;
    for (let j = a; j < b; j++) v = Math.max(v, src[j]);
    out[i] = v;
  }
  return out;
}

/**
 * 对称映射：中间是低频，向两边逐渐变成高频（灯管、声波、桌面辉光用）。
 * 圆环用 ring=true：顶部低频，沿两侧到底部变高频。
 */
export function mirrored(src: number[], n: number, ring = false): number[] {
  const half = resample(src, Math.ceil(n / 2) + 1);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const d = ring ? Math.min(i, n - i) : Math.abs(i - (n - 1) / 2);
    out[i] = half[Math.min(half.length - 1, Math.round(d))];
  }
  return out;
}
