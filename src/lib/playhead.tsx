import { createContext, useContext, useRef, type ReactNode } from "react";
import type { NowPlaying } from "./types";
import { usePosition, useSeek } from "./player";

interface Playhead {
  /** 实时播放进度（毫秒），拖动进度条或唱针时是预览的位置 */
  position: number;
  seek: (ms: number) => void;
  setPreview: (ms: number | null) => void;
}

const PlayheadContext = createContext<Playhead>({ position: 0, seek: () => {}, setPreview: () => {} });
const PositionRefContext = createContext<{ current: number }>({ current: 0 });

/**
 * 播放进度一秒变 60 次。把它单独放在这一层：进度一变，只有用 usePlayhead() 订阅了的组件
 * （进度条、歌词、唱片）重绘，包在里面的其他界面（设置面板、曲库、菜单…）不跟着重算。
 */
export function PlayheadProvider({ now, children }: { now: NowPlaying | null; children: ReactNode }) {
  const raw = usePosition(now);
  const playhead = useSeek(now, raw);
  const ref = useRef(playhead.position);
  ref.current = playhead.position;
  return (
    <PositionRefContext.Provider value={ref}>
      <PlayheadContext.Provider value={playhead}>{children}</PlayheadContext.Provider>
    </PositionRefContext.Provider>
  );
}

/** 订阅播放进度：用了它的组件每帧重绘 */
export function usePlayhead(): Playhead {
  return useContext(PlayheadContext);
}

/** 只在需要时读一下当前进度（比如打开分享时看唱到哪一句），不会引起重绘 */
export function usePositionRef(): { current: number } {
  return useContext(PositionRefContext);
}
