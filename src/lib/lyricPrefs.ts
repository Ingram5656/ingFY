import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * 每首歌单独记住的歌词设置：时间偏移、手动选的歌词版本。
 * 存在 localStorage（主窗口和桌面歌词窗口同源，共用一份），改了以后广播给另一个窗口。
 */
export interface LyricPref {
  /** 毫秒。正数 = 歌词提前出现，负数 = 推后 */
  offset?: number;
  /** 手动选的歌词：来源和编号；没有就是自动匹配 */
  source?: string;
  id?: string;
}

const KEY = "ingfy.lyricPrefs";
const EVENT = "lyric-prefs-changed";

function readAll(): Record<string, LyricPref> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, LyricPref>;
  } catch {
    return {};
  }
}

export function getLyricPref(track: string): LyricPref {
  return (track && readAll()[track]) || {};
}

export function setLyricPref(track: string, patch: Partial<LyricPref>) {
  if (!track) return;
  const all = readAll();
  const next: LyricPref = { ...all[track], ...patch };
  // 去掉默认值，免得越存越多
  if (!next.offset) delete next.offset;
  if (!next.source || !next.id) {
    delete next.source;
    delete next.id;
  }
  if (Object.keys(next).length) all[track] = next;
  else delete all[track];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 存不下就算了 */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: track }));
  void emit(EVENT, track).catch(() => {});
}

/** 当前歌曲的歌词设置，另一个窗口改了也会同步过来 */
export function useLyricPref(track: string): LyricPref {
  const [pref, setPref] = useState<LyricPref>(() => getLyricPref(track));
  useEffect(() => {
    setPref(getLyricPref(track));
    const refresh = () => setPref(getLyricPref(track));
    window.addEventListener(EVENT, refresh);
    const un = listen<string>(EVENT, refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      void un.then((f) => f());
    };
  }, [track]);
  return pref;
}
