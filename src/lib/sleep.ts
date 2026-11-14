import { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "./types";
import { trackKey } from "./types";
import { mediaControl } from "./player";
import { t } from "./i18n";

export type SleepMode = "off" | 15 | 30 | 60 | "track";

/** 最后这么多毫秒里拾音灯慢慢变暗 */
export const SLEEP_FADE_MS = 20000;

/**
 * 睡眠定时：到点暂停播放。"本首完"= 当前这首播完、下一首一开始就暂停。
 * 返回剩余毫秒（"本首完"时是这首剩下的时间），没开为 null。
 */
export function useSleepTimer(now: NowPlaying | null, position: number) {
  const [mode, setMode] = useState<SleepMode>("off");
  const [endsAt, setEndsAt] = useState(0);
  const [tick, setTick] = useState(0);
  const armedTrack = useRef("");
  const key = now?.title ? trackKey(now) : "";

  const start = (m: SleepMode) => {
    setMode(m);
    if (typeof m === "number") setEndsAt(Date.now() + m * 60_000);
    armedTrack.current = m === "track" ? key : "";
  };

  // 定时：每秒看一次
  useEffect(() => {
    if (typeof mode !== "number") return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  useEffect(() => {
    if (typeof mode === "number" && Date.now() >= endsAt) {
      if (now?.playing) void mediaControl("toggle");
      setMode("off");
    }
  }, [tick, mode, endsAt, now?.playing]);

  // 本首完：换到下一首时立刻暂停
  useEffect(() => {
    if (mode !== "track" || !key || key === armedTrack.current) return;
    void mediaControl("toggle");
    setMode("off");
  }, [mode, key]);

  let left: number | null = null;
  if (typeof mode === "number") left = Math.max(0, endsAt - Date.now());
  else if (mode === "track" && now) left = Math.max(0, now.durationMs - position);

  return { mode, start, left };
}

export function sleepLabel(mode: SleepMode, left: number | null): string {
  if (mode === "off" || left === null) return "";
  const min = Math.ceil(left / 60000);
  if (mode === "track") return left < 60000 ? t("这首播完就暂停，还有 {n} 秒", { n: Math.ceil(left / 1000) }) : t("这首播完就暂停，还有 {n} 分钟", { n: min });
  return left < 60000 ? t("还剩 {n} 秒", { n: Math.ceil(left / 1000) }) : t("还剩 {n} 分钟", { n: min });
}
