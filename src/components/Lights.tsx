import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { pickGradient } from "../lib/palette";
import { mirrored, onAudioLevels, resample } from "../lib/audio";

export type LightStyle = "tube" | "hist" | "ring" | "wave";

interface Props {
  palette: string[];
  style: LightStyle;
  playing: boolean;
  /** 跟着音乐跳（设置里的"跟着节拍闪烁"）。关掉时只缓慢呼吸 */
  reactive: boolean;
}

const COUNT: Record<LightStyle, number> = { tube: 14, hist: 48, ring: 64, wave: 40 };

/** 把 64 段频谱映射到这种灯效的每一根灯上 */
function mapBands(bands: number[], style: LightStyle, n: number): number[] {
  if (style === "hist") return resample(bands, n); // 频谱仪习惯：左低右高
  if (style === "ring") return mirrored(bands, n, true); // 顶部低频，两侧往下是高频
  return mirrored(bands, n); // 灯管、声波：中间低频，向两边是高频
}

/**
 * 拾音灯。收到后端的实时频谱后进入"实时模式"（容器加 is-live），
 * 每根灯的高度由 --lv 驱动；回调里直接写 DOM，不触发 React 重绘。
 * 超过 1 秒没收到频谱（没声音、或者采集不可用）就退回 CSS 模拟动画。
 */
export function Lights({ palette, style, playing, reactive }: Props) {
  const n = COUNT[style];
  const boxRef = useRef<HTMLDivElement>(null);
  const lightRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const items = useMemo(() => {
    return Array.from({ length: n }, (_, i) => {
      let level: number;
      if (style === "hist") level = Math.max(0.1, Math.exp(-i / 22) * (0.65 + 0.35 * Math.abs(Math.sin(i * 0.9))));
      else if (style === "ring") level = Math.abs(Math.sin(i * 0.35) * 0.6 + Math.sin(i * 0.11 + 2) * 0.4);
      else if (style === "wave") level = Math.abs(Math.sin(i * 0.42) * 0.7 + Math.sin(i * 0.17 + 1) * 0.3);
      else level = [0.42, 0.66, 0.9, 0.58, 1, 0.74, 0.5, 0.86, 0.62, 0.96, 0.7, 0.48, 0.8, 0.56][i % 14];
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
    const off = onAudioLevels((bands) => {
      const values = mapBands(bands, style, n);
      const loud = values.some((v) => v > 0.02);
      for (let i = 0; i < n; i++) lightRefs.current[i]?.style.setProperty("--lv", values[i].toFixed(3));
      if (loud) {
        box.classList.add("is-live");
        clearTimeout(idle);
        idle = setTimeout(() => box.classList.remove("is-live"), 1000);
      }
    });
    return () => {
      off();
      clearTimeout(idle);
      box.classList.remove("is-live");
    };
  }, [reactive, style, n]);

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
