import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 订阅后端推来的频谱（64 段，低频在前，0~1）。
 * 整个窗口只建一个监听，多个组件共享；回调里直接改 DOM，不走 React 重绘。
 */
type Fn = (bands: number[]) => void;

const subs = new Set<Fn>();
let started = false;

// ---------- 灵敏度、反应速度（设置里的两个滑块，0~100，50 是原样） ----------

let gain = 1;
let gamma = 1;
let response = 50;

/**
 * 灵敏度：同样大的声音，灯跳多高。
 * 调高：放大并抬起小声的部分，细节也能让灯明显跳；调低：压低小声的部分，只有响的地方才跳得高。
 */
export function setLightSensitivity(v: number) {
  gain = 2 ** ((v - 50) / 50); // 0.5 ~ 2 倍
  gamma = 1.3 - (v / 100) * 0.6; // 1.3 ~ 0.7，越小越能把小声抬起来
}

/** 按灵敏度换算一个 0~1 的灯高 */
export function shapeLevel(x: number): number {
  return x <= 0 ? 0 : Math.min(1, gain * Math.pow(x, gamma));
}

/** 反应速度：声音来了灯窜得多快、声音停了落得多快。真实频谱在后端平滑，这里记一份给预览用 */
export function setLightResponse(v: number) {
  response = v;
}

/** 每 25 毫秒一帧时，上升和回落各走剩余距离的多少（和后端 audio.rs 用同一个公式） */
export function responseCoef(): { attack: number; release: number } {
  return { attack: 0.35 + (response / 100) * 0.6, release: 0.16 * 2.8 ** ((response - 50) / 50) };
}

/**
 * 这个窗口现在看不看得见。后端只要还有一个窗口开着就会推频谱，
 * 比如主窗口缩到托盘、只开着桌面歌词时，主窗口也会收到——看不见的窗口就别跟着更新灯了
 */
let active = true;
let watching = false;
function watchWindow() {
  if (watching) return;
  watching = true;
  const w = getCurrentWindow();
  const check = () => {
    Promise.all([w.isVisible(), w.isMinimized()]).then(
      ([v, m]) => (active = v && !m),
      () => {},
    );
  };
  check();
  setInterval(check, 500);
  document.addEventListener("visibilitychange", check);
}
export function windowActive(): boolean {
  watchWindow();
  return active && !document.hidden;
}

export function onAudioLevels(fn: Fn): () => void {
  watchWindow();
  if (!started) {
    started = true;
    listen<number[]>("audio-levels", (e) => {
      if (!windowActive()) return;
      const bands = e.payload.map((v) => shapeLevel(v / 255));
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
