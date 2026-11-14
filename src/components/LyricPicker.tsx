import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NowPlaying } from "../lib/types";
import { formatTime } from "../lib/player";
import { Sheet } from "./Sheet";

interface LyricOption {
  source: "netease" | "lrclib";
  id: string;
  name: string;
  artists: string;
  durationMs: number;
  synced: boolean | null;
}

interface Props {
  now: NowPlaying;
  /** 当前手动选的版本，自动匹配时为空 */
  current: { source?: string; id?: string };
  onPick: (choice: { source: string; id: string } | null) => void;
  onClose: () => void;
}

const SOURCE_NAME: Record<string, string> = { netease: "网易云", lrclib: "LRCLIB" };

/** 换一个歌词：列出网易云和 LRCLIB 的候选，选中后这首歌以后都用它 */
export function LyricPicker({ now, current, onPick, onClose }: Props) {
  const [list, setList] = useState<LyricOption[] | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<LyricOption[]>("lyrics_options", { title: now.title, artist: now.artist, durationMs: now.durationMs })
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [now.title, now.artist, now.durationMs]);

  const auto = !current.source;
  return (
    <Sheet title="换一个歌词" subtitle={`${now.title}，${now.artist}`} onClose={onClose}>
      <ol className="nl-list picker-list">
        <li>
          <button className={`nl-row${auto ? " is-on" : ""}`} onClick={() => onPick(null)} aria-current={auto || undefined}>
            <span className="nl-text">
              <span className="nl-name">自动匹配</span>
              <span className="nl-artist">网易云优先，找不到再用 LRCLIB</span>
            </span>
            {auto && <Check />}
          </button>
        </li>
        {list === null && <li className="nl-hint">正在搜索…</li>}
        {list?.length === 0 && <li className="nl-hint">没找到其他版本</li>}
        {list?.map((o) => {
          const on = current.source === o.source && current.id === o.id;
          const diff = now.durationMs && o.durationMs ? Math.round((o.durationMs - now.durationMs) / 1000) : null;
          return (
            <li key={`${o.source}:${o.id}`}>
              <button className={`nl-row${on ? " is-on" : ""}`} onClick={() => onPick({ source: o.source, id: o.id })} aria-current={on || undefined}>
                <span className={`picker-src picker-src--${o.source}`}>{SOURCE_NAME[o.source] ?? o.source}</span>
                <span className="nl-text">
                  <span className="nl-name">{o.name}</span>
                  <span className="nl-artist">
                    {o.artists}
                    {o.synced === false ? "，没有时间轴" : ""}
                  </span>
                </span>
                <span className="nl-dur" title="和正在播放的这首相差的时长">
                  {o.durationMs ? formatTime(o.durationMs) : ""}
                  {diff !== null && Math.abs(diff) >= 2 && <small className="picker-diff">{diff > 0 ? `+${diff}s` : `${diff}s`}</small>}
                </span>
                {on && <Check />}
              </button>
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}

function Check() {
  return (
    <svg className="picker-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
