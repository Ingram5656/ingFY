import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NowPlaying } from "../lib/types";
import { formatTime } from "../lib/player";
import { Sheet } from "./Sheet";
import { t } from "../lib/i18n";

interface LyricOption {
  source: "netease" | "lrclib";
  id: string;
  name: string;
  artists: string;
  durationMs: number;
  synced: boolean | null;
}

/** 后端返回：候选，加上这次没连上的歌词源 */
interface OptionsReport {
  options: LyricOption[];
  failed: string[];
}

interface Props {
  now: NowPlaying;
  /** 当前手动选的版本，自动匹配时为空 */
  current: { source?: string; id?: string };
  onPick: (choice: { source: string; id: string } | null) => void;
  onClose: () => void;
}

const SOURCE_NAME: Record<string, string> = { netease: t("网易云"), lrclib: "LRCLIB" };

/** 换一个歌词：列出网易云和 LRCLIB 的候选，选中后这首歌以后都用它 */
export function LyricPicker({ now, current, onPick, onClose }: Props) {
  const [result, setResult] = useState<OptionsReport | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 自动找的结果不对时，可以改歌名、歌手重新搜（比如去掉"(Live)"、换成原名）
  const [title, setTitle] = useState(now.title);
  const [artist, setArtist] = useState(now.artist);
  const [query, setQuery] = useState({ title: now.title, artist: now.artist });

  useEffect(() => {
    setTitle(now.title);
    setArtist(now.artist);
    setQuery({ title: now.title, artist: now.artist });
  }, [now.title, now.artist]);

  useEffect(() => {
    let alive = true;
    setResult(null);
    invoke<OptionsReport>("lyrics_options", { title: query.title, artist: query.artist, durationMs: now.durationMs })
      .then((r) => alive && setResult(r))
      // 整个请求都出错：当作两边都没连上，而不是"没找到"
      .catch(() => alive && setResult({ options: [], failed: ["netease", "lrclib"] }));
    return () => {
      alive = false;
    };
  }, [query.title, query.artist, now.durationMs, attempt]);

  const list = result?.options ?? null;
  const failed = result?.failed ?? [];
  const allFailed = failed.length >= 2;
  const retry = (
    <button type="button" className="picker-retry" onClick={() => setAttempt((n) => n + 1)}>
      {t("重试")}
    </button>
  );

  const search = () => {
    if (title.trim()) setQuery({ title: title.trim(), artist: artist.trim() });
  };

  const auto = !current.source;
  return (
    <Sheet title={t("换一个歌词")} subtitle={`${now.title}，${now.artist}`} onClose={onClose}>
      <form
        className="picker-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("歌名")} aria-label={t("歌名")} />
        <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder={t("歌手")} aria-label={t("歌手")} />
        <button type="submit" disabled={!title.trim()}>
          {t("搜索")}
        </button>
      </form>
      <ol className="nl-list picker-list">
        <li>
          <button className={`nl-row${auto ? " is-on" : ""}`} onClick={() => onPick(null)} aria-current={auto || undefined}>
            <span className="nl-text">
              <span className="nl-name">{t("自动匹配")}</span>
              <span className="nl-artist">{t("网易云优先，找不到再用 LRCLIB")}</span>
            </span>
            {auto && <Check />}
          </button>
        </li>
        {list === null && <li className="nl-hint">{t("正在搜索…")}</li>}
        {list !== null && allFailed && (
          <li className="nl-hint">
            {t("连不上歌词库，请检查网络")}
            {retry}
          </li>
        )}
        {list !== null && failed.length === 1 && (
          <li className="nl-hint picker-partial">
            {list.length > 0
              ? t("{name}暂时连不上，下面只有另一边的结果", { name: t(SOURCE_NAME[failed[0]] ?? failed[0]) })
              : t("{name}暂时连不上，另一边也没找到", { name: t(SOURCE_NAME[failed[0]] ?? failed[0]) })}
            {retry}
          </li>
        )}
        {list?.length === 0 && failed.length === 0 && <li className="nl-hint">{t("没找到其他版本")}</li>}
        {list?.map((o) => {
          const on = current.source === o.source && current.id === o.id;
          const diff = now.durationMs && o.durationMs ? Math.round((o.durationMs - now.durationMs) / 1000) : null;
          return (
            <li key={`${o.source}:${o.id}`}>
              <button className={`nl-row${on ? " is-on" : ""}`} onClick={() => onPick({ source: o.source, id: o.id })} aria-current={on || undefined}>
                <span className={`picker-src picker-src--${o.source}`}>{t(SOURCE_NAME[o.source] ?? o.source)}</span>
                <span className="nl-text">
                  <span className="nl-name">{o.name}</span>
                  <span className="nl-artist">
                    {o.artists}
                    {o.synced === false ? t("，没有时间轴") : ""}
                  </span>
                </span>
                <span className="nl-dur" title={t("和正在播放的这首相差的时长")}>
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
