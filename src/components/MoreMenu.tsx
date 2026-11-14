import { useEffect, useRef } from "react";
import type { SleepMode } from "../lib/sleep";

interface Props {
  onClose: () => void;
  /** 当前歌曲的歌词偏移（毫秒）；没有同步歌词时不能调 */
  offset: number;
  canAdjust: boolean;
  onOffset: (ms: number) => void;
  canPickLyrics: boolean;
  onPickLyrics: () => void;
  canShare: boolean;
  onShare: () => void;
  sleep: SleepMode;
  /** 剩余时间文字，比如"还剩 23 分钟"；没开时为空 */
  sleepLeft: string;
  onSleep: (m: SleepMode) => void;
}

const SLEEP_OPTIONS: { id: SleepMode; label: string }[] = [
  { id: "off", label: "关" },
  { id: 15, label: "15 分" },
  { id: 30, label: "30 分" },
  { id: 60, label: "60 分" },
  { id: "track", label: "本首完" },
];

/**
 * 右上角"更多"里的小菜单：歌词时间微调、换一个歌词、分享歌词、睡眠定时。
 * 不常用的功能都收在这里，平时界面保持干净。
 */
export function MoreMenu(p: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // 点菜单外面或按 Esc 关闭
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest(".more-btn")) p.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [p]);

  const sec = (p.offset / 1000).toFixed(1);
  const offsetText = p.offset === 0 ? "准时" : p.offset > 0 ? `提前 ${sec}s` : `推后 ${sec.slice(1)}s`;

  return (
    <div className="more-menu glass glass--thick" ref={ref} role="dialog" aria-label="更多">
      <div className={`mm-row${p.canAdjust ? "" : " is-disabled"}`}>
        <span className="mm-label">
          歌词时间
          <small>{p.canAdjust ? offsetText : "这首没有时间轴"}</small>
        </span>
        <div className="mm-stepper" role="group" aria-label="歌词时间微调">
          <button aria-label="歌词推后 0.1 秒" disabled={!p.canAdjust} onClick={() => p.onOffset(p.offset - 100)}>
            −
          </button>
          <button className="mm-reset" aria-label="恢复准时" disabled={!p.canAdjust || p.offset === 0} onClick={() => p.onOffset(0)}>
            {p.offset === 0 ? "0.0" : (p.offset > 0 ? "+" : "") + sec}
          </button>
          <button aria-label="歌词提前 0.1 秒" disabled={!p.canAdjust} onClick={() => p.onOffset(p.offset + 100)}>
            +
          </button>
        </div>
      </div>

      <button className="mm-link" disabled={!p.canPickLyrics} onClick={p.onPickLyrics}>
        <span>换一个歌词</span>
        <Chevron />
      </button>
      <button className="mm-link" disabled={!p.canShare} onClick={p.onShare}>
        <span>分享歌词</span>
        <Chevron />
      </button>

      <div className="mm-sep" />

      <div className="mm-block">
        <span className="mm-label">
          睡眠定时
          <small>{p.sleepLeft || "到点后暂停播放，拾音灯慢慢熄灭"}</small>
        </span>
        <div className="mm-chips" role="radiogroup" aria-label="睡眠定时">
          {SLEEP_OPTIONS.map((o) => (
            <button key={String(o.id)} role="radio" aria-checked={p.sleep === o.id} className={p.sleep === o.id ? "is-on" : ""} onClick={() => p.onSleep(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
