import { useEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { SleepMode } from "../lib/sleep";
import { t } from "../lib/i18n";

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
  /** 助眠模式：画面变成一扇窗；开着时多一行去设置里换景色和窗框 */
  sleepMode: boolean;
  onSleepMode: (v: boolean) => void;
  onSleepSettings: () => void;
  /** 歌词界面开着拾音灯时才能隐藏歌词 / 专辑信息（不然画面就空了），其他时候不显示这两项 */
  view: { showLyrics: boolean; showAlbum: boolean; onLyrics: (v: boolean) => void; onAlbum: (v: boolean) => void } | null;
  fullscreen: boolean;
  onFullscreen: () => void;
}

const SLEEP_OPTIONS: { id: SleepMode; label: string }[] = [
  { id: "off", label: "关" },
  { id: 15, label: "15 分" },
  { id: 30, label: "30 分" },
  { id: 60, label: "60 分" },
  { id: "track", label: "本首完" },
];

/** 点外面或按 Esc 关掉弹出菜单。trigger 是打开它的按钮，点那个按钮交给按钮自己处理 */
export function useDismiss(ref: RefObject<HTMLElement | null>, trigger: string, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest(trigger)) close.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, trigger]);
}

/** 菜单里的一行开关 */
export function MenuSwitch({ label, sub, on, onChange }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className="mm-switch" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="mm-label">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span className="mm-knob" aria-hidden="true" />
    </button>
  );
}

/**
 * 按住一直调：按下先走一步，停一下之后连续走。键盘（回车 / 空格）按一次走一步
 */
export function useRepeat(step: () => void) {
  const fn = useRef(step);
  fn.current = step;
  const timer = useRef<number | undefined>(undefined);
  const stop = () => {
    window.clearTimeout(timer.current);
    window.clearInterval(timer.current);
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || e.currentTarget.disabled) return;
      fn.current();
      stop();
      timer.current = window.setTimeout(() => {
        timer.current = window.setInterval(() => fn.current(), 70);
      }, 380);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) fn.current();
    },
  };
}

/**
 * 右上角"更多"里的小菜单：显示内容、歌词时间微调、换一个歌词、分享歌词、睡眠定时、助眠模式、全屏。
 * 不常用的功能都收在这里，平时界面保持干净。
 */
export function MoreMenu(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, ".more-btn", p.onClose);

  // 按住连续调时每一步都要拿到最新的偏移
  const offsetRef = useRef(p.offset);
  offsetRef.current = p.offset;
  const set = (ms: number) => {
    offsetRef.current = ms;
    p.onOffset(ms);
  };
  const minus = useRepeat(() => set(offsetRef.current - 100));
  const plus = useRepeat(() => set(offsetRef.current + 100));

  const sec = (p.offset / 1000).toFixed(1);
  const offsetText = p.offset === 0 ? t("准时") : p.offset > 0 ? t("提前 {s}s", { s: sec }) : t("推后 {s}s", { s: sec.slice(1) });

  return (
    <div className="more-menu glass glass--thick" ref={ref} role="dialog" aria-label={t("更多")}>
      {p.view && (
        <>
          <MenuSwitch label={t("显示歌词")} on={p.view.showLyrics} onChange={p.view.onLyrics} />
          <MenuSwitch label={t("显示专辑信息")} on={p.view.showAlbum} onChange={p.view.onAlbum} />
          <div className="mm-sep" />
        </>
      )}

      <div className={`mm-row${p.canAdjust ? "" : " is-disabled"}`}>
        <span className="mm-label">
          {t("歌词时间")}
          <small>{p.canAdjust ? offsetText : t("这首没有时间轴")}</small>
        </span>
        <div className="mm-stepper" role="group" aria-label={t("歌词时间微调")}>
          <button aria-label={t("歌词推后 0.1 秒")} title={t("按住连续调")} disabled={!p.canAdjust} {...minus}>
            −
          </button>
          <button className="mm-reset" aria-label={t("恢复准时")} disabled={!p.canAdjust || p.offset === 0} onClick={() => set(0)}>
            {t("{s} 秒", { s: p.offset === 0 ? "0.0" : (p.offset > 0 ? "+" : "") + sec })}
          </button>
          <button aria-label={t("歌词提前 0.1 秒")} title={t("按住连续调")} disabled={!p.canAdjust} {...plus}>
            +
          </button>
        </div>
      </div>

      <button className="mm-link" disabled={!p.canPickLyrics} onClick={p.onPickLyrics}>
        <span>{t("换一个歌词")}</span>
        <Chevron />
      </button>
      <button className="mm-link" disabled={!p.canShare} onClick={p.onShare}>
        <span>{t("分享歌词")}</span>
        <Chevron />
      </button>

      <div className="mm-sep" />

      <div className="mm-block">
        <span className="mm-label">
          {t("睡眠定时")}
          <small>{p.sleepLeft || t("到点后暂停播放，拾音灯慢慢熄灭")}</small>
        </span>
        <div className="mm-chips" role="radiogroup" aria-label={t("睡眠定时")}>
          {SLEEP_OPTIONS.map((o) => (
            <button key={String(o.id)} role="radio" aria-checked={p.sleep === o.id} className={p.sleep === o.id ? "is-on" : ""} onClick={() => p.onSleep(o.id)}>
              {t(o.label)}
            </button>
          ))}
        </div>
      </div>
      <MenuSwitch label={t("助眠模式")} sub={t("画面变成一扇窗，可以下雨")} on={p.sleepMode} onChange={p.onSleepMode} />
      {p.sleepMode && (
        <button className="mm-link" onClick={p.onSleepSettings}>
          <span>{t("天气、景色和窗框")}</span>
          <Chevron />
        </button>
      )}

      <div className="mm-sep" />

      <button className="mm-link" onClick={p.onFullscreen}>
        <span>{p.fullscreen ? t("退出全屏") : t("全屏")}</span>
        <kbd className="mm-kbd">F11</kbd>
      </button>
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
