import { useEffect, useRef } from "react";
import type { LightStyle } from "./Lights";
import { onAudioLevels, windowActive } from "../lib/audio";
import { usePositionRef } from "../lib/playhead";
import { BRUSH, Scene3D, type SceneProps } from "../lib/scene3d";
import type { LyricLine } from "../lib/types";

interface Props {
  style: LightStyle;
  palette: string[];
  base: string;
  alpha: number;
  thickness: number;
  playing: boolean;
  reactive: boolean;
  /** 3D 开着；关掉后镜头转回 2D 的样子，转到位时调 onFlat */
  on3d: boolean;
  onFlat: () => void;
  /** 有时间轴、并且要显示的歌词；否则 null */
  lines: LyricLine[] | null;
  offset: number;
  duration: number;
  lyricScale: number;
  sung: [number, number, number];
}

const STAGE_W = 1440;
const STAGE_H = 900;

/** 上一个场景转到了哪儿：在 3D 里换灯效时，新场景直接从 3D 开始，不用再从 2D 转一遍 */
let lastK = 0;

/** 毛笔字体：第一次用到墨晕的 3D 歌词时才去取。取不到（没网）就用系统里的行楷或楷体 */
let brushRequested = false;
function ensureBrushFont(text: string) {
  if (!brushRequested) {
    brushRequested = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap";
    document.head.appendChild(link);
  }
  // 中文网络字体是按用到的字分片下载的，把这首歌的字报上去
  if (text) void document.fonts?.load(BRUSH, text).catch(() => {});
}

/**
 * 拾音灯的 3D 模式：一张铺满整个窗口的画布，灯、场景和歌词都画在里面。
 * 画布放在舞台里（跟着舞台一起缩放），但位置和大小按窗口算，所以窗口比例和舞台不一样时两边也是满的。
 * 在画面上按住左右拖可以转镜头，松手慢慢回正。
 */
export function Lights3D(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const positionRef = usePositionRef();
  const live = useRef(p);
  live.current = p;

  const sceneProps = (reduce: boolean): SceneProps => {
    const c = live.current;
    return { style: c.style, palette: c.palette, base: c.base, alpha: c.alpha, thickness: c.thickness, playing: c.playing, reactive: c.reactive, on3d: c.on3d, reduce, lines: c.lines, duration: c.duration, lyricScale: c.lyricScale, sung: c.sung };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scene = new Scene3D(canvas, sceneProps(mq.matches), live.current.on3d ? lastK : 1);
    sceneRef.current = scene;
    const fit = () => {
      const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
      const w = window.innerWidth / scale;
      const h = window.innerHeight / scale;
      canvas.style.left = `${-(w - STAGE_W) / 2}px`;
      canvas.style.top = `${-(h - STAGE_H) / 2}px`;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      scene.resize(window.innerWidth, window.innerHeight, scale);
    };
    fit();
    window.addEventListener("resize", fit);
    const off = onAudioLevels((b) => scene.pushBands(b));
    let raf = 0;
    let flat = false;
    let lastDraw = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // 窗口藏到托盘、最小化时不画
      if (document.hidden || !windowActive()) return;
      // 最多每秒 60 帧：高刷屏（144、165、240Hz）上不跟着屏幕刷新率多画两三倍
      if (now - lastDraw < 15) return;
      lastDraw = now;
      const c = live.current;
      scene.props = sceneProps(mq.matches);
      scene.frame(now, positionRef.current + c.offset);
      lastK = scene.k;
      // 关掉 3D、镜头转回到位了：告诉外面可以换回 2D 的灯
      if (!c.on3d && scene.k <= 0 && !flat) {
        flat = true;
        c.onFlat();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      off();
      window.removeEventListener("resize", fit);
      if (!live.current.on3d) lastK = 0;
      sceneRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 墨晕的歌词用毛笔字
  const inkText = p.style === "ink" && p.on3d && p.lines ? p.lines.map((l) => l.text).join("") : "";
  useEffect(() => {
    if (inkText) ensureBrushFont(inkText);
  }, [inkText]);

  const drag = useRef<{ x: number; yaw: number } | null>(null);
  return (
    <canvas
      ref={canvasRef}
      className={`lights3d${p.style === "ink" ? " is-ink" : ""}`}
      aria-hidden="true"
      onPointerDown={(e) => {
        const s = sceneRef.current;
        if (!s || !live.current.on3d || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, yaw: s.yaw };
        s.dragging = true;
      }}
      onPointerMove={(e) => {
        const s = sceneRef.current;
        if (s && drag.current) s.yaw = Math.max(-1.2, Math.min(1.2, drag.current.yaw + (e.clientX - drag.current.x) * 0.005));
      }}
      onPointerUp={() => {
        drag.current = null;
        if (sceneRef.current) sceneRef.current.dragging = false;
      }}
      onPointerCancel={() => {
        drag.current = null;
        if (sceneRef.current) sceneRef.current.dragging = false;
      }}
    />
  );
}
